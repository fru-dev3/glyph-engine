// Arena's plain files: <vault>/build/_meta/arena/*. Encryption-aware through the
// engine's vault-session helpers, so an encrypted vault stays encrypted.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimePath } from "../path-safety.ts";
import { vappendLine, vreadFile, vwriteFileAtomic } from "../vault-session.ts";
import type { AdverseEvent, ArenaConfig, Duel, Pick, Recipe, Signal } from "./types.ts";

export function arenaDir(vault: string): string {
  const dir = join(runtimePath(vault, "_meta"), "arena");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const file = (vault: string, name: string) => join(arenaDir(vault), name);

/** The vault: --vault, then PREVAIL_VAULT, then ~/.prevail/config.json vaultPath. */
export function resolveArenaVault(flag?: string | null): string | null {
  if (flag) return flag;
  if (process.env.PREVAIL_VAULT) return process.env.PREVAIL_VAULT;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".prevail", "config.json"), "utf8")) as { vaultPath?: string };
    if (cfg.vaultPath && existsSync(cfg.vaultPath)) return cfg.vaultPath;
  } catch { /* no config */ }
  return null;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(vreadFile(path)) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  vwriteFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  let raw = "";
  try { raw = vreadFile(path); } catch { return []; }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip a torn line */ }
  }
  return out;
}

export function appendLine(path: string, value: unknown): void {
  vappendLine(path, `${JSON.stringify(value)}\n`);
}

// Default Home Only league: health and the money domains. A domain whose manifest
// says privacy.localOnly joins it too (privacy.ts).
export const DEFAULT_HOME_ONLY = ["health", "money", "wealth", "tax", "insurance", "benefits", "estate", "real-estate"];

export const DEFAULT_CONFIG: ArenaConfig = {
  monthly_cap_usd: 10,
  home_only: DEFAULT_HOME_ONLY,
  home_endpoints: ["http://localhost:11434"],
  home_hosts: [],
  replay_sample: 6,
  min_games: 3,
  sentinel_day: 0,
  judge: "",
  code_tests: true,
};

export function readConfig(vault: string): ArenaConfig {
  const c = readJson<Partial<ArenaConfig>>(file(vault, "config.json"), {});
  return { ...DEFAULT_CONFIG, ...c };
}

export function writeConfig(vault: string, patch: Partial<ArenaConfig>): ArenaConfig {
  const next = { ...readConfig(vault), ...patch };
  if (!(next.monthly_cap_usd >= 0)) throw new Error("monthly_cap_usd must be a number >= 0");
  writeJson(file(vault, "config.json"), next);
  return next;
}

export const readRecipes = (vault: string) => readJson<Recipe[]>(file(vault, "recipes.json"), []);
export const writeRecipes = (vault: string, r: Recipe[]) => writeJson(file(vault, "recipes.json"), r);

/** Duels are append-only; a later line for the same id (a pick) supersedes it. */
export function readDuels(vault: string): Duel[] {
  const byId = new Map<string, Duel>();
  for (const d of readLines<Duel>(file(vault, "duels.jsonl"))) byId.set(d.id, d);
  return [...byId.values()].sort((x, y) => x.ts - y.ts);
}
export const appendDuel = (vault: string, d: Duel) => appendLine(file(vault, "duels.jsonl"), d);
export const readPicks = (vault: string) => readLines<Pick>(file(vault, "picks.jsonl"));
export const readAdverse = (vault: string) => readLines<AdverseEvent>(file(vault, "adverse.jsonl"));
export const readSignals = (vault: string) => readLines<Signal>(file(vault, "signals.jsonl"));
