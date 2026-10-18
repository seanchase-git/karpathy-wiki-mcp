/** Levenshtein distance with a two-row table: O(a*b) time, O(min(a,b)) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Up to `limit` candidates that plausibly match `query`, best first. A candidate qualifies
 * when one contains the other or the edit distance is under 40% of the longer string.
 */
export function suggest(query: string, candidates: readonly string[], limit = 3): string[] {
  const q = normalizeForMatch(query);
  if (!q) return [];
  const scored: { c: string; score: number }[] = [];
  for (const c of candidates) {
    const n = normalizeForMatch(c);
    if (!n) continue;
    let score: number;
    if (n === q) score = 0;
    else if (n.includes(q) || q.includes(n)) score = 0.1 + Math.abs(n.length - q.length) / Math.max(n.length, q.length) / 10;
    else {
      const longer = Math.max(n.length, q.length);
      if (Math.abs(n.length - q.length) / longer > 0.4) continue;
      score = levenshtein(n, q) / longer;
      if (score > 0.4) continue;
    }
    scored.push({ c, score });
  }
  scored.sort((x, y) => x.score - y.score || x.c.localeCompare(y.c));
  return scored.slice(0, limit).map((s) => s.c);
}
