import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const SEED = {
  "01 Alpha.md": "# Alpha\n\nAlpha Corp was founded by Jane Roe in 1900.\n",
  "02 Beta.md": "# Beta\n\nBeta is a river.\n" + "word ".repeat(3000),
  "notes.pdf": "binary",
};

const body = (extra = "") => `## Overview\nAlpha Corp was founded by [[Jane Roe]] in 1900.${extra}\n\nMore detail about the company and its history so the page is not a stub. `.padEnd(260, ".");

describe("tool flow", () => {
  it("lists 12 tools whose schemas are flat", async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["wiki_add_source", "wiki_create_page", "wiki_delete_page", "wiki_edit_page", "wiki_get_info", "wiki_lint", "wiki_list", "wiki_log", "wiki_read", "wiki_search", "wiki_start", "wiki_status"].sort(),
    );
    for (const t of tools) {
      for (const [k, v] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { type?: string }>)) {
        expect(["string", "integer", "array"], `${t.name}.${k}`).toContain(v.type);
      }
    }
  });

  it("starts a sandbox, seeds raw/, writes SCHEMA/index/log", async () => {
    const h = await harness({ seed: SEED });
    const r = await h.call("wiki_start", { model: "google/gemma-3-31b" });
    expect(r.isError).toBe(false);
    const id = /sandbox_id: (\S+)/.exec(r.text)![1];
    expect(id).toMatch(/^\d{8}-\d{6}-gemma-3-31b$/);
    expect(r.text).toContain("raw/01 Alpha");
    expect(r.text).toContain("Seed files skipped: notes.pdf");
    const dir = path.join(h.root, id);
    expect(await readFile(path.join(dir, "SCHEMA.md"), "utf8")).toContain("How this wiki works");
    expect(await readFile(path.join(dir, "index.md"), "utf8")).toContain("[[raw/01 Alpha]] — not ingested yet");
    expect(await readFile(path.join(dir, "log.md"), "utf8")).toMatch(/## \[\d{4}-\d\d-\d\d \d\d:\d\d\] start \|/);
  });

  it("requires a model unless exactly one LLM is loaded", async () => {
    const one = await harness({ fetchImpl: (async () => new Response(JSON.stringify({ models: [{ type: "llm", key: "qwen3-32b", loaded_instances: [{ id: "q" }] }] }))) as typeof fetch });
    expect((await one.call("wiki_start", {})).text).toMatch(/sandbox_id: \d{8}-\d{6}-qwen3-32b/);
    const two = await harness({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: "a", type: "llm", state: "loaded" }, { id: "b", type: "llm", state: "loaded" }] }))) as typeof fetch,
    });
    const r = await two.call("wiki_start", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Several models are loaded (a, b)");
    const none = await harness({ fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch });
    expect((await none.call("wiki_start", {})).text).toContain("model is required");
  });

  it("paginates long reads", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    const r1 = await h.call("wiki_read", { sandbox_id: id, name: "02 beta" });
    const off = Number(/offset=(\d+)/.exec(r1.text)![1]);
    expect(off).toBeGreaterThan(4000);
    expect(off).toBeLessThanOrEqual(8000);
    const r2 = await h.call("wiki_read", { sandbox_id: id, name: "raw/02 Beta", offset: String(off) });
    expect(r2.text).toContain("you have read the whole source");
    expect((await h.call("wiki_read", { sandbox_id: id, name: "raw/02 Beta", offset: 999999 })).isError).toBe(true);
  });

  it("creates pages, reports missing links, rebuilds the index", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    const r = await h.call("wiki_create_page", {
      sandbox_id: id,
      title: "[[Alpha Corp]]",
      type: "Company",
      summary: "A company founded in 1900.",
      sources: "raw/01 Alpha, Nonexistent",
      tags: '["org"]',
      content: `---\ntitle: junk\n---\n# Alpha Corp\n${body()}`,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("Missing links (1): [[Jane Roe]]");
    expect(r.text).toContain("do not exist and were NOT saved: Nonexistent");
    const file = await readFile(path.join(h.root, id, "wiki", "Alpha Corp.md"), "utf8");
    expect(file).toMatch(/^---\ntitle: Alpha Corp\ntype: entity\n/);
    expect(file).toContain('- "[[raw/01 Alpha]]"');
    expect(file).not.toContain("# Alpha Corp\n");
    expect(file).not.toContain("junk");
    const index = await readFile(path.join(h.root, id, "index.md"), "utf8");
    expect(index).toContain("## Entities\n\n- [[Alpha Corp]] — A company founded in 1900.");

    const dup = await h.call("wiki_create_page", { sandbox_id: id, title: "alpha corp", type: "entity", summary: "x", content: "y" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("wiki_edit_page");
  });

  it("marks a raw source ingested once a source page cites it", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    await h.call("wiki_create_page", { sandbox_id: id, title: "Alpha", type: "source", summary: "Summary of Alpha.", sources: ["01 Alpha"], content: body() });
    const s = await h.call("wiki_status", { sandbox_id: id });
    expect(s.text).toContain("raw/01 Alpha — ingested (cited by [[Alpha]])");
    expect(s.text).toContain("raw/02 Beta — NOT INGESTED");
    expect(s.text).toContain('Next: ingest raw/02 Beta');
  });

  it("refuses ambiguous names that exist in raw/ and wiki/", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    await h.call("wiki_create_page", { sandbox_id: id, title: "01 Alpha", type: "source", summary: "s", sources: ["01 Alpha"], content: body() });
    const r = await h.call("wiki_read", { sandbox_id: id, name: "01 Alpha" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"raw/01 Alpha"');
    expect((await h.call("wiki_read", { sandbox_id: id, name: "wiki/01 Alpha" })).text).toContain("# wiki/01 Alpha");
  });

  it("edits with every mode and merges metadata", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    await h.call("wiki_create_page", { sandbox_id: id, title: "Jane Roe", type: "person", summary: "Founder.", sources: ["raw/01 Alpha"], content: "## Life\nBorn.\n\n## Work\nFounded Alpha." });
    let r = await h.call("wiki_edit_page", { sandbox_id: id, title: "jane roe", mode: "replace section", section: "## Life", content: "Born in 1870." });
    expect(r.isError, r.text).toBe(false);
    r = await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Roe", mode: "append", content: "## Contradictions\n- none", sources: ["02 Beta"], tags: "person" });
    expect(r.isError, r.text).toBe(false);
    r = await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Roe", mode: "append", content: "", summary: "Founder of Alpha Corp." });
    expect(r.isError, r.text).toBe(false);
    const file = await readFile(path.join(h.root, id, "wiki", "Jane Roe.md"), "utf8");
    expect(file).toContain("## Life\nBorn in 1870.\n\n## Work\nFounded Alpha.\n\n## Contradictions\n- none");
    expect(file).toContain('- "[[raw/01 Alpha]]"\n  - "[[raw/02 Beta]]"');
    expect(file).toContain("summary: Founder of Alpha Corp.");

    expect((await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Roe", mode: "replace_section", content: "x" })).text).toContain("needs section");
    expect((await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Roe", mode: "replace_section", section: "Nope", content: "x" })).text).toContain("## Life | ## Work");
    expect((await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Roe", mode: "replace_all", content: "" })).text).toContain("would erase");
    expect((await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Ro", mode: "append", content: "x" })).text).toContain('Did you mean: "Jane Roe"');
    expect((await h.call("wiki_edit_page", { sandbox_id: id, title: "Jane Roe", mode: "bogus", content: "x" })).text).toContain("must be one of");
  });

  it("deletes pages and reports broken inbound links; raw is protected", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    await h.call("wiki_create_page", { sandbox_id: id, title: "Jane Roe", type: "entity", summary: "s", content: "x" });
    await h.call("wiki_create_page", { sandbox_id: id, title: "Alpha Corp", type: "entity", summary: "s", content: body() });
    const r = await h.call("wiki_delete_page", { sandbox_id: id, title: "Jane Roe", reason: "test" });
    expect(r.text).toContain("still link to it (now broken): [[Alpha Corp]]");
    expect((await h.call("wiki_delete_page", { sandbox_id: id, title: "raw/01 Alpha", reason: "x" })).isError).toBe(true);
    const lint = await h.call("wiki_lint", { sandbox_id: id });
    expect(lint.text).toMatch(/1\. \[broken-link\] Alpha Corp: Links to \[\[Jane Roe\]\]/);
  });

  it("adds sources once and never overwrites them", async () => {
    const h = await harness();
    const id = await h.start();
    expect((await h.call("wiki_add_source", { sandbox_id: id, title: "Notes", content: "Some text." })).isError).toBe(false);
    const again = await h.call("wiki_add_source", { sandbox_id: id, title: "notes", content: "Other." });
    expect(again.isError).toBe(true);
    expect(await readFile(path.join(h.root, id, "raw", "Notes.md"), "utf8")).toBe("Some text.\n");
  });

  it("searches and logs", async () => {
    const h = await harness({ seed: SEED });
    const id = await h.start();
    await h.call("wiki_create_page", { sandbox_id: id, title: "Alpha Corp", type: "entity", summary: "A company.", content: body() });
    const s = await h.call("wiki_search", { sandbox_id: id, query: "founded 1900", scope: "both" });
    expect(s.text).toMatch(/1\. (Alpha Corp|raw\/01 Alpha)/);
    expect((await h.call("wiki_search", { sandbox_id: id, query: "zebra" })).text).toContain("No matches");
    await h.call("wiki_log", { sandbox_id: id, operation: "Ingest", title: "01 Alpha", details: "Created Alpha Corp." });
    const log = await readFile(path.join(h.root, id, "log.md"), "utf8");
    expect(log).toMatch(/\] ingest \| 01 Alpha\n+Created Alpha Corp\./);
  });

  it("serializes concurrent writes to one sandbox", async () => {
    const h = await harness();
    const id = await h.start();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => h.call("wiki_create_page", { sandbox_id: id, title: `Page ${i}`, type: "concept", summary: `p${i}`, content: "x" })),
    );
    const index = await readFile(path.join(h.root, id, "index.md"), "utf8");
    expect(index.match(/^- \[\[Page \d+\]\]/gm)?.length).toBe(20);
  });

  it("gives actionable errors for unknown sandboxes", async () => {
    const h = await harness();
    const id = await h.start();
    const r = await h.call("wiki_status", { sandbox_id: id.slice(0, -1) + "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Did you mean: ${id}`);
    const missing = await h.call("wiki_status", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("sandbox_id is required");
    await rm(path.join(h.root, id), { recursive: true });
  });
});
