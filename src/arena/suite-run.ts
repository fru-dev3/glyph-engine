// The suite runner: a suite x models -> every output saved as a file under
// runs/<id>/, run.json kept up to date after each step (so a run that dies resumes),
// every paid call priced first against the monthly cap and the run's own cap, and
// Home Only items refused to any model that is not local.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callModel, LimitError, type AdapterDeps, type CallRecord } from "./adapters.ts";
import { canSpend, estimateUsd, monthSpend, recordSpend } from "./budget.ts";
import { runCheck } from "./checkers.ts";
import { judgePair, pickJury, type Game } from "./jury.ts";
import { makeImage, makeSpeech, makeVideo, transcribe, wer, whisperBin, whisperModel } from "./media.ts";
import { isLocalModel, readModels, type ModelDef } from "./models.ts";
import { isHomeOnlyTask } from "./privacy.ts";
import { listRuns, type RunCell, type RunFile } from "./ratings.ts";
import { arenaDir, readConfig, readJson, writeJson } from "./store.ts";
import { readSuite, runnableItems, suitesDir, type Suite, type SuiteItem } from "./suites.ts";

export interface MediaDeps {
  image?: typeof makeImage;
  speech?: typeof makeSpeech;
  video?: typeof makeVideo;
  transcribe?: typeof transcribe;
}

export interface RunDeps extends AdapterDeps { media?: MediaDeps }

export interface RunOpts {
  suite: string;
  /** model ids (models.json); default: the active models of the suite's kind */
  models?: string[];
  /** a cap on this run alone, on top of the monthly cap */
  budgetUsd?: number;
  /** only the first N runnable items (a trial) */
  maxItems?: number;
  resume?: string;
  /** appended to the run id (a trial run) */
  label?: string;
  /** judge model ids; default: any other-family text model, cheapest first */
  judges?: string[];
  deps?: RunDeps;
  onProgress?: (e: { run: string; done: number; total: number; cost_usd: number; note?: string }) => void;
  signal?: AbortSignal;
  now?: Date;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(":", "");
export const runDir = (vault: string, id: string) => join(arenaDir(vault), "runs", id);

/** A rough price for the pre-flight check: the CLI's own prompt counts, so add its overhead. */
const CLI_OVERHEAD_CHARS = 8000;
const estimate = (m: ModelDef, promptChars: number) => estimateUsd(m.cli, m.model, promptChars + (["claude", "codex", "gemini"].includes(m.cli) ? CLI_OVERHEAD_CHARS : 0));

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

export function pairsOf<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  // ponytail: every pair; past six models this is 15+ pairs per item: sample neighbours then
  const near = xs.length > 6;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (!near || j - i <= 3 || xs.length - j + i <= 3) out.push([xs[i]!, xs[j]!]);
  return out;
}

export async function runSuite(vault: string, o: RunOpts): Promise<RunFile> {
  const cfg = readConfig(vault);
  const suite = readSuite(vault, o.suite);
  const all = readModels(vault);
  const wantIds = o.models?.length ? o.models : all.filter((m) => m.kind === suite.kind && m.active !== false).map((m) => m.id);
  const models = wantIds.map((id) => {
    const m = all.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model "${id}"`);
    if (m.kind !== suite.kind) throw new Error(`${m.id} makes ${m.kind}, suite ${suite.id} is ${suite.kind}`);
    return m;
  });
  if (models.length < 1) throw new Error(`no models for a ${suite.kind} suite: add some with "models add"`);
  const now = o.now ?? new Date();
  let id = o.resume ?? `${stamp(now)}-${suite.id}${o.label ? `-${o.label}` : ""}`;
  // two runs in the same minute must not share a folder
  if (!o.resume) for (let n = 2, base = id; existsSync(join(runDir(vault, id), "run.json")); n++) id = `${base}-${n}`;
  const dir = runDir(vault, id);
  mkdirSync(dir, { recursive: true });
  const prior = o.resume ? readJson<RunFile | null>(join(dir, "run.json"), null) : null;
  const run: RunFile = prior ?? { id, suite: suite.id, started: now.toISOString(), models: models.map((m) => m.id), status: "running", cost_usd: 0, by_item: {}, games: [], ...(o.budgetUsd ? { budget_usd: o.budgetUsd } : {}) };
  run.status = "running";
  delete run.ended;
  run.notes ??= [];
  const save = () => writeJson(join(dir, "run.json"), run);
  save();

  const items = runnableItems(suite).slice(0, o.maxItems ?? Infinity);
  const deps = o.deps ?? {};
  const limited = new Set<string>();
  let spentRun = run.cost_usd;
  let stopped: RunFile["status"] | null = null;
  const pairs = suite.kind === "text" ? items.length * pairsOf(models).length : suite.kind === "transcribe" ? items.length * pairsOf(models).length : 0;
  const total = items.length * models.length + pairs;
  let done = 0;
  const tick = (note?: string) => o.onProgress?.({ run: id, done, total, cost_usd: Math.round(run.cost_usd * 1e4) / 1e4, note });

  /** Can this much be spent? Records why not. */
  const afford = (usd: number): boolean => {
    if (!canSpend(monthSpend(vault), usd, cfg.monthly_cap_usd) || (o.budgetUsd !== undefined && usd > 0 && spentRun + usd > o.budgetUsd)) { stopped ??= "budget"; return false; }
    return true;
  };
  const charge = (usd: number, m: ModelDef) => {
    if (usd <= 0) return;
    spentRun += usd;
    run.cost_usd = Math.round(spentRun * 1e6) / 1e6;
    recordSpend(vault, usd, `arena:${id}`, m.model);
  };

  const homeOf = (it: SuiteItem) => isHomeOnlyTask({ domain: suite.domain ?? "", prompt: it.prompt ?? it.script ?? "" }, cfg, vault);

  // ---- generation ----
  const cells: { item: SuiteItem; model: ModelDef }[] = [];
  for (const it of items) for (const m of models) cells.push({ item: it, model: m });
  await pool(cells, 4, async ({ item, model }) => {
    const cell = (run.by_item[item.id] ??= {});
    if (cell[model.id]?.output_ref || cell[model.id]?.status === "privacy") { done++; return; }
    if (o.signal?.aborted) { stopped ??= "stopped"; return; }
    const put = (c: RunCell) => { cell[model.id] = c; save(); done++; tick(`${item.id} ${model.id}`); };
    if (homeOf(item) && !isLocalModel(model, cfg)) return put({ status: "privacy", error: "Home Only: this item runs on local models only; nothing was sent." });
    if (limited.has(model.cli)) return put({ status: "limited", error: `${model.cli} is rate limited; skipped` });
    const text = suite.kind === "voice-tts" ? item.script ?? "" : item.prompt ?? "";
    const est = suite.kind === "text" ? estimate(model, text.length) : model.local ? 0 : mediaPrice(suite.kind);
    if (!afford(est)) return put({ status: "budget", error: "skipped: would pass the budget" });
    const base = join(dir, `${item.id}.${model.id}`);
    try {
      const c = await generate(vault, suite, item, model, text, base, deps, cfg);
      charge(c.cost ?? 0, model);
      cell[model.id] = c;
      if (suite.kind === "text" && item.check && c.output_ref) {
        const txt = readFileSync(join(dir, c.output_ref), "utf8");
        const r = runCheck(item.check, txt, { codeTests: cfg.code_tests });
        c.scores = { ...c.scores, check: r.pass, check_detail: r.detail };
      }
      save(); done++; tick(`${item.id} ${model.id}`);
    } catch (e) {
      if (e instanceof LimitError) { limited.add(model.cli); run.notes!.push(`${model.cli} hit its limit: ${e.message.slice(0, 120)}`); }
      put({ status: e instanceof LimitError ? "limited" : "error", error: (e as Error).message.slice(0, 300) });
    }
  });

  // ---- scoring ----
  if (suite.kind === "text") await scoreText(vault, suite, items, models, all, run, { ...o, deps }, { afford, charge, save, tick: () => { done++; tick(); }, limited, homeOf, dir, cfg, stopped: () => stopped });
  else if (suite.kind === "transcribe") scoreWer(items, models, run, () => { done++; tick(); }, save);

  // an item's winner and mean score, for the cell view
  for (const it of items) {
    const row = run.by_item[it.id] ?? {};
    const wins: Record<string, number> = {};
    for (const g of run.games.filter((x) => x.item === it.id)) {
      if (g.winner === "a") wins[g.a] = (wins[g.a] ?? 0) + 1;
      else if (g.winner === "b") wins[g.b] = (wins[g.b] ?? 0) + 1;
      for (const [m, s] of [[g.a, g.sa], [g.b, g.sb]] as [string, number | undefined][]) if (typeof s === "number" && row[m]) (row[m]!.scores ??= {}).score = s;
    }
    const best = Math.max(0, ...Object.values(wins));
    const leaders = Object.entries(wins).filter(([, n]) => n === best && best > 0);
    for (const [m, c] of Object.entries(row)) if (c.output_ref) (c.scores ??= {}).won = leaders.length === 1 && leaders[0]![0] === m;
  }
  run.status = stopped ?? (limited.size ? "limited" : "done");
  run.ended = new Date().toISOString();
  save();
  tick(`run ${run.status}`);
  return run;
}

const mediaPrice = (kind: string) => ({ image: 0.04, "voice-tts": 0.01, transcribe: 0.006, video: 0.5 } as Record<string, number>)[kind] ?? 0.05;

async function generate(vault: string, suite: Suite, item: SuiteItem, m: ModelDef, text: string, base: string, deps: RunDeps, cfg: ReturnType<typeof readConfig>): Promise<RunCell> {
  const t0 = Date.now();
  const head = { cli: m.cli, model: m.model };
  const file = (p: string) => p.split("/").pop()!;
  if (suite.kind === "text") {
    const rec: CallRecord = await callModel(vault, { cli: m.cli, model: m.model, prompt: text, baseUrl: m.base_url, effort: m.effort }, deps);
    writeFileSync(`${base}.txt`, rec.text);
    return { output_ref: file(`${base}.txt`), tokens: rec.tokens, cost: rec.cached ? 0 : rec.cost_estimate, latency_ms: rec.latency_ms, cli: m.cli, cli_version: rec.cli_version, model: m.model, ...(rec.cached ? { cached: true } : {}) };
  }
  const md = deps.media ?? {};
  let out: string;
  let cost = m.local ? 0 : mediaPrice(suite.kind);
  const scores: RunCell["scores"] = {};
  if (suite.kind === "image") out = await (md.image ?? makeImage)(m.cli, m.model, `${text}${item.aspect ? ` (aspect ${item.aspect})` : ""}`, base);
  else if (suite.kind === "voice-tts") {
    out = await (md.speech ?? makeSpeech)(m.cli, m.model, text, base);
    // read it back with whisper where it is on this Mac: the word error rate of the speech
    if (md.transcribe || (whisperBin() && whisperModel(cfg.whisper_model))) {
      try { scores.wer = wer(text, await (md.transcribe ?? transcribe)("whisper", "local", out, { whisperModel: cfg.whisper_model })); scores.score = Math.max(0, 1 - (scores.wer as number)); } catch { /* the signal is optional */ }
    }
  } else if (suite.kind === "video") out = await (md.video ?? makeVideo)(m.cli, m.model, text, base);
  else if (suite.kind === "transcribe") {
    const audio = join(suitesDir(vault), "media", item.audio ?? "");
    if (!item.audio || !existsSync(audio)) throw new Error(`audio file missing for ${item.id}`);
    const hyp = await (md.transcribe ?? transcribe)(m.cli, m.model, audio, { whisperModel: cfg.whisper_model });
    writeFileSync(`${base}.txt`, hyp);
    out = `${base}.txt`;
    scores.wer = wer(item.reference ?? "", hyp);
    scores.score = Math.max(0, 1 - (scores.wer as number));
    if (m.local) cost = 0;
  } else throw new Error(`a ${suite.kind} suite is run by hand (an app suite has no generator here)`);
  return { output_ref: file(out), cost, latency_ms: Date.now() - t0, ...head, ...(Object.keys(scores).length ? { scores } : {}) };
}

function scoreWer(items: SuiteItem[], models: ModelDef[], run: RunFile, tick: () => void, save: () => void) {
  for (const it of items) for (const [a, b] of pairsOf(models)) {
    const ca = run.by_item[it.id]?.[a.id];
    const cb = run.by_item[it.id]?.[b.id];
    tick();
    if (run.games.some((g) => g.item === it.id && g.a === a.id && g.b === b.id)) continue;
    if (typeof ca?.scores?.wer !== "number" || typeof cb?.scores?.wer !== "number") continue;
    const d = (ca.scores.wer as number) - (cb.scores.wer as number);
    run.games.push({ item: it.id, a: a.id, b: b.id, winner: Math.abs(d) < 0.02 ? "tie" : d < 0 ? "a" : "b", by: "wer", sa: ca.scores.score as number, sb: cb.scores.score as number });
  }
  save();
}

interface ScoreCtx {
  afford: (usd: number) => boolean;
  charge: (usd: number, m: ModelDef) => void;
  save: () => void;
  tick: () => void;
  limited: Set<string>;
  homeOf: (it: SuiteItem) => boolean;
  dir: string;
  cfg: ReturnType<typeof readConfig>;
  stopped: () => string | null;
}

async function scoreText(vault: string, suite: Suite, items: SuiteItem[], models: ModelDef[], pool0: ModelDef[], run: RunFile, o: RunOpts & { deps: RunDeps }, c: ScoreCtx) {
  const text = (itemId: string, m: ModelDef) => {
    const ref = run.by_item[itemId]?.[m.id]?.output_ref;
    return ref ? readFileSync(join(c.dir, ref), "utf8") : null;
  };
  // Named judges (the --judges flag, else config.judges) are the whole jury pool, so a tiny
  // model never fills a seat; with none named, any active text model may judge.
  const preferred = o.judges?.length ? o.judges : readConfig(vault).judges ?? [];
  const judgePool = pool0.filter((m) => m.kind === "text" && (preferred.length ? preferred.includes(m.id) : m.active !== false));
  const todo: { item: SuiteItem; a: ModelDef; b: ModelDef }[] = [];
  for (const item of items) for (const [a, b] of pairsOf(models)) todo.push({ item, a, b });
  for (const { item, a, b } of todo) {
    if (c.stopped() === "budget" || o.signal?.aborted) { c.tick(); continue; }
    if (run.games.some((g) => g.item === item.id && g.a === a.id && g.b === b.id)) { c.tick(); continue; }
    const ta = text(item.id, a);
    const tb = text(item.id, b);
    if (ta === null || tb === null) { c.tick(); continue; }
    const ka = run.by_item[item.id]![a.id]!.scores?.check as boolean | undefined;
    const kb = run.by_item[item.id]![b.id]!.scores?.check as boolean | undefined;
    const game = (g: Omit<Game, "item" | "a" | "b">) => { run.games.push({ item: item.id, a: a.id, b: b.id, ...g }); c.save(); c.tick(); };
    if (ta.trim() === tb.trim()) { game({ winner: "tie", by: "identical" }); continue; }
    // checks first: they decide with no judge and no cost
    if (item.check && ka !== undefined && kb !== undefined) { game({ winner: ka === kb ? "tie" : ka ? "a" : "b", by: "check" }); continue; }
    const home = c.homeOf(item);
    const jury = pickJury(judgePool, a, b, preferred, 2, home ? (m) => isLocalModel(m, c.cfg) : undefined);
    if (!jury.length) { run.notes!.push(`${item.id} ${a.id} vs ${b.id}: no judge from another family${home ? " (Home Only: a local one)" : ""}`); c.tick(); continue; }
    let spent = 0;
    try {
      const r = await judgePair(item, ta, tb, jury, async (j, prompt) => {
        if (c.limited.has(j.cli)) throw new Error(`${j.cli} is rate limited`);
        const est = j.local ? 0 : estimate(j, prompt.length);
        if (!c.afford(est)) throw new Error("budget");
        let rec: CallRecord;
        try { rec = await callModel(vault, { cli: j.cli, model: j.model, prompt, baseUrl: j.base_url, effort: j.effort }, o.deps); } catch (e) {
          // Only this judge's provider is limited: the rest of the jury carries on without it.
          if (e instanceof LimitError) { c.limited.add(j.cli); run.notes!.push(`judge limit: ${j.cli}: ${e.message.slice(0, 100)}`); throw new Error(`${j.cli} is rate limited`); }
          throw e;
        }
        const usd = rec.cached ? 0 : rec.cost_estimate;
        c.charge(usd, j);
        spent += usd;
        return rec;
      });
      if (r.failed.length && r.game.judges?.length) run.notes!.push(`${item.id} ${a.id} vs ${b.id}: ${r.failed.join("; ").slice(0, 200)}`);
      if (r.game.judges?.length) game({ ...r.game, cost_usd: Math.round(spent * 1e6) / 1e6 });
      else { run.notes!.push(`${item.id} ${a.id} vs ${b.id}: the jury could not judge (${r.failed.join("; ").slice(0, 200)})`); c.tick(); }
    } catch (e) {
      run.notes!.push(`${item.id} ${a.id} vs ${b.id}: ${(e as Error).message.slice(0, 120)}`);
      c.tick();
    }
  }
  c.save();
}

export function runStatus(vault: string, id?: string): RunFile | null {
  const runs = listRuns(vault);
  return id ? runs.find((r) => r.id === id) ?? null : runs.filter((r) => r.status === "running").pop() ?? runs.pop() ?? null;
}
