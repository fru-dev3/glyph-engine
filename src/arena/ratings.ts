// Ratings: Bradley-Terry over every pairwise game in every run, per area, with a
// bootstrap 95% interval (items resampled, since the games of one item are not
// independent). A verdict is "clear" only when the interval on the leader's lead
// excludes a tie; otherwise "close" and the pick is the cheaper model.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Game } from "./jury.ts";
import { isLocalModel, readModels, type ModelDef } from "./models.ts";
import { isHomeOnlyTask } from "./privacy.ts";
import { arenaDir, file, readConfig, readJson, readLines, writeJson } from "./store.ts";
import { listSuites, type Suite } from "./suites.ts";

export interface RunCell {
  output_ref?: string; tokens?: number; cost?: number; latency_ms?: number; cli?: string; cli_version?: string; model?: string;
  scores?: { score?: number; won?: boolean; [k: string]: unknown };
  status?: string; error?: string; cached?: boolean;
}

export interface RunFile {
  id: string;
  suite: string;
  started: string;
  ended?: string;
  models: string[];
  status: "running" | "done" | "budget" | "limited" | "error" | "stopped";
  cost_usd: number;
  budget_usd?: number;
  by_item: Record<string, Record<string, RunCell>>;
  games: Game[];
  notes?: string[];
}

export interface RatedModel { model: string; label: string; rate: number; lo: number; hi: number; games: number; cost_usd: number; latency_ms: number; allowed: boolean; p_lead?: number }
export interface RatedArea { area: string; suite: string; verdict: "clear" | "likely" | "close" | "home_only" | "none"; models: RatedModel[]; note?: string }
export interface RatingsFile { updated: string; overall: { leader: string; areas_led: number; areas: number }; areas: RatedArea[] }

export interface Pair { a: string; b: string; w: number; cluster: string }

/** Bradley-Terry strengths by minorization-maximization. A half-weight pseudo-tie between
 * every pair keeps a perfect record finite. */
export function btFit(models: string[], games: Pair[], iters = 200): Record<string, number> {
  const p: Record<string, number> = Object.fromEntries(models.map((m) => [m, 1]));
  const W: Record<string, number> = Object.fromEntries(models.map((m) => [m, 0]));
  const n = new Map<string, number>();
  const key = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  const add = (a: string, b: string, wa: number, c: number) => {
    W[a]! += wa; W[b]! += c - wa;
    n.set(key(a, b), (n.get(key(a, b)) ?? 0) + c);
  };
  for (const g of games) add(g.a, g.b, g.w, 1);
  for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) add(models[i]!, models[j]!, 0.25, 0.5);
  for (let it = 0; it < iters; it++) {
    const next: Record<string, number> = {};
    for (const i of models) {
      let d = 0;
      for (const j of models) if (j !== i) d += (n.get(key(i, j)) ?? 0) / (p[i]! + p[j]!);
      next[i] = d > 0 ? W[i]! / d : p[i]!;
    }
    const gm = Math.exp(models.reduce((s, m) => s + Math.log(next[m]!), 0) / models.length);
    for (const m of models) p[m] = next[m]! / gm;
  }
  return p;
}

/** Win share against the field: the mean chance of beating each other model, 0..1. */
export function shares(p: Record<string, number>): Record<string, number> {
  const ms = Object.keys(p);
  return Object.fromEntries(ms.map((i) => [i, ms.length < 2 ? 0.5 : ms.filter((j) => j !== i).reduce((s, j) => s + p[i]! / (p[i]! + p[j]!), 0) / (ms.length - 1)]));
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? 0;
};

export interface Fit { rate: Record<string, number>; lo: Record<string, number>; hi: Record<string, number>; leader: string; p_lead: number; lead_lo: number; lead_lo80: number }

export function fitArea(models: string[], games: Pair[], boots = 300, seed = 7): Fit {
  const p = btFit(models, games);
  const rate = shares(p);
  const order = [...models].sort((x, y) => rate[y]! - rate[x]! || x.localeCompare(y));
  const [L, R] = [order[0]!, order[1]];
  const clusters = new Map<string, Pair[]>();
  for (const g of games) (clusters.get(g.cluster) ?? clusters.set(g.cluster, []).get(g.cluster)!).push(g);
  const keys = [...clusters.keys()];
  const rand = rng(seed);
  const samples: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
  const leads: number[] = [];
  for (let b = 0; b < boots && keys.length; b++) {
    const g: Pair[] = [];
    for (let k = 0; k < keys.length; k++) g.push(...clusters.get(keys[Math.floor(rand() * keys.length)]!)!);
    const pb = btFit(models, g, 60);
    const rb = shares(pb);
    for (const m of models) samples[m]!.push(rb[m]!);
    if (R) leads.push(Math.log(pb[L]! / pb[R]!));
  }
  const lo: Record<string, number> = {}, hi: Record<string, number> = {};
  for (const m of models) { lo[m] = samples[m]!.length ? pct(samples[m]!, 0.025) : rate[m]!; hi[m] = samples[m]!.length ? pct(samples[m]!, 0.975) : rate[m]!; }
  return {
    rate, lo, hi, leader: L,
    p_lead: leads.length ? leads.filter((x) => x > 0).length / leads.length : 0,
    lead_lo: leads.length ? pct(leads, 0.025) : 0,
    lead_lo80: leads.length ? pct(leads, 0.1) : 0,
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function listRuns(vault: string): RunFile[] {
  const d = join(arenaDir(vault), "runs");
  if (!existsSync(d)) return [];
  return readdirSync(d).sort()
    .map((n) => readJson<RunFile | null>(join(d, n, "run.json"), null))
    .filter((r): r is RunFile => !!r && !!r.id);
}

interface MediaPick { ts: string; run: string; item: string; winner: string; shown: string[] }

/** Every game for a suite: the runs' judged games, plus blind picks on its media. */
export function suiteGames(runs: RunFile[], picks: MediaPick[], suiteId: string): Pair[] {
  const out: Pair[] = [];
  const mine = runs.filter((r) => r.suite === suiteId);
  for (const r of mine) for (const g of r.games ?? []) out.push({ a: g.a, b: g.b, w: g.winner === "a" ? 1 : g.winner === "b" ? 0 : 0.5, cluster: `${r.id}/${g.item}` });
  const ids = new Set(mine.map((r) => r.id));
  for (const pk of picks) {
    if (!ids.has(pk.run) || pk.winner === "none") continue;
    const shown = (pk.shown ?? []).filter(Boolean);
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
      const [x, y] = [shown[i]!, shown[j]!];
      const w = pk.winner === "tie" ? 0.5 : pk.winner === x ? 1 : pk.winner === y ? 0 : null;
      if (w !== null) out.push({ a: x, b: y, w, cluster: `${pk.run}/${pk.item}` });
    }
  }
  return out;
}

export function computeRatings(vault: string, now = new Date().toISOString()): RatingsFile {
  const cfg = readConfig(vault);
  const defs = new Map(readModels(vault).map((m) => [m.id, m]));
  const runs = listRuns(vault);
  const picks = readLines<MediaPick>(file(vault, "picks-media.jsonl"));
  const byArea = new Map<string, Suite[]>();
  for (const s of listSuites(vault)) (byArea.get(s.area) ?? byArea.set(s.area, []).get(s.area)!).push(s);
  const areas: RatedArea[] = [];
  for (const [area, suites] of [...byArea].sort((x, y) => x[0].localeCompare(y[0]))) {
    const games: Pair[] = [];
    const cost = new Map<string, number[]>();
    const ms = new Map<string, number[]>();
    const seen = new Set<string>();
    const blocked = new Set<string>();
    const refused = new Set<string>();
    for (const s of suites) {
      games.push(...suiteGames(runs, picks, s.id));
      const home = isHomeOnlyTask({ domain: s.domain ?? "", prompt: s.items.map((i) => i.prompt ?? "").join(" ") }, cfg);
      for (const r of runs.filter((x) => x.suite === s.id)) {
        for (const cells of Object.values(r.by_item)) for (const [m, c] of Object.entries(cells)) {
          if (c.status === "privacy") { refused.add(m); continue; }
          if (!c.output_ref) continue;
          seen.add(m);
          if (typeof c.cost === "number") (cost.get(m) ?? cost.set(m, []).get(m)!).push(c.cost);
          if (typeof c.latency_ms === "number") (ms.get(m) ?? ms.set(m, []).get(m)!).push(c.latency_ms);
        }
      }
      if (home) for (const m of seen) if (defs.get(m) && !isLocalModel(defs.get(m)!, cfg)) blocked.add(m);
    }
    // refused on some items but answering others: still a player. Refused everywhere: out.
    for (const m of refused) if (!seen.has(m)) blocked.add(m);
    const models = [...new Set([...seen, ...blocked])];
    const mean = (x?: number[]) => (x?.length ? x.reduce((p, c) => p + c, 0) / x.length : 0);
    const name = (m: string) => defs.get(m)?.label ?? m;
    const suite = [...suites].sort((x, y) => suiteGames(runs, picks, y.id).length - suiteGames(runs, picks, x.id).length)[0]!.id;
    const homeArea = suites.some((s) => isHomeOnlyTask({ domain: s.domain ?? "", prompt: "" }, cfg));
    const playable = models.filter((m) => !blocked.has(m));
    if (!games.length || playable.length < 2) {
      areas.push({ area, suite, verdict: homeArea && playable.length ? "home_only" : "none", models: models.map((m) => ({ model: m, label: name(m), rate: 0.5, lo: 0, hi: 1, games: 0, cost_usd: r4(mean(cost.get(m))), latency_ms: Math.round(mean(ms.get(m))), allowed: !blocked.has(m) })) });
      continue;
    }
    const fit = fitArea(playable, games);
    const n = (m: string) => games.filter((g) => g.a === m || g.b === m).length;
    const rated: RatedModel[] = playable.map((m) => ({ model: m, label: name(m), rate: r3(fit.rate[m]!), lo: r3(fit.lo[m]!), hi: r3(fit.hi[m]!), games: n(m), cost_usd: r4(mean(cost.get(m))), latency_ms: Math.round(mean(ms.get(m))), allowed: true }))
      .sort((x, y) => y.rate - x.rate || x.cost_usd - y.cost_usd);
    rated[0]!.p_lead = r3(fit.p_lead);
    for (const m of blocked) if (!playable.includes(m)) rated.push({ model: m, label: name(m), rate: 0, lo: 0, hi: 0, games: 0, cost_usd: r4(mean(cost.get(m))), latency_ms: 0, allowed: false });
    const verdict = homeArea ? "home_only" : fit.lead_lo > 0 ? "clear" : fit.lead_lo80 > 0 ? "likely" : "close";
    areas.push({ area, suite, verdict, models: rated, ...(verdict === "close" ? { note: "too close to call: use the cheaper" } : {}) });
  }
  const led = new Map<string, number>();
  const sum = new Map<string, number[]>();
  for (const a of areas) {
    const top = a.models.find((m) => m.allowed && m.games > 0);
    if (top) led.set(top.model, (led.get(top.model) ?? 0) + 1);
    for (const m of a.models) if (m.allowed && m.games > 0) (sum.get(m.model) ?? sum.set(m.model, []).get(m.model)!).push(m.rate);
  }
  const avg = (m: string) => (sum.get(m) ?? [0]).reduce((p, c) => p + c, 0) / (sum.get(m)?.length || 1);
  const leader = [...sum.keys()].sort((x, y) => (led.get(y) ?? 0) - (led.get(x) ?? 0) || avg(y) - avg(x))[0] ?? "";
  const out: RatingsFile = { updated: now, overall: { leader, areas_led: led.get(leader) ?? 0, areas: areas.length }, areas };
  writeJson(file(vault, "ratings.json"), out);
  return out;
}

export interface PickAnswer { area: string; model: string | null; label?: string; verdict: string; why: string; alternatives: string[] }

/** The model to use for an area: the leader when it is clear, else the cheapest whose interval still overlaps the leader's. */
export function pickModel(ratings: RatingsFile | null, area: string): PickAnswer {
  const a = ratings?.areas.find((x) => x.area.toLowerCase() === area.toLowerCase() || x.suite === area);
  if (!a) return { area, model: null, verdict: "none", why: `no ratings for "${area}" yet`, alternatives: [] };
  const ok = a.models.filter((m) => m.allowed && m.games > 0);
  if (!ok.length) return { area, model: null, verdict: a.verdict, why: "no model has played here yet", alternatives: [] };
  const lead = ok[0]!;
  if (a.verdict === "clear" || a.verdict === "likely" || a.verdict === "home_only" || ok.length === 1) return { area, model: lead.model, label: lead.label, verdict: a.verdict, why: `${lead.label} leads with ${Math.round(lead.rate * 100)}%`, alternatives: ok.slice(1, 3).map((m) => m.model) };
  const close = ok.filter((m) => m.hi >= lead.lo).sort((x, y) => x.cost_usd - y.cost_usd || y.rate - x.rate);
  const cheap = close[0]!;
  return { area, model: cheap.model, label: cheap.label, verdict: "close", why: `too close to call between ${close.map((m) => m.label).join(", ")}: the cheaper one, ${cheap.label}`, alternatives: close.slice(1).map((m) => m.model) };
}
