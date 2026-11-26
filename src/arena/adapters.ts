// One adapter per model runtime, one record shape out. The agent CLIs are driven
// headless with tools off and the model named explicitly; Ollama and Google go over
// HTTP. Every call is cached by hash(cli, version, model, prompt, settings), runs one
// at a time per CLI, and backs off when the CLI says it is rate limited.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalCliKind, priceForOrDefault, estimateTokens } from "../model-pricing.ts";
import { providerKey } from "./media.ts";
import { arenaDir, readJson, writeJson } from "./store.ts";

export interface CallRecord {
  text: string;
  /** input + output tokens (a CLI's own system prompt included, as billed) */
  tokens: number;
  tokens_in: number;
  tokens_out: number;
  /** USD, an estimate: the CLI's own figure when it reports one, else tokens x the price table */
  cost_estimate: number;
  latency_ms: number;
  cli: string;
  cli_version: string;
  model: string;
  cached?: boolean;
}

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (bin: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<ExecResult>;

export interface AdapterDeps {
  exec?: Exec;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** back-off waits in ms, one per retry */
  backoff?: number[];
  timeoutMs?: number;
}

export interface CallInput {
  cli: string;
  model: string;
  prompt: string;
  baseUrl?: string;
  /** anything that changes the answer (temperature...) joins the cache key */
  settings?: Record<string, unknown>;
  cache?: boolean;
}

/** The limit wording the CLIs and APIs use. */
export const LIMIT_RE = /\b429\b|rate.?limit|usage limit|hit your limit|quota|overloaded|too many requests|try again (later|in)|resource.?exhausted/i;

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

const realExec: Exec = (bin, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    // stdin "ignore": codex waits forever on an open pipe.
    const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); stderr += "\ntimeout"; }, timeoutMs);
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: String(e.message) }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, stderr }); });
  });

/** Calls to one CLI run one at a time: they share one login and one limit. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => undefined));
  return run;
}

const versions = new Map<string, string>();
export function clearVersionCache(): void { versions.clear(); }

async function cliVersion(cli: string, baseUrl: string | undefined, d: Required<Pick<AdapterDeps, "exec" | "fetch">>): Promise<string> {
  const k = `${cli}@${baseUrl ?? ""}`;
  const hit = versions.get(k);
  if (hit) return hit;
  let v = "unknown";
  try {
    if (cli === "ollama") {
      const r = await d.fetch(`${(baseUrl ?? "http://localhost:11434").replace(/\/+$/, "")}/api/version`, { signal: AbortSignal.timeout(8000) });
      v = String(((await r.json()) as { version?: string }).version ?? "unknown");
    } else if (cli === "google") v = "api-v1beta";
    else {
      const r = await d.exec(binFor(cli), ["--version"], { cwd: tmpdir(), timeoutMs: 15_000 });
      v = r.stdout.trim().split("\n")[0]?.slice(0, 60) || "unknown";
    }
  } catch { /* unknown stays */ }
  versions.set(k, v);
  return v;
}

const binFor = (cli: string) => ({ claude: "claude", codex: "codex", gemini: "gemini" } as Record<string, string>)[cli] ?? cli;

const stripThink = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

function firstJson(s: string): any {
  const i = s.indexOf("{");
  if (i < 0) throw new Error(`no JSON in output: ${s.slice(0, 200)}`);
  return JSON.parse(s.slice(i));
}

const priced = (cli: string, model: string, tin: number, tout: number): number => {
  if (isLocalCliKind(cli)) return 0;
  const p = priceForOrDefault(cli, model);
  return (tin / 1e6) * p.inUsd + (tout / 1e6) * p.outUsd;
};

type Parsed = Pick<CallRecord, "text" | "tokens_in" | "tokens_out"> & { cost?: number };

// ---- the four adapters' parsers (pure, so the tests feed them recorded output) ----

export function parseClaude(stdout: string): Parsed {
  const j = firstJson(stdout);
  if (j.is_error) throw new Error(String(j.result ?? "claude error").slice(0, 300));
  // modelUsage names every model that ran (a hidden second model shows up here), so sum it.
  const mu = Object.values(j.modelUsage ?? {}) as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }[];
  let tin = 0, tout = 0, cost = 0;
  for (const m of mu) {
    tin += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
    tout += m.outputTokens ?? 0;
    cost += m.costUSD ?? 0;
  }
  if (!mu.length) { tin = j.usage?.input_tokens ?? 0; tout = j.usage?.output_tokens ?? 0; cost = j.total_cost_usd ?? 0; }
  return { text: String(j.result ?? "").trim(), tokens_in: tin, tokens_out: tout, cost: cost || (j.total_cost_usd ?? 0) };
}

export function parseCodex(stdout: string): Parsed {
  let text = "";
  let tin = 0, tout = 0;
  let err = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "item.completed" && e.item?.type === "agent_message") text += `${text ? "\n" : ""}${e.item.text ?? ""}`;
    else if (e.type === "turn.completed") { tin += e.usage?.input_tokens ?? 0; tout += (e.usage?.output_tokens ?? 0) + (e.usage?.reasoning_output_tokens ?? 0); }
    else if (e.type === "error" || e.type === "turn.failed") err = String(e.message ?? e.error?.message ?? "codex error");
  }
  if (!text && err) throw new Error(err.slice(0, 300));
  return { text: text.trim(), tokens_in: tin, tokens_out: tout };
}

export function parseGemini(stdout: string): Parsed {
  const j = firstJson(stdout);
  if (j.error) throw new Error(String(j.error.message ?? j.error).slice(0, 300));
  let tin = 0, tout = 0;
  for (const m of Object.values(j.stats?.models ?? {}) as { tokens?: { prompt?: number; candidates?: number; input?: number } }[]) {
    tin += m.tokens?.prompt ?? m.tokens?.input ?? 0;
    tout += m.tokens?.candidates ?? 0;
  }
  return { text: String(j.response ?? "").trim(), tokens_in: tin, tokens_out: tout };
}

async function viaCli(cli: string, model: string, prompt: string, d: Required<Pick<AdapterDeps, "exec" | "timeoutMs">>): Promise<Parsed> {
  const cwd = mkdtempSync(join(tmpdir(), "arena-call-"));
  try {
    // Tools off, model explicit, an empty working folder, no session kept.
    const args = cli === "claude"
      ? ["-p", prompt, "--output-format", "json", "--model", model, "--tools", "", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", "You are a helpful assistant. Answer the user directly."]
      : cli === "codex"
        ? ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-m", model, "-C", cwd, prompt]
        : ["-p", prompt, "--output-format", "json", "-m", model];
    const r = await d.exec(binFor(cli), args, { cwd, timeoutMs: d.timeoutMs });
    if (r.code === 127) throw new Error(`${cli} is not installed here`);
    const both = `${r.stdout}\n${r.stderr}`;
    let parsed: Parsed;
    try {
      parsed = cli === "claude" ? parseClaude(r.stdout) : cli === "codex" ? parseCodex(r.stdout) : parseGemini(r.stdout);
    } catch (e) {
      if (LIMIT_RE.test(both)) throw new LimitError(both.trim().slice(0, 300));
      throw new Error(`${cli} failed (exit ${r.code}): ${(e as Error).message || r.stderr.slice(0, 200)}`);
    }
    if (!parsed.text) {
      if (LIMIT_RE.test(both)) throw new LimitError(both.trim().slice(0, 300));
      throw new Error(`${cli}: empty reply (exit ${r.code}) ${r.stderr.slice(0, 160)}`);
    }
    return parsed;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function viaOllama(model: string, prompt: string, baseUrl: string | undefined, d: Required<Pick<AdapterDeps, "fetch" | "timeoutMs">>): Promise<Parsed> {
  const res = await d.fetch(`${(baseUrl ?? "http://localhost:11434").replace(/\/+$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // think:false: a thinking model (qwen3) otherwise spends all 2048 tokens inside <think> and
    // never writes the answer; models without thinking ignore it.
    body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0, num_predict: 2048 } }),
    signal: AbortSignal.timeout(d.timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
  const j = JSON.parse(body) as { response?: string; prompt_eval_count?: number; eval_count?: number };
  return { text: stripThink(j.response ?? ""), tokens_in: j.prompt_eval_count ?? estimateTokens(prompt.length), tokens_out: j.eval_count ?? 0 };
}

async function viaGoogle(model: string, prompt: string, d: Required<Pick<AdapterDeps, "fetch" | "timeoutMs">>): Promise<Parsed> {
  const k = providerKey("google");
  if (!k) throw new Error("no Google key on this Mac");
  const res = await d.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": k },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
    signal: AbortSignal.timeout(d.timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 429) throw new LimitError(`HTTP 429: ${body.slice(0, 200)}`);
    throw new Error(`google HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = JSON.parse(body) as any;
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
  return { text, tokens_in: j.usageMetadata?.promptTokenCount ?? 0, tokens_out: (j.usageMetadata?.candidatesTokenCount ?? 0) + (j.usageMetadata?.thoughtsTokenCount ?? 0) };
}

export const cacheKey = (cli: string, version: string, model: string, prompt: string, settings: unknown): string =>
  createHash("sha256").update(JSON.stringify([cli, version, model, prompt, settings ?? {}])).digest("hex");

/** The one entry point: a model, a prompt, a record. Throws LimitError after the back-offs are spent. */
export async function callModel(vault: string, input: CallInput, deps: AdapterDeps = {}): Promise<CallRecord> {
  const d = {
    exec: deps.exec ?? realExec,
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    backoff: deps.backoff ?? [15_000, 45_000, 120_000],
    timeoutMs: deps.timeoutMs ?? 240_000,
  };
  const { cli, model, prompt } = input;
  const version = await cliVersion(cli, input.baseUrl, d);
  const key = cacheKey(cli, version, model, prompt, input.settings);
  const cdir = join(arenaDir(vault), "cache");
  const cpath = join(cdir, `${key}.json`);
  if (input.cache !== false && existsSync(cpath)) {
    const hit = readJson<CallRecord | null>(cpath, null);
    if (hit?.text) return { ...hit, cached: true };
  }
  return serial(cli, async () => {
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      try {
        const p = cli === "ollama" ? await viaOllama(model, prompt, input.baseUrl, d)
          : cli === "google" ? await viaGoogle(model, prompt, d)
          : ["claude", "codex", "gemini"].includes(cli) ? await viaCli(cli, model, prompt, d)
          : (() => { throw new Error(`no adapter for ${cli}`); })();
        if (!p.text) throw new Error("empty reply");
        const rec: CallRecord = {
          text: p.text, tokens: p.tokens_in + p.tokens_out, tokens_in: p.tokens_in, tokens_out: p.tokens_out,
          cost_estimate: Math.round((p.cost ?? priced(cli, model, p.tokens_in, p.tokens_out)) * 1e6) / 1e6,
          latency_ms: Date.now() - t0, cli, cli_version: version, model,
        };
        if (input.cache !== false) { mkdirSync(cdir, { recursive: true }); writeJson(cpath, rec); }
        return rec;
      } catch (e) {
        const limited = e instanceof LimitError || LIMIT_RE.test((e as Error).message);
        if (!limited) throw e;
        if (attempt >= d.backoff.length) throw new LimitError((e as Error).message);
        await d.sleep(d.backoff[attempt]!);
      }
    }
  });
}
