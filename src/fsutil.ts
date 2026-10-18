import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WikiError } from "./errors.js";

/** Max bytes for a single page or raw source. */
export const MAX_FILE_BYTES = 100 * 1024;

/**
 * Resolve `rel` under `base` and refuse anything that escapes it or passes through a
 * symlink (checked with lstat on every existing component below `base`).
 */
export async function safePath(base: string, rel: string): Promise<string> {
  const root = path.resolve(base);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new WikiError(`Path "${rel}" is outside the sandbox.`, "Use a plain page title or raw/<name>.");
  }
  let cur = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw e;
    }
    if (st.isSymbolicLink()) throw new WikiError(`Path "${rel}" goes through a symlink, which is not allowed.`);
  }
  return target;
}

/** Write via temp file + fsync + rename so a crash never leaves a half-written file. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Create a file that must not already exist, atomically: stage + fsync a temp file, then
 * hard-link it into place (link fails with EEXIST instead of replacing), then drop the temp.
 */
export async function writeNewAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Throw if `p` exists and is a symlink (or not the expected kind). */
export async function assertNotSymlink(p: string, kind: "file" | "dir"): Promise<void> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) {
    throw new WikiError(`${path.basename(p)} in this sandbox is not a regular ${kind === "dir" ? "folder" : "file"}; the sandbox looks tampered with.`);
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Regular `.md` files directly inside `dir` (symlinks and subfolders ignored), sorted. */
export async function listMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function assertSize(s: string, what: string): void {
  const n = byteLength(s);
  if (n > MAX_FILE_BYTES) {
    throw new WikiError(
      `${what} is ${Math.round(n / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB.`,
      "Split it into several smaller pages, or add the rest with wiki_edit_page mode=append.",
    );
  }
}
