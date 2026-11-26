// Suites: ready-made sets of tests that run themselves. One file per suite in
// <vault>/build/_meta/arena/suites/<id>.json. Items carry their own prompt (or
// script, or audio), a rubric and, for text, the leak-check results; the pointer
// back to the vault note a test came from lives only in suites/.private-index.json.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arenaDir, readJson, writeJson } from "./store.ts";
import type { Check } from "./types.ts";

export type SuiteKind = "text" | "image" | "voice-tts" | "transcribe" | "video" | "app";
export const SUITE_KINDS: SuiteKind[] = ["text", "image", "voice-tts", "transcribe", "video", "app"];

export interface RubricLine {
  criterion: string;
  /** -10..10; negative lines are behaviour to avoid (met = points taken away). */
  points: number;
  type: "hard_fail" | "preference" | "quality";
}

export interface LeakCheck {
  pii?: number;
  canary?: boolean;
  max_ngram?: number;
  similarity?: number;
  reid?: "chance" | "above";
  approved?: boolean;
}

export interface SuiteItem {
  id: string;
  template_id?: string;
  prompt?: string;
  /** voice-tts: the words to read aloud */
  script?: string;
  /** transcribe: an audio file name inside suites/media/ */
  audio?: string;
  /** transcribe: the true transcript */
  reference?: string;
  inputs?: string[];
  rubric?: RubricLine[];
  reference_facts?: string[];
  decision_refs?: string[];
  /** a mechanical check decides the item before any judge */
  check?: Check;
  split?: "active" | "reserve";
  canary_id?: string;
  aspect?: string;
  leak?: LeakCheck;
}

export interface Suite {
  id: string;
  title: string;
  kind: SuiteKind;
  area: string;
  /** a vault domain, for the Home Only guard (health, money...) */
  domain?: string;
  schedule: "nightly" | "weekly" | "manual";
  items: SuiteItem[];
  created?: string;
  version?: number;
  last_swap?: string;
}

export function suitesDir(vault: string): string {
  const d = join(arenaDir(vault), "suites");
  mkdirSync(d, { recursive: true });
  return d;
}

const safeId = (id: string) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id)) throw new Error(`bad suite id "${id}"`);
  return id;
};

export function listSuites(vault: string): Suite[] {
  const d = suitesDir(vault);
  return readdirSync(d)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => readJson<Suite | null>(join(d, f), null))
    .filter((s): s is Suite => !!s && typeof s.id === "string" && Array.isArray(s.items))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function readSuite(vault: string, id: string): Suite {
  const p = join(suitesDir(vault), `${safeId(id)}.json`);
  if (!existsSync(p)) throw new Error(`no suite "${id}"`);
  return readJson<Suite>(p, null as unknown as Suite);
}

export function writeSuite(vault: string, s: Suite): void {
  if (!SUITE_KINDS.includes(s.kind)) throw new Error(`bad kind ${s.kind}`);
  writeJson(join(suitesDir(vault), `${safeId(s.id)}.json`), s);
}

/** What a run uses: active items, and for text only the ones Fru approved (or that
 * never needed approval: hand-written items carry no leak record). */
export function runnableItems(s: Suite): SuiteItem[] {
  return s.items.filter((i) => i.split !== "reserve" && (!i.leak || i.leak.approved !== false));
}

export function approve(vault: string, suiteId: string, itemId?: string): { suite: string; approved: number } {
  const s = readSuite(vault, suiteId);
  let n = 0;
  for (const i of s.items) {
    if (itemId && i.id !== itemId) continue;
    if (i.leak && i.leak.approved !== true) { i.leak.approved = true; n++; }
  }
  writeSuite(vault, s);
  return { suite: s.id, approved: n };
}

/** Monthly freshness (LiveBench style): a sixth of the active items go to the reserve
 * and the same number come back, oldest reserve first. Returns how many swapped. */
export function swapReserve(vault: string, s: Suite, now = new Date()): number {
  const active = s.items.filter((i) => i.split !== "reserve");
  const reserve = s.items.filter((i) => i.split === "reserve" && (!i.leak || i.leak.approved !== false));
  const n = Math.min(Math.floor(active.length / 6), reserve.length);
  if (n <= 0) return 0;
  for (const i of active.slice(0, n)) i.split = "reserve";
  for (const i of reserve.slice(0, n)) i.split = "active";
  // rotate so the next swap retires different items
  s.items = [...s.items.filter((i) => i.split !== "reserve"), ...s.items.filter((i) => i.split === "reserve")];
  s.last_swap = now.toISOString();
  writeSuite(vault, s);
  return n;
}
