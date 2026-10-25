// Arena operations the app and the CLI share: blind picks, flags, signals,
// sentinels, scouting, the policy rebuild and the status snapshot.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detectSubprocessClis } from "../cli-bridge.ts";
import { readModelSuggestions, scoutModels } from "../model-scout.ts";
import { DOMAINS_DIR, dataRoot, runtimePath } from "../path-safety.ts";
import { readRouteOverrides } from "../route-learning.ts";
import { vwriteFileAtomic } from "../vault-session.ts";
import { currentSuspensions, recordAdverse } from "./adverse.ts";
import { monthKey, monthSpend } from "./budget.ts";
import { isLocalRecipe } from "./privacy.ts";
import { buildPolicy, lookupRoute, policyMarkdown, readPolicy } from "./policy.ts";
import { makeRecipe, ollamaModels } from "./recipes.ts";
import { answerOne, engineCall, type Caller } from "./run.ts";
import { decided, inLeague, standings } from "./score.ts";
import { appendDuel, appendLine, file, readAdverse, readConfig, readDuels, readLines, readPicks, readRecipes, readSignals, writeJson } from "./store.ts";
import { SENTINELS } from "./tasks.ts";
import type { AdverseEvent, Duel, League, Policy, Recipe, Severity, Signal, TaskKind, Weight } from "./types.ts";

export const ARENA_GENERATOR = "Glyph Arena 0.1.0";

/** Shadow signals: the user's own, plus Studio's "pick a different model" overrides as reverts. */
export function allSignals(vault: string): Signal[] {
  const own = readSignals(vault);
  let overrides: ReturnType<typeof readRouteOverrides> = [];
  try { overrides = readRouteOverrides(vault); } catch { overrides = []; }
  const fromStudio: Signal[] = overrides.map((o) => ({
    ts: o.ts,
    domain: o.domain || "general",
    weight: (o.band === "light" ? "light" : o.band === "hard" ? "heavy" : "middle") as Weight,
    model: o.fromModel,
    signal: "revert",
    to_model: o.toModel,
    source: "studio-override",
  }));
  return [...own, ...fromStudio];
}

export function rebuildPolicy(vault: string, now = Date.now()): Policy {
  const config = readConfig(vault);
  const policy = buildPolicy({
    duels: readDuels(vault),
    signals: allSignals(vault),
    recipes: readRecipes(vault),
    suspended: currentSuspensions(vault, now),
    config,
    spent: monthSpend(vault, now),
    month: monthKey(now),
    now,
    generator: ARENA_GENERATOR,
  });
  writeJson(file(vault, "policy.json"), policy);
  vwriteFileAtomic(file(vault, "policy.md"), policyMarkdown(policy));
  return policy;
}

// ---- blind picks -----------------------------------------------------------

export interface BlindCard {
  duel: string;
  league: League;
  prompt: string;
  left: "a" | "b";
  left_text: string;
  right_text: string;
  queue: number;
}

/** The next duel waiting for a pick, with sides shuffled. Names are withheld until the pick. */
export function nextPick(vault: string, rand = Math.random): BlindCard | null {
  const pending = readDuels(vault).filter((d) => d.outcome === "pending");
  if (pending.length === 0) return null;
  const d = pending[0]!;
  const left: "a" | "b" = rand() < 0.5 ? "a" : "b";
  const L = left === "a" ? d.a : d.b;
  const R = left === "a" ? d.b : d.a;
  return { duel: d.id, league: d.league, prompt: d.task.prompt, left, left_text: L.reply, right_text: R.reply, queue: pending.length };
}

export interface Reveal {
  duel: string;
  winner: string | null;
  loser: string | null;
  tie: boolean;
  a: { recipe: string; label: string; cost_usd: number; ms: number };
  b: { recipe: string; label: string; cost_usd: number; ms: number };
  routed: string | null;
  agrees_with_policy: boolean | null;
  unblinding: Policy["unblinding"];
}

export function submitPick(vault: string, duelId: string, choice: "left" | "right" | "tie", left: "a" | "b", ms: number): Reveal {
  const d = readDuels(vault).find((x) => x.id === duelId);
  if (!d) throw new Error(`no duel ${duelId}`);
  if (d.outcome !== "pending") throw new Error(`duel ${duelId} is already decided (${d.outcome})`);
  const winner: "a" | "b" | "tie" = choice === "tie" ? "tie" : choice === "left" ? left : left === "a" ? "b" : "a";
  const ts = Date.now();
  // The policy before this pick: the unblinding score compares against it.
  const before = readPolicy(vault);
  const routed = before ? lookupRoute(before, d.league.domain, d.league.kind as TaskKind, d.league.weight as Weight)?.recipe ?? null : null;
  appendLine(file(vault, "picks.jsonl"), { ts, duel: d.id, winner, left, ms: Math.max(0, Math.round(ms)) });
  const next: Duel = { ...d, outcome: winner, decided_by: "pick", pick: { winner, ms: Math.max(0, Math.round(ms)), left, ts } };
  appendDuel(vault, next);
  const policy = rebuildPolicy(vault);
  const recipes = new Map(readRecipes(vault).map((r) => [r.id, r]));
  const lab = (id: string) => recipes.get(id)?.label ?? id;
  const w = winner === "tie" ? null : winner === "a" ? d.a.recipe : d.b.recipe;
  const l = winner === "tie" ? null : winner === "a" ? d.b.recipe : d.a.recipe;
  return {
    duel: d.id,
    winner: w,
    loser: l,
    tie: winner === "tie",
    a: { recipe: d.a.recipe, label: lab(d.a.recipe), cost_usd: d.a.cost_usd, ms: d.a.ms },
    b: { recipe: d.b.recipe, label: lab(d.b.recipe), cost_usd: d.b.cost_usd, ms: d.b.ms },
    routed,
    agrees_with_policy: routed && w ? routed === w : null,
    unblinding: policy.unblinding,
  };
}

/** Flag one side of a duel in the adverse-event register. */
export function flagDuel(vault: string, duelId: string, side: "a" | "b", kind: AdverseEvent["kind"], severity: Severity, what: string): AdverseEvent {
  const d = readDuels(vault).find((x) => x.id === duelId);
  if (!d) throw new Error(`no duel ${duelId}`);
  const r = readRecipes(vault).find((x) => x.id === (side === "a" ? d.a.recipe : d.b.recipe));
  const ev = recordAdverse(vault, { model: r?.model ?? d[side].recipe, domain: d.league.domain === "*" ? "*" : d.league.domain, severity, kind, what, source: "pick", duel: d.id });
  rebuildPolicy(vault);
  return ev;
}

export function recordSignal(vault: string, s: Omit<Signal, "ts"> & { ts?: number }): Signal {
  if (!["accept", "edit", "revert"].includes(s.signal)) throw new Error("signal must be accept, edit or revert");
  if (!s.model) throw new Error("signal needs a model");
  const sig: Signal = { ...s, ts: s.ts ?? Date.now() };
  appendLine(file(vault, "signals.jsonl"), sig);
  return sig;
}

// ---- sentinels ---------------------------------------------------------------

interface SentinelLine { ts: number; recipe: string; model: string; task: string; pass: boolean; detail: string }

export function sentinelDue(vault: string, now = Date.now()): boolean {
  const lines = readLines<SentinelLine>(file(vault, "sentinel.jsonl"));
  if (lines.length === 0) return true;
  const last = Math.max(...lines.map((l) => l.ts));
  const days = (now - last) / 86_400_000;
  return days >= 7 || (days >= 6 && new Date(now).getDay() === readConfig(vault).sentinel_day);
}

/** Run the six sentinels on the given recipes (default: every routed recipe). A pass that turns into a fail is a regression. */
export async function runSentinels(vault: string, recipeIds?: string[], opts: { call?: Caller; onProgress?: (e: { done: number; total: number; note?: string }) => void } = {}) {
  const recipes = readRecipes(vault);
  const policy = readPolicy(vault);
  const ids = recipeIds?.length ? recipeIds : [...new Set((policy?.routes ?? []).map((r) => r.recipe))];
  const chosen = recipes.filter((r) => ids.includes(r.id));
  const prior = readLines<SentinelLine>(file(vault, "sentinel.jsonl"));
  const lastFor = (recipe: string, task: string) =>
    prior.filter((l) => l.recipe === recipe && l.task === task).sort((a, b) => b.ts - a.ts)[0];
  const results: SentinelLine[] = [];
  const regressions: AdverseEvent[] = [];
  const total = chosen.length * SENTINELS.length;
  let done = 0;
  const cfg = readConfig(vault);
  for (const r of chosen) {
    for (const t of SENTINELS) {
      const side = await answerOne(vault, t, r, cfg, opts.call ?? engineCall);
      done++;
      if (!side.ok) { opts.onProgress?.({ done, total, note: `${r.label}: ${side.status} ${side.error ?? ""}` }); continue; }
      const line: SentinelLine = { ts: Date.now(), recipe: r.id, model: r.model, task: t.id, pass: !!side.check?.pass, detail: side.check?.detail ?? "" };
      const was = lastFor(r.id, t.id);
      appendLine(file(vault, "sentinel.jsonl"), line);
      results.push(line);
      if (was?.pass && !line.pass) {
        regressions.push(recordAdverse(vault, { model: r.model, domain: "*", severity: "major", kind: "regression", what: `sentinel ${t.id} passed before, now fails: ${line.detail}`, source: "sentinel" }));
      }
      opts.onProgress?.({ done, total });
    }
  }
  if (regressions.length) rebuildPolicy(vault);
  return { results, regressions };
}

// ---- scouting ------------------------------------------------------------------

export interface Scouted { cli: string; model: string; base_url?: string; label: string; why: string; source: "local" | "web" }

/** Challengers worth a duel: local models not yet tested, and the web scout's list. */
export async function scouted(vault: string): Promise<Scouted[]> {
  const cfg = readConfig(vault);
  const have = new Set(readRecipes(vault).map((r) => `${r.cli}|${r.model}|${r.baseUrl ?? ""}`));
  const out: Scouted[] = [];
  for (const url of cfg.home_endpoints) {
    for (const m of await ollamaModels(url)) {
      if (have.has(`ollama|${m}|${url}`)) continue;
      let host = url;
      try { host = new URL(url).hostname; } catch { /* keep */ }
      out.push({ cli: "ollama", model: m, base_url: url, label: m, why: `installed on ${host}, not tested yet`, source: "local" });
    }
  }
  for (const s of readModelSuggestions(vault)?.items ?? []) {
    out.push({ cli: s.kind === "open" ? "openrouter" : "", model: s.name, label: s.name, why: `${s.provider}: ${s.reason}`, source: "web" });
  }
  return out;
}

/** Overnight scouting: the engine's web Model Scout, then a short note the morning brief can read. */
export async function scoutWeb(vault: string): Promise<number> {
  const claude = detectSubprocessClis().find((c) => c.kind === "claude");
  if (!claude) throw new Error("web scouting needs the claude CLI");
  const known = readRecipes(vault).map((r) => r.model);
  const items = await scoutModels({ vault, cli: claude, model: "claude-haiku-4-5", known });
  const lines = ["# Arena scout", "", `New models worth a duel (${new Date().toISOString().slice(0, 10)}):`, ""];
  for (const s of items) lines.push(`- ${s.name} (${s.provider}, ${s.kind}): ${s.reason}`);
  vwriteFileAtomic(file(vault, "scout.md"), `${lines.join("\n")}\n`);
  return items.length;
}

export function addScouted(vault: string, s: Scouted): Recipe {
  const r = makeRecipe({ cli: s.cli, model: s.model, baseUrl: s.base_url, source: "scout" });
  const list = readRecipes(vault).filter((x) => x.id !== r.id);
  list.push(r);
  writeJson(file(vault, "recipes.json"), list);
  return r;
}

// ---- status ----------------------------------------------------------------------

export function leagueTable(vault: string, league: League) {
  const recipes = readRecipes(vault);
  const modelOf = (id: string) => recipes.find((r) => r.id === id)?.model ?? id;
  const duels = readDuels(vault).filter((d) => inLeague(d, league));
  const sigs = allSignals(vault).filter((s) => (league.domain === "*" || s.domain === league.domain));
  return { league, standings: standings(duels, sigs, modelOf), duels: duels.length };
}

/** The vault's life domains (folder names), for the league pickers. */
export function vaultDomains(vault: string): string[] {
  try {
    return readdirSync(join(dataRoot(vault), DOMAINS_DIR), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function status(vault: string) {
  const cfg = readConfig(vault);
  const duels = readDuels(vault);
  const recipes = readRecipes(vault);
  const policy = readPolicy(vault);
  const leagues = new Map<string, { league: League; duels: number; decided: number; pending: number }>();
  for (const d of duels) {
    const k = `${d.league.domain}|${d.league.kind}|${d.league.weight}`;
    const row = leagues.get(k) ?? { league: d.league, duels: 0, decided: 0, pending: 0 };
    row.duels++;
    if (decided(d)) row.decided++;
    if (d.outcome === "pending") row.pending++;
    leagues.set(k, row);
  }
  return {
    vault_ok: existsSync(vault),
    arena_dir: file(vault, ""),
    generator: ARENA_GENERATOR,
    config: cfg,
    recipes,
    home_recipes: recipes.filter((r) => isLocalRecipe(r, cfg)).map((r) => r.id),
    policy,
    budget: { month: monthKey(), cap_usd: cfg.monthly_cap_usd, spent_usd: monthSpend(vault) },
    counts: {
      duels: duels.length,
      decided: duels.filter(decided).length,
      pending: duels.filter((d) => d.outcome === "pending").length,
      errors: duels.filter((d) => d.outcome === "error").length,
      picks: readPicks(vault).length,
      adverse: readAdverse(vault).length,
    },
    leagues: [...leagues.values()].sort((a, b) => b.duels - a.duels),
    suspended: currentSuspensions(vault),
    sentinel_due: sentinelDue(vault),
    domains: vaultDomains(vault),
    studio_policy_path: join(runtimePath(vault, "_meta"), "arena", "policy.json"),
  };
}
