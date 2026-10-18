import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WikiError } from "../src/errors.js";
import { safePath } from "../src/fsutil.js";
import { suggest } from "../src/fuzzy.js";
import { lintPages } from "../src/lint.js";
import { cleanName, extractLinks, normalizeType, parsePage, replaceSection, sanitizeTitle, serializePage, toList } from "../src/pages.js";
import { slugifyModel, timestampId, WikiRoot } from "../src/sandbox.js";
import { bm25, chunkDocument } from "../src/search.js";
import { tempDir } from "./helpers.js";

describe("names", () => {
  it("cleans links, extensions, quotes and aliases", () => {
    expect(cleanName("[[Ada Lovelace]]")).toBe("Ada Lovelace");
    expect(cleanName("Ada Lovelace.md")).toBe("Ada Lovelace");
    expect(cleanName('"Ada"')).toBe("Ada");
    expect(cleanName("[[Ada|the countess]]")).toBe("Ada");
  });
  it("strips Obsidian-hostile characters and rejects reserved/empty names", () => {
    expect(sanitizeTitle("What: a #test | ^x?")).toBe("What a test x");
    expect(() => sanitizeTitle("index")).toThrow(WikiError);
    expect(() => sanitizeTitle("###")).toThrow(WikiError);
    expect(() => sanitizeTitle("x".repeat(121))).toThrow(WikiError);
  });
  it("maps type synonyms", () => {
    expect(normalizeType("Person")).toBe("entity");
    expect(normalizeType("concepts")).toBe("concept");
    expect(() => normalizeType("banana")).toThrow(/Unknown page type/);
  });
  it("accepts list arguments in several shapes", () => {
    expect(toList("a, b")).toEqual(["a", "b"]);
    expect(toList('["a","b"]')).toEqual(["a", "b"]);
    expect(toList(["a", " "])).toEqual(["a"]);
    expect(toList("[[raw/X]]")).toEqual(["[[raw/X]]"]);
  });
  it("suggests near matches", () => {
    expect(suggest("Ada Lovelce", ["Ada Lovelace", "Charles Babbage"])).toEqual(["Ada Lovelace"]);
    expect(suggest("zzz", ["Ada Lovelace"])).toEqual([]);
  });
});

describe("ids", () => {
  it("slugifies model names", () => {
    expect(slugifyModel("google/gemma-3-31b")).toBe("gemma-3-31b");
    expect(slugifyModel("Qwen3 30B A3B@q4_k_m")).toBe("qwen3-30b-a3b");
    expect(slugifyModel("!!!")).toBe("unknown-model");
  });
  it("formats timestamps without colons", () => {
    expect(timestampId(new Date(2026, 9, 18, 14, 30, 5))).toBe("20261018-143005");
  });
  it("never reuses a folder when two sandboxes start in the same second", async () => {
    const root = await tempDir();
    const w = new WikiRoot(root);
    await w.init();
    const t = new Date(2026, 9, 18, 14, 30, 5);
    const [a, b] = await Promise.all([w.create("m", t), w.create("m", t)]);
    expect(new Set([a.sandbox.id, b.sandbox.id])).toEqual(new Set(["20261018-143005-m", "20261018-143005-m-2"]));
  });
  it("rejects bad and unknown ids with guidance", async () => {
    const root = await tempDir();
    const w = new WikiRoot(root);
    await w.init();
    await expect(w.open("../etc")).rejects.toThrow(/not a valid sandbox_id/);
    await expect(w.open("20261018-143005-nope")).rejects.toThrow(/does not exist/);
    await expect(w.open("")).rejects.toThrow(/missing/);
  });
});

describe("path safety", () => {
  it("refuses traversal and symlinks", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "wiki"));
    await expect(safePath(root, "../x")).rejects.toThrow(/outside/);
    const outside = await tempDir();
    await symlink(outside, path.join(root, "link"));
    await expect(safePath(root, "link/a.md")).rejects.toThrow(/symlink/);
    await expect(safePath(root, "wiki/ok.md")).resolves.toBe(path.join(root, "wiki", "ok.md"));
  });
});

describe("pages", () => {
  it("round-trips frontmatter with quoted wikilinks", () => {
    const text = serializePage({ title: "A", type: "entity", summary: "s", sources: ["[[raw/X]]"] }, "## H\nbody");
    expect(text).toContain('- "[[raw/X]]"');
    const p = parsePage(text);
    expect(p.frontmatter.sources).toEqual(["[[raw/X]]"]);
    expect(p.body.trim()).toBe("## H\nbody");
  });
  it("reports missing and invalid frontmatter", () => {
    expect(parsePage("no fm").frontmatterError).toBe("missing frontmatter");
    expect(parsePage("---\n: : :\n---\nx").frontmatterError).toMatch(/invalid YAML|not a key/);
  });
  it("extracts links, ignoring code", () => {
    expect(extractLinks("[[A]] [[B|alias]] [[C#h]] `[[D]]`\n```\n[[E]]\n```")).toEqual(["A", "B", "C"]);
  });
  it("replaces a section up to the next same-or-higher heading", () => {
    const body = "## One\na\n### Sub\nb\n## Two\nc";
    expect(replaceSection(body, "One", "new")).toBe("## One\nnew\n\n## Two\nc");
    expect(replaceSection(body, "## Sub", "### Sub\nz")).toBe("## One\na\n\n### Sub\nz\n\n## Two\nc");
  });
  it("errors on missing or duplicate headings", () => {
    try {
      replaceSection("## A\nx", "B", "y");
      expect.unreachable();
    } catch (e) {
      expect((e as WikiError).format()).toMatch(/existing headings: ## A/);
    }
    expect(() => replaceSection("## A\nx\n## A\ny", "A", "z")).toThrow(/appears 2 times/);
  });
});

describe("search", () => {
  it("ranks the most relevant chunk first", () => {
    const chunks = [
      ...chunkDocument("Ada Lovelace", "---\nsummary: mathematician\n---\n## Life\nAda wrote notes on the engine."),
      ...chunkDocument("Railways", "## History\nTrains and railways in England."),
    ];
    const hits = bm25(chunks, "Ada notes", 5);
    expect(hits[0].chunk.label).toBe("Ada Lovelace");
    expect(hits[0].chunk.line).toBe(4);
    expect(bm25(chunks, "zebra", 5)).toEqual([]);
  });
});

describe("lint", () => {
  const page = (title: string, fm: Record<string, unknown>, body: string) => ({ title, file: "", parsed: parsePage(serializePage(fm, body)) });
  it("finds each kind of issue", () => {
    const long = "x".repeat(250);
    const issues = lintPages(
      [
        page("Src", { type: "source", summary: "s", sources: ["[[raw/A]]"] }, `${long} [[Ent]] [[Ghost]]`),
        page("Ent", { type: "entity", summary: "e" }, "short [[Src]]"),
        page("Ents", { type: "entity", summary: "e", sources: ["[[raw/A]]"] }, long),
        { title: "Bare", file: "", parsed: parsePage("no frontmatter here") },
      ],
      ["A", "B"],
    );
    const kinds = new Set(issues.map((i) => `${i.kind}:${i.page}`));
    expect(kinds).toContain("broken-link:Src");
    expect(kinds).toContain("frontmatter:Bare");
    expect(kinds).toContain("uningested-source:raw/B");
    expect(kinds).toContain("no-sources:Ent");
    expect(kinds).toContain("stub:Ent");
    expect(kinds).toContain("orphan:Ents");
    expect(kinds).toContain("near-duplicate:Ent");
    expect(kinds).not.toContain("uningested-source:raw/A");
    expect(kinds).not.toContain("orphan:Ent");
    expect(issues[0].kind).toBe("broken-link");
  });
});


