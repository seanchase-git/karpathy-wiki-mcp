/**
 * End-to-end smoke test: spawn the built server over stdio (as LM Studio does), run
 * get_info → start → ingest one seed doc → search → lint → log, and check the files on disk.
 * Usage: npm run e2e
 */
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`E2E FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-e2e-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "dist", "index.js"), "--root", root, "--seed", path.join(repo, "seed")],
    stderr: "inherit",
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`${name} returned an error:\n${text}`);
    return text;
  };

  try {
    const { tools } = await client.listTools();
    check(tools.length === 12, `12 tools listed (${tools.length})`);
    check((await call("wiki_get_info")).includes("INGEST"), "wiki_get_info returns the manual");

    const start = await call("wiki_start", { model: "e2e-model" });
    const id = /sandbox_id: (\S+)/.exec(start)![1];
    const firstSource = /- raw\/(.+)/.exec(start)![1].trim();
    check(/^\d{8}-\d{6}-e2e-model$/.test(id), `sandbox id ${id}`);

    let offset: number | undefined = 0;
    let text = "";
    while (offset !== undefined) {
      const part = await call("wiki_read", { sandbox_id: id, name: `raw/${firstSource}`, offset });
      text += part;
      const m = /continue reading: .* offset=(\d+)/.exec(part);
      offset = m ? Number(m[1]) : undefined;
    }
    check(text.length > 500, `read raw/${firstSource} fully`);

    await call("wiki_create_page", {
      sandbox_id: id,
      title: `${firstSource} summary`,
      type: "source",
      summary: "E2E source summary.",
      sources: [`raw/${firstSource}`],
      content: `## Key points\n- See [[E2E Entity]].\n\n${"Filler text for length. ".repeat(12)}`,
    });
    const ent = await call("wiki_create_page", {
      sandbox_id: id,
      title: "E2E Entity",
      type: "entity",
      summary: "An entity created by the e2e test.",
      sources: [`raw/${firstSource}`],
      content: `## Overview\nMentioned in [[${firstSource} summary]].\n\n${"More filler text. ".repeat(15)}`,
    });
    check(!ent.includes("Missing links"), "no missing links after creating both pages");

    const patched = await call("wiki_edit_page", {
      sandbox_id: id, title: "E2E Entity", mode: "patch",
      edits: [{ old_text: "Mentioned in", new_text: "Described in" }],
    });
    check(patched.includes("patch (1 edit)"), "patch mode works over stdio");

    check((await call("wiki_search", { sandbox_id: id, query: "E2E entity" })).includes("1. E2E Entity"), "search finds the new page");
    const status = await call("wiki_status", { sandbox_id: id });
    check(status.includes(`raw/${firstSource} — ingested`), "status shows the source as ingested");
    const lint = await call("wiki_lint", { sandbox_id: id });
    check(lint.includes("uningested-source") && !lint.includes("broken-link"), "lint flags remaining sources, no broken links");
    await call("wiki_log", { sandbox_id: id, operation: "ingest", title: firstSource, details: "Created 2 pages." });

    const dir = path.join(root, id);
    const index = await readFile(path.join(dir, "index.md"), "utf8");
    check(index.includes("[[E2E Entity]] — An entity created by the e2e test."), "index.md lists the entity");
    const log = await readFile(path.join(dir, "log.md"), "utf8");
    check(/\] ingest \| /.test(log), "log.md has the agent's ingest entry");
    const page = await readFile(path.join(dir, "wiki", "E2E Entity.md"), "utf8");
    check(page.startsWith("---\ntitle: E2E Entity\ntype: entity\n"), "page frontmatter written by server");
    check(page.includes(`Described in [[${firstSource} summary]].`), "patch persisted the exact replacement");
    console.log(`\nE2E PASSED${process.env.KEEP_E2E === "1" ? ` (sandbox kept at ${dir})` : ""}`);
  } finally {
    await client.close();
    if (process.env.KEEP_E2E !== "1") await rm(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
