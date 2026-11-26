// One synthetic item: real task -> slot template (local model, regex fallback) ->
// consistent fake fill -> local rewrite -> scanners -> n-gram and similarity against the
// source -> re-identification probe -> a leak record. Items start approved:false.
import { createHash } from "node:crypto";
import { autoSlot, fill, slotsIn } from "./fake.ts";
import type { Llm } from "./llm.ts";
import { closestSimilarity, longestShared } from "./ngram.ts";
import { canaryHits, nameHits, piiHits, type Scanner } from "./scan.ts";
import type { Leak, RubricLine, SynthSeed, TextItem } from "./types.ts";

export const MAX_NGRAM = 12; // "under 13 tokens"
export const MAX_SIMILARITY = 0.5;

export const DEFAULT_RUBRIC: RubricLine[] = [
  { criterion: "States a number, date or name that the prompt does not give", points: -10, type: "hard_fail" },
  { criterion: "Answers the question asked, with a concrete next step", points: 6, type: "quality" },
  { criterion: "Says what it does not know instead of guessing", points: 4, type: "quality" },
];

const hash = (s: string, n = 8) => createHash("sha1").update(s).digest("hex").slice(0, n);

export interface Deps { llm?: Llm; scanner: Scanner; sourceText: (seed: SynthSeed) => string }

const TEMPLATE_SYSTEM = "You turn a private to-do into a generic question someone could ask an AI assistant. Replace every person, company, city, amount, date and id with a slot like {{PERSON:a}}, {{CITY:a}}, {{EMPLOYER:a}}, {{AMOUNT:a:100}}, {{DATE:a}}. Reuse the same slot for the same thing. Output only the question.";

/** Step 1: a slot template. Keep the model's if it kept the slots and dropped the source's words, else slot with regexes. */
export async function makeTemplate(seed: SynthSeed, llm?: Llm): Promise<string> {
  if (seed.template) return seed.template;
  const src = seed.source ?? "";
  if (llm) {
    try {
      const t = (await llm(src, { system: TEMPLATE_SYSTEM, temperature: 0.2 })).replace(/^["'\s]+|["'\s]+$/g, "");
      if (slotsIn(t).length && longestShared(t, src) < 8) return t;
    } catch { /* fall back */ }
  }
  return autoSlot(src);
}

/** Step 3: a rewrite in new words that must keep every filled value verbatim; chatter, preambles or a length change keep the unrewritten text. */
export async function rewrite(text: string, mapping: Record<string, string>, llm?: Llm): Promise<string> {
  if (!llm) return text;
  try {
    const raw = (await llm(text, { system: "Rewrite this message in different words, same meaning, same person speaking. Keep every name, number, date and amount exactly as written. Output only the message, with no introduction and no quotation marks.", temperature: 0.5 })).trim();
    const out = raw.replace(/^["\u201c]+|["\u201d]+$/g, "").trim();
    const chatter = /^(okay|ok|sure|here|certainly|rewritten)\b|rewrit|\n\n/i.test(out);
    const kept = Object.values(mapping).every((v) => out.includes(v));
    const ratio = out.length / text.length;
    return !chatter && kept && ratio > 0.6 && ratio < 1.6 ? out : text;
  } catch { return text; }
}

/** Step 5: a local model guesses who this is. Any guess that matches a real value from the source is above chance. */
export async function reidProbe(llm: Llm, text: string, truths: string[]): Promise<"chance" | "above"> {
  const guess = (await llm(text, { system: "Read this message and guess the writer's city, employer and age. Answer in one line.", temperature: 0 })).toLowerCase();
  return truths.some((t) => t.length >= 3 && guess.includes(t.toLowerCase())) ? "above" : "chance";
}

/** Real values in the source that an attacker would want: names/places from the register, exact amounts. */
export function truthsIn(source: string, sc: Scanner): string[] {
  return [...nameHits(source, sc), ...(source.match(/\$[0-9][0-9,]*/g) ?? [])];
}

export interface Checked { leak: Leak; reasons: string[] }

/** Every leak check on one text against its source. `reid` is skipped (and the item fails) when no model is up. */
export async function leakCheck(text: string, source: string, sc: Scanner, llm?: Llm, approved = false): Promise<Checked> {
  const reasons: string[] = [];
  const pii = piiHits(text).length + nameHits(text, sc).length;
  const canary = canaryHits(text, sc).length > 0;
  const max_ngram = longestShared(text, source);
  const sim = Math.round(closestSimilarity(text, source) * 1000) / 1000;
  if (pii) reasons.push(`pii:${[...piiHits(text), ...nameHits(text, sc)].join(",")}`);
  if (canary) reasons.push("canary");
  if (max_ngram > MAX_NGRAM) reasons.push(`ngram:${max_ngram}`);
  if (sim > MAX_SIMILARITY) reasons.push(`similarity:${sim}`);
  let reid: "chance" | "above" = "above";
  if (!llm) reasons.push("reid:no-local-model");
  else {
    try { reid = await reidProbe(llm, text, truthsIn(source, sc)); } catch { reasons.push("reid:probe-failed"); }
    if (reid === "above") reasons.push("reid:above-chance");
  }
  return { leak: { pii, canary, max_ngram, similarity: sim, reid, approved }, reasons };
}

const itemText = (i: Pick<TextItem, "prompt" | "rubric" | "reference_facts" | "inputs">) =>
  [i.prompt, ...Object.values(i.inputs ?? {}), ...i.rubric.map((r) => r.criterion), ...(i.reference_facts ?? [])].join("\n");
export { itemText };

export interface Built { item: TextItem | null; reasons: string[]; mapping: Record<string, string>; template: string }

/** Build one item from one seed. `n` varies the fake fill so one template yields several items. */
export async function buildItem(seed: SynthSeed, n: number, deps: Deps): Promise<Built> {
  const template = await makeTemplate(seed, deps.llm);
  const template_id = seed.template_id ?? `tpl-${hash(template)}`;
  const { text, mapping } = fill(template, `${template_id}:${n}`);
  const prompt = await rewrite(text, mapping, deps.llm);
  const item: TextItem = {
    id: `${seed.area}-${hash(`${template_id}:${n}`)}`,
    template_id,
    prompt,
    rubric: seed.rubric ?? DEFAULT_RUBRIC,
    reference_facts: seed.reference_facts,
    decision_refs: seed.decision_refs,
    split: seed.split ?? "active",
    leak: { pii: 0, canary: false, max_ngram: 0, similarity: 0, reid: "chance", approved: false },
  };
  if (!item.reference_facts) delete item.reference_facts;
  if (!item.decision_refs) delete item.decision_refs;
  const source = deps.sourceText(seed);
  const { leak, reasons } = await leakCheck(itemText(item), source, deps.scanner, deps.llm);
  item.leak = leak;
  return { item: reasons.length ? null : item, reasons, mapping, template };
}
