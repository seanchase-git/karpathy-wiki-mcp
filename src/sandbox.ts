import { promises as fs } from "node:fs";
import path from "node:path";
import { WikiError } from "./errors.js";
import { randomBytes } from "node:crypto";
import { assertNotSymlink, assertSize, atomicWrite, exists, MAX_FILE_BYTES, writeNewAtomic } from "./fsutil.js";
import { suggest } from "./fuzzy.js";
import { SCHEMA_MD } from "./guide.js";
import { appendLog, rebuildIndex } from "./indexlog.js";
import { Sandbox, sanitizeTitle } from "./pages.js";

export const ID_RE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9-]{0,55}$/;
const SEED_EXT = new Set([".md", ".txt"]);

export function slugifyModel(model: string): string {
  const s = model
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/@.*$/, "")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/\.gguf$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "unknown-model";
}

export function timestampId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface StartResult {
  sandbox: Sandbox;
  seeded: string[];
  skipped: string[];
}

/** Owns the wikis/ root: sandbox creation, lookup and per-sandbox write serialization. */
export class WikiRoot {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly root: string,
    readonly seedDir?: string,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const st = await fs.lstat(this.root);
    if (!st.isDirectory()) throw new Error(`WIKI_ROOT ${this.root} is not a directory`);
  }

  /** Serialize all mutations of one sandbox: LM Studio may run tool calls concurrently. */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }

  async listIds(): Promise<string[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && ID_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  }

  async create(model: string, now = new Date()): Promise<StartResult> {
    const base = `${timestampId(now)}-${slugifyModel(model)}`;
    let id = base;
    let dir = "";
    for (let n = 1; ; n++) {
      id = n === 1 ? base : `${base}-${n}`;
      dir = path.join(this.root, id);
      try {
        await fs.mkdir(dir); // non-recursive: fails with EEXIST instead of reusing a folder
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 50) throw e;
      }
    }
    const sb = new Sandbox(id, dir);
    await fs.mkdir(sb.rawDir);
    await fs.mkdir(sb.wikiDir);
    await atomicWrite(path.join(dir, "SCHEMA.md"), SCHEMA_MD);
    await atomicWrite(path.join(dir, "log.md"), `# Log\n\nAppend-only record of what happened in this wiki. Newest entries are at the bottom.\n`);
    const { seeded, skipped } = await this.seed(sb);
    await rebuildIndex(sb);
    await appendLog(sb, "start", `sandbox created for model "${model}"`, seeded.length ? `Seeded raw sources: ${seeded.join(", ")}` : undefined);
    return { sandbox: sb, seeded, skipped };
  }

  /** Copy regular .md/.txt files from the seed folder into raw/. Symlinks and oversize files are skipped. */
  private async seed(sb: Sandbox): Promise<{ seeded: string[]; skipped: string[] }> {
    const seeded: string[] = [];
    const skipped: string[] = [];
    if (!this.seedDir) return { seeded, skipped };
    let entries;
    try {
      entries = await fs.readdir(this.seedDir, { withFileTypes: true });
    } catch (e) {
      process.stderr.write(`[karpathy-wiki-mcp] seed dir unreadable (${this.seedDir}): ${(e as Error).message}\n`);
      return { seeded, skipped };
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const ext = path.extname(e.name).toLowerCase();
      if (!e.isFile() || !SEED_EXT.has(ext) || e.name.startsWith(".")) {
        if (!e.name.startsWith(".")) skipped.push(e.name);
        continue;
      }
      const src = path.join(this.seedDir, e.name);
      const st = await fs.lstat(src);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) {
        skipped.push(e.name);
        continue;
      }
      let name: string;
      try {
        name = sanitizeTitle(e.name.slice(0, -ext.length));
      } catch {
        skipped.push(e.name);
        continue;
      }
      const dest = await sb.sourcePath(name);
      if (await exists(dest)) {
        skipped.push(e.name);
        continue;
      }
      const text = await fs.readFile(src, "utf8");
      assertSize(text, `Seed file ${e.name}`);
      await writeNewAtomic(dest, text);
      seeded.push(name);
    }
    return { seeded, skipped };
  }

  /** Look up an existing sandbox, tolerating quotes, paths and case. */
  async open(input: unknown): Promise<Sandbox> {
    const raw = typeof input === "string" ? input : "";
    const id = path
      .basename(raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[\\/]+$/, ""))
      .toLowerCase();
    if (!id) {
      throw new WikiError(
        "sandbox_id is missing.",
        "Pass the sandbox_id that wiki_start returned. If you have none yet, call wiki_start first.",
        'wiki_status sandbox_id="20261018-143005-my-model"',
      );
    }
    const recent = async () => (await this.listIds()).slice(0, 5);
    if (!ID_RE.test(id)) {
      const ids = await recent();
      throw new WikiError(
        `"${raw}" is not a valid sandbox_id. Ids look like 20261018-143005-my-model.`,
        ids.length ? `Recent sandboxes: ${ids.join(", ")}. Or call wiki_start to create a new one.` : "Call wiki_start to create a sandbox.",
      );
    }
    const dir = path.join(this.root, id);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      st = undefined;
    }
    if (!st?.isDirectory()) {
      const all = await this.listIds();
      const near = suggest(id, all);
      throw new WikiError(
        `Sandbox "${id}" does not exist.`,
        near.length
          ? `Did you mean: ${near.join(", ")}?`
          : all.length
            ? `Recent sandboxes: ${all.slice(0, 5).join(", ")}. Or call wiki_start to create a new one.`
            : "No sandboxes exist yet. Call wiki_start to create one.",
      );
    }
    const sb = new Sandbox(id, dir);
    // Every bulk read/append goes through these; refuse a sandbox whose structure was swapped for symlinks.
    await Promise.all([
      assertNotSymlink(sb.rawDir, "dir"),
      assertNotSymlink(sb.wikiDir, "dir"),
      assertNotSymlink(path.join(dir, "log.md"), "file"),
      assertNotSymlink(path.join(dir, "index.md"), "file"),
      assertNotSymlink(path.join(dir, "SCHEMA.md"), "file"),
    ]);
    return sb;
  }
}

/**
 * Single-process guard for a WIKI_ROOT. The lock file is created atomically *with* its pid
 * (staged temp file + hard link), so a reader never sees an empty lock. A stale lock (dead pid)
 * is taken over by renaming it aside and re-checking that the moved file is the stale one; if a
 * fresh lock was moved by mistake it is linked back. A live holder gets `waitMs` to exit
 * (LM Studio restarts can briefly overlap).
 */
export async function acquireProcessLock(root: string, waitMs = 3000): Promise<() => Promise<void>> {
  const lock = path.join(root, ".server.lock");
  const me = String(process.pid);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const tmp = `${lock}.${me}-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, me, { flag: "wx" });
    try {
      await fs.link(tmp, lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await fs.rm(tmp, { force: true });
    }
    const holder = (await fs.readFile(lock, "utf8").catch(() => "")).trim();
    if (!holder) continue; // removed between our link attempt and read: retry
    const pid = Number(holder);
    if (pid && pid !== process.pid && isAlive(pid)) {
      if (Date.now() > deadline) {
        throw new Error(`Another karpathy-wiki-mcp process (pid ${pid}) is already serving ${root}. Only one server per WIKI_ROOT is supported.`);
      }
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const aside = `${lock}.stale-${me}-${randomBytes(4).toString("hex")}`;
    try {
      await fs.rename(lock, aside);
    } catch {
      continue; // someone else moved it first
    }
    const moved = (await fs.readFile(aside, "utf8").catch(() => "")).trim();
    if (moved !== holder) await fs.link(aside, lock).catch(() => undefined); // not the stale lock: put it back
    await fs.rm(aside, { force: true });
  }
  return async () => {
    const owner = (await fs.readFile(lock, "utf8").catch(() => "")).trim();
    if (owner === me) await fs.rm(lock, { force: true });
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
