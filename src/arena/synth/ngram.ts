// Overlap with the real source: longest shared run of tokens (must stay under 13) and
// a similarity score (cosine of content words and word pairs, no model needed).
export const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9$%']+/g) ?? [];

/** Longest common contiguous token run between two texts. */
export function longestShared(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return 0;
  let best = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) { cur[j] = prev[j - 1]! + 1; if (cur[j]! > best) best = cur[j]!; }
    }
    prev = cur;
  }
  return best;
}

const STOP = new Set("that this with from have your about what when which would could should there their been into than then them they will just like also some more most only over such each very much many where while does did doing being those these because before after again once here both other same make made need want give take tell show please".split(" "));
/** content words and their neighbours: topic overlap, not letter overlap */
function grams(s: string): Map<string, number> {
  const t = tokens(s).filter((w) => w.length >= 4 && !STOP.has(w) && !/^[0-9$%,.]+$/.test(w));
  const m = new Map<string, number>();
  const add = (g: string) => m.set(g, (m.get(g) ?? 0) + 1);
  t.forEach((w, i) => { add(w); if (i > 0) add(`${t[i - 1]} ${w}`); });
  return m;
}

export function similarity(a: string, b: string): number {
  const x = grams(a), y = grams(b);
  let dot = 0, nx = 0, ny = 0;
  for (const [g, c] of x) { nx += c * c; const d = y.get(g); if (d) dot += c * d; }
  for (const c of y.values()) ny += c * c;
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

/** Similarity to the closest line or paragraph of a longer source, so a big note file does not dilute a copy. */
export function closestSimilarity(text: string, source: string): number {
  let best = similarity(text, source);
  for (const chunk of source.split(/\n+/)) if (chunk.trim().length >= 20) best = Math.max(best, similarity(text, chunk));
  return best;
}
