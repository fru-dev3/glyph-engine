export const theme = {
  // Brand: office green, lifted for the dark terminal (#008000 on light).
  // Green, never gold.
  brand: "#3FA34D",
  brandDim: "#2A6E34",
  brandBright: "#B9F0B0",
  // aiAccent: high-contrast electric cyan, kept for AI-specific highlights.
  aiAccent: "#3CD8FF",
  aiAccentDim: "#1A9DC8",
  bg: "#0E0E0E",
  bgPanel: "#161616",
  fg: "#E6E6E6",
  fgDim: "#9A9A9A",
  fgFaint: "#5A5A5A",
  accent: "#3FA34D",
  warn: "#E08A3C",
  ok: "#7BB369",
  selBg: "#16261A",
  selFg: "#D8F5D2",
  border: "#3A3A3A",
  borderFocus: "#3FA34D",
  bubbleUser: "#3FA34D",
  bubbleAssistant: "#5F7A8C",
  bubbleSystem: "#3A3A3A",
  inputBorder: "#5F7A8C",
} as const;

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function spinnerChar(tick: number): string {
  return SPINNER[tick % SPINNER.length] ?? "·";
}

export const THINKING_WORDS = [
  "thinking",
  "pondering",
  "cogitating",
  "ruminating",
  "noodling",
  "brewing",
  "synthesizing",
  "musing",
  "deliberating",
  "marinating",
  "percolating",
  "reflecting",
  "reasoning",
  "weighing",
  "scheming",
  "untangling",
  "distilling",
  "composing",
  "considering",
  "calibrating",
  "drafting",
  "puzzling",
  "stewing",
  "tracing",
  "sketching",
  "wrangling",
  "channeling",
  "divining",
  "conjuring",
  "polishing",
] as const;

const WORD_TICKS = 12;

export function thinkingWord(tick: number): string {
  const idx = Math.floor(tick / WORD_TICKS) % THINKING_WORDS.length;
  return THINKING_WORDS[idx] ?? "thinking";
}
