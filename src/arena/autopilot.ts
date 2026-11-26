// Autopilot: once a day (a launchd job runs `autopilot tick`) look for new models,
// try each new one on ten items and, if it holds up, on the full suites against the
// current leader; run suites on their schedule; swap a sixth of each suite's items
// from the reserve once a month. Everything it spends is logged and capped by
// budget_monthly_usd, and the monthly cap in config still applies underneath.
import { type AdapterDeps } from "./adapters.ts";
import { addModel, makeModel, readModels, type ModelDef } from "./models.ts";
import { loadKeyFiles, providerKey } from "./media.ts";
import { ollamaModels } from "./recipes.ts";
import { computeRatings, listRuns, type RatingsFile } from "./ratings.ts";
import { runSuite, type RunDeps } from "./suite-run.ts";
import { appendLine, file, readConfig, readJson, writeJson } from "./store.ts";
import { listSuites, swapReserve, writeSuite, type Suite } from "./suites.ts";

export interface AutopilotState {
  on: boolean;
  check_at: string;
  budget_monthly_usd: number;
  last_check?: string;
  running: { run: string; done: number; total: number; cost_usd: number; eta_min: number } | null;
  queue: { when: string; what: string }[];
  log: { ts: string; what: string; cost_usd: number }[];
}

export const DEFAULT_AUTOPILOT: AutopilotState = { on: false, check_at: "06:00", budget_monthly_usd: 10, running: null, queue: [], log: [] };

export const readAutopilot = (vault: string): AutopilotState => ({ ...DEFAULT_AUTOPILOT, ...readJson<Partial<AutopilotState>>(file(vault, "autopilot.json"), {}) });
const writeAutopilot = (vault: string, s: AutopilotState) => writeJson(file(vault, "autopilot.json"), s);

export function setAutopilot(vault: string, patch: { on?: boolean; budget?: number; at?: string }): AutopilotState {
  const s = readAutopilot(vault);
  if (patch.on !== undefined) s.on = patch.on;
  if (patch.budget !== undefined) {
    if (!(patch.budget >= 0)) throw new Error("budget must be a number >= 0");
    s.budget_monthly_usd = patch.budget;
  }
  if (patch.at !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.at)) throw new Error("--at must be HH:MM");
    s.check_at = patch.at;
  }
  s.queue = buildQueue(vault, s);
  writeAutopilot(vault, s);
  return s;
}

const monthOf = (iso: string) => iso.slice(0, 7);
export const autopilotSpent = (s: AutopilotState, now: Date) => s.log.filter((l) => monthOf(l.ts) === monthOf(now.toISOString())).reduce((a, l) => a + l.cost_usd, 0);

const lastRun = (vault: string, suite: string): number => Math.max(0, ...listRuns(vault).filter((r) => r.suite === suite).map((r) => Date.parse(r.started) || 0));

export function buildQueue(vault: string, _s: AutopilotState, now = new Date()): { when: string; what: string }[] {
  const q: { when: string; what: string }[] = [];
  for (const su of listSuites(vault)) {
    if (su.kind === "app") continue;
    if (su.schedule === "nightly") q.push({ when: "Tonight", what: `${su.title}` });
    else if (su.schedule === "weekly") {
      const days = Math.max(0, 7 - Math.floor((now.getTime() - lastRun(vault, su.id)) / 86_400_000));
      q.push({ when: days === 0 ? "Tonight" : `In ${days} day${days === 1 ? "" : "s"}`, what: su.title });
    }
  }
  return q;
}

// ---- model lists ------------------------------------------------------------

export type Lists = Record<string, string[]>;

/** Every provider's model list we can reach. A list that fails is left out, not treated as empty. */
export async function fetchLists(vault: string, deps: AdapterDeps = {}): Promise<Lists> {
  const f = deps.fetch ?? fetch;
  const cfg = readConfig(vault);
  const out: Lists = {};
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await f(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as any;
  };
  for (const u of cfg.home_endpoints) {
    const m = await ollamaModels(u);
    if (m.length) out[`ollama@${u}`] = m;
  }
  try { out.openrouter = ((await get("https://openrouter.ai/api/v1/models")).data ?? []).map((m: { id: string }) => m.id); } catch { /* offline */ }
  const ok = providerKey("openai");
  if (ok) try { out.openai = ((await get("https://api.openai.com/v1/models", { authorization: `Bearer ${ok}` })).data ?? []).map((m: { id: string }) => m.id); } catch { /* key or net */ }
  const gk = providerKey("google");
  if (gk) try { out.google = ((await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": gk })).models ?? []).map((m: { name: string }) => m.name.replace(/^models\//, "")); } catch { /* key or net */ }
  return out;
}

/** A listed model we can actually run, or null. OpenRouter names map onto the CLI that serves that vendor. */
export function runnableFor(list: string, id: string): ModelDef | null {
  const skip = /embed|tts|image|audio|realtime|transcribe|whisper|moderation|vision|live|aqa|imagen|veo|search|instruct|dall/i;
  if (list.startsWith("ollama@")) return /embed|bge|minilm/i.test(id) ? null : makeModel({ cli: "ollama", model: id, baseUrl: list.slice(7) });
  const openrouter = list === "openrouter";
  const [vendor, rest] = openrouter ? id.split("/", 2) as [string, string] : ["", id];
  if (skip.test(rest ?? id) || id.includes(":free")) return null;
  if ((openrouter && vendor === "anthropic") || (!openrouter && /^claude-/.test(id))) return /^claude-/.test(rest) ? makeModel({ cli: "claude", model: rest.replace(/\./g, "-") }) : null;
  if ((openrouter && vendor === "openai") || list === "openai") return /^gpt-/.test(rest) ? makeModel({ cli: "codex", model: rest }) : null;
  if ((openrouter && vendor === "google") || list === "google") return /^gemini-/.test(rest) ? makeModel({ cli: "google", model: rest }) : null;
  return null;
}

export interface TickResult { skipped?: string; new_models: string[]; trials: string[]; runs: string[]; swapped: Record<string, number>; spent_usd: number; log: string[] }

export interface TickOpts { deps?: RunDeps; now?: Date; force?: boolean; lists?: Lists; onRun?: (e: { run: string; done: number; total: number; cost_usd: number }) => void }

export async function tick(vault: string, o: TickOpts = {}): Promise<TickResult> {
  const now = o.now ?? new Date();
  const cfg = readConfig(vault);
  if (cfg.env_files?.length) loadKeyFiles(cfg.env_files);
  const st = readAutopilot(vault);
  const res: TickResult = { new_models: [], trials: [], runs: [], swapped: {}, spent_usd: 0, log: [] };
  if (!st.on && !o.force) return { ...res, skipped: "autopilot is off" };
  if (st.last_check && st.last_check.slice(0, 10) === now.toISOString().slice(0, 10) && !o.force) return { ...res, skipped: "already checked today" };
  const log = (what: string, cost = 0) => { st.log.push({ ts: now.toISOString(), what, cost_usd: Math.round(cost * 1e6) / 1e6 }); res.log.push(what); res.spent_usd += cost; };
  const remaining = () => st.budget_monthly_usd - autopilotSpent(st, now);
  const start = Date.now();
  const progress = (e: { run: string; done: number; total: number; cost_usd: number }) => {
    const rate = e.done > 0 ? (Date.now() - start) / e.done : 0;
    st.running = { run: e.run, done: e.done, total: e.total, cost_usd: e.cost_usd, eta_min: Math.round(((e.total - e.done) * rate) / 60000) };
    writeAutopilot(vault, st);
    o.onRun?.(e);
  };
  const go = async (suite: Suite, models: string[], opts: { maxItems?: number; label?: string }) => {
    const r = await runSuite(vault, { suite: suite.id, models, budgetUsd: Math.max(0, remaining()), deps: o.deps, onProgress: progress, now, ...opts });
    st.running = null;
    log(`${opts.label ? "trial" : "run"} ${suite.title} (${models.join(", ")}): ${r.status}`, r.cost_usd);
    res.runs.push(r.id);
    return r;
  };

  // 1. new models
  const lists = o.lists ?? (await fetchLists(vault, o.deps));
  const catalog = readJson<Record<string, Record<string, string>>>(file(vault, "catalog.json"), {});
  const have = new Set(readModels(vault).map((m) => m.id));
  const fresh: ModelDef[] = [];
  for (const [list, ids] of Object.entries(lists)) {
    const known = catalog[list];
    if (!known) { catalog[list] = Object.fromEntries(ids.map((i) => [i, now.toISOString()])); log(`first look at ${list}: ${ids.length} models noted`); continue; }
    for (const id of ids) {
      if (known[id]) continue;
      known[id] = now.toISOString();
      const m = runnableFor(list, id);
      appendLine(file(vault, "scout.jsonl"), { ts: now.toISOString(), list, id, runnable: m?.id ?? null });
      if (m && !have.has(m.id) && !fresh.some((f) => f.id === m.id)) fresh.push(m);
    }
  }
  writeJson(file(vault, "catalog.json"), catalog);
  for (const m of fresh.slice(0, 3)) {
    addModel(vault, { ...m, active: false, first_seen: now.toISOString() });
    res.new_models.push(m.id);
    log(`new model: ${m.id} (${m.cli})`);
  }

  // 2. a ten-item trial per new model, then full suites against the leader
  const textSuites = listSuites(vault).filter((s) => s.kind === "text");
  for (const id of res.new_models) {
    if (remaining() <= 0 || !textSuites.length) { log(`no budget or no text suite: ${id} waits`); continue; }
    const ratings = readJson<RatingsFile | null>(file(vault, "ratings.json"), null);
    const leaderOf = (s: Suite) => ratings?.areas.find((a) => a.suite === s.id)?.models.find((m) => m.allowed && m.model !== id)?.model
      ?? readModels(vault).find((m) => m.kind === "text" && m.active !== false && m.id !== id)?.id;
    const per = Math.max(1, Math.ceil(10 / textSuites.length));
    const wins = { w: 0, n: 0 };
    for (const s of textSuites) {
      const lead = leaderOf(s);
      if (!lead) continue;
      const r = await go(s, [id, lead], { maxItems: per, label: "trial" });
      for (const g of r.games) { wins.n++; wins.w += g.a === id ? (g.winner === "a" ? 1 : g.winner === "tie" ? 0.5 : 0) : (g.winner === "b" ? 1 : g.winner === "tie" ? 0.5 : 0); }
    }
    res.trials.push(id);
    if (wins.n === 0) { log(`trial of ${id} produced no games; not promoted`); continue; }
    const share = wins.w / wins.n;
    log(`trial ${id}: ${wins.w}/${wins.n} points`);
    if (share < 0.3) { log(`${id} did not hold up in the trial; stays off`); continue; }
    addModel(vault, { ...readModels(vault).find((m) => m.id === id)!, active: true });
    for (const s of textSuites) { const lead = leaderOf(s); if (lead && remaining() > 0) await go(s, [id, lead], {}); }
  }

  // 3. suites on their schedule
  for (const s of listSuites(vault)) {
    if (s.kind === "app" || s.schedule === "manual") continue;
    const age = (now.getTime() - lastRun(vault, s.id)) / 86_400_000;
    if (s.schedule === "weekly" && age < 7) continue;
    if (s.schedule === "nightly" && age < 0.9) continue;
    if (remaining() <= 0) { log(`skipped ${s.title}: the autopilot budget is spent`); continue; }
    try { await go(s, [], {}); } catch (e) { log(`${s.title}: ${(e as Error).message.slice(0, 120)}`); }
  }

  // 4. the monthly reserve swap
  for (const s of listSuites(vault)) {
    if (s.last_swap && monthOf(s.last_swap) === monthOf(now.toISOString())) continue;
    if (!s.last_swap) { // first month: stamp it so the swap starts next month
      writeSuite(vault, { ...s, last_swap: now.toISOString() });
      continue;
    }
    const n = swapReserve(vault, s, now);
    if (n) { res.swapped[s.id] = n; log(`swapped ${n} items in ${s.title} from the reserve`); }
  }

  computeRatings(vault, now.toISOString());
  st.last_check = now.toISOString();
  st.running = null;
  st.queue = buildQueue(vault, st, now);
  st.log = st.log.slice(-200);
  writeAutopilot(vault, st);
  return res;
}
