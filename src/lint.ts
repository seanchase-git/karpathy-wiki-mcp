import { levenshtein, normalizeForMatch } from "./fuzzy.js";
import { citedSources } from "./indexlog.js";
import { extractLinks, linkResolver, PAGE_TYPES, type PageInfo, type Sandbox } from "./pages.js";

export type IssueKind =
  | "broken-link"
  | "frontmatter"
  | "uningested-source"
  | "no-sources"
  | "orphan"
  | "stub"
  | "near-duplicate";

export interface Issue {
  kind: IssueKind;
  page: string;
  message: string;
  fix: string;
}

/** Order issues by how much they hurt the wiki. */
const SEVERITY: IssueKind[] = ["broken-link", "frontmatter", "uningested-source", "no-sources", "near-duplicate", "orphan", "stub"];
export const STUB_CHARS = 200;
const NEEDS_SOURCES = new Set(["source", "entity", "concept"]);

export async function lint(sb: Sandbox): Promise<Issue[]> {
  const pages = await sb.readPages();
  const sources = await sb.sourceNames();
  return lintPages(pages, sources);
}

export function lintPages(pages: PageInfo[], sources: string[]): Issue[] {
  const issues: Issue[] = [];
  const resolve = linkResolver(
    pages.map((p) => p.title),
    sources,
  );
  const inbound = new Map<string, Set<string>>();

  for (const p of pages) {
    const fm = p.parsed.frontmatter;
    if (p.parsed.frontmatterError) {
      issues.push({
        kind: "frontmatter",
        page: p.title,
        message: `Frontmatter problem: ${p.parsed.frontmatterError}.`,
        fix: `wiki_edit_page title="${p.title}" mode="append" content="" type="<page type>" summary="<one sentence>" — the server rewrites the frontmatter.`,
      });
    } else {
      const missing: string[] = [];
      if (!PAGE_TYPES.includes(fm.type as never)) missing.push(fm.type ? `unknown type "${fm.type}"` : "type");
      if (!fm.summary || !String(fm.summary).trim()) missing.push("summary");
      if (missing.length) {
        issues.push({
          kind: "frontmatter",
          page: p.title,
          message: `Missing or invalid: ${missing.join(", ")}.`,
          fix: `wiki_edit_page title="${p.title}" mode="append" content=""${missing.some((m) => m.includes("type")) ? ' type="<source|entity|concept|comparison|synthesis|overview>"' : ""}${missing.includes("summary") ? ' summary="<one sentence>"' : ""}`,
        });
      }
    }

    const links = new Set(extractLinks(p.parsed.body));
    const sourceLinks = new Set<string>();
    for (const s of fm.sources ?? []) for (const l of extractLinks(s)) (links.add(l), sourceLinks.add(l));
    for (const target of links) {
      const kind = resolve(target);
      if (kind === null) {
        issues.push({
          kind: "broken-link",
          page: p.title,
          message: `Links to [[${target}]], which does not exist${sourceLinks.has(target) ? " (listed in sources)" : ""}.`,
          fix: sourceLinks.has(target)
            ? `wiki_edit_page title="${p.title}" mode="append" content="" remove_sources=["${target}"] — then add the right source if there is one.`
            : target.toLowerCase().startsWith("raw/")
            ? `Raw sources are: ${sources.map((s) => `raw/${s}`).join(", ") || "(none)"}. Correct the link with wiki_edit_page.`
            : `Create it with wiki_create_page title="${target}", or change/remove the link on "${p.title}".`,
        });
      } else if (kind === "page") {
        const key = target.replace(/^wiki\//i, "").toLowerCase();
        if (key !== p.title.toLowerCase()) {
          if (!inbound.has(key)) inbound.set(key, new Set());
          inbound.get(key)!.add(p.title);
        }
      }
    }

    if (NEEDS_SOURCES.has(String(fm.type)) && !(fm.sources ?? []).length) {
      issues.push({
        kind: "no-sources",
        page: p.title,
        message: `A ${fm.type} page with no sources listed, so its claims cannot be checked.`,
        fix: `wiki_edit_page title="${p.title}" mode="append" content="" sources=["raw/<source name>"]`,
      });
    }

    if (p.parsed.body.replace(/^#.*$/gm, "").trim().length < STUB_CHARS) {
      issues.push({
        kind: "stub",
        page: p.title,
        message: `Only ${p.parsed.body.trim().length} characters of content.`,
        fix: `Expand it from the sources (wiki_edit_page mode="append"), or merge it into a related page and delete it.`,
      });
    }
  }

  for (const p of pages) {
    if (p.parsed.frontmatter.type === "overview") continue;
    if (!inbound.has(p.title.toLowerCase())) {
      issues.push({
        kind: "orphan",
        page: p.title,
        message: "No other wiki page links here.",
        fix: `Add [[${p.title}]] to a related page (a source summary, entity or overview page).`,
      });
    }
  }

  const cited = citedSources(pages, sources);
  for (const s of sources) {
    if (!cited.has(s)) {
      issues.push({
        kind: "uningested-source",
        page: `raw/${s}`,
        message: "No source page cites this raw source, so it has not been ingested.",
        fix: `Ingest it: wiki_read name="raw/${s}", then wiki_create_page type="source" sources=["raw/${s}"] and update related pages.`,
      });
    }
  }

  issues.push(...nearDuplicates(pages.map((p) => p.title)));
  issues.sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind) || a.page.localeCompare(b.page));
  return issues;
}

/** Title pairs that differ only by case/punctuation/plural, or by a small edit distance. */
function nearDuplicates(titles: string[]): Issue[] {
  const keyed = titles.map((t) => ({ t, k: normalizeForMatch(t).replace(/\s+/g, "").replace(/s$/, "") })).sort((a, b) => a.k.length - b.k.length);
  const out: Issue[] = [];
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i];
      const b = keyed[j];
      if (b.k.length - a.k.length > 2) break; // sorted by length: nothing further can be within 2 edits
      const close = a.k === b.k || (a.k.length >= 6 && levenshtein(a.k, b.k) <= Math.min(2, Math.floor(a.k.length * 0.15)));
      if (close) {
        out.push({
          kind: "near-duplicate",
          page: a.t,
          message: `"${a.t}" and "${b.t}" look like the same topic.`,
          fix: `If they are the same, merge the content into one page, update links, and delete the other with wiki_delete_page.`,
        });
      }
    }
  }
  return out;
}
