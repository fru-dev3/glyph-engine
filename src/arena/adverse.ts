// The adverse-event register. Append-only; a lift is an event too, so the history
// of why a model was benched is never lost. Suspensions are derived, never stored.
import { appendLine, file, readAdverse } from "./store.ts";
import type { AdverseEvent, Suspension } from "./types.ts";

const DAY = 86_400_000;
export const SUSPEND_DAYS = 30;

/**
 * One severe event, or two major events within 30 days, suspends that model in
 * that domain for 30 days from the event that tipped it. Domain "*" covers all.
 * A later "lift" event for the same model and domain ends the suspension.
 */
export function suspensions(events: AdverseEvent[], now = Date.now()): Suspension[] {
  const keys = new Map<string, AdverseEvent[]>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const k = `${e.model}\u0001${e.domain}`;
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k)!.push(e);
  }
  const out: Suspension[] = [];
  for (const list of keys.values()) {
    let tipped: { at: number; why: string } | null = null;
    const majors: AdverseEvent[] = [];
    for (const e of list) {
      if (e.kind === "lift") { tipped = null; majors.length = 0; continue; }
      if (e.severity === "severe") tipped = { at: e.ts, why: `severe ${e.kind.replace("_", " ")}: ${e.what}` };
      else if (e.severity === "major") {
        majors.push(e);
        const recent = majors.filter((m) => e.ts - m.ts <= SUSPEND_DAYS * DAY);
        if (recent.length >= 2) tipped = { at: e.ts, why: `${recent.length} major events in 30 days, last: ${e.what}` };
      }
    }
    if (!tipped) continue;
    const until = tipped.at + SUSPEND_DAYS * DAY;
    if (until <= now) continue;
    out.push({ model: list[0]!.model, domain: list[0]!.domain, until: new Date(until).toISOString().slice(0, 10), why: tipped.why });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.domain.localeCompare(b.domain));
}

export function isSuspended(model: string, domain: string, s: Suspension[]): Suspension | null {
  return s.find((x) => x.model === model && (x.domain === "*" || x.domain === domain)) ?? null;
}

export function recordAdverse(vault: string, e: Omit<AdverseEvent, "ts"> & { ts?: number }): AdverseEvent {
  const ev: AdverseEvent = { ...e, ts: e.ts ?? Date.now(), what: e.what.slice(0, 400) };
  if (!ev.model || !ev.domain) throw new Error("an adverse event needs a model and a domain");
  appendLine(file(vault, "adverse.jsonl"), ev);
  return ev;
}

export const currentSuspensions = (vault: string, now = Date.now()) => suspensions(readAdverse(vault), now);
