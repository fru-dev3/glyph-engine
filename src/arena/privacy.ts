// The Home Only league: health and money tasks run on local models only. This is a
// hard guard, checked again right before every model call (run.ts), not a filter
// the UI is trusted to apply.
import { isLocalCliKind } from "../model-pricing.ts";
import { readManifest } from "../manifest.ts";
import { looksHomeOnly } from "./classify.ts";
import type { ArenaConfig, ArenaTask, Recipe } from "./types.ts";

export class HomeOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeOnlyViolation";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Is this endpoint on this Mac or on a host the user listed as home? */
export function isHomeEndpoint(url: string | undefined, cfg: Pick<ArenaConfig, "home_hosts">): boolean {
  if (!url) return false;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (LOOPBACK.has(host)) return true;
  return cfg.home_hosts.map((h) => h.toLowerCase()).includes(host);
}

/** Local = a local engine kind AND, for HTTP engines, an endpoint at home. */
export function isLocalRecipe(r: Recipe, cfg: Pick<ArenaConfig, "home_hosts">): boolean {
  if (!isLocalCliKind(r.cli)) return false;
  return isHomeEndpoint(r.baseUrl ?? "http://localhost:11434", cfg);
}

function manifestLocalOnly(vault: string, domain: string): boolean {
  try {
    return !!readManifest(vault, domain)?.privacy?.localOnly;
  } catch {
    return false;
  }
}

/** Home Only: a listed domain, a localOnly manifest, or a prompt that reads as health/money. */
export function isHomeOnlyTask(task: Pick<ArenaTask, "domain" | "prompt">, cfg: Pick<ArenaConfig, "home_only">, vault?: string): boolean {
  const d = (task.domain || "").toLowerCase();
  if (d && cfg.home_only.map((x) => x.toLowerCase()).includes(d)) return true;
  if (vault && d && d !== "*" && manifestLocalOnly(vault, d)) return true;
  if (!d || d === "*" || d === "general") return looksHomeOnly(task.prompt);
  return false;
}

/** Throws before any byte leaves the machine. Called by the runner for every side. */
export function assertRecipeAllowed(task: Pick<ArenaTask, "domain" | "prompt">, recipe: Recipe, cfg: ArenaConfig, vault?: string): void {
  if (!isHomeOnlyTask(task, cfg, vault)) return;
  if (!isLocalRecipe(recipe, cfg)) {
    throw new HomeOnlyViolation(
      `Home Only: "${task.domain || "this task"}" runs on local models only; ${recipe.label} (${recipe.cli}) was refused and nothing was sent.`,
    );
  }
}

/** Recipes a task may use. */
export function allowedRecipes(task: Pick<ArenaTask, "domain" | "prompt">, recipes: Recipe[], cfg: ArenaConfig, vault?: string): Recipe[] {
  if (!isHomeOnlyTask(task, cfg, vault)) return recipes;
  return recipes.filter((r) => isLocalRecipe(r, cfg));
}
