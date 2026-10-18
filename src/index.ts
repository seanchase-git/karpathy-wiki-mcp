#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { acquireProcessLock, WikiRoot } from "./sandbox.js";
import { createServer, repairIndexes } from "./server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "karpathy-wiki-mcp [--root DIR] [--seed DIR|none] [--lmstudio-url URL]\n" +
        "  env: WIKI_ROOT (default <repo>/wikis), WIKI_SEED_DIR (default <repo>/seed; 'none' disables), WIKI_LMSTUDIO_URL (default http://127.0.0.1:1234)\n",
    );
    return;
  }
  const root = path.resolve(arg("root") ?? process.env.WIKI_ROOT ?? path.join(repoRoot, "wikis"));
  const seedOpt = arg("seed") ?? process.env.WIKI_SEED_DIR;
  const defaultSeed = path.join(repoRoot, "seed");
  const seedDir = seedOpt === "none" ? undefined : seedOpt ? path.resolve(seedOpt) : existsSync(defaultSeed) ? defaultSeed : undefined;
  const lmstudioUrl = arg("lmstudio-url") ?? process.env.WIKI_LMSTUDIO_URL ?? "http://127.0.0.1:1234";

  const wikis = new WikiRoot(root, seedDir);
  await wikis.init();
  const release = await acquireProcessLock(root);
  const shutdown = async () => {
    await release().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await repairIndexes(wikis);
  const server = createServer({ root, seedDir, lmstudioUrl }, wikis);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[karpathy-wiki-mcp] serving ${root}${seedDir ? ` (seed: ${seedDir})` : ""}\n`);
}

main().catch((e) => {
  process.stderr.write(`[karpathy-wiki-mcp] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
