// Mechanical checkers: the cheapest, most honest way to decide a duel. No human, no
// judge model. A task carries at most one check.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, CheckResult } from "./types.ts";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Numbers as written: "1,234.50", "$1234.5", "-12". */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/[$,]/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** The first JSON object or array in a reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : text).trim();
  try { return JSON.parse(body); } catch { /* look for an embedded object */ }
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found");
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(body.slice(start, end)); } catch { /* shorter */ }
  }
  throw new Error("no valid JSON found");
}

/** The first fenced code block, else the whole reply. */
export function extractCode(text: string): string {
  const m = text.match(/```(?:[a-z]+)?\s*\n([\s\S]*?)```/i);
  return (m ? m[1]! : text).trim();
}

export function runCheck(check: Check, reply: string, opts: { codeTests?: boolean } = {}): CheckResult {
  switch (check.type) {
    case "keywords": {
      const low = reply.toLowerCase();
      const miss = check.all.filter((k) => !low.includes(k.toLowerCase()));
      return { pass: miss.length === 0, detail: miss.length ? `missing: ${miss.join(", ")}` : `all ${check.all.length} present` };
    }
    case "regex": {
      let re: RegExp;
      try { re = new RegExp(check.pattern, check.flags ?? "i"); } catch { return { pass: false, detail: "bad pattern" }; }
      return re.test(reply) ? { pass: true, detail: "matches" } : { pass: false, detail: "no match" };
    }
    case "json": {
      try {
        const v = extractJson(reply) as Record<string, unknown>;
        const miss = (check.keys ?? []).filter((k) => !(v && typeof v === "object" && k in v));
        return { pass: miss.length === 0, detail: miss.length ? `missing keys: ${miss.join(", ")}` : "valid JSON" };
      } catch (e) {
        return { pass: false, detail: (e as Error).message };
      }
    }
    case "max_words": {
      const n = words(reply);
      return { pass: n <= check.n, detail: `${n} words (limit ${check.n})` };
    }
    case "citations": {
      const urls = new Set(reply.match(/https?:\/\/[^\s)\]>"']+/g) ?? []);
      const refs = new Set(reply.match(/\[\d+\]/g) ?? []);
      const n = Math.max(urls.size, refs.size);
      return { pass: n >= check.min, detail: `${n} citations (need ${check.min})` };
    }
    case "number": {
      const tol = check.tolerance ?? 0.005;
      const hit = numbersIn(reply).some((n) => Math.abs(n - check.expect) <= Math.max(tol, Math.abs(check.expect) * 1e-9));
      return { pass: hit, detail: hit ? `reconciles to ${check.expect}` : `does not reconcile to ${check.expect}` };
    }
    case "tests": {
      if (!opts.codeTests) return { pass: false, detail: "code tests are off in Settings" };
      return runJsTests(extractCode(reply), check.code);
    }
  }
}

// The answer's code plus the task's asserts, run by this same runtime in a fresh
// temp dir with an empty environment (no keys, no vault) and a 10 s limit.
function runJsTests(code: string, tests: string): CheckResult {
  const dir = mkdtempSync(join(tmpdir(), "arena-check-"));
  try {
    writeFileSync(join(dir, "check.mjs"), `${code}\n\n// --- task tests ---\n${tests}\nconsole.log("ARENA_TESTS_PASSED");\n`);
    const res = spawnSync(process.execPath, [join(dir, "check.mjs")], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir, BUN_BE_BUN: "1" },
      timeout: 10_000,
      encoding: "utf8",
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status === 0 && out.includes("ARENA_TESTS_PASSED")) return { pass: true, detail: "tests pass" };
    const why = res.error ? res.error.message : out.split("\n").find((l) => /error|assert/i.test(l)) ?? `exit ${res.status}`;
    return { pass: false, detail: `tests fail: ${why.trim().slice(0, 160)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
