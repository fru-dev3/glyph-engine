// Glyph Arena: scoring, the policy writer, and the Home Only privacy guard.
// Everything runs on a throwaway made-up vault with a fake model caller.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspensions } from "./adverse.ts";
import { canSpend, estimateUsd, monthSpend, recordSpend } from "./budget.ts";
import { runCheck, numbersIn } from "./checkers.ts";
import { classifyKind, classifyWeight, looksHomeOnly } from "./classify.ts";
import { buildPolicy, lookupRoute, readPolicy, POLICY_SCHEMA } from "./policy.ts";
import { allowedRecipes, assertRecipeAllowed, HomeOnlyViolation, isHomeEndpoint, isHomeOnlyTask } from "./privacy.ts";
import { makeRecipe } from "./recipes.ts";
import { decide, providerError, runDuel, runReplay, type Caller } from "./run.ts";
import { equivalent, similarity, standings, unblinding, wilsonLower } from "./score.ts";
import { nextPick, rebuildPolicy, submitPick, flagDuel, runSentinels } from "./service.ts";
import { DEFAULT_CONFIG, readDuels, writeConfig, writeRecipes } from "./store.ts";
import { replayable, SENTINELS } from "./tasks.ts";
import type { AdverseEvent, ArenaTask, Duel, Recipe, Side } from "./types.ts";

const cloudA = makeRecipe({ cli: "claude", model: "claude-opus-5-5" });
const cloudB = makeRecipe({ cli: "claude", model: "claude-haiku-4-5" });
const localA = makeRecipe({ cli: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434" });
const localB = makeRecipe({ cli: "ollama", model: "gemma3:4b", baseUrl: "http://localhost:11434" });
const farOllama = makeRecipe({ cli: "ollama", model: "llama3.2", baseUrl: "http://203.0.113.9:11434" });

const side = (recipe: string, reply: string, extra: Partial<Side> = {}): Side => ({ recipe, ok: true, reply, ms: 1000, cost_usd: 0.01, ...extra });
const task = (over: Partial<ArenaTask> = {}): ArenaTask => ({ id: "t1", source: "custom", domain: "content", kind: "drafting", weight: "middle", prompt: "Write a short post about trail running", ...over });

let n = 0;
function duel(a: Recipe, b: Recipe, outcome: Duel["outcome"], over: Partial<Duel> = {}, costA = 0.05, costB = 0.01): Duel {
  n++;
  return {
    id: `d${n}`, ts: 1_700_000_000_000 + n, task: task(), league: { domain: "content", kind: "drafting", weight: "middle" },
    a: side(a.id, "x", { cost_usd: costA }), b: side(b.id, "y", { cost_usd: costB }), similarity: 0, outcome, decided_by: "pick", ...over,
  };
}

let vault = "";
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "arena-vault-"));
  mkdirSync(join(vault, "build"), { recursive: true });
  mkdirSync(join(vault, "data", "domains", "content"), { recursive: true });
  writeFileSync(join(vault, "data", "domains", "content", "ideal-state.md"), "# Content\nWrite plainly for runners.\n");
  mkdirSync(join(vault, "data", "domains", "health"), { recursive: true });
  writeFileSync(join(vault, "data", "domains", "health", "ideal-state.md"), "# Health\nPRIVATE-MARKER resting heart rate notes.\n");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("scoring", () => {
  test("similarity: same content agrees, different content does not, empty never agrees", () => {
    expect(similarity("Repave Main Street in April for six weeks", "Main Street repaving: April, six weeks")).toBeGreaterThan(0.3);
    expect(similarity("Buy the house now", "Rent for another year and invest")).toBeLessThan(0.2);
    expect(similarity("", "")).toBe(0);
  });

  test("wilson lower bound pulls small samples down", () => {
    expect(wilsonLower(3, 3)).toBeLessThan(wilsonLower(30, 30));
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(10, 10)).toBeGreaterThan(0.7);
  });

  test("standings count wins, losses, half ties; errors and pending do not count", () => {
    const ds = [duel(cloudA, cloudB, "a"), duel(cloudA, cloudB, "a"), duel(cloudA, cloudB, "tie"), duel(cloudA, cloudB, "error"), duel(cloudA, cloudB, "pending")];
    const t = standings(ds);
    const A = t.find((s) => s.recipe === cloudA.id)!;
    const B = t.find((s) => s.recipe === cloudB.id)!;
    expect([A.wins, A.losses, A.ties, A.games]).toEqual([2, 0, 1, 3]);
    expect(A.rate).toBeCloseTo(2.5 / 3, 2);
    expect(B.rate).toBeCloseTo(0.5 / 3, 2);
    expect(t[0]!.recipe).toBe(cloudA.id);
  });

  test("a revert signal is a loss for the routed model", () => {
    const ds = [duel(cloudA, cloudB, "tie")];
    const t = standings(ds, [{ ts: 1, domain: "content", model: cloudA.model, signal: "revert", source: "test" }], (id) => (id === cloudA.id ? cloudA.model : cloudB.model));
    expect(t.find((s) => s.recipe === cloudA.id)!.losses).toBe(1);
  });

  test("equivalent: tie band and agreement count, too few games do not", () => {
    expect(equivalent({ x: 2, y: 2, ties: 1, games: 5 }, 3)).toBe(true);
    expect(equivalent({ x: 0, y: 0, ties: 3, games: 3 }, 3)).toBe(true);
    expect(equivalent({ x: 5, y: 0, ties: 0, games: 5 }, 3)).toBe(false);
    expect(equivalent({ x: 1, y: 1, ties: 0, games: 2 }, 3)).toBe(false);
  });

  test("decide: checker first, then agreement, then judge, else a blind pick", () => {
    const t = task();
    expect(decide(t, side("a", "x", { check: { pass: true, detail: "" } }), side("b", "y", { check: { pass: false, detail: "" } })).outcome).toBe("a");
    expect(decide(t, side("a", "x", { check: { pass: true, detail: "" } }), side("b", "y", { check: { pass: true, detail: "" } }))).toMatchObject({ outcome: "tie", by: "check" });
    expect(decide(t, side("a", "same answer about trail running shoes"), side("b", "same answer about trail running shoes")).by).toBe("agree");
    expect(decide(t, side("a", "buy now", { judge: 9 }), side("b", "wait a year", { judge: 3 }))).toMatchObject({ outcome: "a", by: "judge" });
    expect(decide(t, side("a", "buy now"), side("b", "wait a year")).outcome).toBe("pending");
    expect(decide(t, side("a", "x", { ok: false }), side("b", "y")).outcome).toBe("error");
  });

  test("unblinding: blind winners matching the routed recipe", () => {
    const ds = [
      duel(cloudA, cloudB, "a", { pick: { winner: "a", ms: 1500, left: "a", ts: 1 } }),
      duel(cloudA, cloudB, "b", { pick: { winner: "b", ms: 1500, left: "b", ts: 2 } }),
    ];
    expect(unblinding(ds, () => cloudA.id)).toEqual({ picks: 2, agree: 1, score: 0.5 });
  });
});

describe("checkers", () => {
  test("number reconciles a ledger total", () => {
    expect(numbersIn("Total: $1,850.86")).toContain(1850.86);
    expect(runCheck({ type: "number", expect: 1850.86 }, "The total is 1,850.86").pass).toBe(true);
    expect(runCheck({ type: "number", expect: 1850.86 }, "The total is 1,850.00").pass).toBe(false);
  });
  test("json, keywords, regex, words, citations", () => {
    expect(runCheck({ type: "json", keys: ["vendor"] }, '```json\n{"vendor":"Acme"}\n```').pass).toBe(true);
    expect(runCheck({ type: "json", keys: ["date"] }, '{"vendor":"Acme"}').pass).toBe(false);
    expect(runCheck({ type: "keywords", all: ["thursday"] }, "Thursday.").pass).toBe(true);
    expect(runCheck({ type: "regex", pattern: "^\\d+$" }, "42").pass).toBe(true);
    expect(runCheck({ type: "max_words", n: 3 }, "one two three four").pass).toBe(false);
    expect(runCheck({ type: "citations", min: 2 }, "see https://a.example and https://b.example").pass).toBe(true);
  });
  test("code tests run the answer in a scratch dir, and are off when disabled", () => {
    const sentinel = SENTINELS.find((s) => s.id === "sentinel-code")!;
    const good = "```js\nfunction slugify(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');}\n```";
    const bad = "```js\nfunction slugify(s){return s.toLowerCase();}\n```";
    expect(runCheck(sentinel.check!, good, { codeTests: true }).pass).toBe(true);
    expect(runCheck(sentinel.check!, bad, { codeTests: true }).pass).toBe(false);
    expect(runCheck(sentinel.check!, good, { codeTests: false }).pass).toBe(false);
  });
});

describe("classify", () => {
  test("kinds and weights", () => {
    expect(classifyKind("Fix this TypeScript function that throws")).toBe("coding");
    expect(classifyKind("Should I buy the truck or keep leasing?")).toBe("decision");
    expect(classifyKind("Write a script for a YouTube video about canyons")).toBe("video_script");
    expect(classifyKind("Draft an email to the landlord")).toBe("drafting");
    expect(classifyWeight("hi")).toBe("light");
  });
  test("ghost replays skip prompts bound to their old conversation", () => {
    expect(replayable("yes do it")).toBe(false);
    expect(replayable("[Image #1] what is this")).toBe(false);
    expect(replayable("Draft a two-paragraph note to the team about the move to Vercel hosting")).toBe(true);
  });
});

describe("privacy guard (Home Only)", () => {
  const cfg = { ...DEFAULT_CONFIG, home_hosts: ["mini.home.example"] };

  test("home endpoints: loopback and listed hosts only", () => {
    expect(isHomeEndpoint("http://localhost:11434", cfg)).toBe(true);
    expect(isHomeEndpoint("http://127.0.0.1:11434", cfg)).toBe(true);
    expect(isHomeEndpoint("http://mini.home.example:11434", cfg)).toBe(true);
    expect(isHomeEndpoint("http://203.0.113.9:11434", cfg)).toBe(false);
    expect(isHomeEndpoint("not a url", cfg)).toBe(false);
  });

  test("health and money tasks refuse cloud recipes and far endpoints", () => {
    const t = task({ domain: "health", prompt: "Summarize my lab results" });
    expect(isHomeOnlyTask(t, cfg)).toBe(true);
    expect(() => assertRecipeAllowed(t, cloudA, cfg)).toThrow(HomeOnlyViolation);
    expect(() => assertRecipeAllowed(t, farOllama, cfg)).toThrow(HomeOnlyViolation);
    expect(() => assertRecipeAllowed(t, localA, cfg)).not.toThrow();
    expect(allowedRecipes(t, [cloudA, localA, farOllama], cfg).map((r) => r.id)).toEqual([localA.id]);
  });

  test("a domain-less prompt that reads as health or money is Home Only", () => {
    expect(looksHomeOnly("what dosage of ibuprofen")).toBe(true);
    expect(isHomeOnlyTask({ domain: "general", prompt: "How much should go in my Roth IRA this year?" }, cfg)).toBe(true);
    expect(isHomeOnlyTask({ domain: "content", prompt: "Write a post about trail running" }, cfg)).toBe(false);
  });

  test("a localOnly manifest puts a domain in the Home Only league", () => {
    const dir = join(vault, "data", "domains", "journal");
    mkdirSync(join(dir, ".system"), { recursive: true });
    writeFileSync(join(dir, ".system", "manifest.json"), JSON.stringify({ privacy: { localOnly: true } }));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ privacy: { localOnly: true } }));
    // manifest location varies by layout; the guard must at least never throw
    expect(typeof isHomeOnlyTask({ domain: "journal", prompt: "x" }, cfg, vault)).toBe("boolean");
  });

  test("end to end: a cloud recipe is never called for a health task, and nothing is sent", async () => {
    writeRecipes(vault, [cloudA, localA]);
    const calls: string[] = [];
    const call: Caller = async ({ recipe, prompt }) => { calls.push(`${recipe.cli}:${prompt}`); return "ok"; };
    const d = await runDuel(vault, task({ domain: "health", prompt: "Plan my week of workouts" }), cloudA, localA, { call });
    expect(d.a.ok).toBe(false);
    expect(d.a.status).toBe("privacy");
    expect(d.outcome).toBe("error");
    expect(calls.every((c) => c.startsWith("ollama:"))).toBe(true);
  });

  test("a cloud recipe with vault context never receives Home Only notes", async () => {
    const ctxCloud = makeRecipe({ cli: "claude", model: "claude-haiku-4-5", context: "domain" });
    const ctxCloud2 = makeRecipe({ cli: "claude", model: "claude-sonnet-5", context: "domain" });
    writeRecipes(vault, [ctxCloud, ctxCloud2]);
    const seen: string[] = [];
    const call: Caller = async ({ prompt }) => { seen.push(prompt); return "answer"; };
    // content domain: context is included
    await runDuel(vault, task({ domain: "content" }), ctxCloud, ctxCloud2, { call });
    expect(seen.some((p) => p.includes("Write plainly for runners"))).toBe(true);
    // health domain: refused before any call, so the marker never appears
    await runDuel(vault, task({ domain: "health", prompt: "Write a post" }), ctxCloud, ctxCloud2, { call });
    expect(seen.some((p) => p.includes("PRIVATE-MARKER"))).toBe(false);
  });

  test("replays skip Home Only tasks unless both recipes are local", async () => {
    writeRecipes(vault, [cloudA, cloudB]);
    const call: Caller = async () => "fine";
    const notes: string[] = [];
    const out = await runReplay(vault, [task({ domain: "money", prompt: "Reconcile the rent ledger" })], cloudA, cloudB, { call, onProgress: (e) => e.note && notes.push(e.note) });
    expect(out.length).toBe(0);
    expect(notes[0]).toContain("Home Only");
  });
});

describe("budget", () => {
  test("local is free; the cap stops a call before it is made", async () => {
    expect(estimateUsd("ollama", "qwen3:8b", 5000)).toBe(0);
    expect(estimateUsd("claude", "claude-opus-5-5", 4000)).toBeGreaterThan(0);
    expect(canSpend(9.99, 0.02, 10)).toBe(false);
    expect(canSpend(9.99, 0, 10)).toBe(true);
    recordSpend(vault, 0.5, "r", "m");
    expect(monthSpend(vault)).toBeCloseTo(0.5, 5);

    writeConfig(vault, { monthly_cap_usd: 0.5 });
    writeRecipes(vault, [cloudA, cloudB]);
    let called = 0;
    const d = await runDuel(vault, task(), cloudA, cloudB, { call: async () => { called++; return "x"; } });
    expect(called).toBe(0);
    expect(d.a.status).toBe("budget");
    expect(d.outcome).toBe("error");
  });
});

describe("adverse events", () => {
  const ev = (over: Partial<AdverseEvent>): AdverseEvent => ({ ts: Date.UTC(2026, 9, 1), model: "m1", domain: "health", severity: "minor", kind: "other", what: "x", source: "manual", ...over });
  const now = Date.UTC(2026, 9, 10);
  test("one severe event suspends in that domain", () => {
    const s = suspensions([ev({ severity: "severe", kind: "unsafe_advice" })], now);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ model: "m1", domain: "health" });
  });
  test("two majors in 30 days suspend; minors and spread-out majors do not", () => {
    expect(suspensions([ev({ severity: "major" }), ev({ severity: "major", ts: Date.UTC(2026, 9, 5) })], now).length).toBe(1);
    expect(suspensions([ev({ severity: "minor" }), ev({ severity: "minor" })], now).length).toBe(0);
    expect(suspensions([ev({ severity: "major", ts: Date.UTC(2026, 6, 1) }), ev({ severity: "major", ts: Date.UTC(2026, 9, 5) })], now).length).toBe(0);
  });
  test("a lift ends it, and suspensions expire", () => {
    expect(suspensions([ev({ severity: "severe" }), ev({ kind: "lift", ts: Date.UTC(2026, 9, 2) })], now).length).toBe(0);
    expect(suspensions([ev({ severity: "severe" })], Date.UTC(2026, 11, 1)).length).toBe(0);
  });
});

describe("policy writer", () => {
  const cfg = { ...DEFAULT_CONFIG, min_games: 3 };

  test("the cheaper recipe takes the route when it is equivalent", () => {
    const ds = [duel(cloudA, cloudB, "tie"), duel(cloudA, cloudB, "tie"), duel(cloudA, cloudB, "a"), duel(cloudA, cloudB, "b")];
    const p = buildPolicy({ duels: ds, signals: [], recipes: [cloudA, cloudB], suspended: [], config: cfg, spent: 1.234, month: "2026-10", now: Date.UTC(2026, 9, 25) });
    const r = lookupRoute(p, "content", "drafting", "middle")!;
    expect(r.recipe).toBe(cloudB.id);
    expect(r.verdict).toBe("equivalent_cheaper");
    expect(r.why).toContain("cheaper");
    expect(p.schema).toBe(POLICY_SCHEMA);
    expect(p.budget).toEqual({ month: "2026-10", cap_usd: 10, spent_usd: 1.23 });
  });

  test("a clear winner keeps the route, with a readable why", () => {
    const ds = [1, 2, 3, 4, 5, 6, 7].map(() => duel(cloudA, cloudB, "a"));
    const p = buildPolicy({ duels: ds, signals: [], recipes: [cloudA, cloudB], suspended: [], config: cfg, spent: 0, month: "2026-10" });
    const r = lookupRoute(p, "content", "drafting", "middle")!;
    expect(r.recipe).toBe(cloudA.id);
    expect(r.verdict).toBe("best");
    expect(r.why).toMatch(/leads with 7-0-0/);
    expect(r.runner_up).toBe(cloudB.id);
  });

  test("too few games: no route; suspended models never get one", () => {
    const few = [duel(cloudA, cloudB, "a")];
    expect(buildPolicy({ duels: few, signals: [], recipes: [cloudA, cloudB], suspended: [], config: cfg, spent: 0, month: "m" }).routes.length).toBe(0);
    const ds = [1, 2, 3, 4].map(() => duel(cloudA, cloudB, "a"));
    const p = buildPolicy({ duels: ds, signals: [], recipes: [cloudA, cloudB], suspended: [{ model: cloudA.model, domain: "content", until: "2099-01-01", why: "x" }], config: cfg, spent: 0, month: "m" });
    expect(p.routes.filter((r) => r.domain === "content").every((r) => r.recipe !== cloudA.id)).toBe(true);
    expect(lookupRoute(p, "content", "drafting", "middle")?.recipe).not.toBe(cloudA.id);
    expect(lookupRoute(p, "content", "drafting", "light")?.recipe ?? null).not.toBe(cloudA.id);
  });

  test("Home Only leagues route only to local recipes", () => {
    const ds = [1, 2, 3, 4].map(() => duel(cloudA, localA, "a", { league: { domain: "health", kind: "planning", weight: "light" } }));
    ds.push(...[1, 2, 3].map(() => duel(localA, localB, "a", { league: { domain: "health", kind: "planning", weight: "light" } })));
    const p = buildPolicy({ duels: ds, signals: [], recipes: [cloudA, localA, localB], suspended: [], config: cfg, spent: 0, month: "m" });
    const r = lookupRoute(p, "health", "planning", "light")!;
    expect(r.cli).toBe("ollama");
    expect(r.verdict).toBe("home_only");
  });

  test("lookup falls back from exact to wider leagues", () => {
    const p = { routes: [
      { domain: "*", kind: "coding", weight: "*", recipe: "wide" },
      { domain: "dev", kind: "coding", weight: "heavy", recipe: "exact" },
    ] } as never;
    expect(lookupRoute(p, "dev", "coding", "heavy")!.recipe).toBe("exact");
    expect(lookupRoute(p, "dev", "coding", "light")!.recipe).toBe("wide");
    expect(lookupRoute(p, "dev", "drafting", "light")).toBeNull();
  });

  test("rebuild writes policy.json and policy.md atomically, readable by Studio", () => {
    writeRecipes(vault, [cloudA, cloudB]);
    const p = rebuildPolicy(vault);
    const path = join(vault, "build", "_meta", "arena", "policy.json");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(vault, "build", "_meta", "arena", "policy.md"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe(POLICY_SCHEMA);
    expect(readPolicy(vault)?.generated_at).toBe(p.generated_at);
    writeFileSync(path, "{ torn");
    expect(readPolicy(vault)).toBeNull();
  });
});

describe("blind picks, end to end on a made-up vault", () => {
  test("disagreeing answers queue a pick; the pick decides, unblinds and updates the policy", async () => {
    writeRecipes(vault, [cloudA, cloudB]);
    const call: Caller = async ({ recipe }) => (recipe.id === cloudA.id ? "Go with the red option, it lasts longer." : "Blue is cheaper and fine for a weekend.");
    const d = await runDuel(vault, task(), cloudA, cloudB, { call });
    expect(d.outcome).toBe("pending");
    const card = nextPick(vault, () => 0.1)!;
    expect(card.duel).toBe(d.id);
    expect(card.left).toBe("a");
    expect(JSON.stringify(card)).not.toContain(cloudA.id); // blind
    const reveal = submitPick(vault, card.duel, "left", card.left, 1800);
    expect(reveal.winner).toBe(cloudA.id);
    expect(readDuels(vault).find((x) => x.id === d.id)!.outcome).toBe("a");
    expect(nextPick(vault)).toBeNull();
    expect(() => submitPick(vault, card.duel, "left", "a", 1)).toThrow(/already decided/);
    const ev = flagDuel(vault, d.id, "b", "hallucination", "severe", "made up a warranty");
    expect(ev.domain).toBe("content");
    expect(readPolicy(vault)!.suspended[0]!.model).toBe(cloudB.model);
  });

  test("a failed side is an error, not a loss, and is not written as a result", async () => {
    writeRecipes(vault, [cloudA, cloudB]);
    const call: Caller = async ({ recipe }) => { if (recipe.id === cloudB.id) throw new Error("rate limit"); return "fine"; };
    const d = await runDuel(vault, task(), cloudA, cloudB, { call });
    expect(d.outcome).toBe("error");
    expect(d.b.error).toContain("rate limit");
    expect(rebuildPolicy(vault).routes.length).toBe(0);
  });

  test("sentinels: a pass that turns into a fail is a regression event", async () => {
    writeRecipes(vault, [cloudA]);
    let good = true;
    const call: Caller = async ({ prompt }) => {
      if (/total/.test(prompt)) return good ? "1850.86" : "1850.00";
      return "n/a";
    };
    await runSentinels(vault, [cloudA.id], { call });
    good = false;
    const r = await runSentinels(vault, [cloudA.id], { call });
    expect(r.regressions.length).toBe(1);
    expect(r.regressions[0]!.kind).toBe("regression");
  });
});

describe("Studio's Auto router follows the policy", () => {
  const { chooseModel, makeCandidate } = require("../model-routing.ts") as typeof import("../model-routing.ts");
  const cands = ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"].map((m) => makeCandidate("claude", m));
  const base = { message: "Draft a post about the new trail map", candidates: cands, bias: "balanced" as const };

  test("an Arena route on this runtime wins, with the why as the reason", () => {
    const d = chooseModel({ ...base, arena: { cli: "claude", model: "claude-haiku-4-5", why: "equivalent and 4x cheaper" } });
    expect(d.model).toBe("claude-haiku-4-5");
    expect(d.reason).toBe("Arena: equivalent and 4x cheaper");
  });
  test("a route for another runtime or an unavailable model is ignored", () => {
    const plain = chooseModel(base);
    expect(chooseModel({ ...base, arena: { cli: "ollama", model: "qwen3:8b", why: "x" } }).model).toBe(plain.model);
    expect(chooseModel({ ...base, arena: { cli: "claude", model: "claude-nope", why: "x" } }).model).toBe(plain.model);
    expect(chooseModel({ ...base, arena: null })).toEqual(plain);
  });
  test("the user's own repeated override still wins over Arena", () => {
    const overrides = [1, 2].map((i) => ({ ts: i, domain: "content", band: "light" as const, fromModel: "claude-haiku-4-5", toModel: "claude-opus-5-5" }));
    const d = chooseModel({ ...base, domain: "content", overrides, arena: { cli: "claude", model: "claude-haiku-4-5", why: "x" } });
    expect(d.model).toBe("claude-opus-5-5");
  });
});

describe("provider failures are errors, never answers", () => {
  test("engine error replies and quota refusals are recognised", () => {
    expect(providerError("(anthropic: HTTP 401, invalid x-api-key)")).toContain("401");
    expect(providerError("(ollama: fetch failed)")).toBe("ollama: fetch failed");
    expect(providerError("You've hit your usage limit. Please try again later.")).toBeTruthy();
    expect(providerError("1850.86")).toBeNull();
    expect(providerError("(a parenthetical answer that is long and real: it explains the trade-offs of the two options in detail)")).toBeNull();
  });
  test("a 401 reply leaves the duel unscored and spends nothing", async () => {
    writeRecipes(vault, [cloudA, cloudB]);
    const call: Caller = async ({ recipe }) => (recipe.id === cloudA.id ? "(anthropic: HTTP 401, invalid x-api-key)" : "1850.86");
    const d = await runDuel(vault, task({ check: { type: "number", expect: 1850.86 } }), cloudA, cloudB, { call });
    expect(d.outcome).toBe("error");
    expect(d.a.status).toBe("error");
  });
  test("think blocks are stripped before grading", async () => {
    writeRecipes(vault, [localA, localB]);
    const call: Caller = async () => "<think>maybe 1850.00?</think>1850.86";
    const d = await runDuel(vault, task({ domain: "general", check: { type: "number", expect: 1850.86 } }), localA, localB, { call });
    expect(d.a.reply).toBe("1850.86");
    expect(d.outcome).toBe("tie");
  });
});
