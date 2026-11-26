// Scoring two answers to one item. Order of trust: a mechanical check, then a jury of
// two judge models from other families than both contestants, each asked in both
// orders (an answer that wins in one order and loses in the other is a tie), with the
// item's rubric scored in the same call. A hard_fail line that trips zeroes the answer.
import { LimitError, type CallRecord } from "./adapters.ts";
import { familyOf, type ModelDef } from "./models.ts";
import type { RubricLine, SuiteItem } from "./suites.ts";

export type By = "check" | "identical" | "hard_fail" | "jury" | "wer" | "pick";

export interface Game {
  item: string;
  a: string;
  b: string;
  winner: "a" | "b" | "tie";
  by: By;
  /** rubric score 0..1 for each side (mean over the judge calls), when a jury ran */
  sa?: number;
  sb?: number;
  judges?: string[];
  votes?: { a: number; b: number; tie: number };
  /** how many judges changed their answer when the order flipped */
  flips?: number;
  cost_usd?: number;
}

/** A rubric score: points of the met criteria over the points on offer, 0..1; zeroed by a tripped hard_fail.
 * For a hard_fail line, negative points mean "met = tripped" (a forbidden behaviour);
 * positive points mean "not met = tripped" (a must-have). */
export function rubricScore(rubric: RubricLine[], met: Set<string>, ids: string[]): { score: number; zeroed: boolean } {
  let possible = 0;
  let got = 0;
  let zeroed = false;
  rubric.forEach((r, i) => {
    const m = met.has(ids[i]!);
    if (r.points > 0) possible += r.points;
    if (m) got += r.points;
    if (r.type === "hard_fail" && ((r.points < 0 && m) || (r.points > 0 && !m))) zeroed = true;
  });
  if (zeroed) return { score: 0, zeroed };
  if (possible <= 0) return { score: 1, zeroed };
  return { score: Math.max(0, Math.min(1, got / possible)), zeroed };
}

const critId = (i: number) => `c${i + 1}`;

export function judgePrompt(item: SuiteItem, first: string, second: string): string {
  const rubric = (item.rubric ?? []).map((r, i) => `${critId(i)} [${r.type}, ${r.points > 0 ? "+" : ""}${r.points}]: ${r.criterion}`).join("\n");
  const facts = (item.reference_facts ?? []).map((f) => `- ${f}`).join("\n");
  return [
    "You are a strict, impartial judge comparing two answers to the same task. Judge only what is written; ignore length and style unless the task asks for them.",
    "",
    `TASK:\n${item.prompt ?? ""}`,
    facts ? `\nFACTS THAT ARE TRUE:\n${facts}` : "",
    rubric ? `\nRUBRIC (a line describing bad behaviour is met when the answer does it):\n${rubric}` : "",
    `\nANSWER 1:\n${first.slice(0, 6000)}`,
    `\nANSWER 2:\n${second.slice(0, 6000)}`,
    "",
    `Reply with ONLY one JSON object: {"first":{"met":[<rubric ids met by answer 1>]},"second":{"met":[<ids met by answer 2>]},"better":"first"|"second"|"tie"}`,
  ].filter((x) => x !== "").join("\n");
}

export interface Verdict { first: Set<string>; second: Set<string>; better: "first" | "second" | "tie" }

export function parseVerdict(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { first?: { met?: unknown[] }; second?: { met?: unknown[] }; better?: string };
    const better = String(j.better ?? "").toLowerCase();
    if (!["first", "second", "tie"].includes(better)) return null;
    const set = (x?: { met?: unknown[] }) => new Set((Array.isArray(x?.met) ? x!.met : []).map(String));
    return { first: set(j.first), second: set(j.second), better: better as Verdict["better"] };
  } catch {
    return null;
  }
}

/** Two judges, from two families when there are two to be had, neither from a contestant's family.
 * `preferred` (model ids) goes first, then the cheapest. */
export function pickJury(pool: ModelDef[], a: ModelDef, b: ModelDef, preferred: string[] = [], n = 2, needLocal?: (m: ModelDef) => boolean): ModelDef[] {
  const banned = new Set([familyOf(a), familyOf(b)]);
  const ok = pool.filter((m) => m.kind === "text" && !banned.has(familyOf(m)) && (!needLocal || needLocal(m)));
  const rank = (m: ModelDef) => {
    const p = preferred.indexOf(m.id);
    return p >= 0 ? p : 100 + (m.local ? 1 : 0);
  };
  ok.sort((x, y) => rank(x) - rank(y) || x.id.localeCompare(y.id));
  const out: ModelDef[] = [];
  for (const m of ok) if (out.length < n && !out.some((o) => familyOf(o) === familyOf(m))) out.push(m);
  for (const m of ok) if (out.length < n && !out.includes(m)) out.push(m);
  return out;
}

export interface JuryResult { game: Pick<Game, "winner" | "by" | "sa" | "sb" | "judges" | "votes" | "flips">; cost: number; failed: string[] }

/** The jury's verdict on one pair. `ask` makes one judge call (the runner wraps budget and Home Only around it). */
export async function judgePair(
  item: SuiteItem,
  textA: string,
  textB: string,
  jury: ModelDef[],
  ask: (judge: ModelDef, prompt: string) => Promise<CallRecord>,
): Promise<JuryResult> {
  const rubric = item.rubric ?? [];
  const ids = rubric.map((_, i) => critId(i));
  const votes = { a: 0, b: 0, tie: 0 };
  const scoresA: number[] = [];
  const scoresB: number[] = [];
  const zeroA: boolean[] = [];
  const zeroB: boolean[] = [];
  let flips = 0;
  let cost = 0;
  const used: string[] = [];
  const failed: string[] = [];
  for (const j of jury) {
    const orders: ("ab" | "ba")[] = ["ab", "ba"];
    const said: ("a" | "b" | "tie")[] = [];
    for (const o of orders) {
      const [first, second] = o === "ab" ? [textA, textB] : [textB, textA];
      let v: Verdict | null = null;
      for (let t = 0; t < 2 && !v; t++) {
        let rec: CallRecord;
        try { rec = await ask(j, judgePrompt(item, first, second)); } catch (e) {
          if (e instanceof LimitError) throw e;
          failed.push(`${j.id}: ${(e as Error).message.slice(0, 120)}`);
          break;
        }
        cost += rec.cost_estimate;
        v = parseVerdict(rec.text);
      }
      if (!v) { if (!failed.length || !failed[failed.length - 1]!.startsWith(j.id)) failed.push(`${j.id}: unreadable verdict`); continue; }
      const sFirst = rubricScore(rubric, v.first, ids);
      const sSecond = rubricScore(rubric, v.second, ids);
      const [sa, sb] = o === "ab" ? [sFirst, sSecond] : [sSecond, sFirst];
      scoresA.push(sa.score); scoresB.push(sb.score); zeroA.push(sa.zeroed); zeroB.push(sb.zeroed);
      const better = v.better === "tie" ? "tie" : (v.better === "first") === (o === "ab") ? "a" : "b";
      said.push(better);
    }
    if (said.length === 2) {
      // both orders: agree = that vote, flip = tie
      if (said[0] === said[1]) votes[said[0]!]++;
      else { votes.tie++; flips++; }
      used.push(j.id);
    } else if (said.length === 1) { votes[said[0]!]++; used.push(j.id); }
  }
  const mean = (x: number[]) => (x.length ? Math.round((x.reduce((p, c) => p + c, 0) / x.length) * 1000) / 1000 : undefined);
  const sa = mean(scoresA);
  const sb = mean(scoresB);
  const half = (z: boolean[]) => z.length > 0 && z.filter(Boolean).length * 2 > z.length;
  const hfA = half(zeroA);
  const hfB = half(zeroB);
  const base = { sa, sb, judges: used, votes, flips };
  if (!used.length) return { game: { winner: "tie", by: "jury", ...base }, cost, failed };
  // a gotcha failure zeroes the item: that decides it before the vote
  if (hfA !== hfB) return { game: { winner: hfA ? "b" : "a", by: "hard_fail", ...base }, cost, failed };
  const winner = votes.a > votes.b ? "a" : votes.b > votes.a ? "b" : "tie";
  return { game: { winner, by: "jury", ...base }, cost, failed };
}
