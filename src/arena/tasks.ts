// Where duels come from: ghost replays of the user's own past prompts, canonical
// questions with a known answer, weekly sentinels, and custom tasks with checkers.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { listQuestions } from "../canonical-bench.ts";
import { loadCorpus } from "../prompt-corpus.ts";
import { classifyKind, classifyWeight } from "./classify.ts";
import { file, readJson } from "./store.ts";
import type { ArenaTask, TaskKind } from "./types.ts";

export const taskId = (prefix: string, text: string) =>
  `${prefix}-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;

// Prompts that only make sense inside their original conversation or repo are
// poor replays: they lean on an image, a paste, a file, or "the above".
const CONTEXT_BOUND = /\[image|<pasted|\bthe above\b|\bthis (file|repo|screenshot|page|branch|session)\b|\bas (i|we) (said|discussed)\b|^\s*\/\w|^\s*(yes|no|ok|okay|go|continue|do it|commit|push)\b/i;

export function replayable(text: string): boolean {
  const t = text.trim();
  if (t.length < 30 || t.length > 3000) return false;
  if (CONTEXT_BOUND.test(t)) return false;
  // mostly paths or code with no question
  if ((t.match(/\//g) ?? []).length > 12) return false;
  return true;
}

export function ghostTasks(vault: string, opts: { home?: string; limit?: number } = {}): ArenaTask[] {
  let prompts: ReturnType<typeof loadCorpus>["prompts"] = [];
  try { prompts = loadCorpus(vault, opts.home ?? homedir()).prompts; } catch { prompts = []; }
  const out: ArenaTask[] = [];
  const seen = new Set<string>();
  // Newest first; prompts typed into Studio (domain-tagged) lead.
  const ordered = [...prompts].sort((a, b) => (b.domain ? 1 : 0) - (a.domain ? 1 : 0) || b.ts - a.ts);
  for (const p of ordered) {
    if (!replayable(p.text)) continue;
    const key = p.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: taskId("ghost", p.text),
      source: "ghost",
      domain: p.domain || "general",
      kind: classifyKind(p.text),
      weight: classifyWeight(p.text),
      prompt: p.text.trim(),
      ts: p.ts,
    });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

export function canonicalTasks(vault: string): ArenaTask[] {
  let qs: ReturnType<typeof listQuestions> = [];
  try { qs = listQuestions(vault); } catch { qs = []; }
  return qs.map((q) => {
    const prompt = q.context ? `${q.prompt}\n\nContext:\n${q.context}` : q.prompt;
    return {
      id: `canon-${q.id}`,
      source: "canonical" as const,
      domain: q.domain || "general",
      kind: classifyKind(q.prompt) === "general" ? ("decision" as TaskKind) : classifyKind(q.prompt),
      weight: classifyWeight(prompt),
      prompt,
      ...(q.expected_decision ? { expected: q.expected_decision } : {}),
      ...(q.expected_verdict_keywords?.length ? { check: { type: "keywords" as const, all: q.expected_verdict_keywords } } : {}),
    };
  });
}

/** Six fixed, generic tasks with checkers. Weekly, on every routed recipe. */
export const SENTINELS: ArenaTask[] = [
  {
    id: "sentinel-ledger", source: "sentinel", domain: "*", kind: "general", weight: "light",
    prompt: "Line items: rent 1,450.00; utilities 212.37; internet 69.99; parking 118.50. What is the total? Reply with the number only.",
    check: { type: "number", expect: 1850.86, tolerance: 0.005 },
  },
  {
    id: "sentinel-json", source: "sentinel", domain: "*", kind: "general", weight: "light",
    prompt: 'Extract the vendor, date and amount from: "Paid Acme Plumbing $380 on 2026-03-14 for the water heater." Reply with JSON only, keys vendor, date, amount.',
    check: { type: "json", keys: ["vendor", "date", "amount"] },
  },
  {
    id: "sentinel-code", source: "sentinel", domain: "*", kind: "coding", weight: "middle",
    prompt: "Write a JavaScript function slugify(s) that lowercases the string, replaces every run of characters that are not a-z or 0-9 with one hyphen, and strips leading and trailing hyphens. Reply with only the code in one code block, no exports.",
    check: {
      type: "tests", lang: "js",
      code: [
        'if (slugify("  Hello, World! ") !== "hello-world") throw new Error("assert: basic");',
        'if (slugify("--Glyph   Arena--") !== "glyph-arena") throw new Error("assert: edges");',
        'if (slugify("a1_b2") !== "a1-b2") throw new Error("assert: underscore");',
      ].join("\n"),
    },
  },
  {
    id: "sentinel-brief", source: "sentinel", domain: "*", kind: "drafting", weight: "light",
    prompt: "Summarize in at most 40 words: The town council voted to repave Main Street next spring. Work starts in April and lasts six weeks. Shops stay open, but parking on Main Street is closed during the work, and a free shuttle runs from the library lot every fifteen minutes.",
    check: { type: "max_words", n: 40 },
  },
  {
    id: "sentinel-date", source: "sentinel", domain: "*", kind: "general", weight: "light",
    prompt: "What day of the week was 29 February 2024? Reply with one word.",
    check: { type: "keywords", all: ["thursday"] },
  },
  {
    id: "sentinel-format", source: "sentinel", domain: "*", kind: "general", weight: "light",
    prompt: "List three prime numbers between 50 and 70, separated by commas, and nothing else.",
    check: { type: "regex", pattern: "^\\s*(53|59|61|67)\\s*,\\s*(53|59|61|67)\\s*,\\s*(53|59|61|67)\\s*\\.?\\s*$" },
  },
];

export function customTasks(vault: string): ArenaTask[] {
  const raw = readJson<Partial<ArenaTask>[]>(file(vault, "tasks.json"), []);
  return raw
    .filter((t) => typeof t.prompt === "string" && t.prompt.trim())
    .map((t) => ({
      id: t.id || taskId("custom", t.prompt!),
      source: "custom" as const,
      domain: t.domain || "general",
      kind: t.kind || classifyKind(t.prompt!),
      weight: t.weight || classifyWeight(t.prompt!),
      prompt: t.prompt!,
      ...(t.expected ? { expected: t.expected } : {}),
      ...(t.check ? { check: t.check } : {}),
    }));
}

export type TaskSource = "ghost" | "canonical" | "sentinel" | "custom";

export function loadTasks(vault: string, source: TaskSource, opts: { home?: string } = {}): ArenaTask[] {
  if (source === "ghost") return ghostTasks(vault, { home: opts.home, limit: 400 });
  if (source === "canonical") return canonicalTasks(vault);
  if (source === "sentinel") return SENTINELS;
  return customTasks(vault);
}

/** Up to n tasks for a league, newest first, spread across kinds when the league is wide. */
export function sampleTasks(tasks: ArenaTask[], league: { domain: string; kind: string; weight: string }, n: number): ArenaTask[] {
  const fit = tasks.filter((t) =>
    (league.domain === "*" || t.domain === league.domain)
    && (league.kind === "*" || t.kind === league.kind)
    && (league.weight === "*" || t.weight === league.weight));
  if (league.kind !== "*") return fit.slice(0, n);
  const byKind = new Map<string, ArenaTask[]>();
  for (const t of fit) {
    if (!byKind.has(t.kind)) byKind.set(t.kind, []);
    byKind.get(t.kind)!.push(t);
  }
  const out: ArenaTask[] = [];
  while (out.length < n && [...byKind.values()].some((l) => l.length)) {
    for (const l of byKind.values()) {
      const t = l.shift();
      if (t) out.push(t);
      if (out.length >= n) break;
    }
  }
  return out;
}
