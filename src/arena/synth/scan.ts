// Scanners: PII regexes, a names/places list read from the vault at run time (never
// committed), and planted canary strings (fake policy numbers that must never surface).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arenaDir } from "../store.ts";

const PII: Array<[string, RegExp]> = [
  ["email", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ["phone", /(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/],
  ["ssn", /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/],
  ["card", /(?<!\d)(?:\d[ -]?){13,16}(?!\d)/],
  ["ip", /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/],
  ["url", /https?:\/\/\S+/],
  ["path", /(?:\/Users\/|\/Volumes\/|~\/)\S+/],
  ["iban", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/],
];

export function piiHits(text: string): string[] {
  return PII.filter(([, re]) => re.test(text)).map(([n]) => n);
}

export interface Scanner {
  names: string[];
  canaries: Array<{ id: string; value: string }>;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words a real name list would flood with false hits; the vault may add more in synth/allow.txt */
const COMMON = new Set(["will", "mark", "grace", "bill", "rich", "summer", "may", "bay", "hope", "park", "post", "home", "chase", "apple", "target", "square"]);

function frontName(md: string): string[] {
  const out: string[] = [];
  const m = /^name:\s*(.+)$/m.exec(md);
  if (m) out.push(m[1]!.trim());
  const a = /^aliases:\s*\[(.*)\]/m.exec(md);
  if (a) out.push(...a[1]!.split(",").map((x) => x.replace(/["']/g, "").trim()));
  return out;
}

/** Reads people, places and orgs from the entity register, plus synth/{names,allow,canaries}.txt. Nothing is cached on disk. */
export function loadScanner(vault: string): Scanner {
  const names = new Set<string>();
  for (const kind of ["people", "places", "orgs"]) {
    const dir = join(vault, "data", "entities", kind);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      try { for (const n of frontName(readFileSync(join(dir, d, "entity.md"), "utf8"))) names.add(n); } catch { /* no entity.md */ }
    }
  }
  const lines = (f: string): string[] => {
    try { return readFileSync(join(arenaDir(vault), "synth", f), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")); } catch { return []; }
  };
  for (const n of lines("names.txt")) names.add(n);
  const allow = new Set(lines("allow.txt").map((x) => x.toLowerCase()));
  const kept = [...names].filter((n) => n.length >= 4 && !COMMON.has(n.toLowerCase()) && !allow.has(n.toLowerCase()));
  const canaries = lines("canaries.txt").map((l) => {
    const [id, ...v] = l.split(/\s+/);
    return { id: id!, value: v.join(" ") || id! };
  });
  return { names: kept, canaries };
}

export function nameHits(text: string, sc: Scanner): string[] {
  const hits: string[] = [];
  for (const n of sc.names) if (new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, "i").test(text)) hits.push(n);
  return hits;
}

export function canaryHits(text: string, sc: Scanner): string[] {
  const t = text.toLowerCase();
  return sc.canaries.filter((c) => t.includes(c.value.toLowerCase())).map((c) => c.id);
}
