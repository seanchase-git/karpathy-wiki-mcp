import { promises as fs } from "node:fs";
import path from "node:path";
import { headings, parsePage, type Sandbox } from "./pages.js";

const STOP = new Set(
  "a an and are as at be but by for from has have he her his in is it its of on or she that the their them they this to was were which who will with what when where how why does did do".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Deliberately light stemming: plural/possessive endings only, so names stay intact. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export interface Chunk {
  label: string; // "Page Title" or "raw/Name"
  heading?: string;
  line: number; // 1-based line in the file
  text: string;
}

export interface Hit {
  chunk: Chunk;
  score: number;
  snippet: string;
}

/** Split a document into heading-sized chunks; line numbers are relative to the whole file. */
export function chunkDocument(label: string, fileText: string): Chunk[] {
  const parsed = parsePage(fileText);
  const body = parsed.body;
  const bodyLineOffset = fileText.slice(0, fileText.length - body.length).split("\n").length - 1;
  const lines = body.split("\n");
  const hs = headings(body).filter((h) => h.level <= 3);
  const starts = [0, ...hs.map((h) => h.line).filter((l) => l > 0)];
  const chunks: Chunk[] = [];
  const summary = typeof parsed.frontmatter.summary === "string" ? parsed.frontmatter.summary : "";
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    let text = lines.slice(start, end).join("\n");
    if (i === 0 && summary) text = `${summary}\n${text}`;
    if (!text.trim()) return;
    const h = hs.find((x) => x.line === start);
    chunks.push({ label, heading: h?.text, line: start + 1 + bodyLineOffset, text });
  });
  return chunks;
}

const K1 = 1.2;
const B = 0.75;

/** Okapi BM25 over chunks; the page title is added to every chunk's terms (weighted ×2). */
export function bm25(chunks: Chunk[], query: string, limit: number): Hit[] {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length || !chunks.length) return [];
  const docs = chunks.map((c) => {
    const title = tokenize(c.label.replace(/^raw\//, ""));
    const terms = [...tokenize(c.text), ...title, ...title];
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, len: terms.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const q of qTerms) df.set(q, docs.filter((d) => d.tf.has(q)).length);
  const N = docs.length;
  const hits: Hit[] = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const q of qTerms) {
      const f = d.tf.get(q);
      if (!f) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.len) / avg));
    }
    if (score > 0) hits.push({ chunk: chunks[i], score, snippet: snippet(chunks[i].text, qTerms) });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function snippet(text: string, qTerms: string[]): string {
  const q = new Set(qTerms);
  let best = "";
  let bestN = -1;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || /^#{1,6}\s/.test(l)) continue;
    const n = tokenize(l).filter((t) => q.has(t)).length;
    if (n > bestN) {
      best = l;
      bestN = n;
    }
  }
  return best.length > 220 ? best.slice(0, 217) + "..." : best;
}

export async function loadChunks(sb: Sandbox, scope: "wiki" | "raw" | "all"): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  if (scope !== "raw") {
    for (const t of await sb.pageTitles()) {
      chunks.push(...chunkDocument(t, await fs.readFile(path.join(sb.wikiDir, `${t}.md`), "utf8")));
    }
  }
  if (scope !== "wiki") {
    for (const s of await sb.sourceNames()) {
      chunks.push(...chunkDocument(`raw/${s}`, await fs.readFile(path.join(sb.rawDir, `${s}.md`), "utf8")));
    }
  }
  return chunks;
}
