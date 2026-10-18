// Regressions for the Codex implementation review (2026-10-18).
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { citedSources } from "../src/indexlog.js";
import { parsePage, serializePage } from "../src/pages.js";
import { acquireProcessLock, WikiRoot } from "../src/sandbox.js";
import { harness, tempDir } from "./helpers.js";

const filler = "Some text so the page is long enough. ".repeat(8);

describe("review fixes", () => {
  it("refuses a sandbox whose log.md or wiki/ is a symlink", async () => {
    const h = await harness();
    const id = await h.start();
    const outside = path.join(await tempDir(), "victim.md");
    await writeFile(outside, "untouched");
    await rm(path.join(h.root, id, "log.md"));
    await symlink(outside, path.join(h.root, id, "log.md"));
    const r = await h.call("wiki_log", { sandbox_id: id, operation: "note", title: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("tampered");
    expect(await readFile(outside, "utf8")).toBe("untouched");

    const id2 = await h.start("other");
    await rm(path.join(h.root, id2, "wiki"), { recursive: true });
    await symlink(await tempDir(), path.join(h.root, id2, "wiki"));
    expect((await h.call("wiki_list", { sandbox_id: id2 })).isError).toBe(true);
  });

  it("counts [[X]] as citing raw/X only when no wiki page X exists", () => {
    const page = (title: string, type: string, body: string) => ({ title, file: "", parsed: parsePage(serializePage({ type, summary: "s" }, body)) });
    const pages = [page("Report", "entity", filler), page("Summary", "source", "See [[Report]].")];
    expect(citedSources(pages, ["Report"]).has("Report")).toBe(false);
    expect(citedSources([pages[1]], ["Report"]).has("Report")).toBe(true);
    expect(citedSources([page("S2", "source", "See [[raw/Report]].")], ["Report"]).has("Report")).toBe(true);
  });

  it("can change type and remove or replace sources", async () => {
    const h = await harness({ seed: { "A.md": "a", "B.md": "b" } });
    const id = await h.start();
    await h.call("wiki_create_page", { sandbox_id: id, title: "Gone", type: "entity", summary: "s", sources: ["A"], content: filler });
    await h.call("wiki_create_page", { sandbox_id: id, title: "P", type: "concept", summary: "s", sources: ["A", "Gone"], content: filler });
    await h.call("wiki_delete_page", { sandbox_id: id, title: "Gone", reason: "test" });
    expect((await h.call("wiki_lint", { sandbox_id: id })).text).toContain('remove_sources=["Gone"]');
    let r = await h.call("wiki_edit_page", { sandbox_id: id, title: "P", mode: "append", content: "", remove_sources: ["[[Gone]]"], type: "person" });
    expect(r.isError, r.text).toBe(false);
    let file = await readFile(path.join(h.root, id, "wiki", "P.md"), "utf8");
    expect(file).toContain("type: entity");
    expect(file).not.toContain("Gone");
    r = await h.call("wiki_edit_page", { sandbox_id: id, title: "P", mode: "replace_all", content: filler, sources: ["B"] });
    expect(r.isError, r.text).toBe(false);
    file = await readFile(path.join(h.root, id, "wiki", "P.md"), "utf8");
    expect(file).toContain('- "[[raw/B]]"');
    expect(file).not.toContain("raw/A");
  });

  it("takes over a stale process lock but not a live one", async () => {
    const root = await tempDir();
    await new WikiRoot(root).init();
    await writeFile(path.join(root, ".server.lock"), "999999");
    const release = await acquireProcessLock(root, 0);
    expect((await readFile(path.join(root, ".server.lock"), "utf8")).trim()).toBe(String(process.pid));
    await release();
    await writeFile(path.join(root, ".server.lock"), String(process.ppid));
    await expect(acquireProcessLock(root, 300)).rejects.toThrow(/already serving/);
    expect((await readFile(path.join(root, ".server.lock"), "utf8")).trim()).toBe(String(process.ppid));
  });

  it("leaves no temp files behind after adding a source", async () => {
    const h = await harness();
    const id = await h.start();
    await h.call("wiki_add_source", { sandbox_id: id, title: "N", content: "text" });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.join(h.root, id, "raw"))).toEqual(["N.md"]);
  });
});
