// Glyph Arena: shared types. Arena tests RECIPES (model + prompt + vault context +
// tools), not bare models, on the user's own tasks, and writes a routing policy that
// Glyph Studio's Auto router follows. Everything is a plain file under
// <vault>/build/_meta/arena/ (see store.ts). Design: the vault note glyph-arena.md.

export type TaskKind = "drafting" | "decision" | "research" | "planning" | "video_script" | "coding" | "general";
export const TASK_KINDS: TaskKind[] = ["drafting", "decision", "research", "planning", "video_script", "coding", "general"];

/** Weight classes by difficulty (the engine's 1..5 difficulty, banded). */
export type Weight = "light" | "middle" | "heavy";
export const WEIGHTS: Weight[] = ["light", "middle", "heavy"];

export interface League {
  domain: string; // a life domain, or "*"
  kind: TaskKind | "*";
  weight: Weight | "*";
}

export type PromptStyle = "plain" | "concise" | "expert";
export type ContextMode = "none" | "domain";
export type ToolMode = "none" | "web";

export interface Recipe {
  id: string;
  label: string;
  cli: string; // engine CliKind: claude | codex | ollama | anthropic | openai | openrouter | ...
  model: string;
  /** Ollama / OpenAI-compatible endpoint, for local recipes. */
  baseUrl?: string;
  prompt: PromptStyle;
  context: ContextMode;
  tools: ToolMode;
  /** false = kept for history, not offered for new duels. */
  active?: boolean;
  added_at?: string;
  /** Where it came from: default, user, scout. */
  source?: string;
}

/** A mechanical checker: decides a duel with no human and no judge. */
export type Check =
  | { type: "keywords"; all: string[] }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "json"; keys?: string[] }
  | { type: "max_words"; n: number }
  | { type: "citations"; min: number }
  | { type: "number"; expect: number; tolerance?: number }
  | { type: "tests"; lang: "js"; code: string };

export interface ArenaTask {
  id: string;
  source: "ghost" | "canonical" | "sentinel" | "custom";
  domain: string;
  kind: TaskKind;
  weight: Weight;
  prompt: string;
  /** A known good answer (canonical questions): judged for alignment. */
  expected?: string;
  check?: Check;
  /** epoch ms of the original prompt, for ghost replays */
  ts?: number;
}

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface Side {
  recipe: string;
  ok: boolean;
  /** "error" | "budget" | "privacy" when ok=false */
  status?: string;
  error?: string;
  reply: string;
  ms: number;
  cost_usd: number;
  check?: CheckResult;
  judge?: number | null;
}

export type Outcome = "a" | "b" | "tie" | "pending" | "error";
export type DecidedBy = "check" | "agree" | "judge" | "pick" | "signal" | "none";

export interface Duel {
  id: string;
  ts: number;
  task: ArenaTask;
  league: League;
  a: Side;
  b: Side;
  similarity: number;
  outcome: Outcome;
  decided_by: DecidedBy;
  /** filled when a blind pick decided it */
  pick?: { winner: "a" | "b" | "tie"; ms: number; left: "a" | "b"; ts: number };
}

export interface Pick {
  ts: number;
  duel: string;
  winner: "a" | "b" | "tie";
  left: "a" | "b";
  ms: number;
}

export type Severity = "minor" | "major" | "severe";
export interface AdverseEvent {
  ts: number;
  model: string;
  domain: string; // "*" = every domain
  severity: Severity;
  kind: "hallucination" | "wrong_number" | "unsafe_advice" | "privacy" | "regression" | "other" | "lift";
  what: string;
  source: "pick" | "check" | "sentinel" | "manual" | "signal";
  duel?: string;
}

export interface Suspension {
  model: string;
  domain: string;
  until: string; // ISO date
  why: string;
}

export interface Signal {
  ts: number;
  domain: string;
  kind?: TaskKind;
  weight?: Weight;
  model: string;
  signal: "accept" | "edit" | "revert";
  /** for revert: the model the user switched to */
  to_model?: string;
  source: string;
}

export interface ArenaConfig {
  monthly_cap_usd: number;
  home_only: string[];
  /** Ollama / OpenAI-compatible endpoints allowed for the Home Only league. */
  home_endpoints: string[];
  /** Hosts besides loopback that count as home (e.g. a Mac mini on the home network). */
  home_hosts: string[];
  /** Ghost replays sampled per league per run. */
  replay_sample: number;
  /** Decided games a recipe needs before it can take a route. */
  min_games: number;
  /** 0 = Sunday ... 6 = Saturday */
  sentinel_day: number;
  /** Judge for tasks with a known answer: a recipe id, or "" for none. */
  judge: string;
  /** Run checker code tests (in a temp dir, no secrets in env, 10 s limit). */
  code_tests: boolean;
}

export type Verdict = "best" | "equivalent_cheaper" | "home_only" | "provisional";

export interface PolicyRoute {
  domain: string;
  kind: TaskKind | "*";
  weight: Weight | "*";
  recipe: string;
  cli: string;
  model: string;
  base_url?: string;
  prompt: PromptStyle;
  context: ContextMode;
  tools: ToolMode;
  verdict: Verdict;
  why: string;
  confidence: number;
  games: number;
  runner_up?: string;
  updated_at: string;
}

export interface Policy {
  schema: "glyph-arena/policy@1";
  generated_at: string;
  generator: string;
  routes: PolicyRoute[];
  suspended: Suspension[];
  home_only: string[];
  budget: { month: string; cap_usd: number; spent_usd: number };
  unblinding: { picks: number; agree: number; score: number | null };
}

export interface Standing {
  recipe: string;
  wins: number;
  losses: number;
  ties: number;
  games: number;
  rate: number; // ties count half
  lower: number; // Wilson lower bound
  cost_avg: number;
  ms_avg: number;
}
