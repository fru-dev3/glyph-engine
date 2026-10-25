// The routing policy: what Studio follows. Built from the duels, picks, signals and
// the adverse-event register; written atomically to build/_meta/arena/policy.json
// with a readable twin, policy.md. lookupRoute is what any harness calls.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runtimePath } from "../path-safety.ts";
import { vreadFile } from "../vault-session.ts";
import { isSuspended } from "./adverse.ts";
import { isHomeOnlyTask, isLocalRecipe } from "./privacy.ts";
import { equivalent, headToHead, inLeague, standings, unblinding } from "./score.ts";
import type { ArenaConfig, Duel, League, Policy, PolicyRoute, Recipe, Signal, Suspension, TaskKind, Weight } from "./types.ts";

export const POLICY_SCHEMA = "glyph-arena/policy@1" as const;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: number) => (x < 0.001 ? "free" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);

export interface BuildInput {
  duels: Duel[];
  signals: Signal[];
  recipes: Recipe[];
  suspended: Suspension[];
  config: ArenaConfig;
  spent: number;
  month: string;
  now?: number;
  generator?: string;
}

/** Leagues worth a route: every league seen, plus its kind-wide and domain-wide parents. */
function candidateLeagues(duels: Duel[]): League[] {
  const keys = new Set<string>();
  for (const d of duels) {
    const { domain, kind, weight } = d.league;
    for (const l of [
      { domain, kind, weight },
      { domain, kind, weight: "*" },
      { domain, kind: "*", weight: "*" },
      { domain: "*", kind, weight },
      { domain: "*", kind, weight: "*" },
    ]) keys.add(`${l.domain}|${l.kind}|${l.weight}`);
  }
  return [...keys].map((k) => {
    const [domain, kind, weight] = k.split("|") as [string, TaskKind | "*", Weight | "*"];
    return { domain, kind, weight };
  });
}

export function buildPolicy(inp: BuildInput): Policy {
  const now = inp.now ?? Date.now();
  const byId = new Map(inp.recipes.map((r) => [r.id, r]));
  const modelOf = (id: string) => byId.get(id)?.model ?? id;
  const routes: PolicyRoute[] = [];

  for (const league of candidateLeagues(inp.duels)) {
    const duels = inp.duels.filter((d) => inLeague(d, league));
    const sigs = inp.signals.filter((s) =>
      (league.domain === "*" || s.domain === league.domain)
      && (league.kind === "*" || !s.kind || s.kind === league.kind)
      && (league.weight === "*" || !s.weight || s.weight === league.weight));
    const homeOnly = league.domain !== "*" && isHomeOnlyTask({ domain: league.domain, prompt: "" }, inp.config);
    const table = standings(duels, sigs, modelOf).filter((s) => {
      const r = byId.get(s.recipe);
      if (!r) return false;
      if (league.domain !== "*" && isSuspended(r.model, league.domain, inp.suspended)) return false;
      if (league.domain === "*" && isSuspended(r.model, "*", inp.suspended)) return false;
      if (homeOnly && !isLocalRecipe(r, inp.config)) return false;
      return s.games >= inp.config.min_games;
    });
    if (table.length === 0) continue;

    // Equivalent, use the cheaper: among the leader and every recipe whose head to
    // head with it is inside the tie band, the cheapest takes the route.
    const leaderRow = table[0]!;
    const peers = table.filter((s) => s.recipe === leaderRow.recipe || equivalent(headToHead(duels, leaderRow.recipe, s.recipe), inp.config.min_games));
    const pick = [...peers].sort((a, b) => a.cost_avg - b.cost_avg)[0]!;
    const priciest = [...peers].sort((a, b) => b.cost_avg - a.cost_avg)[0]!;
    let verdict: PolicyRoute["verdict"] = homeOnly ? "home_only" : "best";
    let why = "";
    if (peers.length > 1 && priciest.cost_avg > pick.cost_avg) {
      const other = priciest;
      const h = headToHead(duels, pick.recipe, other.recipe);
      const ratio = pick.cost_avg > 0 ? other.cost_avg / pick.cost_avg : Infinity;
      why = `Equivalent to ${byId.get(other.recipe)?.label ?? other.recipe} (${h.x}-${h.y}, ${h.ties} even in ${h.games} meetings) and ${
        Number.isFinite(ratio) ? `${ratio.toFixed(ratio < 10 ? 1 : 0)}x cheaper` : "free"
      }, so the cheaper one takes the route.`;
      verdict = homeOnly ? "home_only" : "equivalent_cheaper";
    }
    const r = byId.get(pick.recipe)!;
    const runner = table.find((s) => s.recipe !== pick.recipe);
    if (!why) {
      const rec = `${pick.wins}-${pick.losses}-${pick.ties}`;
      why = `${r.label} leads with ${rec} (${pct(pick.rate)} of points) over ${pick.games} games`
        + (runner ? `; next is ${byId.get(runner.recipe)?.label ?? runner.recipe} at ${pct(runner.rate)}` : "")
        + `; ${money(pick.cost_avg)} an answer.`;
    }
    if (homeOnly) why = `Home Only: local models only. ${why}`;
    if (pick.games < inp.config.min_games * 2 && verdict === "best") verdict = "provisional";

    routes.push({
      domain: league.domain,
      kind: league.kind,
      weight: league.weight,
      recipe: r.id,
      cli: r.cli,
      model: r.model,
      ...(r.baseUrl ? { base_url: r.baseUrl } : {}),
      prompt: r.prompt,
      context: r.context,
      tools: r.tools,
      verdict,
      why,
      confidence: Math.round(Math.min(0.99, pick.lower + Math.min(0.3, pick.games / 100)) * 100) / 100,
      games: pick.games,
      ...(runner ? { runner_up: runner.recipe } : {}),
      updated_at: new Date(now).toISOString(),
    });
  }

  routes.sort((a, b) => a.domain.localeCompare(b.domain) || a.kind.localeCompare(b.kind) || a.weight.localeCompare(b.weight));
  const routed = (d: Duel) => lookupRoute({ routes } as Policy, d.league.domain, d.league.kind as TaskKind, d.league.weight as Weight)?.recipe ?? null;
  return {
    schema: POLICY_SCHEMA,
    generated_at: new Date(now).toISOString(),
    generator: inp.generator ?? "Glyph Arena",
    routes,
    suspended: inp.suspended,
    home_only: inp.config.home_only,
    budget: { month: inp.month, cap_usd: inp.config.monthly_cap_usd, spent_usd: Math.round(inp.spent * 100) / 100 },
    unblinding: unblinding(inp.duels, routed),
  };
}

/** Most specific route first; "*" is a wildcard. */
export function lookupRoute(policy: Pick<Policy, "routes"> & Partial<Pick<Policy, "suspended">>, domain: string, kind: TaskKind, weight: Weight): PolicyRoute | null {
  const benched = (r: PolicyRoute) => (policy.suspended ?? []).some((s) => s.model === r.model && (s.domain === "*" || s.domain === domain));
  const order: [string, string, string][] = [
    [domain, kind, weight],
    [domain, kind, "*"],
    [domain, "*", "*"],
    ["*", kind, weight],
    ["*", kind, "*"],
    ["*", "*", "*"],
  ];
  for (const [d, k, w] of order) {
    const hit = policy.routes.find((r) => r.domain === d && r.kind === k && r.weight === w && !benched(r));
    if (hit) return hit;
  }
  return null;
}

export function policyMarkdown(p: Policy): string {
  const L: string[] = ["# Routing policy", "", `Written by ${p.generator} at ${p.generated_at}. Studio's Auto router follows it.`, ""];
  if (p.routes.length === 0) L.push("No routes yet: run a few duels and blind picks first.", "");
  for (const r of p.routes) {
    const where = [r.domain === "*" ? "any domain" : r.domain, r.kind === "*" ? "any task" : r.kind.replace("_", " "), r.weight === "*" ? "any weight" : r.weight].join(" / ");
    L.push(`## ${where}: ${r.recipe}`, "", `${r.cli} ${r.model}, prompt ${r.prompt}, context ${r.context}, tools ${r.tools}. Verdict: ${r.verdict.replace("_", " ")}, confidence ${pct(r.confidence)}.`, "", r.why, "");
  }
  if (p.suspended.length) {
    L.push("## Suspended", "");
    for (const s of p.suspended) L.push(`- ${s.model} in ${s.domain === "*" ? "every domain" : s.domain} until ${s.until}: ${s.why}`);
    L.push("");
  }
  L.push(`Budget ${p.budget.month}: $${p.budget.spent_usd.toFixed(2)} of $${p.budget.cap_usd.toFixed(2)}.`);
  return `${L.join("\n")}\n`;
}

export function policyPath(vault: string): string {
  return join(runtimePath(vault, "_meta"), "arena", "policy.json");
}

/** Read the policy without creating anything (safe on every chat turn). */
export function readPolicy(vault: string): Policy | null {
  const p = policyPath(vault);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(vreadFile(p)) as Policy;
    return v && v.schema === POLICY_SCHEMA && Array.isArray(v.routes) ? v : null;
  } catch {
    return null;
  }
}
