import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePage } from "../src/pages.js";
import { harness } from "./helpers.js";

async function patchPage(content: string) {
  const h = await harness({ seed: { "Notes.md": "Source notes." } });
  const id = await h.start();
  const created = await h.call("wiki_create_page", {
    sandbox_id: id, title: "Observatory", type: "entity", summary: "An observatory.",
    sources: ["raw/Notes"], tags: ["science"], content,
  });
  expect(created.isError, created.text).toBe(false);
  const dir = path.join(h.root, id);
  const files = [path.join(dir, "wiki", "Observatory.md"), path.join(dir, "index.md"), path.join(dir, "log.md")];
  return {
    h, id,
    snapshot: () => Promise.all(files.map((file) => readFile(file, "utf8"))),
    edit: (args: Record<string, unknown>) => h.call("wiki_edit_page", { sandbox_id: id, title: "Observatory", mode: "patch", ...args }),
  };
}

describe("wiki_edit_page patch", () => {
  it("applies ordered literal edits, preserves metadata, and logs one mutation", async () => {
    const p = await patchPage("## Overview\nThe archive opens in 2027.\n\n## Example\n```text\nprice = 10\n```\n\nRemove this sentence.\n\nKeep this paragraph.");
    const [before, , logBefore] = await p.snapshot();
    const r = await p.edit({
      edits: [
        { old_text: "opens in 2027", new_text: "opens in 2028" },
        { old_text: "opens in 2028", new_text: "opens in spring 2028" },
        { old_text: "price = 10", new_text: "price = $& + $1 + café" },
        { old_text: "Remove this sentence.\n\n", new_text: "" },
      ],
      summary: "An observatory opening in 2028.", tags: ["archive"],
    });
    expect(r.isError, r.text).toBe(false);
    const [after, index, log] = await p.snapshot();
    const parsed = parsePage(after);
    expect(parsed.body.trim()).toBe("## Overview\nThe archive opens in spring 2028.\n\n## Example\n```text\nprice = $& + $1 + café\n```\n\nKeep this paragraph.");
    expect(parsed.frontmatter).toMatchObject({
      title: "Observatory", type: "entity", sources: ["[[raw/Notes]]"],
      tags: ["science", "archive"], created: parsePage(before).frontmatter.created,
      summary: "An observatory opening in 2028.",
    });
    expect(index).toContain("[[Observatory]] — An observatory opening in 2028.");
    expect(log.slice(logBefore.length)).toMatch(/edit \| Observatory\n+patch \(4 edits\)/);
    expect(log.slice(logBefore.length).match(/edit \|/g)).toHaveLength(1);
    expect(r.text).toContain("4 edits");
  });

  it.each([
    { name: "missing text", error: /edit 2.*not found/i, content: "## Overview\nOne.\nTwo.", edits: [{ old_text: "One.", new_text: "Changed." }, { old_text: "Missing.", new_text: "New." }] },
    { name: "ambiguous text", error: /edit 2.*more than once/i, content: "## Overview\nOne.\nSame. Same.", edits: [{ old_text: "One.", new_text: "Changed." }, { old_text: "Same.", new_text: "New." }] },
    { name: "overlapping matches", error: /more than once/i, content: "## Overview\naaaa", edits: [{ old_text: "aaa", new_text: "b" }] },
    { name: "frontmatter target", error: /not found/i, content: "## Overview\nOne.", edits: [{ old_text: "summary: An observatory.", new_text: "summary: Changed." }] },
    { name: "whole body deletion", error: /erase the whole page/i, content: "## Overview\nOne.", edits: [{ old_text: "## Overview\nOne.", new_text: "" }] },
  ])("leaves page, index, and log untouched on $name", async ({ content, edits, error }) => {
    const p = await patchPage(content);
    const before = await p.snapshot();
    const r = await p.edit({ edits, summary: "Must not be saved." });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(error);
    expect(await p.snapshot()).toEqual(before);
  });

  it.each([
    {}, { edits: [] }, { edits: [{ old_text: "", new_text: "x" }] },
    { edits: [{ old_text: "One." }] },
    { edits: [{ old_text: "One.", new_text: "Two." }], content: "Ignored?" },
    { edits: [{ old_text: "One.", new_text: "Two." }], section: "Overview" },
    { mode: "append", content: "New paragraph.", edits: [{ old_text: "One.", new_text: "Two." }] },
  ])("rejects malformed or conflicting patch arguments %#", async (args) => {
    const p = await patchPage("## Overview\nOne.");
    const before = await p.snapshot();
    expect((await p.edit(args)).isError).toBe(true);
    expect(await p.snapshot()).toEqual(before);
  });

  it("preserves leading headings and whitespace in replacement text and reports new missing links", async () => {
    const p = await patchPage("## Overview\nOne.\n\n## Other\nKeep.");
    const r = await p.edit({ edits: [{ old_text: "One.", new_text: "### Detail\n  Indented [[New page]]." }] });
    expect(r.isError, r.text).toBe(false);
    expect(parsePage((await p.snapshot())[0]).body.trim()).toBe("## Overview\n### Detail\n  Indented [[New page]].\n\n## Other\nKeep.");
    expect(r.text).toContain("[[New page]]");
  });

  it("rejects an oversized patched body without saving", async () => {
    const p = await patchPage("## Overview\nOne.");
    const before = await p.snapshot();
    const r = await p.edit({ edits: [{ old_text: "One.", new_text: "x".repeat(103000) }] });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("limit");
    expect(await p.snapshot()).toEqual(before);
  });

  it("rejects a competing stale patch instead of overwriting a completed patch", async () => {
    const p = await patchPage("## Overview\nOne.");
    const results = await Promise.all([
      p.edit({ edits: [{ old_text: "One.", new_text: "First." }] }),
      p.edit({ edits: [{ old_text: "One.", new_text: "Second." }] }),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.find((r) => r.isError)?.text).toMatch(/not found/i);
    const [file, , log] = await p.snapshot();
    expect(parsePage(file).body.trim()).toMatch(/^## Overview\n(First|Second)\.$/);
    expect(log.match(/edit \| Observatory/g)).toHaveLength(1);
  });
});
