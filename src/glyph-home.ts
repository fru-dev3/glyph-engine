// glyph-home - the names Glyph Bot answers to, decided in one place.
//
// Glyph Bot is the new name of the engine that shipped as `prevail`. Stage 1 of
// the rename ADDS the new names beside the old ones and removes nothing:
//   home folder   GLYPH_HOME, then ~/.glyph if it exists, then ~/.prevail
//   command       `glyph-bot` and `prevail` are the same program
//   environment   GLYPH_X is accepted wherever PREVAIL_X is read (new wins)
// Nothing here creates or moves a folder.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const PRODUCT_NAME = "Glyph Bot";
export const COMMAND_NAME = "glyph-bot";
export const LEGACY_COMMAND_NAME = "prevail";

type Env = Record<string, string | undefined>;

/** The machine-local config folder. Pass `home` where a caller injects one. */
export function glyphHome(
  home: string = homedir(),
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const forced = env.GLYPH_HOME;
  if (forced && forced.length > 0) return forced;
  const next = join(home, ".glyph");
  return exists(next) ? next : join(home, ".prevail");
}

/** Make every PREVAIL_X read also see GLYPH_X. GLYPH_X wins when both are set.
 *  Runs once when this module loads; index.tsx imports it first. */
export function aliasGlyphEnv(env: Env = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GLYPH_") || key.length === 6 || value === undefined) continue;
    env[`PREVAIL_${key.slice(6)}`] = value;
  }
}

/** Which of the two command names started this process (default: the new one).
 *  Looks at each candidate path's file name, so a symlink or a bin shim works. */
export function invokedName(candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (!c) continue;
    const base = basename(c).replace(/\.(tsx?|js)$/, "");
    if (base === COMMAND_NAME || base === LEGACY_COMMAND_NAME) return base;
  }
  return COMMAND_NAME;
}

export function commandName(): string {
  return invokedName([process.argv[1], process.argv0, process.execPath]);
}

aliasGlyphEnv();
