// Scoring: agreement between two answers, standings per league, and the
// "equivalent, use the cheaper" test. Pure functions; the tests pin them down.
import type { Duel, League, Signal, Standing } from "./types.ts";

const STOP = new Set(
  "a an and are as at be but by can do for from has have i if in into is it its of on or so that the their then there these this to was we were will with you your not no yes".split(" "),
);

function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/```[\s\S]*?```/g, " ").match(/[a-z0-9$%.']+/g) ?? []) {
    const t = w.replace(/^[.']+|[.']+$/g, "");
    if (t.length > 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

/** Content-word overlap, 0..1 (Jaccard). Two empty answers are not "agreeing". */
export function similarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return Math.round((inter / (x.size + y.size - inter)) * 1000) / 1000;
}

/** Above this overlap two answers say the same thing: a tie, no human needed. */
export const AGREE_AT = 0.6;

/** Wilson score lower bound (95%). Small samples are pulled toward zero. */
export function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

export function inLeague(d: { league: League }, l: League): boolean {
  return (l.domain === "*" || d.league.domain === l.domain)
    && (l.kind === "*" || d.league.kind === l.kind)
    && (l.weight === "*" || d.league.weight === l.weight);
}

export const decided = (d: Duel) => d.outcome === "a" || d.outcome === "b" || d.outcome === "tie";

/** Standings for the duels given (already filtered to a league), best first. */
export function standings(duels: Duel[], signals: Signal[] = [], modelOf: (recipe: string) => string = (r) => r): Standing[] {
  const s = new Map<string, { w: number; l: number; t: number; cost: number; ms: number; n: number }>();
  const row = (id: string) => {
    let r = s.get(id);
    if (!r) { r = { w: 0, l: 0, t: 0, cost: 0, ms: 0, n: 0 }; s.set(id, r); }
    return r;
  };
  for (const d of duels) {
    for (const side of [d.a, d.b]) {
      if (!side.ok) continue;
      const r = row(side.recipe);
      r.cost += side.cost_usd;
      r.ms += side.ms;
      r.n++;
    }
    if (!decided(d)) continue;
    const A = row(d.a.recipe);
    const B = row(d.b.recipe);
    if (d.outcome === "a") { A.w++; B.l++; }
    else if (d.outcome === "b") { B.w++; A.l++; }
    else { A.t++; B.t++; }
  }
  // Shadow signals: a revert is a loss for the model that was routed; accept a win.
  for (const sig of signals) {
    for (const [id] of s) {
      if (modelOf(id) !== sig.model) continue;
      const r = row(id);
      if (sig.signal === "accept") r.w++;
      else if (sig.signal === "revert") r.l++;
      else r.t++;
    }
  }
  const out: Standing[] = [];
  for (const [recipe, r] of s) {
    const games = r.w + r.l + r.t;
    const score = r.w + r.t / 2;
    out.push({
      recipe,
      wins: r.w,
      losses: r.l,
      ties: r.t,
      games,
      rate: games ? Math.round((score / games) * 1000) / 1000 : 0,
      lower: Math.round(wilsonLower(score, games) * 1000) / 1000,
      cost_avg: r.n ? r.cost / r.n : 0,
      ms_avg: r.n ? Math.round(r.ms / r.n) : 0,
    });
  }
  return out.sort((x, y) => y.lower - x.lower || y.rate - x.rate || x.cost_avg - y.cost_avg || x.recipe.localeCompare(y.recipe));
}

/** Head to head between two recipes in these duels. */
export function headToHead(duels: Duel[], x: string, y: string): { x: number; y: number; ties: number; games: number } {
  const h = { x: 0, y: 0, ties: 0, games: 0 };
  for (const d of duels) {
    if (!decided(d)) continue;
    const ids = [d.a.recipe, d.b.recipe];
    if (!(ids.includes(x) && ids.includes(y))) continue;
    h.games++;
    if (d.outcome === "tie") { h.ties++; continue; }
    const winner = d.outcome === "a" ? d.a.recipe : d.b.recipe;
    if (winner === x) h.x++;
    else h.y++;
  }
  return h;
}

/**
 * Is the cheaper recipe as good as the leader? Yes when they have met at least
 * minGames times and the leader's share of the points is inside the tie band
 * (40-60%), or most of their meetings were agreements.
 */
export function equivalent(h: { x: number; y: number; ties: number; games: number }, minGames: number): boolean {
  if (h.games < minGames) return false;
  if (h.ties / h.games >= 0.5) return true;
  const share = (h.x + h.ties / 2) / h.games;
  return share >= 0.4 && share <= 0.6;
}

/** Unblinding score: how often the blind winner is the recipe the policy already routes. */
export function unblinding(duels: Duel[], routedFor: (d: Duel) => string | null): { picks: number; agree: number; score: number | null } {
  let picks = 0;
  let agree = 0;
  for (const d of duels) {
    if (d.decided_by !== "pick" || !d.pick || d.pick.winner === "tie") continue;
    const routed = routedFor(d);
    if (!routed) continue;
    picks++;
    const winner = d.pick.winner === "a" ? d.a.recipe : d.b.recipe;
    if (winner === routed) agree++;
  }
  return { picks, agree, score: picks ? Math.round((agree / picks) * 100) / 100 : null };
}
