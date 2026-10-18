import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WikiRoot } from "../src/sandbox.js";
import { createServer } from "../src/server.js";

export async function tempDir(prefix = "wiki-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function makeSeed(files: Record<string, string>): Promise<string> {
  const dir = await tempDir("wiki-seed-");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

export interface Harness {
  root: string;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  start: (model?: string) => Promise<string>;
}

export async function harness(opts: { seed?: Record<string, string>; fetchImpl?: typeof fetch } = {}): Promise<Harness> {
  const root = await tempDir();
  const seedDir = opts.seed ? await makeSeed(opts.seed) : undefined;
  const wikis = new WikiRoot(root, seedDir);
  await wikis.init();
  const server = createServer({ root, seedDir, lmstudioUrl: "http://127.0.0.1:9", fetchImpl: opts.fetchImpl }, wikis);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  const start = async (model = "test-model") => {
    const r = await call("wiki_start", { model });
    const m = /sandbox_id: (\S+)/.exec(r.text);
    if (!m) throw new Error(`wiki_start failed: ${r.text}`);
    return m[1];
  };
  return { root, client, call, start };
}
