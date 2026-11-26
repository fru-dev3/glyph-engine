// Consistent fake fill: one slot key gets one fake value everywhere in an item.
// Indirect identifiers (city, employer, exact amounts, rare conditions, dates) are
// replaced or perturbed too: stripping names alone still lets a model infer the person.
import { createHash } from "node:crypto";
import type { SlotKind } from "./types.ts";

export function rng(seed: string): () => number {
  let a = parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Made-up pools. A name that happens to be real is caught by the scanner at check time.
const FIRST = ["Marlo", "Teodor", "Ines", "Bram", "Sunniva", "Kellan", "Odalys", "Piet", "Ravenna", "Dov", "Linnea", "Cosmo"];
const LAST = ["Alderwick", "Brannock", "Castellane", "Dunmore", "Everhart", "Fennimore", "Garrowby", "Hollin", "Ibsley", "Jessamy"];
const CITY = ["Marlow Falls", "Pinecrest Bay", "Tallis Ford", "Oakhaven Ridge", "Silverlake Mills", "Harrow Point", "Wexcombe", "Larkspur Dale"];
const EMPLOYER = ["Brightwell Dynamics", "Kestrel Logistics", "Northgate Analytics", "Ardent Freight", "Pallas Software", "Quillon Health Group", "Tidewater Supply", "Vantor Systems"];
const CARRIER = ["Harbor Mutual", "Beacon Shield", "Granite State Assurance", "Evergreen Casualty", "Summit Trust Insurance", "Lantern Life"];
const CONDITION = ["seasonal migraines", "mild asthma", "a thyroid imbalance", "chronic tendinitis", "iron-deficiency anemia", "eczema flare-ups", "a slow-healing sprain"];
const NAME = ["Orchard & Vale", "Copperline", "Blue Heron Works", "Tamarack Row", "Fieldstone Co", "Nimbus Lane"];

export type Fillable = { kind: SlotKind; key: string; base?: number };
const SLOT = /\{\{([A-Z]+):([A-Za-z0-9_]+)(?::(-?[0-9.]+))?\}\}/g;

export function slotsIn(template: string): Fillable[] {
  const seen = new Map<string, Fillable>();
  for (const m of template.matchAll(SLOT)) {
    const key = `${m[1]}:${m[2]}`;
    if (!seen.has(key)) seen.set(key, { kind: m[1] as SlotKind, key: m[2]!, base: m[3] !== undefined ? Number(m[3]) : undefined });
  }
  return [...seen.values()];
}

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
const digits = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join("");
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
/** exact amounts are moved 12-35% and rounded to a plausible precision */
export function perturb(r: () => number, base: number): number {
  const f = (r() < 0.5 ? -1 : 1) * (0.12 + r() * 0.23);
  const v = base * (1 + f);
  const step = v >= 10000 ? 100 : v >= 1000 ? 50 : v >= 100 ? 5 : 1;
  return Math.max(1, Math.round(v / step) * step);
}

function fakeOne(r: () => number, s: Fillable): string {
  switch (s.kind) {
    case "PERSON": return `${pick(r, FIRST)} ${pick(r, LAST)}`;
    case "CITY": return pick(r, CITY);
    case "EMPLOYER": return pick(r, EMPLOYER);
    case "CARRIER": return pick(r, CARRIER);
    case "CONDITION": return pick(r, CONDITION);
    case "NAME": return pick(r, NAME);
    case "POLICY": return `${pick(r, ["HM", "BS", "GA", "EC"])}-${digits(r, 7)}`;
    case "ID": return `${digits(r, 3)}-${digits(r, 5)}`;
    case "AGE": return String(s.base !== undefined ? Math.max(1, Math.round(s.base + (r() < 0.5 ? -1 : 1) * (2 + Math.floor(r() * 4)))) : 25 + Math.floor(r() * 40));
    case "AMOUNT": return money(s.base !== undefined ? perturb(r, s.base) : 100 + Math.floor(r() * 4900));
    case "NUM": return String(s.base !== undefined ? perturb(r, s.base) : 2 + Math.floor(r() * 90));
    case "PERCENT": return `${s.base !== undefined ? Math.max(1, Math.round(perturb(r, s.base))) : 2 + Math.floor(r() * 30)}%`;
    case "DATE": {
      const mo = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      return `${pick(r, mo)} ${1 + Math.floor(r() * 28)}, ${2026 + Math.floor(r() * 2)}`;
    }
  }
}

/** Fill every slot. Same `KIND:key` always gets the same value inside one item. */
export function fill(template: string, seed: string): { text: string; mapping: Record<string, string> } {
  const r = rng(seed);
  const mapping: Record<string, string> = {};
  for (const s of slotsIn(template)) mapping[`${s.kind}:${s.key}`] = fakeOne(r, s);
  const text = template.replace(SLOT, (_m, k: string, key: string) => mapping[`${k}:${key}`] ?? _m);
  return { text, mapping };
}

/** Last resort when a small local model cannot make a template: slot what a regex can see. */
export function autoSlot(text: string): string {
  const keys = new Map<string, string>();
  const k = (kind: string, v: string) => {
    if (!keys.has(v)) keys.set(v, `${kind}:${kind.toLowerCase()}${keys.size}`);
    return keys.get(v)!;
  };
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => "{{ID:email}}")
    .replace(/\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)(k|K|M)?/g, (_m, n: string, sfx?: string) => {
      const base = Number(n.replace(/,/g, "")) * (sfx?.toLowerCase() === "k" ? 1000 : sfx === "M" ? 1e6 : 1);
      return `{{${k("AMOUNT", _m)}:${base}}}`;
    })
    .replace(/\b(20\d\d-\d\d-\d\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, 20\d\d)?)\b/g, (m) => `{{${k("DATE", m)}}}`)
    .replace(/(?<![:\w])\d{2,}\b/g, (m) => `{{${k("NUM", m)}:${m}}}`)
    // a Capitalized word that is not the sentence start is read as a name
    .replace(/(?<=[a-z,;:] )([A-Z][a-zA-Z&'-]{2,}(?: [A-Z][a-zA-Z&'-]{2,})*)/g, (m) => `{{${k("NAME", m)}}}`);
}
