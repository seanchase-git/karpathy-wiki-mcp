import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { WikiError } from "./errors.js";
import { assertSize, atomicWrite, exists, writeNewAtomic } from "./fsutil.js";
import { GUIDE, PATCH_HINT } from "./guide.js";
import { appendLog, citedSources, rebuildIndex, recentLog, type LogOp } from "./indexlog.js";
import { lint, type Issue } from "./lint.js";
import {
  cleanName,
  extractLinks,
  linkResolver,
  normalizeType,
  parsePage,
  replaceSection,
  resolveReadTarget,
  sanitizeTitle,
  serializePage,
  toList,
  type Frontmatter,
  type Sandbox,
} from "./pages.js";
import { slugifyModel, WikiRoot } from "./sandbox.js";
import { bm25, loadChunks } from "./search.js";

export interface ServerConfig {
  root: string;
  seedDir?: string;
}

export const READ_CHUNK = 8000;
export const LIST_PAGE = 50;
export const LINT_PAGE = 30;
export const SEARCH_LIMIT = 10;
export const MAX_PAGES = 2000;

/** Slugs that are placeholders or example values, not a real model id. */
const PLACEHOLDER_MODELS = new Set(["unknown-model", "your-model-id", "your-model", "my-model", "model", "model-id", "model-name"]);

// ---------- lenient argument schemas ----------

const msg = (field: string, example: string) => ({ error: `${field} is required, e.g. ${example}` });
const sandboxId = z.string(msg("sandbox_id", '"20261018-143005-my-model" (from wiki_start)')).describe("Your sandbox id from wiki_start.");
const list = (desc: string) => z.preprocess((v) => (v === undefined || v === null ? undefined : toList(v)), z.array(z.string()).optional()).describe(desc);
const int = (desc: string) =>
  z
    .preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number().int().min(0).max(100_000_000).optional())
    .describe(desc);
const choice = <T extends string>(values: readonly [T, ...T[]], synonyms: Record<string, T>, desc: string) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return synonyms[k] ?? k;
  }, z.enum(values, { error: `must be one of: ${values.join(", ")}` })).describe(desc);

const MODES = ["append", "replace_section", "replace_all", "patch"] as const;
const MODE_SYN: Record<string, (typeof MODES)[number]> = {
  add: "append", extend: "append", replace: "replace_all", overwrite: "replace_all", rewrite: "replace_all", all: "replace_all",
  section: "replace_section", replacesection: "replace_section", update_section: "replace_section",
};
const OPS = ["ingest", "query", "lint", "note"] as const;
const OP_SYN: Record<string, (typeof OPS)[number]> = { answer: "query", question: "query", check: "lint", ingested: "ingest" };

// ---------- response helpers ----------

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string, next?: string): Result {
  return { content: [{ type: "text", text: next ? `${text.trimEnd()}\n\nNext: ${next}` : text }] };
}

async function run(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WikiError) return { isError: true, content: [{ type: "text", text: e.format() }] };
    process.stderr.write(`[karpathy-wiki-mcp] unexpected error: ${(e as Error).stack ?? e}\n`);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: the server hit an unexpected problem (${(e as Error).message}). Try the call again; if it repeats, try a different approach.` }],
    };
  }
}

function q(s: string) {
  return JSON.stringify(s);
}

/** Missing-link report appended to every create/edit reply: the most common small-model failure. */
async function linkReport(sb: Sandbox, body: string, fm: Frontmatter, self: string): Promise<string> {
  const resolve = linkResolver(await sb.pageTitles(), await sb.sourceNames());
  const links = [...new Set([...extractLinks(body), ...(fm.sources ?? []).flatMap((s) => extractLinks(s))])];
  const missing = links.filter((l) => resolve(l) === null && l.toLowerCase() !== self.toLowerCase());
  const lines: string[] = [];
  if (missing.length) {
    lines.push(`Missing links (${missing.length}): ${missing.map((m) => `[[${m}]]`).join(", ")} — create these pages or remove the links.`);
  }
  if (!extractLinks(body).length) lines.push("Warning: this page links to no other page. Add [[links]] to related pages.");
  if (body.length > 20000) lines.push("Warning: this page is long. Consider splitting it into one page per subject.");
  return lines.join("\n");
}

/** Normalize `sources` entries to `[[raw/X]]` or `[[Page]]` wikilinks; report unknown ones. */
async function normalizeSources(sb: Sandbox, input: string[]): Promise<{ sources: string[]; unknown: string[] }> {
  const out: string[] = [];
  const unknown: string[] = [];
  for (const s of input) {
    const name = cleanName(s);
    if (!name) continue;
    const src = await sb.findSource(name);
    if (src) {
      out.push(`[[raw/${src}]]`);
      continue;
    }
    const page = /^raw\//i.test(name) ? undefined : await sb.findPage(name.replace(/^wiki\//i, ""));
    if (page) out.push(`[[${page}]]`);
    else unknown.push(name); // not stored: a dangling source would mislead readers; the reply warns instead
  }
  return { sources: [...new Set(out)], unknown };
}

/** Comparable key for a `sources` entry: "[[raw/X]]", "raw/X", "X.md" → "x". */
function sourceKey(s: string): string {
  return cleanName(s).replace(/^(raw|wiki)\//i, "").toLowerCase();
}

function mergeList(a: string[] | undefined, b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...(a ?? []), ...b]) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Remove frontmatter or a leading `# Title` the model added to `content` itself. */
function cleanBody(content: string, title: string): { body: string; fm?: Frontmatter } {
  let body = content.replace(/\r\n/g, "\n");
  let fm: Frontmatter | undefined;
  if (/^\s*---\n/.test(body)) {
    const parsed = parsePage(body.trimStart());
    if (!parsed.frontmatterError) {
      fm = parsed.frontmatter;
      body = parsed.body;
    }
  }
  const h1 = /^\s*#\s+(.+?)\s*\n/.exec(body);
  if (h1 && cleanName(h1[1]).toLowerCase() === title.toLowerCase()) body = body.slice(h1[0].length);
  return { body: body.trim(), fm };
}

function formatIssues(issues: Issue[], offset: number): string {
  const page = issues.slice(offset, offset + LINT_PAGE);
  const lines = page.map((i, n) => `${offset + n + 1}. [${i.kind}] ${i.page}: ${i.message}\n   Fix: ${i.fix}`);
  const more = offset + LINT_PAGE < issues.length ? `\n\nShowing ${offset + 1}–${offset + page.length} of ${issues.length}. Continue with offset=${offset + LINT_PAGE}.` : "";
  return lines.join("\n") + more;
}

function countKinds(issues: Issue[]): string {
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}: ${n}`).join(", ");
}

// ---------- server ----------

export function createServer(cfg: ServerConfig, wikis = new WikiRoot(cfg.root, cfg.seedDir)): McpServer {
  const server = new McpServer(
    { name: "karpathy-wiki-mcp", version: "0.1.0" },
    {
      instructions:
        `A sandboxed LLM wiki (Karpathy pattern). ${PATCH_HINT} Call wiki_get_info first: it explains the method and every tool. If the user gave you a sandbox_id, use it (call wiki_status); if they asked for a new wiki, call wiki_start; otherwise ASK the user whether they have a sandbox_id or want a new wiki. Pass the sandbox_id on every call.`,
    },
  );

  /** Run a mutation under the sandbox lock and rebuild index.md afterwards. */
  const mutate = (sb: Sandbox, fn: () => Promise<Result>) =>
    wikis.withLock(sb.id, async () => {
      const r = await fn();
      await rebuildIndex(sb);
      return r;
    });

  server.registerTool(
    "wiki_get_info",
    {
      title: "Wiki manual",
      description:
        'Read this FIRST for current tool instructions, including wiki_edit_page mode="patch" for small edits. Explains ingest/query/lint, page rules, a worked example, and every tool. No arguments.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(GUIDE, "if the user gave you a sandbox_id, call wiki_status with it; if they asked for a new wiki, call wiki_start; otherwise ask them which they want."),
  );

  server.registerTool(
    "wiki_start",
    {
      title: "Start a sandbox wiki",
      description:
        'Create a NEW sandbox wiki and get its sandbox_id. Only call this when the user wants a new wiki. If the user gave you a sandbox_id, use that instead (wiki_status). If you are not sure, ask the user first. Example: wiki_start model="<your-model-id>", using your real model id. If nobody told you your model id, ask the user for it.',
      inputSchema: {
        model: z.string().optional().describe("Your model id, as the user or system prompt gave it. Required; it becomes part of the sandbox_id. Never copy an example value."),
      },
    },
    async ({ model }) =>
      run(async () => {
        const label = model?.trim() ?? "";
        if (PLACEHOLDER_MODELS.has(slugifyModel(label))) {
          throw new WikiError(
            label ? `"${label}" is an example, not a model id.` : "model is required.",
            "Pass your real model id. If the user or system prompt didn't tell you, ask the user which model you are.",
            'wiki_start model="<your-model-id>"',
          );
        }
        const { sandbox, seeded, skipped } = await wikis.create(label);
        const lines = [
          `Sandbox created.`,
          `sandbox_id: ${sandbox.id}`,
          `Pass sandbox_id="${sandbox.id}" on every other wiki call.`,
          "",
          seeded.length
            ? `Raw sources waiting to be ingested (${seeded.length}):\n${seeded.map((s) => `- raw/${s}`).join("\n")}`
            : "No raw sources yet. The user can paste text for you to save with wiki_add_source.",
        ];
        if (skipped.length) lines.push(`(Seed files skipped: ${skipped.join(", ")})`);
        lines.push("", "If you have not read the manual yet, call wiki_get_info now.");
        return ok(
          lines.join("\n"),
          seeded.length
            ? `ingest the first source: wiki_read sandbox_id="${sandbox.id}" name="raw/${seeded[0]}".`
            : "wait for the user's sources or question.",
        );
      }),
  );

  server.registerTool(
    "wiki_status",
    {
      title: "Sandbox status",
      description:
        "Where things stand: page counts, which raw sources are not ingested yet, recent log entries, lint summary. Use at the start of a session and whenever you lose track.",
      inputSchema: { sandbox_id: sandboxId },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        const pages = await sb.readPages();
        const sources = await sb.sourceNames();
        const cited = citedSources(pages, sources);
        const byType = new Map<string, number>();
        for (const p of pages) byType.set(String(p.parsed.frontmatter.type ?? "unknown"), (byType.get(String(p.parsed.frontmatter.type ?? "unknown")) ?? 0) + 1);
        const issues = await lint(sb);
        const pending = sources.filter((s) => !cited.has(s));
        const log = await recentLog(sb, 5);
        const text = [
          `# Sandbox ${sb.id}`,
          "",
          PATCH_HINT,
          "",
          `Wiki pages: ${pages.length}${byType.size ? ` (${[...byType].map(([t, n]) => `${t}: ${n}`).join(", ")})` : ""}`,
          "",
          `Raw sources: ${sources.length}`,
          ...sources.map((s) => `- raw/${s} — ${cited.has(s) ? `ingested (cited by ${cited.get(s)!.map((t) => `[[${t}]]`).join(", ")})` : "NOT INGESTED"}`),
          "",
          "Recent log:",
          ...(log.length ? log.map((l) => `- ${l}`) : ["- (empty)"]),
          "",
          `Lint: ${issues.length ? `${issues.length} issues (${countKinds(issues)}). Run wiki_lint for details.` : "no issues."}`,
        ].join("\n");
        return ok(
          text,
          pending.length
            ? `ingest raw/${pending[0]}: wiki_read sandbox_id="${sb.id}" name="raw/${pending[0]}".`
            : issues.length
              ? `everything is ingested; fix issues with wiki_lint, or answer the user's question.`
              : "everything is ingested and clean; answer the user's question or wait for new sources.",
        );
      }),
  );

  server.registerTool(
    "wiki_add_source",
    {
      title: "Add a raw source",
      description:
        'Save text the user pasted as a new read-only raw source (raw/<title>.md). Then ingest it. Example: wiki_add_source sandbox_id="..." title="Interview Notes" content="...".',
      inputSchema: {
        sandbox_id: sandboxId,
        title: z.string(msg("title", '"Interview Notes"')).describe("Name for the source file."),
        content: z.string(msg("content", "the full pasted text")).describe("The full source text, unchanged. Do not summarize it."),
      },
    },
    async ({ sandbox_id, title, content }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        const name = sanitizeTitle(title.replace(/^raw\//i, ""));
        if (!content.trim()) throw new WikiError("content is empty.", "Pass the full text of the source.");
        assertSize(content, "This source");
        return mutate(sb, async () => {
          const existing = await sb.findSource(name);
          if (existing) {
            throw new WikiError(
              `A raw source named "${existing}" already exists, and raw sources cannot be changed.`,
              `Pick a different title, e.g. "${name} (2)".`,
            );
          }
          const file = await sb.sourcePath(name);
          await writeNewAtomic(file, content.endsWith("\n") ? content : content + "\n");
          await appendLog(sb, "add-source", name, `${content.length} characters`);
          return ok(`Saved raw source "raw/${name}" (${content.length} characters).`, `ingest it, starting with wiki_search for its main entities, then wiki_create_page type="source" sources=["raw/${name}"].`);
        });
      }),
  );

  server.registerTool(
    "wiki_list",
    {
      title: "List pages or sources",
      description: 'List wiki pages (folder="wiki", default) or raw sources (folder="raw") with their summaries. 50 per call; use offset for more.',
      inputSchema: {
        sandbox_id: sandboxId,
        folder: choice(["wiki", "raw"] as const, { pages: "wiki", sources: "raw", source: "raw", page: "wiki" }, '"wiki" (default) or "raw".').optional(),
        offset: int("Start position for the next page of results (default 0)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, folder = "wiki", offset = 0 }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        let rows: string[];
        if (folder === "raw") {
          const sources = await sb.sourceNames();
          const cited = citedSources(await sb.readPages(), sources);
          rows = sources.map((s) => `- raw/${s} — ${cited.has(s) ? "ingested" : "NOT INGESTED"}`);
        } else {
          rows = (await sb.readPages()).map((p) => {
            const fm = p.parsed.frontmatter;
            return `- ${p.title} (${fm.type ?? "no type"})${fm.summary ? ` — ${String(fm.summary).replace(/\s+/g, " ")}` : ""}`;
          });
        }
        if (!rows.length) {
          return ok(folder === "raw" ? "No raw sources." : "No wiki pages yet.", folder === "raw" ? "ask the user for a source, or save pasted text with wiki_add_source." : "ingest a raw source (see wiki_status).");
        }
        const pageRows = rows.slice(offset, offset + LIST_PAGE);
        const more = offset + LIST_PAGE < rows.length ? `\nShowing ${offset + 1}–${offset + pageRows.length} of ${rows.length}. Continue with offset=${offset + LIST_PAGE}.` : "";
        return ok(`${folder === "raw" ? "Raw sources" : "Wiki pages"} (${rows.length}):\n${pageRows.join("\n")}${more}`);
      }),
  );

  server.registerTool(
    "wiki_read",
    {
      title: "Read a page or source",
      description:
        'Read a wiki page by title, a raw source as "raw/<name>", or "index", "log", "SCHEMA". Long files come in 8000-character parts; the reply says which offset to pass next. Example: wiki_read sandbox_id="..." name="raw/Example Article".',
      inputSchema: {
        sandbox_id: sandboxId,
        name: z.string(msg("name", '"Ada Lovelace", "raw/Example Article" or "index"')).describe('Page title, "raw/<source>", "index", "log" or "SCHEMA".'),
        offset: int("Character position to continue from (default 0)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, name, offset = 0 }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        const target = await resolveReadTarget(sb, name);
        const text = await fs.readFile(target.file, "utf8");
        if (offset >= text.length && text.length > 0) {
          throw new WikiError(`offset ${offset} is past the end of ${target.label} (${text.length} characters).`, "You have already read the whole file.");
        }
        let end = Math.min(text.length, offset + READ_CHUNK);
        if (end < text.length) {
          const nl = text.lastIndexOf("\n", end);
          if (nl > offset + READ_CHUNK / 2) end = nl + 1;
        }
        const part = text.slice(offset, end);
        const whole = offset === 0 && end === text.length;
        const header = whole ? `# ${target.label} (${text.length} characters, complete)` : `# ${target.label} — characters ${offset}–${end} of ${text.length}`;
        const isRaw = target.label.startsWith("raw/");
        const next =
          end < text.length
            ? `continue reading: wiki_read sandbox_id="${sb.id}" name=${q(target.label)} offset=${end}.`
            : isRaw
              ? "you have read the whole source; search for its entities, then create its source page."
              : undefined;
        return ok(`${header}\n\n${part}${end < text.length ? `\n\n[... ${text.length - end} more characters. Continue with offset=${end}]` : ""}`, next);
      }),
  );

  server.registerTool(
    "wiki_search",
    {
      title: "Search the wiki",
      description:
        'Keyword search (BM25) over wiki pages (scope="wiki", default), raw sources ("raw"), or both ("all"). Search before creating a page to avoid duplicates. Example: wiki_search sandbox_id="..." query="Ada Lovelace".',
      inputSchema: {
        sandbox_id: sandboxId,
        query: z.string(msg("query", '"analytical engine"')).describe("Words to search for."),
        scope: choice(["wiki", "raw", "all"] as const, { pages: "wiki", sources: "raw", both: "all", everything: "all" }, '"wiki" (default), "raw" or "all".').optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, query, scope = "wiki" }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        if (!query.trim()) throw new WikiError("query is empty.", "Pass one or more words to search for.");
        const hits = bm25(await loadChunks(sb, scope), query, SEARCH_LIMIT);
        if (!hits.length) {
          return ok(
            `No matches for ${q(query)} in ${scope === "all" ? "wiki pages or raw sources" : scope === "raw" ? "raw sources" : "wiki pages"}.`,
            scope === "wiki" ? 'no page covers this yet: create one if the source supports it, or try scope="all".' : "try other words.",
          );
        }
        const rows = hits.map(
          (h, i) => `${i + 1}. ${h.chunk.label}${h.chunk.heading ? ` › ${h.chunk.heading}` : ""} (line ${h.chunk.line}, score ${h.score.toFixed(2)})\n   ${h.snippet}`,
        );
        return ok(`Results for ${q(query)}:\n${rows.join("\n")}`, "wiki_read the most relevant result before writing.");
      }),
  );

  server.registerTool(
    "wiki_create_page",
    {
      title: "Create a wiki page",
      description:
        'Create a NEW wiki page. The server writes the frontmatter and updates index.md. Fails if the page exists (then use wiki_edit_page). Example: wiki_create_page sandbox_id="..." title="Ada Lovelace" type="entity" summary="English mathematician." sources=["raw/Example Article"] content="## Overview\\n...".',
      inputSchema: {
        sandbox_id: sandboxId,
        title: z.string(msg("title", '"Ada Lovelace"')).describe("Page title = the subject's name. Others link to it as [[Title]]."),
        type: z.string(msg("type", '"entity"')).describe("One of: source, entity, concept, comparison, synthesis, overview."),
        summary: z.string(msg("summary", '"English mathematician known for the first algorithm."')).describe("One sentence describing the page."),
        content: z.string(msg("content", '"## Overview\\n..."')).describe("Markdown body with ## sections and [[links]]. No frontmatter, no # title."),
        sources: list('Raw sources the facts come from, e.g. ["raw/Example Article"].'),
        tags: list('Optional tags, e.g. ["person", "mathematics"].'),
      },
    },
    async (args) =>
      run(async () => {
        const sb = await wikis.open(args.sandbox_id);
        const title = sanitizeTitle(args.title);
        const type = normalizeType(args.type);
        const summary = args.summary.replace(/\s+/g, " ").trim();
        if (!summary) throw new WikiError("summary is empty.", "Pass one sentence describing the page.");
        const { body, fm: inline } = cleanBody(args.content, title);
        assertSize(body, "This page");
        return mutate(sb, async () => {
          const existing = await sb.findPage(title);
          if (existing) {
            throw new WikiError(
              `The page "${existing}" already exists.`,
              "Use wiki_edit_page to add to it (mode=\"append\") or change a section (mode=\"replace_section\").",
              `wiki_edit_page sandbox_id="${sb.id}" title=${q(existing)} mode="append" content="## New section\\n..."`,
            );
          }
          if ((await sb.pageTitles()).length >= MAX_PAGES) throw new WikiError(`This sandbox already has ${MAX_PAGES} pages, the maximum.`);
          const { sources, unknown } = await normalizeSources(sb, [...(args.sources ?? []), ...(inline?.sources ?? [])]);
          const now = nowIso();
          const fm: Frontmatter = { title, type, summary, tags: mergeList(undefined, [...(args.tags ?? []), ...(inline?.tags ?? [])]), sources, created: now, updated: now };
          if (!fm.tags!.length) delete fm.tags;
          await atomicWrite(await sb.pagePath(title), serializePage(fm, body));
          await appendLog(sb, "create", title, `type: ${type}`);
          const notes = [await linkReport(sb, body, fm, title)];
          if (unknown.length) notes.push(`Warning: these sources do not exist and were NOT saved: ${unknown.join(", ")}. Check the names with wiki_list folder="raw".`);
          if (!sources.length && ["source", "entity", "concept"].includes(type)) notes.push('Warning: no sources given. Add them with wiki_edit_page ... sources=["raw/<name>"].');
          if (title !== cleanName(args.title)) notes.push(`Note: the title was saved as "${title}" (some characters are not allowed in file names).`);
          const report = notes.filter(Boolean).join("\n");
          return ok(
            `Created [[${title}]] (${type}).${report ? `\n${report}` : ""}`,
            report.includes("Missing links") ? "create the missing pages (or edit the links)." : "continue with the next page, or wiki_log when this ingest is done.",
          );
        });
      }),
  );

  server.registerTool(
    "wiki_edit_page",
    {
      title: "Edit a wiki page (patch for small changes)",
      description:
        'SMALL EDITS: USE mode="patch" with edits=[{old_text:"exact existing text",new_text:"replacement"}]; omit content and section. Each old_text must match the body exactly once; edits run in order and all must succeed before saving. mode="append" adds content; "replace_section" replaces a section (give section); "replace_all" replaces the body. summary/type replace values; sources/tags are added (replace_all replaces sources); remove_sources deletes entries.',
      inputSchema: {
        sandbox_id: sandboxId,
        title: z.string(msg("title", '"Ada Lovelace"')).describe("Title of the existing page."),
        mode: choice(MODES, MODE_SYN, '"append", "replace_section", "replace_all" or "patch" (small edits).'),
        content: z.string().optional().describe('Markdown to add or replace with. Omit for patch; may be "" for metadata-only append.'),
        section: z.string().optional().describe('Required for mode="replace_section": the heading text, e.g. "Early life".'),
        edits: z.array(z.object({
          old_text: z.string().min(1).describe("Exact body text to match once, including whitespace."),
          new_text: z.string().describe('Literal replacement; "" deletes the matched text.'),
        })).min(1).max(100).optional().describe("Required for patch only: 1–100 edits, applied in order. Invalid edits save nothing."),
        summary: z.string().optional().describe("New one-sentence summary (optional)."),
        type: z.string().optional().describe("New page type (optional): source, entity, concept, comparison, synthesis, overview."),
        sources: list("Raw sources to add (optional)."),
        remove_sources: list("Sources to remove from the list (optional), e.g. a deleted page."),
        tags: list("Tags to add (optional)."),
      },
    },
    async (args) =>
      run(async () => {
        const sb = await wikis.open(args.sandbox_id);
        if (args.mode === "patch") {
          if (!args.edits?.length) throw new WikiError('mode="patch" needs edits.', 'Pass edits=[{old_text:"exact body text",new_text:"replacement"}].');
          if (args.content !== undefined || args.section !== undefined) throw new WikiError('mode="patch" uses edits, not content or section.', "Omit content and section; put replacements in edits.");
        } else if (args.edits !== undefined) {
          throw new WikiError('edits requires mode="patch".', 'Use mode="patch", or omit edits.');
        }
        if (args.mode === "replace_section" && !args.section?.trim()) {
          throw new WikiError(
            'mode="replace_section" needs section (the heading text).',
            'Pass section="<heading>", or use mode="append" to add a new section.',
            `wiki_edit_page sandbox_id="${sb.id}" title=${q(args.title)} mode="replace_section" section="Overview" content="..."`,
          );
        }
        const content = args.content ?? "";
        const metaOnly = args.mode !== "patch" && !content.trim();
        if (metaOnly && args.mode !== "append") {
          throw new WikiError(`content is empty, which would erase ${args.mode === "replace_all" ? "the whole page" : "the section"}.`, "Pass the new content. To delete a page use wiki_delete_page.");
        }
        if (metaOnly && args.summary === undefined && args.type === undefined && !args.sources?.length && !args.remove_sources?.length && !args.tags?.length) {
          throw new WikiError("Nothing to change: content is empty and no summary, type, sources, remove_sources or tags were given.");
        }
        const newType = args.type !== undefined ? normalizeType(args.type) : undefined;
        return mutate(sb, async () => {
          const title = await sb.requirePage(args.title);
          const file = await sb.pagePath(title);
          const parsed = parsePage(await fs.readFile(file, "utf8"));
          const fm: Frontmatter = { ...parsed.frontmatter, title };
          const { body: incoming, fm: inline } = cleanBody(content, title);
          let body = args.mode === "patch" ? parsed.body : parsed.body.trim();
          if (args.mode === "patch") {
            for (const [i, edit] of args.edits!.entries()) {
              const start = body.indexOf(edit.old_text);
              if (start < 0) throw new WikiError(`Patch edit ${i + 1}: old_text was not found in the page body. No changes saved.`, "Read the page and copy the exact text, including whitespace. Frontmatter uses the metadata arguments.");
              if (body.indexOf(edit.old_text, start + 1) >= 0) throw new WikiError(`Patch edit ${i + 1}: old_text occurs more than once. No changes saved.`, "Include enough surrounding text to match exactly once.");
              // Slicing keeps replacement text literal, including $& and $1.
              body = body.slice(0, start) + edit.new_text + body.slice(start + edit.old_text.length);
            }
            if (!body.trim()) throw new WikiError("Patch would erase the whole page. No changes saved.", "Use wiki_delete_page to delete a page.");
          } else if (!metaOnly) {
            if (args.mode === "append") body = body ? `${body}\n\n${incoming}` : incoming;
            else if (args.mode === "replace_all") body = incoming;
            else body = replaceSection(body, args.section!, incoming);
          }
          assertSize(body, "This page");
          if (args.summary !== undefined) {
            const s = args.summary.replace(/\s+/g, " ").trim();
            if (s) fm.summary = s;
          }
          if (newType) fm.type = newType;
          else if (inline?.type) fm.type = normalizeType(String(inline.type));
          const { sources: added, unknown } = await normalizeSources(sb, [...(args.sources ?? []), ...(inline?.sources ?? [])]);
          if (added.length) fm.sources = args.mode === "replace_all" && !metaOnly ? added : mergeList(fm.sources, added);
          if (args.remove_sources?.length) {
            const drop = new Set(args.remove_sources.map(sourceKey));
            fm.sources = (fm.sources ?? []).filter((s) => !drop.has(sourceKey(s)));
          }
          const tags = [...(args.tags ?? []), ...(inline?.tags ?? [])];
          if (tags.length) fm.tags = mergeList(fm.tags, tags);
          fm.created ??= nowIso();
          fm.updated = nowIso();
          await atomicWrite(file, serializePage(fm, body));
          const what = metaOnly ? "metadata" : args.mode === "patch" ? `patch (${args.edits!.length} edit${args.edits!.length === 1 ? "" : "s"})` : args.mode === "replace_section" ? `section "${args.section}"` : args.mode;
          await appendLog(sb, "edit", title, what);
          const notes = [await linkReport(sb, body, fm, title)];
          if (unknown.length) notes.push(`Warning: these sources do not exist and were NOT saved: ${unknown.join(", ")}. Check the names with wiki_list folder="raw".`);
          const report = notes.filter(Boolean).join("\n");
          return ok(`Updated [[${title}]] (${what}).${report ? `\n${report}` : ""}`, report.includes("Missing links") ? "create the missing pages (or edit the links)." : undefined);
        });
      }),
  );

  server.registerTool(
    "wiki_delete_page",
    {
      title: "Delete a wiki page",
      description: 'Delete a wiki page (never a raw source). Reports pages whose links to it are now broken. Example: wiki_delete_page sandbox_id="..." title="Engine" reason="duplicate of Analytical Engine".',
      inputSchema: {
        sandbox_id: sandboxId,
        title: z.string(msg("title", '"Old Page"')).describe("Title of the page to delete."),
        reason: z.string(msg("reason", '"merged into X"')).describe("Why (written to the log)."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ sandbox_id, title, reason }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        if (/^raw\//i.test(cleanName(title))) throw new WikiError("Raw sources cannot be deleted.", "Only wiki pages can be deleted.");
        return mutate(sb, async () => {
          const real = await sb.requirePage(title);
          await fs.rm(await sb.pagePath(real));
          await appendLog(sb, "delete", real, reason);
          const key = real.toLowerCase();
          const linking = (await sb.readPages())
            .filter((p) => extractLinks(p.parsed.body).some((l) => l.replace(/^wiki\//i, "").toLowerCase() === key))
            .map((p) => p.title);
          return ok(
            `Deleted [[${real}]].${linking.length ? `\nThese pages still link to it (now broken): ${linking.map((t) => `[[${t}]]`).join(", ")}` : ""}`,
            linking.length ? "update those links (point them at the replacement page or remove them)." : undefined,
          );
        });
      }),
  );

  server.registerTool(
    "wiki_lint",
    {
      title: "Lint the wiki",
      description:
        "Health check: broken links, bad frontmatter, uningested sources, pages without sources, near-duplicates, orphans, stubs. Each issue has a fix. 30 per call; use offset for more.",
      inputSchema: { sandbox_id: sandboxId, offset: int("Start position (default 0).") },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, offset = 0 }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        const issues = await lint(sb);
        if (!issues.length) {
          return ok("No structural issues found.", 'do the semantic pass (contradictions, unsupported claims, missing links between related pages), then wiki_log operation="lint".');
        }
        return ok(`${issues.length} issues (${countKinds(issues)}):\n\n${formatIssues(issues, offset)}`, 'fix them from the top, re-run wiki_lint, then wiki_log operation="lint".');
      }),
  );

  server.registerTool(
    "wiki_log",
    {
      title: "Write a log entry",
      description:
        'Record what you did in log.md. Use after each ingest, after answering a question, and after a lint pass. Example: wiki_log sandbox_id="..." operation="ingest" title="Example Article" details="Created: A, B. Updated: C."',
      inputSchema: {
        sandbox_id: sandboxId,
        operation: choice(OPS, OP_SYN, '"ingest", "query", "lint" or "note".'),
        title: z.string(msg("title", '"Example Article"')).describe("Short title: the source name, the question, or the topic."),
        details: z.string().optional().describe("What you did: pages created/updated, the answer, issues fixed."),
      },
    },
    async ({ sandbox_id, operation, title, details }) =>
      run(async () => {
        const sb = await wikis.open(sandbox_id);
        if (!title.trim()) throw new WikiError("title is empty.", "Pass a short title.");
        return wikis.withLock(sb.id, async () => {
          await appendLog(sb, operation as LogOp, title, details);
          return ok(`Logged: ${operation} | ${title.replace(/\s+/g, " ").trim()}`);
        });
      }),
  );

  return server;
}

export async function repairIndexes(wikis: WikiRoot): Promise<void> {
  for (const id of await wikis.listIds()) {
    try {
      const sb = await wikis.open(id);
      if (await exists(path.join(sb.dir, "wiki"))) await rebuildIndex(sb);
    } catch (e) {
      process.stderr.write(`[karpathy-wiki-mcp] could not rebuild index for ${id}: ${(e as Error).message}\n`);
    }
  }
}
