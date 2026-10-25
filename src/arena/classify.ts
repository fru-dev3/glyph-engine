// Task kind and weight class from a prompt. Free heuristics, no model call, so the
// same prompt always lands in the same league (Studio's lookup depends on that).
import { deriveHeuristics } from "../model-routing.ts";
import { difficultyBand } from "../route-learning.ts";
import type { TaskKind, Weight } from "./types.ts";

const RULES: [TaskKind, RegExp][] = [
  ["coding", /```|\b(code|function|bug|stack ?trace|typescript|javascript|python|rust|swift|sql|regex|compile|refactor|unit tests?|api endpoint|npm|git)\b/i],
  ["video_script", /\b(video|youtube|script|voice ?over|b-?roll|thumbnail|episode|scene|shot list|narration)\b/i],
  ["decision", /\b(should i|should we|which (one|is better)|decide|decision|worth it|pros and cons|or not|vs\.?|versus)\b/i],
  ["research", /\b(research|find out|look up|sources?|citations?|compare|what is known|evidence|studies|market)\b/i],
  ["planning", /\b(plan|schedule|roadmap|itinerary|steps to|timeline|milestones?|checklist|agenda|week of)\b/i],
  ["drafting", /\b(write|draft|rewrite|email|post|letter|blog|caption|tweet|linkedin|bio|reply to|message to|essay|chapter)\b/i],
];

export function classifyKind(prompt: string): TaskKind {
  for (const [kind, re] of RULES) if (re.test(prompt)) return kind;
  return "general";
}

export function classifyWeight(prompt: string): Weight {
  const band = difficultyBand(deriveHeuristics(prompt).difficultyPrior);
  return band === "light" ? "light" : band === "hard" ? "heavy" : "middle";
}

// A prompt with no domain that reads as health or money is treated as Home Only.
// A false positive keeps a harmless prompt on a local model; a false negative would
// send private data to a cloud model, so this leans wide on purpose.
const HOME_SNIFF = /\b(health|medical|medication|medicine|diagnos\w*|symptoms?|doctor|clinic|therapy|therapist|prescription|dosage|blood (test|pressure)|lab results?|insurance|claim number|bank|account number|routing number|salary|paycheck|net worth|portfolio|401\s?k|ira\b|roth|tax(es)? return|irs\b|w-?2|1099|mortgage|loan|credit (card|score)|ssn|social security|invoice|budget|rent roll|estate|will and trust|beneficiar\w*)\b/i;

export function looksHomeOnly(prompt: string): boolean {
  return HOME_SNIFF.test(prompt);
}
