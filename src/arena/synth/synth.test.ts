// Synthetic Arena items, on a made-up vault and a fake local model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, buildSeeds, checkAll, seedsFromArea } from "./cli.ts";
import { autoSlot, fill, slotsIn } from "./fake.ts";
import type { Llm } from "./llm.ts";
import { ollamaLlm } from "./llm.ts";
import { closestSimilarity, longestShared } from "./ngram.ts";
import { buildItem, leakCheck } from "./pipeline.ts";
import { canaryHits, loadScanner, nameHits, piiHits } from "./scan.ts";

let vault = "";
const w = (rel: string, body: string) => { mkdirSync(join(vault, rel, ".."), { recursive: true }); writeFileSync(join(vault, rel), body); };
// a model that never leaks: it rewrites nothing and guesses nothing
const quiet: Llm = async (_p, o) => (o?.system?.includes("guess") ? "I cannot tell." : "");
const SRC = "- [ ] Call Dana Whitlock at Orrin Mutual about the $1,850 premium on policy ZX-4471920 before 2026-12-01 and ask about the umbrella add-on";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "synth-"));
  w("VAULT.md", "x");
  w("data/entities/people/dana-whitlock/entity.md", "---\nname: Dana Whitlock\naliases: [Dana W]\n---\n");
  w("data/entities/places/harlow-bend/entity.md", "---\nname: Harlow Bend\n---\n");
  w("data/tags/insurance/memory/tasks.md", `# Tasks\n${SRC}\n- [ ] short\n`);
  w("data/tags/insurance/memory/decisions.jsonl", JSON.stringify({ id: "d-1", verdict: "Always compare umbrella add-on quotes before renewing any premium" }) + "\n");
  w("build/_meta/arena/synth/canaries.txt", "can-1 ZX-4471920\n");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("fake fill", () => {
  test("same slot, same value everywhere; amounts are perturbed", () => {
    const t = "{{PERSON:a}} pays {{AMOUNT:rent:1800}}. Ask {{PERSON:a}} about {{AMOUNT:rent:1800}} again.";
    const { text, mapping } = fill(t, "s1");
    expect(text.split(mapping["PERSON:a"]!).length).toBe(3);
    expect(mapping["AMOUNT:rent"]).not.toBe("$1,800");
    expect(fill(t, "s1").text).toBe(text);
    expect(fill(t, "s2").text).not.toBe(text);
  });
  test("slotsIn and the regex slotter", () => {
    expect(slotsIn("{{CITY:c}} {{CITY:c}} {{NUM:n:40}}")).toHaveLength(2);
    const s = autoSlot("Pay $1,850 to Orrin Mutual on 2026-12-01, policy 4471920");
    expect(s).not.toMatch(/\$1,850|2026-12-01|Orrin/);
    expect(slotsIn(s).length).toBeGreaterThan(2);
    // the perturbed fill no longer holds the real amount, date or id
    expect(fill(s, "x").text).not.toMatch(/1,850|1850|2026-12-01|4471920|Orrin/);
  });
});

describe("scanners", () => {
  test("pii regexes", () => {
    expect(piiHits("mail a@b.co or call 612-555-0142")).toEqual(["email", "phone"]);
    expect(piiHits("a plain sentence")).toEqual([]);
  });
  test("names come from the vault at run time, canaries from the vault file", () => {
    const sc = loadScanner(vault);
    expect(nameHits("ask dana whitlock", sc)).toEqual(["Dana Whitlock"]);
    expect(nameHits("a trip to harlow bend", sc)).toEqual(["Harlow Bend"]);
    expect(nameHits("nobody here", sc)).toEqual([]);
    expect(canaryHits("my policy zx-4471920 renews", sc)).toEqual(["can-1"]);
  });
});

describe("overlap", () => {
  test("longest shared run and similarity", () => {
    expect(longestShared("one two three four five", "x two three four y")).toBe(3);
    expect(longestShared("alpha beta", "gamma delta")).toBe(0);
    expect(closestSimilarity(SRC, `intro\n${SRC}\nend`)).toBeGreaterThan(0.95);
    expect(closestSimilarity("a totally different sentence about hiking trails", SRC)).toBeLessThan(0.5);
  });
});

describe("pipeline", () => {
  test("a copy of the source fails n-gram, similarity, pii and canary", async () => {
    const r = await leakCheck(SRC, SRC, loadScanner(vault), quiet);
    expect(r.reasons.join(" ")).toMatch(/ngram/);
    expect(r.reasons.join(" ")).toMatch(/similarity/);
    expect(r.reasons.join(" ")).toMatch(/canary/);
  });
  test("a re-identification guess that hits a real value is above chance", async () => {
    const leaky: Llm = async () => "Probably Harlow Bend";
    const r = await leakCheck("I live somewhere cold and pay rent.", "lives in Harlow Bend", loadScanner(vault), leaky);
    expect(r.leak.reid).toBe("above");
  });
  test("no local model means the item cannot pass", async () => {
    const r = await leakCheck("Plain text.", SRC, loadScanner(vault), undefined);
    expect(r.reasons).toContain("reid:no-local-model");
  });
  test("a seed becomes an unapproved, clean item with no source pointer in it", async () => {
    const b = await buildItem(
      { area: "insurance", source: SRC.slice(6), pointers: [{ path: "data/tags/insurance/memory/tasks.md", line: 2 }] },
      0,
      { llm: quiet, scanner: loadScanner(vault), sourceText: (s) => readFileSync(join(vault, s.pointers[0]!.path), "utf8") },
    );
    expect(b.reasons).toEqual([]);
    expect(b.item?.leak.approved).toBe(false);
    expect(JSON.stringify(b.item)).not.toMatch(/Whitlock|ZX-4471920|1,850|source_pointer|tasks\.md/);
  });
  test("ollama refuses a non-local host", () => {
    expect(() => ollamaLlm("m", "http://203.0.113.9:11434")).toThrow(/local/);
  });
});

describe("commands", () => {
  test("build writes the suite and a private index, check reports, approve only passes clean items", async () => {
    const sc = loadScanner(vault);
    const seeds = seedsFromArea(vault, "insurance", 1, new Set());
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.decision_refs).toEqual(["d-1"]);
    const res = await buildSeeds(vault, "insurance", "insurance", seeds, { llm: quiet, scanner: sc });
    expect(res.added).toBe(1);
    const suite = JSON.parse(readFileSync(join(vault, "build/_meta/arena/suites/insurance.json"), "utf8"));
    expect(suite.items[0].leak.approved).toBe(false);
    expect(suite.items[0].source_pointer).toBeUndefined();
    const idx = JSON.parse(readFileSync(join(vault, "build/_meta/arena/suites/.private-index.json"), "utf8"));
    expect(Object.keys(idx.items)[0]).toBe(`insurance/${suite.items[0].id}`);
    const rep = await checkAll(vault, { llm: quiet, scanner: sc });
    expect(rep).toMatchObject({ tests: 1, leaks: 0 });
    expect(approve(vault, { all: true })).toEqual({ approved: 1, refused: 0 });
    // plant a leak and the next check un-approves it
    suite.items[0].prompt = SRC;
    writeFileSync(join(vault, "build/_meta/arena/suites/insurance.json"), JSON.stringify(suite));
    const bad = await checkAll(vault, { llm: quiet, scanner: sc });
    expect(bad.leaks).toBe(1);
    expect(JSON.parse(readFileSync(join(vault, "build/_meta/arena/suites/insurance.json"), "utf8")).items[0].leak.approved).toBe(false);
    expect(approve(vault, { all: true })).toEqual({ approved: 0, refused: 1 });
  });
});
