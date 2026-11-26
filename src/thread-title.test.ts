import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setThreadTitle, threadTitles } from "./session.ts";

describe("thread titles", () => {
  test("names a chat beside the threads, clears it, and refuses a bad id", () => {
    const v = mkdtempSync(join(tmpdir(), "tt-"));
    mkdirSync(join(v, "data", "domains", "wealth", "memory", "threads"), { recursive: true });
    mkdirSync(join(v, "data", "missions", "fire"), { recursive: true });
    expect(setThreadTitle(v, "wealth", "s1", "  Q4   taxes ")).toEqual({ s1: "Q4 taxes" });
    expect(threadTitles(v, "wealth")).toEqual({ s1: "Q4 taxes" });
    expect(existsSync(join(v, "data", "domains", "wealth", "memory", "thread-titles.json"))).toBe(true);
    expect(setThreadTitle(v, "mission/fire", "s2", "Top FIRE people")).toEqual({ s2: "Top FIRE people" });
    expect(existsSync(join(v, "data", "missions", "fire", "memory", "thread-titles.json"))).toBe(true);
    expect(setThreadTitle(v, "wealth", "s1", "")).toEqual({});
    expect(() => setThreadTitle(v, "wealth", "../x", "t")).toThrow();
  });
});
