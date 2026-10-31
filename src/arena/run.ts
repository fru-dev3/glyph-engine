// Duels and ghost replays. Two recipes answer the same task; the cheapest honest
// signal decides it: a checker, then agreement, then a judge for a known answer,
// otherwise the duel waits for a two-second blind pick.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatTurn } from "../cli-bridge.ts";
import { resolveDomainDir } from "../path-safety.ts";
import { resolveStatePath, stripFrontmatter } from "../vault.ts";
import { vreadFile } from "../vault-session.ts";
import { isSuspended, currentSuspensions } from "./adverse.ts";
import { canSpend, estimateUsd, monthSpend, recordSpend } from "./budget.ts";
import { runCheck } from "./checkers.ts";
import { assertRecipeAllowed, HomeOnlyViolation, isHomeOnlyTask, isLocalRecipe } from "./privacy.ts";
import { blockedReason, cliFor, PROMPT_STYLES } from "./recipes.ts";
import { AGREE_AT, similarity } from "./score.ts";
import { appendDuel, readConfig, readRecipes } from "./store.ts";
import type { ArenaConfig, ArenaTask, DecidedBy, Duel, Outcome, Recipe, Side } from "./types.ts";

const CONTEXT_CAP = 4000;

/** A recipe in this duel cannot run here at all. Raised before anything is spent. */
export class ArenaUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaUnavailable";
  }
}

/** The recipe's own vault context: the domain's ideal and current state, capped. */
export function domainContext(vault: string, domain: string): string {
  if (!domain || domain === "*" || domain === "general") return "";
  const dir = resolveDomainDir(vault, domain);
  const parts: string[] = [];
  const ideal = join(dir, "ideal-state.md");
  if (existsSync(ideal)) parts.push(stripFrontmatter(vreadFile(ideal)).trim());
  const state = resolveStatePath(dir);
  if (state) parts.push(stripFrontmatter(vreadFile(state)).trim());
  const body = parts.filter(Boolean).join("\n\n").slice(0, CONTEXT_CAP);
  return body ? `Context from the user's ${domain} notes:\n${body}\n\n---\n\n` : "";
}

export function framePrompt(vault: string, task: ArenaTask, r: Recipe, cfg: ArenaConfig): string {
  let ctx = "";
  if (r.context === "domain") {
    // A cloud recipe never receives Home Only notes, even if a caller skipped the guard.
    const home = isHomeOnlyTask({ domain: task.domain, prompt: "" }, cfg, vault);
    if (!home || isLocalRecipe(r, cfg)) ctx = domainContext(vault, task.domain);
  }
  return `${PROMPT_STYLES[r.prompt]}${ctx}${task.prompt}`;
}

// The engine returns provider failures as the reply text ("(anthropic: HTTP 401 ...)",
// "(ollama: fetch failed)") so one panelist cannot sink a council. In a duel that
// text is not an answer: grading it would book a broken key as a lost game.
const PROVIDER_ERROR = /^\((?:[a-z][\w.-]{1,24}): [\s\S]{0,600}\)\s*$/i;
const QUOTA = /usage limit|rate limit|quota|too many requests|insufficient (credit|balance|funds)|please try again later|not logged in|please run \/login|invalid api key/i;

export function providerError(reply: string): string | null {
  const t = reply.trim();
  if (PROVIDER_ERROR.test(t)) return t.slice(1, -1).slice(0, 300);
  if (t.length < 300 && QUOTA.test(t)) return t.slice(0, 300);
  return null;
}

// Is the local endpoint there? /api/tags answers in milliseconds on an idle box, but
// a Mac that is already answering a duel can take seven seconds to list its models -
// a short probe called it offline and threw good duels away. So: a long probe, a
// remembered yes for a minute, and a remembered no for only ten seconds, because a
// busy neighbour is back long before an unplugged one.
const endpointSeen = new Map<string, { at: number; state: EndpointState }>();
export const ENDPOINT_PROBE_MS = 12_000;
/** "up" answered, "busy" took too long to answer, "down" refused the connection. */
export type EndpointState = "up" | "busy" | "down";

export async function endpointState(baseUrl: string): Promise<EndpointState> {
  const hit = endpointSeen.get(baseUrl);
  if (hit && Date.now() - hit.at < (hit.state === "up" ? 60_000 : 10_000)) return hit.state;
  let state: EndpointState;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(ENDPOINT_PROBE_MS) });
    state = res.ok ? "up" : "busy";
  } catch (e) {
    // A machine that is not there refuses at once; one that is busy keeps us waiting.
    // Only the first is offline - the second is exactly the machine we came to ask.
    state = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError" ? "busy" : "down";
  }
  endpointSeen.set(baseUrl, { at: Date.now(), state });
  return state;
}

export const endpointUp = async (baseUrl: string): Promise<boolean> => (await endpointState(baseUrl)) !== "down";

/** A local model gets this long per answer; a cloud call is bounded by its runtime. */
export const LOCAL_TIMEOUT_MS = 240_000;

export interface Caller {
  (args: { recipe: Recipe; prompt: string; cwd: string; signal?: AbortSignal }): Promise<string>;
}

/** The real model call: bare + incognito, from an empty folder, web off unless the recipe asks. */
export const engineCall: Caller = async ({ recipe, prompt, cwd, signal }) => {
  const cli = cliFor(recipe);
  if (!cli) throw new Error(`${recipe.cli} is not available on this Mac`);
  return runChatTurn({
    prompt,
    cwd,
    cli,
    model: recipe.model,
    isFirst: true,
    bare: true,
    incognito: true,
    webAccess: recipe.tools === "web" ? "allow" : "deny",
    maxOutputChars: 20_000,
    signal,
  });
};

export async function answerOne(vault: string, task: ArenaTask, r: Recipe, cfg: ArenaConfig, call: Caller, signal?: AbortSignal, localTimeoutMs = LOCAL_TIMEOUT_MS): Promise<Side> {
  const side: Side = { recipe: r.id, ok: false, reply: "", ms: 0, cost_usd: 0 };
  try {
    assertRecipeAllowed(task, r, cfg, vault);
  } catch (e) {
    if (e instanceof HomeOnlyViolation) return { ...side, status: "privacy", error: e.message };
    throw e;
  }
  const blocked = call === engineCall ? blockedReason(r) : null;
  if (blocked) return { ...side, status: "unavailable", error: blocked };
  const suspended = isSuspended(r.model, task.domain, currentSuspensions(vault));
  if (suspended) return { ...side, status: "suspended", error: `suspended until ${suspended.until}: ${suspended.why}` };
  const prompt = framePrompt(vault, task, r, cfg);
  const est = estimateUsd(r.cli, r.model, prompt.length);
  if (!canSpend(monthSpend(vault), est, cfg.monthly_cap_usd)) {
    return { ...side, status: "budget", error: `skipped: would pass the $${cfg.monthly_cap_usd} monthly cap` };
  }
  if (r.cli === "ollama" && call === engineCall && (await endpointState(r.baseUrl ?? "http://localhost:11434")) === "down") {
    return { ...side, status: "offline", error: `${r.baseUrl ?? "localhost"} is not there` };
  }
  const cwd = mkdtempSync(join(tmpdir(), "arena-"));
  const t0 = Date.now();
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener("abort", stop);
  // A local model that runs out of time has not answered: whatever text came back is
  // the beginning of a sentence. Grading it would let a loaded machine lose a duel and
  // write that loss into the policy, so a timed-out side is an error, like any other.
  let timedOut = false;
  const timer = r.cli === "ollama" ? setTimeout(() => { timedOut = true; stop(); }, localTimeoutMs) : null;
  try {
    // Reasoning models (qwen3, deepseek-r1) put their scratch work in <think> tags: not the answer.
    const reply = (await call({ recipe: r, prompt, cwd, signal: ctl.signal })).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const ms = Date.now() - t0;
    if (timedOut) return { ...side, status: "timeout", error: `no answer in ${Math.round(localTimeoutMs / 1000)}s`, ms };
    const failed = providerError(reply);
    if (failed) return { ...side, status: "error", error: failed, ms };
    if (!reply) return { ...side, status: "error", error: "empty reply", ms };
    const cost = estimateUsd(r.cli, r.model, prompt.length, reply.length);
    recordSpend(vault, cost, r.id, r.model);
    const out: Side = { recipe: r.id, ok: true, reply, ms, cost_usd: Math.round(cost * 1e6) / 1e6 };
    if (task.check) out.check = runCheck(task.check, reply, { codeTests: cfg.code_tests });
    return out;
  } catch (e) {
    if (timedOut) return { ...side, status: "timeout", error: `no answer in ${Math.round(localTimeoutMs / 1000)}s`, ms: Date.now() - t0 };
    return { ...side, status: "error", error: (e as Error).message.slice(0, 300), ms: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    rmSync(cwd, { recursive: true, force: true });
  }
}

const JUDGE = [
  "You are scoring an answer against the decision the user actually made and stands behind.",
  "Reply with exactly one line: SCORE: <integer 0-10>",
  "10 = recommends that decision with sound reasons; 5 = could be read either way; 0 = recommends the opposite or will not commit.",
].join("\n");

async function judgeScore(vault: string, task: ArenaTask, reply: string, judge: Recipe, cfg: ArenaConfig, call: Caller, signal?: AbortSignal): Promise<number | null> {
  const t: ArenaTask = { ...task, prompt: `${JUDGE}\n\nQUESTION:\n${task.prompt}\n\nTHE USER'S DECISION:\n${task.expected}\n\nANSWER:\n${reply.slice(0, 8000)}` };
  const side = await answerOne(vault, { ...t, check: undefined }, judge, cfg, call, signal);
  if (!side.ok) return null;
  const m = side.reply.match(/SCORE:\s*(\d{1,2})/i) ?? side.reply.trim().match(/^(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 10 ? n : null;
}

/** Decide a duel from its two sides. Pure, apart from the optional judge scores already on the sides. */
export function decide(task: ArenaTask, a: Side, b: Side): { outcome: Outcome; by: DecidedBy; sim: number } {
  if (!a.ok || !b.ok) return { outcome: "error", by: "none", sim: 0 };
  const sim = similarity(a.reply, b.reply);
  // A checker decides outright: one passes and the other fails, or both land the same.
  if (a.check && b.check) {
    if (a.check.pass !== b.check.pass) return { outcome: a.check.pass ? "a" : "b", by: "check", sim };
    return { outcome: "tie", by: "check", sim };
  }
  if (sim >= AGREE_AT) return { outcome: "tie", by: "agree", sim };
  if (typeof a.judge === "number" && typeof b.judge === "number") {
    const d = a.judge - b.judge;
    return { outcome: Math.abs(d) < 2 ? "tie" : d > 0 ? "a" : "b", by: "judge", sim };
  }
  return { outcome: "pending", by: "none", sim };
}

export interface DuelOpts {
  call?: Caller;
  signal?: AbortSignal;
  now?: number;
  /** How long a local model gets per answer. Only the tests set it. */
  localTimeoutMs?: number;
}

export async function runDuel(vault: string, task: ArenaTask, ra: Recipe, rb: Recipe, opts: DuelOpts = {}): Promise<Duel> {
  const cfg = readConfig(vault);
  const call = opts.call ?? engineCall;
  // One side that cannot run makes the duel undecidable, so the other side never
  // gets asked and never costs anything. A side the Home Only guard refuses is
  // reported as that refusal instead: it is the more useful answer, and it spends
  // nothing either way.
  const refused = (r: Recipe) => {
    try { assertRecipeAllowed(task, r, cfg, vault); return false; } catch { return true; }
  };
  if (call === engineCall && !refused(ra) && !refused(rb)) {
    const stop = blockedReason(ra) ?? blockedReason(rb);
    if (stop) throw new ArenaUnavailable(stop);
  }
  const sameHost = ra.cli === "ollama" && rb.cli === "ollama" && (ra.baseUrl ?? "") === (rb.baseUrl ?? "");
  const [a, b] = sameHost
    ? [await answerOne(vault, task, ra, cfg, call, opts.signal, opts.localTimeoutMs), await answerOne(vault, task, rb, cfg, call, opts.signal, opts.localTimeoutMs)]
    : await Promise.all([answerOne(vault, task, ra, cfg, call, opts.signal, opts.localTimeoutMs), answerOne(vault, task, rb, cfg, call, opts.signal, opts.localTimeoutMs)]);

  let pre = decide(task, a, b);
  if (pre.outcome === "pending" && task.expected && cfg.judge) {
    const judge = readRecipes(vault).find((r) => r.id === cfg.judge);
    if (judge) {
      a.judge = await judgeScore(vault, task, a.reply, judge, cfg, call, opts.signal);
      b.judge = await judgeScore(vault, task, b.reply, judge, cfg, call, opts.signal);
      pre = decide(task, a, b);
    }
  }
  const ts = opts.now ?? Date.now();
  const duel: Duel = {
    id: `d-${ts.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    ts,
    task,
    league: { domain: task.domain, kind: task.kind, weight: task.weight },
    a,
    b,
    similarity: pre.sim,
    outcome: pre.outcome,
    decided_by: pre.by,
  };
  appendDuel(vault, duel);
  return duel;
}

export interface ReplayOpts extends DuelOpts {
  onProgress?: (e: { done: number; total: number; duel?: Duel; note?: string }) => void;
}

/** Run each task as a duel between two recipes. Sides that may not run a task are skipped, not failed. */
export async function runReplay(vault: string, tasks: ArenaTask[], ra: Recipe, rb: Recipe, opts: ReplayOpts = {}): Promise<Duel[]> {
  const cfg = readConfig(vault);
  const call = opts.call ?? engineCall;
  const blocked = call === engineCall ? (blockedReason(ra) ?? blockedReason(rb)) : null;
  if (blocked) throw new ArenaUnavailable(blocked);
  const out: Duel[] = [];
  let done = 0;
  for (const t of tasks) {
    if (opts.signal?.aborted) break;
    const home = isHomeOnlyTask(t, cfg, vault);
    if (home && (!isLocalRecipe(ra, cfg) || !isLocalRecipe(rb, cfg))) {
      done++;
      opts.onProgress?.({ done, total: tasks.length, note: `skipped ${t.id}: Home Only, needs two local recipes` });
      continue;
    }
    const d = await runDuel(vault, t, ra, rb, opts);
    out.push(d);
    done++;
    opts.onProgress?.({ done, total: tasks.length, duel: d });
  }
  return out;
}
