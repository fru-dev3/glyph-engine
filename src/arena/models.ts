// The model registry: models.json lists every model Arena can run, with the CLI or
// provider that runs it. Not recipes (a recipe adds a prompt style and context): a
// model is what ratings are about.
import { spawnSync } from "node:child_process";
import { detectRuntimes, prettyModel, slug } from "./recipes.ts";
import { isLocalRecipe } from "./privacy.ts";
import { mediaKeyPresent, whisperBin, whisperModel } from "./media.ts";
import { file, readConfig, readJson, writeJson } from "./store.ts";
import type { ArenaConfig, Recipe } from "./types.ts";
import type { SuiteKind } from "./suites.ts";

export interface ModelDef {
  id: string;
  label: string;
  /** claude | codex | gemini | ollama | google (API) for text; openai | google | replicate | whisper for media */
  cli: string;
  /** what the CLI or provider is told */
  model: string;
  provider: string;
  local: boolean;
  first_seen: string;
  mono: string;
  kind: SuiteKind;
  base_url?: string;
  /** false = kept, not run by autopilot or `run` without --models */
  active?: boolean;
  /** reasoning effort the CLI is told (claude --effort, codex model_reasoning_effort): the same model at two efforts is two contestants */
  effort?: string;
}

export const PROVIDER_OF: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google", google: "google", openai: "openai", ollama: "ollama", replicate: "replicate", whisper: "local" };

/** "claude-haiku-4-5" -> "haiku-4.5", "qwen3:0.6b" -> "qwen3-0.6b". Stable, short, file-name safe. */
export function modelId(model: string): string {
  const m = model.split("/").pop()!.replace(/^claude-/, "");
  return slug(m.replace(/(\d)-(\d)/g, "$1.$2"));
}

/** The company behind a model: judges must come from a different family than both contestants. */
export function familyOf(d: Pick<ModelDef, "cli" | "model">): string {
  const c = d.cli.toLowerCase();
  if (c === "claude" || c === "anthropic") return "anthropic";
  if (c === "codex" || c === "openai") return "openai";
  if (c === "gemini" || c === "google" || c === "antigravity") return "google";
  const m = d.model.toLowerCase();
  if (/claude/.test(m)) return "anthropic";
  if (/^gpt|^o\d|openai/.test(m)) return "openai";
  if (/gemini|gemma/.test(m)) return "google";
  if (/llama/.test(m)) return "meta";
  if (/qwen|qwq/.test(m)) return "alibaba";
  if (/mistral|mixtral|ministral/.test(m)) return "mistral";
  if (/phi/.test(m)) return "microsoft";
  if (/deepseek/.test(m)) return "deepseek";
  if (m.includes("/")) return m.split("/")[0]!;
  return m.split(/[:-]/)[0] || m;
}

export const readModels = (vault: string): ModelDef[] => readJson<{ models: ModelDef[] }>(file(vault, "models.json"), { models: [] }).models;
export const writeModels = (vault: string, models: ModelDef[]) => writeJson(file(vault, "models.json"), { models });

export function makeModel(o: { cli: string; model: string; kind?: SuiteKind; baseUrl?: string; active?: boolean; now?: string; effort?: string }): ModelDef {
  const kind = o.kind ?? "text";
  const effort = o.effort?.trim().toLowerCase() || undefined;
  const base = modelId(o.model) + (effort ? `-${effort}` : "");
  return {
    id: kind === "text" ? (o.cli === "google" ? `${base}-api` : base) : `${base}-${kind === "voice-tts" ? "tts" : kind}`,
    label: prettyModel(o.model) + (effort ? ` (${effort})` : ""),
    cli: o.cli,
    model: o.model,
    provider: PROVIDER_OF[o.cli] ?? o.cli,
    local: o.cli === "ollama" || o.cli === "whisper",
    first_seen: o.now ?? new Date().toISOString(),
    mono: (base[0] ?? "?").toUpperCase(),
    kind,
    ...(o.baseUrl ? { base_url: o.baseUrl } : {}),
    active: o.active ?? true,
    ...(effort ? { effort } : {}),
  };
}

export function addModel(vault: string, m: ModelDef): ModelDef[] {
  const list = readModels(vault);
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = { ...m, first_seen: list[i]!.first_seen };
  else list.push(m);
  writeModels(vault, list);
  return list;
}

/** A model name from the command line: an id, or "cli:model" for one not registered yet. */
export function resolveModel(list: ModelDef[], spec: string): ModelDef {
  const hit = list.find((m) => m.id === spec) ?? list.find((m) => m.model === spec);
  if (hit) return hit;
  const i = spec.indexOf(":");
  if (i > 0 && ["claude", "codex", "gemini", "ollama", "google"].includes(spec.slice(0, i))) return makeModel({ cli: spec.slice(0, i), model: spec.slice(i + 1) });
  throw new Error(`no model "${spec}" (see: models list; or pass cli:model)`);
}

/** Local, and at home: the Home Only league may use it. */
export const isLocalModel = (m: Pick<ModelDef, "cli" | "base_url">, cfg: Pick<ArenaConfig, "home_hosts">): boolean =>
  isLocalRecipe({ cli: m.cli, baseUrl: m.base_url } as Recipe, cfg);

const onPath = (bin: string) => spawnSync("/usr/bin/which", [bin], { encoding: "utf8" }).status === 0;

/** Register what this Mac can run: the CLIs on PATH, Ollama's models, and media models for each key on disk.
 * Never removes or overwrites a model already listed. Returns the models added. */
export async function refreshModels(vault: string, now = new Date().toISOString()): Promise<ModelDef[]> {
  const cfg = readConfig(vault);
  const have = readModels(vault);
  const found: ModelDef[] = [];
  for (const rt of await detectRuntimes(cfg)) {
    if (rt.cli === "antigravity") continue;
    if (rt.cli === "gemini" && !onPath("gemini")) continue;
    for (const m of rt.models.slice(0, rt.local ? 8 : 3)) found.push(makeModel({ cli: rt.cli, model: m, baseUrl: rt.baseUrl, now }));
  }
  if (mediaKeyPresent("google")) found.push(makeModel({ cli: "google", model: "gemini-3.8-flash", now, active: false }));
  const media: [string, string, SuiteKind][] = [
    ["openai", "gpt-image-1", "image"], ["google", "gemini-2.5-flash-image", "image"], ["replicate", "black-forest-labs/flux-schnell", "image"],
    ["openai", "gpt-4o-mini-tts", "voice-tts"], ["google", "gemini-2.5-flash-preview-tts", "voice-tts"],
    ["openai", "whisper-1", "transcribe"],
  ];
  for (const [p, m, k] of media) if (mediaKeyPresent(p)) found.push(makeModel({ cli: p, model: m, kind: k, now }));
  if (whisperBin() && whisperModel()) found.push(makeModel({ cli: "whisper", model: "local", kind: "transcribe", now }));
  const added = found.filter((f, i) => !have.some((h) => h.id === f.id) && found.findIndex((x) => x.id === f.id) === i);
  if (added.length) writeModels(vault, [...have, ...added]);
  return added;
}
