import { describe, expect, it } from "bun:test";
import { aliasGlyphEnv, glyphHome, invokedName } from "./glyph-home.ts";

describe("glyphHome", () => {
  it("GLYPH_HOME wins over everything", () => {
    expect(glyphHome("/h", { GLYPH_HOME: "/x" }, () => true)).toBe("/x");
  });
  it("uses ~/.glyph when it exists", () => {
    expect(glyphHome("/h", {}, (p) => p === "/h/.glyph")).toBe("/h/.glyph");
  });
  it("falls back to ~/.prevail when ~/.glyph is absent", () => {
    expect(glyphHome("/h", {}, () => false)).toBe("/h/.prevail");
  });
  it("ignores an empty GLYPH_HOME", () => {
    expect(glyphHome("/h", { GLYPH_HOME: "" }, () => false)).toBe("/h/.prevail");
  });
});

describe("aliasGlyphEnv", () => {
  it("copies GLYPH_X to PREVAIL_X and the new one wins", () => {
    const env: Record<string, string | undefined> = { GLYPH_BUNKER: "1", PREVAIL_BUNKER: "0", PREVAIL_ONLY: "a" };
    aliasGlyphEnv(env);
    expect(env.PREVAIL_BUNKER).toBe("1");
    expect(env.PREVAIL_ONLY).toBe("a");
  });
  it("leaves the old name alone when the new one is unset", () => {
    const env: Record<string, string | undefined> = { PREVAIL_VAULT: "/v" };
    aliasGlyphEnv(env);
    expect(env.PREVAIL_VAULT).toBe("/v");
    expect(env.GLYPH_VAULT).toBeUndefined();
  });
});

describe("invokedName", () => {
  it("recognises both commands", () => {
    expect(invokedName(["/usr/bin/prevail"])).toBe("prevail");
    expect(invokedName(["/usr/bin/glyph-bot"])).toBe("glyph-bot");
  });
  it("skips unrelated names and defaults to glyph-bot", () => {
    expect(invokedName(["/x/src/index.tsx", "bun"])).toBe("glyph-bot");
    expect(invokedName(["/x/index.tsx", "/y/prevail"])).toBe("prevail");
  });
});

describe("callers go through glyphHome", () => {
  it("configDir follows GLYPH_HOME, and PREVAIL_CONFIG_DIR still wins", async () => {
    const { configDir } = await import("./config.ts");
    const keep = { h: process.env.GLYPH_HOME, c: process.env.PREVAIL_CONFIG_DIR };
    try {
      delete process.env.PREVAIL_CONFIG_DIR;
      process.env.GLYPH_HOME = "/tmp/glyph-home-test";
      expect(configDir()).toBe("/tmp/glyph-home-test");
      process.env.PREVAIL_CONFIG_DIR = "/tmp/old-seam";
      expect(configDir()).toBe("/tmp/old-seam");
    } finally {
      if (keep.h === undefined) delete process.env.GLYPH_HOME; else process.env.GLYPH_HOME = keep.h;
      if (keep.c === undefined) delete process.env.PREVAIL_CONFIG_DIR; else process.env.PREVAIL_CONFIG_DIR = keep.c;
    }
  });
  it("the MCP-mirror skips Glyph Bot's own server under either name", async () => {
    const { isPrevailServer } = await import("./apps-mirror.ts");
    expect(isPrevailServer("glyph-bot")).toBe(true);
    expect(isPrevailServer("prevail")).toBe(true);
    expect(isPrevailServer("x", "/bin/glyph-bot mcp")).toBe(true);
    expect(isPrevailServer("acme")).toBe(false);
  });
});
