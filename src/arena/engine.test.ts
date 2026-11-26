// Arena engine: adapters, jury, ratings, runner, autopilot. Stub CLIs and a stub fetch
// stand in for every model; the vault is a made-up temp folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, callModel, clearVersionCache, LimitError, parseClaude, parseCodex, parseGemini, type Exec } from "./adapters.ts";
import { fetchLists, readAutopilot, runnableFor, setAutopilot, tick } from "./autopilot.ts";
import { judgePair, judgePrompt, parseVerdict, pickJury, rubricScore } from "./jury.ts";
import { pcmToWav, wer, loadKeyFiles, providerKey } from "./media.ts";
import { familyOf, makeModel, modelId, readModels, resolveModel, writeModels, type ModelDef } from "./models.ts";
import { btFit, computeRatings, fitArea, pickModel, shares, type RatingsFile } from "./ratings.ts";
import { runSuite } from "./suite-run.ts";
import { arenaDir, readConfig, writeConfig } from "./store.ts";
import { approve, readSuite, runnableItems, swapReserve, writeSuite, type Suite } from "./suites.ts";

const GOOD = "GOOD";

// What each stub model "says": the haiku-like one is good, the others are not.
const said = (model: string, prompt: string) => (/haiku/.test(model) ? `${GOOD} answer to: ${prompt.slice(0, 30)}` : `meh answer to: ${prompt.slice(0, 30)}`);
// A judge that prefers whichever answer carries GOOD, and meets every rubric line c1 in a GOOD answer.
function judgeSays(prompt: string): string {
  const a1 = prompt.split("ANSWER 1:")[1]!.split("ANSWER 2:")[0]!;
  const a2 = prompt.split("ANSWER 2:")[1]!;
  const g1 = a1.includes(GOOD), g2 = a2.includes(GOOD);
  return JSON.stringify({ first: { met: g1 ? ["c1"] : [] }, second: { met: g2 ? ["c1"] : [] }, better: g1 === g2 ? "tie" : g1 ? "first" : "second" });
}
const reply = (model: string, prompt: string) => (prompt.includes("impartial judge") ? judgeSays(prompt) : said(model, prompt));

interface Stub { exec: Exec; fetch: typeof fetch; calls: { bin: string; args: string[] }[]; sleeps: number[]; sleep: (ms: number) => Promise<void>; limitFirst: number; peak: number }

function stub(): Stub {
  const s: Stub = { calls: [], sleeps: [], limitFirst: 0, peak: 0, sleep: async (ms) => { s.sleeps.push(ms); }, exec: null as unknown as Exec, fetch: null as unknown as typeof fetch };
  let live = 0;
  s.exec = async (bin, args) => {
    if (args[0] === "--version") return { code: 0, stdout: `${bin} 9.9.9\n`, stderr: "" };
    s.calls.push({ bin, args });
    live++; s.peak = Math.max(s.peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (s.limitFirst > 0) { s.limitFirst--; return { code: 1, stdout: "", stderr: "Error: 429 rate limit exceeded" }; }
    if (bin === "claude") {
      const model = args[args.indexOf("--model") + 1]!;
      return { code: 0, stdout: JSON.stringify({ result: reply(model, args[1]!), total_cost_usd: 0.002, modelUsage: { [model]: { inputTokens: 100, outputTokens: 20, costUSD: 0.002 } }, is_error: false }), stderr: "" };
    }
    if (bin === "codex") {
      const model = args[args.indexOf("-m") + 1]!;
      const text = reply(model, args[args.length - 1]!);
      return { code: 0, stdout: [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 30 } })].join("\n"), stderr: "" };
    }
    const model = args[args.indexOf("-m") + 1]!;
    return { code: 0, stdout: JSON.stringify({ response: reply(model, args[1]!), stats: { models: { [model]: { tokens: { prompt: 300, candidates: 40 } } } } }), stderr: "" };
  };
  s.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.9.9" }));
    if (u.endsWith("/api/generate")) {
      const b = JSON.parse(init!.body!) as { model: string; prompt: string };
      s.calls.push({ bin: "ollama", args: [b.model] });
      return new Response(JSON.stringify({ response: `<think>hmm</think>${reply(b.model, b.prompt)}`, prompt_eval_count: 12, eval_count: 7 }));
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  return s;
}

let vault = "";
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "arena-engine-"));
  mkdirSync(join(vault, "build"), { recursive: true });
  clearVersionCache();
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

const haiku = () => makeModel({ cli: "claude", model: "claude-haiku-4-5" });
const luna = () => makeModel({ cli: "codex", model: "gpt-6-luna" });
const qwen = () => makeModel({ cli: "ollama", model: "qwen3:0.6b" });
const gem = () => makeModel({ cli: "gemini", model: "gemini-3-flash" });

const textSuite = (over: Partial<Suite> = {}): Suite => ({
  id: "notes", title: "Notes", kind: "text", area: "Writing", schedule: "manual",
  items: [1, 2, 3].map((n) => ({ id: `i${n}`, prompt: `Write about topic ${n}`, rubric: [{ criterion: "is good", points: 5, type: "quality" as const }] })),
  ...over,
});

describe("adapter parsers", () => {
  test("claude sums every model in modelUsage", () => {
    const r = parseClaude(JSON.stringify({ result: " hi ", modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, costUSD: 0.1 }, b: { inputTokens: 10, outputTokens: 20, costUSD: 0.2 } } }));
    expect(r).toMatchObject({ text: "hi", tokens_in: 14, tokens_out: 22 });
    expect(r.cost).toBeCloseTo(0.3);
  });
  test("claude is_error throws", () => { expect(() => parseClaude(JSON.stringify({ is_error: true, result: "You hit your limit" }))).toThrow("limit"); });
  test("codex reads turn events", () => {
    const r = parseCodex(['{"type":"item.completed","item":{"type":"agent_message","text":"yo"}}', '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2,"reasoning_output_tokens":1}}'].join("\n"));
    expect(r).toEqual({ text: "yo", tokens_in: 9, tokens_out: 3 });
  });
  test("gemini reads stats.models and skips leading noise", () => {
    const r = parseGemini(`Loaded credentials\n${JSON.stringify({ response: "ok", stats: { models: { m: { tokens: { prompt: 5, candidates: 6 } } } } })}`);
    expect(r).toEqual({ text: "ok", tokens_in: 5, tokens_out: 6 });
  });
});

describe("callModel", () => {
  test("one record shape from every adapter, tools off and model explicit", async () => {
    const s = stub();
    const d = { exec: s.exec, fetch: s.fetch, sleep: s.sleep };
    const recs = await Promise.all([haiku(), luna(), gem(), qwen()].map((m) => callModel(vault, { cli: m.cli, model: m.model, prompt: "hello", baseUrl: m.base_url }, d)));
    for (const r of recs) {
      expect(Object.keys(r).sort()).toEqual(["cli", "cli_version", "cost_estimate", "latency_ms", "model", "text", "tokens", "tokens_in", "tokens_out"]);
      expect(r.cli_version).toMatch(/9\.9\.9|0\.9\.9/);
    }
    const claude = s.calls.find((c) => c.bin === "claude")!.args;
    expect(claude).toContain("--output-format");
    expect(claude[claude.indexOf("--tools") + 1]).toBe("");
    expect(claude[claude.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(s.calls.find((c) => c.bin === "codex")!.args).toContain("read-only");
    expect(recs[3]!.text).not.toContain("think");
    expect(recs[3]!.cost_estimate).toBe(0);
    expect(recs[0]!.cost_estimate).toBeCloseTo(0.002);
  });

  test("cache by cli, version, model, prompt, settings", async () => {
    const s = stub();
    const d = { exec: s.exec, fetch: s.fetch, sleep: s.sleep };
    await callModel(vault, { cli: "claude", model: "claude-haiku-4-5", prompt: "p" }, d);
    const again = await callModel(vault, { cli: "claude", model: "claude-haiku-4-5", prompt: "p" }, d);
    expect(again.cached).toBe(true);
    expect(s.calls.length).toBe(1);
    await callModel(vault, { cli: "claude", model: "claude-haiku-4-5", prompt: "p", settings: { t: 1 } }, d);
    await callModel(vault, { cli: "claude", model: "claude-sonnet-5", prompt: "p" }, d);
    expect(s.calls.length).toBe(3);
    expect(cacheKey("claude", "1", "m", "p", {})).not.toBe(cacheKey("claude", "2", "m", "p", {}));
  });

  test("one call at a time per CLI", async () => {
    const s = stub();
    await Promise.all([1, 2, 3, 4].map((n) => callModel(vault, { cli: "codex", model: "gpt-6-luna", prompt: `q${n}` }, { exec: s.exec, fetch: s.fetch, sleep: s.sleep })));
    expect(s.peak).toBe(1);
  });

  test("backs off on a 429, then gives up with a LimitError", async () => {
    const s = stub();
    s.limitFirst = 2;
    const r = await callModel(vault, { cli: "claude", model: "claude-haiku-4-5", prompt: "x" }, { exec: s.exec, fetch: s.fetch, sleep: s.sleep, backoff: [10, 20, 30] });
    expect(r.text).toContain(GOOD);
    expect(s.sleeps).toEqual([10, 20]);
    s.limitFirst = 99;
    await expect(callModel(vault, { cli: "claude", model: "claude-haiku-4-5", prompt: "y" }, { exec: s.exec, fetch: s.fetch, sleep: s.sleep, backoff: [1, 1] })).rejects.toBeInstanceOf(LimitError);
  });

  test("a CLI that is not installed says so", async () => {
    const exec: Exec = async () => ({ code: 127, stdout: "", stderr: "ENOENT" });
    await expect(callModel(vault, { cli: "gemini", model: "g", prompt: "x" }, { exec, sleep: async () => {} })).rejects.toThrow("not installed");
  });
});

describe("keys on disk", () => {
  test("reads only the four named keys and never a Fireworks one", () => {
    const f = join(vault, "k.env");
    writeFileSync(f, 'OPENAI_API_KEY="sk-made-up"\nFIREWORKS_API_KEY=fw-nope\nGEMINI_API_KEY=g-made-up\n');
    expect(loadKeyFiles([f])).toBe(2);
    expect(providerKey("openai")).toBe("sk-made-up");
    expect(providerKey("google")).toBe("g-made-up");
    expect(providerKey("fireworks")).toBeNull();
    loadKeyFiles([]);
  });
});

describe("models and families", () => {
  test("ids, families, resolve", () => {
    expect(modelId("claude-haiku-4-5")).toBe("haiku-4.5");
    expect(modelId("qwen3:0.6b")).toBe("qwen3-0.6b");
    expect(familyOf(haiku())).toBe("anthropic");
    expect(familyOf(qwen())).toBe("alibaba");
    expect(familyOf({ cli: "ollama", model: "gemma3:1b" })).toBe("google");
    expect(resolveModel([haiku()], "claude:claude-sonnet-5").cli).toBe("claude");
    expect(() => resolveModel([], "nope")).toThrow();
  });
  test("pickJury leaves out both contestants' families", () => {
    const pool = [haiku(), luna(), gem(), qwen()];
    expect(pickJury(pool, haiku(), qwen()).map((m) => m.id).sort()).toEqual([gem().id, luna().id].sort());
    expect(pickJury(pool, haiku(), luna()).map((m) => familyOf(m)).sort()).toEqual(["alibaba", "google"]);
    expect(pickJury([haiku()], haiku(), qwen())).toEqual([]);
    expect(pickJury(pool, haiku(), qwen(), [], 2, (m) => m.local)).toEqual([]);
  });
});

describe("jury", () => {
  const item = { id: "i", prompt: "p", rubric: [{ criterion: "bad thing", points: -10, type: "hard_fail" as const }, { criterion: "good", points: 6, type: "quality" as const }, { criterion: "nice", points: 4, type: "preference" as const }] };
  test("rubric score and hard_fail", () => {
    const ids = ["c1", "c2", "c3"];
    expect(rubricScore(item.rubric, new Set(["c2"]), ids)).toEqual({ score: 0.6, zeroed: false });
    expect(rubricScore(item.rubric, new Set(["c1", "c2", "c3"]), ids)).toEqual({ score: 0, zeroed: true });
    expect(rubricScore([{ criterion: "must say not known", points: 5, type: "hard_fail" }], new Set(), ["c1"]).zeroed).toBe(true);
  });
  test("parseVerdict", () => {
    expect(parseVerdict('sure {"first":{"met":["c1"]},"second":{"met":[]},"better":"first"}')!.better).toBe("first");
    expect(parseVerdict("no json")).toBeNull();
    expect(parseVerdict('{"better":"maybe"}')).toBeNull();
    expect(judgePrompt(item, "AAA", "BBB")).toContain("ANSWER 2:\nBBB");
  });
  const judge = (verdicts: Record<string, "first" | "second" | "tie">) => async (_j: ModelDef, prompt: string) => {
    const first = prompt.split("ANSWER 1:\n")[1]!.split("\n")[0]!;
    return { text: JSON.stringify({ first: { met: ["c2"] }, second: { met: ["c2"] }, better: verdicts[first]! }), tokens: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0.001, latency_ms: 1, cli: "x", cli_version: "1", model: "m" };
  };
  test("a judge who flips with the order gives a tie; one who holds gives a vote", async () => {
    const j = [luna()];
    // always says "first": wins in one order, loses in the other
    const flipper = await judgePair(item, "AAA", "BBB", j, judge({ AAA: "first", BBB: "first" }));
    expect(flipper.game).toMatchObject({ winner: "tie", flips: 1, by: "jury" });
    const holder = await judgePair(item, "AAA", "BBB", j, judge({ AAA: "first", BBB: "second" }));
    expect(holder.game).toMatchObject({ winner: "a", flips: 0 });
    expect(holder.cost).toBeCloseTo(0.002);
  });
  test("a tripped hard_fail decides it before the vote", async () => {
    const ask = async (_j: ModelDef, prompt: string) => {
      const first = prompt.split("ANSWER 1:\n")[1]!.split("\n")[0]!;
      const forbidden = (t: string) => (t === "BAD" ? ["c1", "c2"] : ["c2"]);
      const second = prompt.split("ANSWER 2:\n")[1]!.split("\n")[0]!;
      return { text: JSON.stringify({ first: { met: forbidden(first) }, second: { met: forbidden(second) }, better: "tie" }), tokens: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0, latency_ms: 1, cli: "x", cli_version: "1", model: "m" };
    };
    const r = await judgePair(item, "BAD", "OK", [luna()], ask);
    expect(r.game).toMatchObject({ winner: "b", by: "hard_fail" });
    expect(r.game.sa).toBe(0);
  });
});

describe("ratings", () => {
  const games = (n: number, aWins: number) => Array.from({ length: n }, (_, i) => ({ a: "x", b: "y", w: i < aWins ? 1 : 0, cluster: `c${i}` }));
  test("Bradley-Terry puts the winner first and shares sum sensibly", () => {
    const p = btFit(["x", "y"], games(20, 18));
    expect(p.x!).toBeGreaterThan(p.y!);
    const s = shares(p);
    expect(s.x! + s.y!).toBeCloseTo(1);
  });
  test("a lopsided record is clear, an even one is close", () => {
    const clear = fitArea(["x", "y"], games(30, 28), 200);
    expect(clear.leader).toBe("x");
    expect(clear.lead_lo).toBeGreaterThan(0);
    expect(clear.lo.x!).toBeLessThan(clear.rate.x!);
    expect(clear.hi.x!).toBeGreaterThanOrEqual(clear.rate.x!);
    const close = fitArea(["x", "y"], games(10, 5), 200);
    expect(close.lead_lo).toBeLessThanOrEqual(0);
  });
  test("pickModel takes the cheaper when it is too close", () => {
    const r: RatingsFile = { updated: "", overall: { leader: "a", areas_led: 1, areas: 1 }, areas: [{ area: "Writing", suite: "w", verdict: "close", models: [
      { model: "big", label: "Big", rate: 0.55, lo: 0.4, hi: 0.7, games: 10, cost_usd: 0.5, latency_ms: 1, allowed: true },
      { model: "small", label: "Small", rate: 0.45, lo: 0.3, hi: 0.6, games: 10, cost_usd: 0.01, latency_ms: 1, allowed: true },
      { model: "far", label: "Far", rate: 0.1, lo: 0, hi: 0.2, games: 10, cost_usd: 0.001, latency_ms: 1, allowed: true }] }] };
    expect(pickModel(r, "writing").model).toBe("small");
    r.areas[0]!.verdict = "clear";
    expect(pickModel(r, "Writing").model).toBe("big");
    expect(pickModel(r, "nothing").model).toBeNull();
  });
});

describe("suites", () => {
  test("approval gate and reserve swap", () => {
    mkdirSync(join(vault, "build"), { recursive: true });
    const s = textSuite({ items: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, prompt: "p", split: i >= 6 ? ("reserve" as const) : ("active" as const), leak: { approved: i % 2 === 0 } })) });
    writeSuite(vault, s);
    expect(runnableItems(readSuite(vault, "notes")).length).toBe(3);
    expect(approve(vault, "notes").approved).toBe(6);
    expect(swapReserve(vault, readSuite(vault, "notes"), new Date("2026-12-01"))).toBe(1);
    expect(readSuite(vault, "notes").last_swap).toContain("2026-12-01");
  });
  test("a bad suite id is refused", () => { expect(() => readSuite(vault, "../x")).toThrow(); });
});

describe("runSuite", () => {
  const setup = (models: ModelDef[], suite = textSuite()) => { writeModels(vault, models); writeSuite(vault, suite); };

  test("runs, saves outputs, judges with other families, rates", async () => {
    const s = stub();
    setup([haiku(), qwen(), luna(), gem()]);
    const progress: number[] = [];
    const run = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], deps: s, onProgress: (e) => progress.push(e.done) });
    expect(run.status).toBe("done");
    const dir = join(arenaDir(vault), "runs", run.id);
    expect(run.id).toMatch(/^\d{4}-\d\d-\d\dT\d{4}-notes$/);
    for (const it of ["i1", "i2", "i3"]) for (const m of [haiku().id, qwen().id]) expect(existsSync(join(dir, `${it}.${m}.txt`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).by_item.i1[haiku().id]).toMatchObject({ output_ref: `i1.${haiku().id}.txt`, cli: "claude", model: "claude-haiku-4-5" });
    expect(run.games.length).toBe(3);
    expect(run.games.every((g) => g.winner === "a" && g.by === "jury")).toBe(true);
    // the judges were the codex and gemini models, never the contestants' families
    expect(new Set(run.games.flatMap((g) => g.judges!))).toEqual(new Set([luna().id, gem().id]));
    expect(run.by_item.i1![haiku().id]!.scores).toMatchObject({ score: 1, won: true });
    expect(run.by_item.i1![qwen().id]!.scores).toMatchObject({ score: 0, won: false });
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBeGreaterThanOrEqual(progress[0]!);
    const r = computeRatings(vault);
    expect(r.areas[0]!.models[0]!.model).toBe(haiku().id);
    expect(r.areas[0]!.models[0]!.rate).toBeGreaterThan(0.5);
    expect(r.overall.leader).toBe(haiku().id);
    expect(JSON.parse(readFileSync(join(arenaDir(vault), "ratings.json"), "utf8")).areas[0].suite).toBe("notes");
  });

  test("two runs in one minute get separate folders", async () => {
    const s = stub();
    setup([haiku(), qwen()], textSuite({ items: [{ id: "a", prompt: "hi" }] }));
    const at = new Date("2026-11-25T21:30:00Z");
    const r1 = await runSuite(vault, { suite: "notes", models: [qwen().id], deps: s, now: at });
    const r2 = await runSuite(vault, { suite: "notes", models: [qwen().id], deps: s, now: at });
    expect(r1.id).toBe("2026-11-25T2130-notes");
    expect(r2.id).toBe("2026-11-25T2130-notes-2");
  });

  test("a mechanical check decides with no judge", async () => {
    const s = stub();
    const suite = textSuite({ items: [{ id: "c1", prompt: "say hello", check: { type: "keywords", all: [GOOD] } }] });
    setup([haiku(), qwen()], suite);
    const run = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], deps: s });
    expect(run.games[0]).toMatchObject({ by: "check", winner: "a" });
    expect(s.calls.length).toBe(2);
  });

  test("resumes where a budget stop left it, without repeating finished calls", async () => {
    const s = stub();
    setup([haiku(), qwen(), luna()]);
    const first = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], budgetUsd: 0.003, deps: s });
    expect(first.status).toBe("budget");
    const before = s.calls.length;
    const done = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], resume: first.id, budgetUsd: 5, deps: s });
    expect(done.status).toBe("done");
    expect(done.id).toBe(first.id);
    expect(done.games.length).toBe(3);
    // 6 generations + judging in total; the first run's finished cells were not asked again
    const gens = s.calls.filter((c) => c.bin === "claude" || c.bin === "ollama").length;
    expect(s.calls.length).toBeGreaterThan(before);
    expect(gens).toBeLessThanOrEqual(6 + 12);
  });

  test("Home Only: a health suite never reaches a cloud model", async () => {
    const s = stub();
    setup([haiku(), qwen(), luna()], textSuite({ domain: "health" }));
    const run = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], deps: s });
    expect(run.by_item.i1![haiku().id]!.status).toBe("privacy");
    expect(run.by_item.i1![qwen().id]!.output_ref).toBeTruthy();
    expect(s.calls.some((c) => c.bin === "claude")).toBe(false);
    expect(run.games.length).toBe(0);
    expect(computeRatings(vault).areas[0]!.models.find((m) => m.model === haiku().id)!.allowed).toBe(false);
  });

  test("the monthly cap stops a cloud call before it is made", async () => {
    const s = stub();
    setup([haiku(), qwen(), luna()]);
    writeConfig(vault, { monthly_cap_usd: 0.0000001 });
    const run = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], deps: s });
    expect(run.status).toBe("budget");
    expect(s.calls.some((c) => c.bin === "claude")).toBe(false);
  });

  test("a CLI at its limit is skipped for the rest of the run", async () => {
    const s = stub();
    s.limitFirst = 1000;
    setup([haiku(), qwen(), luna()]);
    const run = await runSuite(vault, { suite: "notes", models: [haiku().id, qwen().id], deps: { ...s, backoff: [1] } });
    expect(["limited", "done"]).toContain(run.status);
    expect(run.by_item.i1![haiku().id]!.output_ref).toBeUndefined();
  });

  test("an image suite saves files and blind picks feed the ratings", async () => {
    const m1 = makeModel({ cli: "openai", model: "img-a", kind: "image" });
    const m2 = makeModel({ cli: "google", model: "img-b", kind: "image" });
    setup([m1, m2], { id: "pics", title: "Pics", kind: "image", area: "Images", schedule: "weekly", items: [{ id: "p1", prompt: "a green door" }, { id: "p2", prompt: "a lake" }] });
    const image = async (_p: string, model: string, _prompt: string, base: string) => { writeFileSync(`${base}.png`, model); return `${base}.png`; };
    const run = await runSuite(vault, { suite: "pics", deps: { media: { image } } });
    expect(run.by_item.p1![m1.id]!.output_ref).toBe(`p1.${m1.id}.png`);
    expect(run.games.length).toBe(0);
    const { appendLine } = await import("./store.ts");
    for (const item of ["p1", "p2"]) appendLine(join(arenaDir(vault), "picks-media.jsonl"), { ts: "t", run: run.id, item, winner: m1.id, shown: [m1.id, m2.id] });
    const a = computeRatings(vault).areas[0]!;
    expect(a.models[0]!.model).toBe(m1.id);
    expect(a.models[0]!.games).toBe(2);
  });

  test("transcription scores by word error rate", async () => {
    const m1 = makeModel({ cli: "whisper", model: "local", kind: "transcribe" });
    const m2 = makeModel({ cli: "openai", model: "whisper-1", kind: "transcribe" });
    setup([m1, m2], { id: "hear", title: "Hear", kind: "transcribe", area: "Transcription", schedule: "manual", items: [{ id: "h1", audio: "a.wav", reference: "the quick brown fox" }] });
    mkdirSync(join(arenaDir(vault), "suites", "media"), { recursive: true });
    writeFileSync(join(arenaDir(vault), "suites", "media", "a.wav"), "x");
    const tr = async (p: string) => (p === "whisper" ? "the quick brown fox" : "the quick brown box");
    const run = await runSuite(vault, { suite: "hear", deps: { media: { transcribe: tr } } });
    expect(run.games[0]).toMatchObject({ by: "wer", winner: "a" });
    expect(run.by_item.h1![m1.id]!.scores!.wer).toBe(0);
  });
});

describe("media helpers", () => {
  test("wer", () => {
    expect(wer("the quick brown fox", "the quick brown fox")).toBe(0);
    expect(wer("the quick brown fox", "the quick brown box")).toBe(0.25);
    expect(wer("a b", "")).toBe(1);
  });
  test("pcmToWav writes a RIFF header", () => { expect(pcmToWav(Buffer.alloc(10)).subarray(0, 4).toString()).toBe("RIFF"); });
});

describe("autopilot", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 10, n, 6, 0));
  test("off does nothing; set validates", async () => {
    expect((await tick(vault, { lists: {}, now: day(1) })).skipped).toContain("off");
    expect(() => setAutopilot(vault, { at: "25:00" })).toThrow();
    expect(setAutopilot(vault, { on: true, budget: 3, at: "06:30" })).toMatchObject({ on: true, budget_monthly_usd: 3, check_at: "06:30" });
  });

  test("runnableFor maps list entries onto runnable models", () => {
    expect(runnableFor("openrouter", "anthropic/claude-opus-5.6")).toMatchObject({ cli: "claude", model: "claude-opus-5-6" });
    expect(runnableFor("openrouter", "openai/gpt-7")).toMatchObject({ cli: "codex" });
    expect(runnableFor("openrouter", "openai/gpt-7-image")).toBeNull();
    expect(runnableFor("openrouter", "mistralai/mistral-x")).toBeNull();
    expect(runnableFor("ollama@http://localhost:11434", "llama9:3b")).toMatchObject({ cli: "ollama", base_url: "http://localhost:11434" });
    expect(runnableFor("ollama@http://localhost:11434", "nomic-embed-text")).toBeNull();
  });

  test("fetchLists reads OpenRouter's list and survives a failing one", async () => {
    const ok = (async (u: string) => (String(u).includes("openrouter") ? new Response(JSON.stringify({ data: [{ id: "a/b" }] })) : new Response("", { status: 500 }))) as unknown as typeof fetch;
    writeConfig(vault, { home_endpoints: [] });
    expect((await fetchLists(vault, { fetch: ok })).openrouter).toEqual(["a/b"]);
  });

  test("baseline, then a new model gets a trial and a full run against the leader", async () => {
    const s = stub();
    writeModels(vault, [haiku(), luna(), gem()]);
    writeSuite(vault, textSuite({ schedule: "manual" }));
    setAutopilot(vault, { on: true, budget: 5 });
    const ep = "ollama@http://localhost:11434";
    const first = await tick(vault, { lists: { [ep]: ["qwen3:0.6b"] }, deps: s, now: day(1) });
    expect(first.new_models).toEqual([]);
    expect((await tick(vault, { lists: { [ep]: ["qwen3:0.6b"] }, deps: s, now: day(1) })).skipped).toContain("already");
    const second = await tick(vault, { lists: { [ep]: ["qwen3:0.6b", "gemma3:1b"] }, deps: s, now: day(2) });
    expect(second.new_models).toEqual(["gemma3-1b"]);
    expect(second.trials).toEqual(["gemma3-1b"]);
    expect(second.runs.length).toBeGreaterThanOrEqual(1);
    expect(second.runs[0]).toMatch(/-notes-trial$/);
    expect(readFileSync(join(arenaDir(vault), "scout.jsonl"), "utf8")).toContain("gemma3:1b");
    const st = readAutopilot(vault);
    expect(st.last_check).toBe(day(2).toISOString());
    expect(st.log.some((l) => l.what.includes("new model"))).toBe(true);
    expect(st.running).toBeNull();
  });

  test("scheduled suites run, budget caps them, and a month's swap happens", async () => {
    const s = stub();
    writeModels(vault, [haiku(), qwen(), luna()]);
    writeSuite(vault, textSuite({ schedule: "nightly", last_swap: "2026-10-03T00:00:00Z", items: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, prompt: `q${i}`, split: i >= 6 ? ("reserve" as const) : ("active" as const) })) }));
    setAutopilot(vault, { on: true, budget: 0 });
    const poor = await tick(vault, { lists: {}, deps: s, now: day(3) });
    expect(poor.runs).toEqual([]);
    expect(poor.swapped.notes).toBe(1);
    setAutopilot(vault, { budget: 5 });
    const rich = await tick(vault, { lists: {}, deps: s, now: day(4), force: true });
    expect(rich.runs.length).toBe(1);
    expect(existsSync(join(arenaDir(vault), "ratings.json"))).toBe(true);
    expect(readAutopilot(vault).queue[0]).toMatchObject({ when: "Tonight" });
  });
});

describe("config and the sidecar", () => {
  test("new settings round-trip", () => {
    writeConfig(vault, { judges: ["a"], env_files: ["/x/y.env"], whisper_model: "/m.bin" });
    expect(readConfig(vault)).toMatchObject({ judges: ["a"], env_files: ["/x/y.env"] });
  });
  test("arena-engine answers suites list and ratings as JSON", () => {
    writeSuite(vault, textSuite());
    const run = (...a: string[]) => JSON.parse(spawnSync("bun", [join(import.meta.dir, "main.ts"), ...a, "--vault", vault, "--json"], { encoding: "utf8", env: { ...process.env, PREVAIL_VAULT: vault } }).stdout);
    expect(run("suites", "list")[0]).toMatchObject({ id: "notes", items: 3, kind: "text" });
    expect(run("suite", "show", "notes").items.length).toBe(3);
    expect(run("ratings").areas[0].area).toBe("Writing");
    expect(run("autopilot", "status").on).toBe(false);
    expect(run("autopilot", "set", "--on", "true", "--budget", "2").budget_monthly_usd).toBe(2);
    expect(run("pick", "--area", "Writing").model).toBeNull();
    expect(run("run", "start", "--suite", "notes", "--models", "nonexistent").error).toContain("no model");
  });
});
