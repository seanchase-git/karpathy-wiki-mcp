import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { WikiError } from "./errors.js";
import { listMarkdown, safePath } from "./fsutil.js";
import { suggest } from "./fuzzy.js";

export const PAGE_TYPES = ["overview", "source", "entity", "concept", "comparison", "synthesis"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

const TYPE_SYNONYMS: Record<string, PageType> = {
  overview: "overview", summary: "overview", hub: "overview", home: "overview",
  source: "source", "source summary": "source", "source-summary": "source", document: "source", article: "source", paper: "source",
  entity: "entity", person: "entity", people: "entity", place: "entity", location: "entity", organization: "entity",
  organisation: "entity", company: "entity", object: "entity", thing: "entity", event: "entity",
  concept: "concept", topic: "concept", idea: "concept", term: "concept", technique: "concept", definition: "concept",
  comparison: "comparison", compare: "comparison", "vs": "comparison",
  synthesis: "synthesis", answer: "synthesis", analysis: "synthesis", query: "synthesis", essay: "synthesis",
};

export function normalizeType(input: string): PageType {
  const key = input.trim().toLowerCase().replace(/[_]+/g, " ");
  const t = TYPE_SYNONYMS[key] ?? TYPE_SYNONYMS[key.replace(/s$/, "")];
  if (!t) {
    throw new WikiError(
      `Unknown page type "${input}".`,
      `Use one of: ${PAGE_TYPES.join(", ")}. People, places, companies and things are "entity"; ideas and techniques are "concept".`,
      `type: "entity"`,
    );
  }
  return t;
}

/** Names the server owns at the sandbox root; pages may not take them. */
export const RESERVED = new Set(["index", "log", "schema"]);
const FORBIDDEN = /[#|^:\[\]\\/?*<>"\u0000-\u001f\u007f]/g;
const MAX_TITLE = 120;

/** Strip `[[ ]]`, a `.md` suffix, quotes and an alias (`[[X|alias]]`). */
export function cleanName(input: string): string {
  let s = input.normalize("NFC").trim();
  s = s.replace(/^`+|`+$/g, "").replace(/^["']+|["']+$/g, "").trim();
  const link = /^\[\[([^\]]*)\]\]$/.exec(s);
  if (link) s = link[1].split("|")[0];
  if (s.toLowerCase().endsWith(".md")) s = s.slice(0, -3);
  return s.trim();
}

/** Turn a title into a safe, Obsidian-compatible file stem. */
export function sanitizeTitle(input: string): string {
  const s = cleanName(input).replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  if (!s) {
    throw new WikiError("The title is empty after removing characters that are not allowed.", 'Use a plain title such as "Attention Mechanism".');
  }
  if (s.length > MAX_TITLE) throw new WikiError(`Title is ${s.length} characters; the limit is ${MAX_TITLE}.`, "Use a shorter title.");
  if (RESERVED.has(s.toLowerCase())) throw new WikiError(`"${s}" is reserved by the server.`, "Pick a different title.");
  return s;
}

export interface Frontmatter {
  title?: string;
  type?: string;
  summary?: string;
  tags?: string[];
  sources?: string[];
  created?: string;
  updated?: string;
  [k: string]: unknown;
}

export interface ParsedPage {
  frontmatter: Frontmatter;
  body: string;
  /** Set when the page has no frontmatter or it could not be parsed. */
  frontmatterError?: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parsePage(text: string): ParsedPage {
  const m = FM_RE.exec(text);
  if (!m) return { frontmatter: {}, body: text, frontmatterError: "missing frontmatter" };
  try {
    const data = YAML.parse(m[1]);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { frontmatter: {}, body: text.slice(m[0].length), frontmatterError: "frontmatter is not a key/value map" };
    }
    const fm = data as Frontmatter;
    fm.tags = toStringList(fm.tags);
    fm.sources = toStringList(fm.sources);
    return { frontmatter: fm, body: text.slice(m[0].length) };
  } catch (e) {
    return { frontmatter: {}, body: text.slice(m[0].length), frontmatterError: `invalid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}

function toStringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

const FM_ORDER = ["title", "type", "summary", "tags", "sources", "created", "updated"];

export function serializePage(fm: Frontmatter, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const k of FM_ORDER) if (fm[k] !== undefined) ordered[k] = fm[k];
  for (const [k, v] of Object.entries(fm)) if (!(k in ordered) && v !== undefined) ordered[k] = v;
  const yaml = YAML.stringify(ordered, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\s+/, "").replace(/\s+$/, "")}\n`;
}

/** Accept an array, a JSON-array string, or a comma/newline separated string. */
export function toList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s) return [];
  if (s.startsWith("[") && s.endsWith("]") && !s.startsWith("[[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* fall through to splitting */
    }
  }
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

/** Wikilink targets in `text`, ignoring fenced and inline code. `[[X#h|alias]]` → `X`. */
export function extractLinks(text: string): string[] {
  const stripped = stripCode(text);
  const out: string[] = [];
  const re = /\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(stripped))) {
    const target = m[1].split("|")[0].split("#")[0].split("^")[0].trim();
    if (target) out.push(target.normalize("NFC"));
  }
  return out;
}

function stripCode(text: string): string {
  return text.replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, "").replace(/`[^`\n]*`/g, "");
}

// ---------- headings / sections ----------

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export function headings(body: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  body.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const f = /^(```|~~~)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1].length, text: h[2].trim(), line: i });
  });
  return out;
}

function headingKey(s: string): string {
  return s.replace(/^#+\s*/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Replace the section that starts at heading `section` and runs to the next heading of the
 * same or higher level. If `content` does not start with a heading, the original heading
 * line is kept above it.
 */
export function replaceSection(body: string, section: string, content: string): string {
  const all = headings(body);
  const key = headingKey(section);
  const matches = all.filter((h) => headingKey(h.text) === key);
  if (matches.length === 0) {
    const list = all.map((h) => `${"#".repeat(h.level)} ${h.text}`);
    throw new WikiError(
      `This page has no heading "${section}".`,
      list.length
        ? `Use one of the existing headings: ${list.join(" | ")} — or use mode="append" to add a new section.`
        : `The page has no headings. Use mode="append" to add a "## ${section.replace(/^#+\s*/, "")}" section.`,
    );
  }
  if (matches.length > 1) {
    throw new WikiError(
      `The heading "${section}" appears ${matches.length} times on this page, so the section is ambiguous.`,
      `Read the page with wiki_read, then rewrite it with mode="replace_all".`,
    );
  }
  const h = matches[0];
  const lines = body.split("\n");
  const next = all.find((x) => x.line > h.line && x.level <= h.level);
  const end = next ? next.line : lines.length;
  let replacement = content.replace(/\s+$/, "");
  if (!/^#{1,6}\s/.test(replacement.trimStart())) replacement = `${lines[h.line]}\n${replacement.replace(/^\s*\n/, "")}`;
  const before = lines.slice(0, h.line).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n").replace(/^\s+/, "");
  return [before, replacement, after].filter((x) => x.length > 0).join("\n\n");
}

// ---------- sandbox file model ----------

export interface PageInfo {
  title: string;
  file: string;
  parsed: ParsedPage;
}

export interface SourceInfo {
  name: string;
  file: string;
}

export class Sandbox {
  constructor(
    readonly id: string,
    readonly dir: string,
  ) {}

  get rawDir() {
    return path.join(this.dir, "raw");
  }
  get wikiDir() {
    return path.join(this.dir, "wiki");
  }

  async pageTitles(): Promise<string[]> {
    return (await listMarkdown(this.wikiDir)).map((f) => f.slice(0, -3));
  }

  async sourceNames(): Promise<string[]> {
    return (await listMarkdown(this.rawDir)).map((f) => f.slice(0, -3));
  }

  async readPages(): Promise<PageInfo[]> {
    const out: PageInfo[] = [];
    for (const title of await this.pageTitles()) {
      const file = path.join(this.wikiDir, `${title}.md`);
      out.push({ title, file, parsed: parsePage(await fs.readFile(file, "utf8")) });
    }
    return out;
  }

  /** Exact-file path for a sanitized page title (may not exist). */
  pagePath(title: string): Promise<string> {
    return safePath(this.dir, path.join("wiki", `${title}.md`));
  }

  sourcePath(name: string): Promise<string> {
    return safePath(this.dir, path.join("raw", `${name}.md`));
  }

  /** Case-insensitive lookup of an existing page; returns its real title or undefined. */
  async findPage(name: string): Promise<string | undefined> {
    const key = cleanName(name).toLowerCase();
    return (await this.pageTitles()).find((t) => t.toLowerCase() === key);
  }

  async findSource(name: string): Promise<string | undefined> {
    const key = cleanName(name).replace(/^raw\//i, "").toLowerCase();
    return (await this.sourceNames()).find((t) => t.toLowerCase() === key);
  }

  /** Same as findPage but throws a helpful error with suggestions. */
  async requirePage(name: string): Promise<string> {
    const cleaned = cleanName(name).replace(/^wiki\//i, "");
    const found = await this.findPage(cleaned);
    if (found) return found;
    const titles = await this.pageTitles();
    const near = suggest(cleaned, titles);
    throw new WikiError(
      `No wiki page named "${cleaned}".`,
      near.length ? `Did you mean: ${near.map((n) => `"${n}"`).join(", ")}?` : "Call wiki_list folder=\"wiki\" or wiki_search to find the right title.",
    );
  }
}

/**
 * Resolve a name passed to wiki_read: a special file, raw/<x>, wiki/<x>, or a bare name
 * that must match exactly one of raw or wiki.
 */
export async function resolveReadTarget(sb: Sandbox, input: string): Promise<{ label: string; file: string }> {
  const name = cleanName(input);
  const lower = name.toLowerCase();
  if (lower === "index" || lower === "log" || lower === "schema") {
    const fileName = lower === "schema" ? "SCHEMA.md" : `${lower}.md`;
    return { label: fileName, file: await safePath(sb.dir, fileName) };
  }
  if (/^raw\//i.test(name)) {
    const found = await sb.findSource(name);
    if (!found) throw await missingSource(sb, name.slice(4));
    return { label: `raw/${found}`, file: await sb.sourcePath(found) };
  }
  if (/^wiki\//i.test(name)) {
    const t = await sb.requirePage(name.slice(5));
    return { label: `wiki/${t}`, file: await sb.pagePath(t) };
  }
  const [page, source] = await Promise.all([sb.findPage(name), sb.findSource(name)]);
  if (page && source) {
    throw new WikiError(
      `"${name}" exists both as a wiki page and as a raw source.`,
      `Add a prefix: "wiki/${page}" for the page or "raw/${source}" for the source.`,
      `wiki_read name="raw/${source}"`,
    );
  }
  if (page) return { label: `wiki/${page}`, file: await sb.pagePath(page) };
  if (source) return { label: `raw/${source}`, file: await sb.sourcePath(source) };
  const near = suggest(name, [...(await sb.pageTitles()), ...(await sb.sourceNames()).map((s) => `raw/${s}`)]);
  throw new WikiError(
    `Nothing named "${name}" in this sandbox.`,
    near.length
      ? `Did you mean: ${near.map((n) => `"${n}"`).join(", ")}?`
      : 'Call wiki_list folder="raw" or folder="wiki" to see what exists. Special names: index, log, SCHEMA.',
  );
}

async function missingSource(sb: Sandbox, name: string): Promise<WikiError> {
  const near = suggest(name, await sb.sourceNames());
  return new WikiError(
    `No raw source named "${name}".`,
    near.length ? `Did you mean: ${near.map((n) => `"raw/${n}"`).join(", ")}?` : 'Call wiki_list folder="raw" to see the sources.',
  );
}

/** Does a link target resolve to something in the sandbox? (Obsidian matches case-insensitively.) */
export function linkResolver(pageTitles: string[], sourceNames: string[]) {
  const pages = new Set(pageTitles.map((t) => t.toLowerCase()));
  const sources = new Set(sourceNames.map((t) => t.toLowerCase()));
  return (target: string): "page" | "source" | "special" | null => {
    const t = target.replace(/\.md$/i, "").trim().toLowerCase();
    if (t.startsWith("raw/")) return sources.has(t.slice(4)) ? "source" : null;
    const bare = t.startsWith("wiki/") ? t.slice(5) : t;
    if (pages.has(bare)) return "page";
    if (bare === "index" || bare === "log" || bare === "schema") return "special";
    if (sources.has(bare)) return "source";
    return null;
  };
}

