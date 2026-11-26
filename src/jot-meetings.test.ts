import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, mcpTools } from "./mcp-server.ts";
import { findMeeting, listMeetings, meetingActions, meetingSummary, meetingTranscript } from "./jot-meetings.ts";

// A made-up vault with three Jot recordings: one full, one with only
// transcript.json (no .txt), one with no notes yet.
let V = "";
const REC = () => join(V, "data", "apps", "jot", "recordings", "Recordings");

function meeting(slug: string, meta: Record<string, unknown>, files: Record<string, string>) {
  const d = join(REC(), slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "meta.json"), JSON.stringify({ schema: 1, id: `Recordings/${slug}`, ...meta }));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
}

beforeAll(() => {
  V = mkdtempSync(join(tmpdir(), "jot-mcp-"));
  meeting("2026-03-02-foo-planning", { title: "Foo planning", created: "2026-03-02T15:00:00Z", duration_sec: 1800, people: ["person/ken-lee"], tags: ["acme"], links: ["org/acme-api"] }, {
    "transcript.txt": "[00:00] Ken Lee: Let's plan the foo launch.\n[00:04] Sam Bar: The bar budget is due Friday.",
    "notes.md": [
      "---", "title: Foo planning", "date: 2026-03-02", "---", "",
      "## Summary", "Ken and Sam planned the foo launch.", "",
      "## Decisions", "- Launch on Tuesday", "",
      "## Action items",
      "- [ ] Send the bar budget.  <!-- owner: Sam Bar -->",
      "- [x] Book the room.  <!-- owner: Ken Lee -->",
      "- [ ] Draft the foo notes.",
    ].join("\n"),
  });
  meeting("2026-03-05-baz-sync", { title: "Baz sync", created: "2026-03-05T10:00:00Z", duration_sec: 600 }, {
    "transcript.json": JSON.stringify({ schema: 1, speakers: { S1: "Ann Qux" }, segments: [{ start: 0.5, end: 3, speaker: "S1", text: "Baz numbers look good." }, { start: 65, end: 70, speaker: "S2", text: "Agreed." }] }),
    "notes.md": "## Summary\nA short baz sync.\n\n## Action items\n- [ ] Check the baz numbers.  <!-- owner: Ann Qux -->\n",
  });
  meeting("2026-01-10-empty", { title: "Empty one", created: "2026-01-10T09:00:00Z" }, {});
  mkdirSync(join(V, "data", "apps", "jot", "recordings", ".memosa"), { recursive: true });
});
afterAll(() => rmSync(V, { recursive: true, force: true }));

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, mcpTools(), V)) as { content: { text: string }[] };
  return r.content.map((c) => c.text).join("");
}

describe("jot meetings", () => {
  test("the four tools are listed and read-only", async () => {
    const r = (await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, mcpTools(), V)) as { tools: { name: string; description: string }[] };
    for (const n of ["search_meetings", "get_meeting_transcript", "get_meeting_summary", "list_meeting_actions"]) {
      const t = r.tools.find((x) => x.name === n);
      expect(t).toBeDefined();
      expect(t!.description).toContain("Read-only");
    }
  });

  test("lists newest first and skips hidden folders", () => {
    expect(listMeetings(V).map((m) => m.id)).toEqual(["Recordings/2026-03-05-baz-sync", "Recordings/2026-03-02-foo-planning", "Recordings/2026-01-10-empty"]);
  });

  test("search matches every word across title, notes and transcript", async () => {
    const out = await call("search_meetings", { query: "bar budget" });
    expect(out).toContain("Recordings/2026-03-02-foo-planning");
    expect(out).not.toContain("baz-sync");
    expect(await call("search_meetings", { query: "baz numbers" })).toContain("baz-sync");
    expect(await call("search_meetings", { query: "acme" })).toContain("foo-planning"); // a tag
    expect(await call("search_meetings", { query: "nothing like this" })).toContain("No Jot meeting mentions");
    const recent = await call("search_meetings", { since: "2026-03-01" });
    expect(recent).toContain("baz-sync");
    expect(recent).not.toContain("empty");
    const json = JSON.parse(await call("search_meetings", { query: "foo", format: "json" }));
    expect(json[0].id).toBe("Recordings/2026-03-02-foo-planning");
    expect(json[0].dir).toBeUndefined(); // no local paths leave the server
  });

  test("transcript from .txt, or built from transcript.json with speaker names", async () => {
    expect(await call("get_meeting_transcript", { id: "Recordings/2026-03-02-foo-planning" })).toContain("[00:04] Sam Bar: The bar budget is due Friday.");
    const baz = meetingTranscript(findMeeting(V, "2026-03-05-baz-sync")!);
    expect(baz).toBe("[00:00] Ann Qux: Baz numbers look good.\n[01:05] S2: Agreed.");
    expect(await call("get_meeting_transcript", { id: "2026-01-10-empty" })).toContain("No transcript yet.");
    expect(await call("get_meeting_transcript", { id: "Recordings/2026-03-02-foo-planning", max_chars: 10 })).toContain("[cut at 10 of");
  });

  test("summary and decisions from notes.md", async () => {
    const m = findMeeting(V, "2026-03-02-foo-planning")!;
    expect(meetingSummary(m)).toEqual({ summary: "Ken and Sam planned the foo launch.", decisions: ["Launch on Tuesday"] });
    const out = await call("get_meeting_summary", { id: "2026-03-02-foo-planning" });
    expect(out).toContain("With: person/ken-lee, org/acme-api");
    expect(out).toContain("- Launch on Tuesday");
    expect(out).toContain("- [ ] Send the bar budget. (Sam Bar)");
    expect(await call("get_meeting_summary", { id: "2026-01-10-empty" })).toContain("No summary yet.");
  });

  test("action items: open across meetings, by owner, by meeting, with done", async () => {
    expect(meetingActions(findMeeting(V, "2026-03-02-foo-planning")!)).toEqual([
      { meeting: "Recordings/2026-03-02-foo-planning", title: "Foo planning", created: "2026-03-02T15:00:00Z", text: "Send the bar budget.", done: false, owner: "Sam Bar" },
      { meeting: "Recordings/2026-03-02-foo-planning", title: "Foo planning", created: "2026-03-02T15:00:00Z", text: "Book the room.", done: true, owner: "Ken Lee" },
      { meeting: "Recordings/2026-03-02-foo-planning", title: "Foo planning", created: "2026-03-02T15:00:00Z", text: "Draft the foo notes.", done: false },
    ]);
    const open = await call("list_meeting_actions");
    expect(open).toContain("Check the baz numbers.");
    expect(open).toContain("Send the bar budget.");
    expect(open).not.toContain("Book the room.");
    expect(await call("list_meeting_actions", { include_done: true })).toContain("Book the room.");
    const anns = await call("list_meeting_actions", { owner: "ann" });
    expect(anns).toContain("Check the baz numbers.");
    expect(anns).not.toContain("bar budget");
    expect(JSON.parse(await call("list_meeting_actions", { id: "2026-03-05-baz-sync", format: "json" }))).toHaveLength(1);
  });

  test("an unknown or escaping id finds nothing", async () => {
    expect(await call("get_meeting_summary", { id: "../../../etc" })).toContain('No Jot meeting "../../../etc"');
    expect(await call("get_meeting_transcript", { id: "" })).toContain("No Jot meeting");
    expect(await call("list_meeting_actions", { id: "nope" })).toContain("No Jot meeting");
  });

  test("a vault without Jot says so", async () => {
    const empty = mkdtempSync(join(tmpdir(), "jot-mcp-none-"));
    try { expect(listMeetings(empty)).toEqual([]); } finally { rmSync(empty, { recursive: true, force: true }); }
    expect(await call("list_meeting_actions", { since: "2027-01-01" })).toBe("No open action items in Jot's meetings.");
  });
});
