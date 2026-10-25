// Recipes = model + prompt style + vault context + tools. Defaults come from what
// this Mac can actually run: the agent CLIs on PATH, Ollama on the home endpoints,
// and direct API providers with a key.
import { DIRECT_PROVIDERS, detectSubprocessClis, type AvailableCli, type CliKind } from "../cli-bridge.ts";
import { isLocalCliKind } from "../model-pricing.ts";
import { readRecipes, writeRecipes } from "./store.ts";
import type { ArenaConfig, ContextMode, PromptStyle, Recipe, ToolMode } from "./types.ts";

export const PROMPT_STYLES: Record<PromptStyle, string> = {
  plain: "",
  concise: "Answer directly and briefly. Lead with the answer; no preamble, no recap.\n\n",
  expert: "You are a careful senior expert. Think the problem through, state assumptions, and give a concrete, actionable answer.\n\n",
};

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");

/** "claude-haiku-4-5" -> "Haiku 4.5", "gpt-6-luna" -> "GPT-6 Luna"; others as they are. */
export function prettyModel(model: string): string {
  const m = model.split("/").pop()!;
  const c = m.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/i);
  if (c) return `${c[1]![0]!.toUpperCase()}${c[1]!.slice(1)} ${c[2]}${c[3] ? `.${c[3]}` : ""}`;
  const g = m.match(/^gpt-([\d.]+)(?:-(\w+))?$/i);
  if (g) return `GPT-${g[1]}${g[2] ? ` ${g[2]![0]!.toUpperCase()}${g[2]!.slice(1)}` : ""}`;
  return m;
}

export function makeRecipe(r: { cli: string; model: string; baseUrl?: string; prompt?: PromptStyle; context?: ContextMode; tools?: ToolMode; label?: string; source?: string }): Recipe {
  const prompt = r.prompt ?? "plain";
  const context = r.context ?? "none";
  const tools = r.tools ?? "none";
  const short = r.model.split("/").pop()!.replace(/^claude-/, "");
  const id = slug([r.cli, short, prompt === "plain" ? "" : prompt, context === "none" ? "" : "ctx", tools === "none" ? "" : tools].filter(Boolean).join("-"));
  const extra = [prompt !== "plain" ? prompt : "", context !== "none" ? "+ vault" : "", tools !== "none" ? "+ web" : ""].filter(Boolean).join(" ");
  const name = prettyModel(r.model);
  return {
    id,
    label: r.label ?? `${name}${extra ? ` ${extra}` : ""}`,
    cli: r.cli,
    model: r.model,
    ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
    prompt,
    context,
    tools,
    active: true,
    added_at: new Date().toISOString(),
    source: r.source ?? "user",
  };
}

/** Ollama models at one endpoint (embedding models left out). Empty when it is down. */
export async function ollamaModels(baseUrl: string, timeoutMs = 1500): Promise<string[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: ctl.signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name).filter((n) => !/embed|bge|minilm/i.test(n));
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

export interface Runtime { cli: string; label: string; models: string[]; baseUrl?: string; local: boolean }

export async function detectRuntimes(cfg: ArenaConfig): Promise<Runtime[]> {
  const out: Runtime[] = [];
  for (const c of detectSubprocessClis()) {
    if (!["claude", "codex", "antigravity", "gemini"].includes(c.kind)) continue;
    const models = c.kind === "claude" ? ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5-5"]
      : c.kind === "codex" ? ["gpt-6-luna", "gpt-6-sol"]
      : ["Gemini 3.8 Flash (Medium)"];
    out.push({ cli: c.kind, label: c.label, models, local: false });
  }
  for (const url of cfg.home_endpoints) {
    const models = await ollamaModels(url);
    if (models.length) out.push({ cli: "ollama", label: `Ollama ${new URL(url).hostname}`, models, baseUrl: url, local: true });
  }
  for (const p of DIRECT_PROVIDERS) {
    if (process.env[p.keyEnv]) out.push({ cli: p.id, label: p.label, models: p.models.slice(0, 3), local: false });
  }
  return out;
}

/** First run: two cloud recipes and every local model found. Never overwrites. */
export async function ensureRecipes(vault: string, cfg: ArenaConfig): Promise<Recipe[]> {
  const have = readRecipes(vault);
  if (have.length) return have;
  const rts = await detectRuntimes(cfg);
  const seed: Recipe[] = [];
  for (const rt of rts) {
    const picks = rt.local ? rt.models.slice(0, 4) : rt.models.slice(0, 2);
    for (const m of picks) seed.push(makeRecipe({ cli: rt.cli, model: m, baseUrl: rt.baseUrl, source: "default" }));
  }
  const uniq = [...new Map(seed.map((r) => [r.id, r])).values()];
  if (uniq.length) writeRecipes(vault, uniq);
  return uniq;
}

export function addRecipe(vault: string, r: Recipe): Recipe[] {
  const list = readRecipes(vault).filter((x) => x.id !== r.id);
  list.push(r);
  writeRecipes(vault, list);
  return list;
}

export function setRecipeActive(vault: string, id: string, active: boolean): Recipe[] {
  const list = readRecipes(vault).map((r) => (r.id === id ? { ...r, active } : r));
  writeRecipes(vault, list);
  return list;
}

/** The engine's runtime handle for a recipe. Subprocess CLIs resolve from PATH. */
export function cliFor(r: Recipe): AvailableCli | null {
  if (r.cli === "ollama") return { kind: "ollama", bin: r.baseUrl ?? "http://localhost:11434", label: "Ollama" };
  const p = DIRECT_PROVIDERS.find((d) => d.id === r.cli);
  if (p) return process.env[p.keyEnv] ? { kind: p.id as CliKind, bin: p.baseUrl, label: p.label } : null;
  if (r.cli === "openrouter") return process.env.PREVAIL_OPENROUTER_KEY ? { kind: "openrouter", bin: "https://openrouter.ai/api/v1", label: "OpenRouter" } : null;
  return detectSubprocessClis().find((c) => c.kind === r.cli) ?? null;
}

export const isLocal = (r: Recipe) => isLocalCliKind(r.cli);
