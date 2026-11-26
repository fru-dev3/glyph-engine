// Synthetic Arena items: shapes written to <vault>/build/_meta/arena/suites/.
// source_pointer lives ONLY in suites/.private-index.json, never in an item.
export type RubricType = "hard_fail" | "preference" | "quality";
export interface RubricLine { criterion: string; points: number; type: RubricType }
export interface Leak {
  pii: number;
  canary: boolean;
  max_ngram: number;
  similarity: number;
  reid: "chance" | "above";
  approved: boolean;
}
export interface TextItem {
  id: string;
  template_id: string;
  prompt: string;
  inputs?: Record<string, string>;
  rubric: RubricLine[];
  reference_facts?: string[];
  decision_refs?: string[];
  split: "active" | "reserve";
  canary_id?: string;
  leak: Leak;
}
export interface Suite {
  id: string;
  title: string;
  kind: "text" | "image" | "voice-tts" | "transcribe" | "video" | "app";
  area: string;
  schedule: "nightly" | "weekly" | "manual";
  items: Array<TextItem | Record<string, unknown>>;
  created: string;
  version: number;
}
/** Where an item came from: a note in the vault, read again at check time. */
export interface SourcePointer { path: string; line?: number }
export interface SynthSeed {
  area: string;
  /** a template with {{KIND:key[:base]}} slots; absent means the model (or the auto slotter) makes one from `source` */
  template?: string;
  template_id?: string;
  /** the real task text, read from the vault, never written out */
  source?: string;
  pointers: SourcePointer[];
  rubric?: RubricLine[];
  reference_facts?: string[];
  decision_refs?: string[];
  split?: "active" | "reserve";
  /** how many fake fills of this one template to make (default 1) */
  variants?: number;
}
export const SLOT_KINDS = ["PERSON", "CITY", "EMPLOYER", "CARRIER", "POLICY", "AMOUNT", "NUM", "DATE", "AGE", "CONDITION", "ID", "PERCENT", "NAME"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];
