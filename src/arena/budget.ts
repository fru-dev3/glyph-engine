// The monthly spend cap. Checked BEFORE every cloud call with the engine's price
// table; a call that would cross the cap is skipped (status "budget"), not failed.
import { estimateTokens, isLocalCliKind, priceForOrDefault } from "../model-pricing.ts";
import { appendLine, file, readLines } from "./store.ts";

export const monthKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 7);

/** Assumed reply size for the pre-flight estimate (a long-ish answer). */
export const ASSUMED_REPLY_CHARS = 3200;

export function estimateUsd(cli: string, model: string, promptChars: number, replyChars = ASSUMED_REPLY_CHARS): number {
  if (isLocalCliKind(cli)) return 0;
  const p = priceForOrDefault(cli, model);
  return (estimateTokens(promptChars) / 1e6) * p.inUsd + (estimateTokens(replyChars) / 1e6) * p.outUsd;
}

interface SpendLine { ts: number; usd: number; recipe: string; model: string }

export function monthSpend(vault: string, ts = Date.now()): number {
  const m = monthKey(ts);
  const sum = readLines<SpendLine>(file(vault, "spend.jsonl"))
    .filter((l) => monthKey(l.ts) === m)
    .reduce((a, l) => a + (Number.isFinite(l.usd) ? l.usd : 0), 0);
  return Math.round(sum * 1e6) / 1e6;
}

export function canSpend(spent: number, estimate: number, cap: number): boolean {
  if (estimate <= 0) return true;
  return spent + estimate <= cap;
}

export function recordSpend(vault: string, usd: number, recipe: string, model: string): void {
  if (usd <= 0) return;
  appendLine(file(vault, "spend.jsonl"), { ts: Date.now(), usd: Math.round(usd * 1e6) / 1e6, recipe, model });
}
