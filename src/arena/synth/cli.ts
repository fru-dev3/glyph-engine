// `synth build --area <a> | synth check | synth approve [--all|--id X]`, run as
// `arena-engine synth <cmd>` once the sidecar dispatches it (see synthCommand), or
// directly through ./main.ts. Every command prints one JSON object on stdout.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { file, readJson, resolveArenaVault, writeJson } from "../store.ts";
import { ollamaLlm, ollamaUp, type Llm } from "./llm.ts";
import { buildItem, itemText, leakCheck } from "./pipeline.ts";
import { loadScanner, type Scanner } from "./scan.ts";
import type { RubricLine, SourcePointer, Suite, SynthSeed, TextItem } from "./types.ts";

type Flags = Record<string, string | true>;
function flagsOf(argv: string[]): { pos: string[]; f: Flags } {
  const pos: string[] = [], f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) f[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) f[a.slice(2)] = argv[++i]!;
    else f[a.slice(2)] = true;
  }
  return { pos, f };
}

const suitesDir = (vault: string) => file(vault, "suites");
const suitePath = (vault: string, id: string) => join(suitesDir(vault), `${id}.json`);
const indexPath = (vault: string) => join(suitesDir(vault), ".private-index.json");
interface PrivateIndex { updated: string; items: Record<string, { pointers: SourcePointer[]; template_id: string; mapping?: Record<string, string> }> }
const readIndex = (vault: string): PrivateIndex => readJson<PrivateIndex>(indexPath(vault), { updated: "", items: {} });
const isText = (i: unknown): i is TextItem => !!i && typeof i === "object" && "leak" in i && "template_id" in i;

export function readSource(vault: string, seed: Pick<SynthSeed, "pointers" | "source">): string {
  const parts = [seed.source ?? ""];
  for (const p of seed.pointers) { try { parts.push(readFileSync(join(vault, p.path), "utf8")); } catch { /* moved note: skip */ } }
  return parts.join("\n");
}

function loadSuite(vault: string, id: string, area: string): Suite {
  const s = readJson<Suite | null>(suitePath(vault, id), null);
  return s ?? { id, title: id.replace(/(^|-)(\w)/g, (_m, a, c) => (a ? " " : "") + c.toUpperCase()), kind: "text", area, schedule: "weekly", items: [], created: new Date().toISOString(), version: 1 };
}

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{5,}/g) ?? []));

/** Open tasks of one area (a tag folder): the real material, read here and never written out. */
export function areaTasks(vault: string, area: string): Array<{ text: string; pointer: SourcePointer }> {
  const out: Array<{ text: string; pointer: SourcePointer }> = [];
  for (const rel of [`data/tags/${area}/memory/tasks.md`, `data/tags/${area}/_tasks.md`]) {
    let txt = "";
    try { txt = readFileSync(join(vault, rel), "utf8"); } catch { continue; }
    txt.split("\n").forEach((l, i) => {
      const m = /^\s*[-*] \[[ x]\] (.{40,})$/.exec(l);
      if (m) out.push({ text: m[1]!, pointer: { path: rel, line: i + 1 } });
    });
  }
  return out;
}

/** A recorded decision close to this task, cited by id only: the judge reads the text from the vault. */
export function decisionFor(vault: string, area: string, task: string): { ref: string } | null {
  const tw = words(task);
  let best: { ref: string; n: number } | null = null;
  try {
    for (const l of readFileSync(join(vault, `data/tags/${area}/memory/decisions.jsonl`), "utf8").split("\n")) {
      if (!l.trim()) continue;
      const d = JSON.parse(l) as { id?: string; verdict?: string; prompt?: string };
      if (!d.id) continue;
      const n = [...words(`${d.verdict ?? ""} ${d.prompt ?? ""}`)].filter((w) => tw.has(w)).length;
      if (n >= 2 && (!best || n > best.n)) best = { ref: d.id, n };
    }
  } catch { /* no decision log */ }
  return best;
}

export function seedsFromArea(vault: string, area: string, count: number, skip: Set<string>): SynthSeed[] {
  const seeds: SynthSeed[] = [];
  const total = Math.ceil(count * 1.3);
  for (const t of areaTasks(vault, area)) {
    if (seeds.length >= total) break;
    const key = `${t.pointer.path}:${t.pointer.line}`;
    if (skip.has(key)) continue;
    const dec = decisionFor(vault, area, t.text);
    const rubric: RubricLine[] | undefined = dec ? [
      { criterion: "States a number, date or name that the prompt does not give", points: -10, type: "hard_fail" },
      { criterion: "Answers the question asked, with a concrete next step", points: 6, type: "quality" },
      { criterion: `Consistent with the owner's recorded decision ${dec.ref}`, points: 5, type: "preference" },
    ] : undefined;
    seeds.push({ area, source: t.text, pointers: [t.pointer], rubric, decision_refs: dec ? [dec.ref] : undefined, split: seeds.length >= count ? "reserve" : "active" });
  }
  return seeds;
}

async function localModel(f: Flags): Promise<Llm | undefined> {
  const url = typeof f.url === "string" ? f.url : "http://localhost:11434";
  if (!(await ollamaUp(url))) return undefined;
  return ollamaLlm(typeof f.model === "string" ? f.model : "gemma3:1b", url);
}

export interface BuildResult { suite: string; added: number; rejected: Array<{ seed: string; reasons: string[] }> }

/** Build items for seeds into one suite. A failing fill is retried with a new fake fill (3 tries), then reported. */
export async function buildSeeds(vault: string, suiteId: string, area: string, seeds: SynthSeed[], deps: { llm?: Llm; scanner: Scanner }): Promise<BuildResult> {
  const suite = loadSuite(vault, suiteId, area);
  const index = readIndex(vault);
  const have = new Set(suite.items.map((i) => (i as { id: string }).id));
  const res: BuildResult = { suite: suiteId, added: 0, rejected: [] };
  for (const seed of seeds) {
    for (let v = 0; v < (seed.variants ?? 1); v++) {
      let last: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const b = await buildItem(seed, v + attempt * 100, { ...deps, sourceText: (s) => readSource(vault, s) });
        if (b.item) {
          if (!have.has(b.item.id)) {
            suite.items.push(b.item); have.add(b.item.id);
            index.items[`${suiteId}/${b.item.id}`] = { pointers: seed.pointers, template_id: b.item.template_id, mapping: b.mapping };
            res.added++;
          }
          last = [];
          break;
        }
        last = b.reasons;
      }
      if (last.length) res.rejected.push({ seed: seed.template_id ?? seed.pointers[0]?.path ?? "?", reasons: last });
    }
  }
  mkdirSync(suitesDir(vault), { recursive: true });
  writeJson(suitePath(vault, suiteId), suite);
  index.updated = new Date().toISOString();
  writeJson(indexPath(vault), index);
  return res;
}

/** Re-run every leak check on every text item, write leak-report.json, and un-approve any failure. */
export async function checkAll(vault: string, deps: { llm?: Llm; scanner: Scanner }, only?: string) {
  const index = readIndex(vault);
  let tests = 0, leaks = 0;
  const failures: Array<{ suite: string; id: string; reasons: string[] }> = [];
  for (const f of existsSync(suitesDir(vault)) ? readdirSync(suitesDir(vault)) : []) {
    if (!f.endsWith(".json") || f.startsWith(".") || (only && f !== `${only}.json`)) continue;
    const suite = readJson<Suite>(join(suitesDir(vault), f), null as never);
    if (!suite) continue;
    let touched = false;
    for (const it of suite.items) {
      if (!isText(it)) continue;
      tests++;
      const ptr = index.items[`${suite.id}/${it.id}`];
      const source = ptr ? readSource(vault, { pointers: ptr.pointers }) : "";
      const { leak, reasons } = await leakCheck(itemText(it), source, deps.scanner, deps.llm, it.leak.approved);
      it.leak = { ...leak, approved: reasons.length ? false : it.leak.approved };
      if (reasons.length) { leaks++; failures.push({ suite: suite.id, id: it.id, reasons }); }
      touched = true;
    }
    if (touched) writeJson(join(suitesDir(vault), f), suite);
  }
  const report = { tests, checks: ["pii", "canary", "ngram", "reid", "similarity"], leaks, updated: new Date().toISOString() };
  writeJson(file(vault, "leak-report.json"), report);
  return { ...report, failures };
}

/** Approve items that pass. An item whose last check failed is never approved, even with --all. */
export function approve(vault: string, o: { all?: boolean; id?: string; suite?: string }) {
  let approved = 0, refused = 0;
  for (const f of existsSync(suitesDir(vault)) ? readdirSync(suitesDir(vault)) : []) {
    if (!f.endsWith(".json") || f.startsWith(".") || (o.suite && f !== `${o.suite}.json`)) continue;
    const suite = readJson<Suite>(join(suitesDir(vault), f), null as never);
    let touched = false;
    for (const it of suite.items) {
      if (!isText(it) || it.leak.approved || !(o.all || o.id === it.id)) continue;
      const clean = it.leak.pii === 0 && !it.leak.canary && it.leak.max_ngram <= 12 && it.leak.reid === "chance";
      if (clean) { it.leak.approved = true; approved++; touched = true; } else refused++;
    }
    if (touched) writeJson(join(suitesDir(vault), f), suite);
  }
  return { approved, refused };
}

export async function synthCommand(argv: string[]): Promise<number> {
  const { pos, f } = flagsOf(argv);
  const say = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const vault = resolveArenaVault(typeof f.vault === "string" ? f.vault : null);
  if (!vault) { say({ error: "no vault" }); return 1; }
  const cmd = pos[0];
  try {
    if (cmd === "build") {
      const area = typeof f.area === "string" ? f.area : "";
      if (!area && typeof f.seeds !== "string") { say({ error: "synth build needs --area <a> (or --seeds <file>)" }); return 2; }
      const llm = await localModel(f);
      if (!llm) { say({ error: "no local Ollama model: synth never sends vault text anywhere else" }); return 1; }
      const scanner = loadScanner(vault);
      const suiteId = typeof f.suite === "string" ? f.suite : area;
      let seeds: SynthSeed[];
      if (typeof f.seeds === "string") seeds = JSON.parse(readFileSync(f.seeds, "utf8")) as SynthSeed[];
      else {
        const skip = new Set(Object.values(readIndex(vault).items).flatMap((x) => x.pointers.map((p) => `${p.path}:${p.line}`)));
        seeds = seedsFromArea(vault, area, Number(f.count ?? 5), skip);
      }
      say(await buildSeeds(vault, suiteId, area || suiteId, seeds, { llm, scanner }));
      return 0;
    }
    if (cmd === "check") {
      const llm = await localModel(f);
      const r = await checkAll(vault, { llm, scanner: loadScanner(vault) }, typeof f.suite === "string" ? f.suite : undefined);
      say(r);
      return r.leaks ? 1 : 0;
    }
    if (cmd === "approve") {
      if (!f.all && typeof f.id !== "string") { say({ error: "synth approve needs --all or --id <item>" }); return 2; }
      say(approve(vault, { all: !!f.all, id: typeof f.id === "string" ? f.id : undefined, suite: typeof f.suite === "string" ? f.suite : undefined }));
      return 0;
    }
    say({ error: "usage: synth build --area <a> [--count N] [--seeds file] | synth check | synth approve [--all|--id X]" });
    return 2;
  } catch (e) {
    say({ error: String((e as Error).message ?? e) });
    return 1;
  }
}
