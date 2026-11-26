// Glyph Jot's meetings, read-only, for the MCP tools (search_meetings,
// get_meeting_transcript, get_meeting_summary, list_meeting_actions).
//
// Jot writes each recording as plain files under
// <vault>/data/apps/jot/recordings/<folder>/<slug>/: meta.json (title,
// created, duration_sec, people, tags, links), transcript.json (segments with
// a speaker key and the speakers' names), transcript.txt ("[mm:ss] Name:
// line") and notes.md (front matter, then ## Summary, ## Decisions,
// ## Action items as "- [ ] text  <!-- owner: Name -->"). Nothing here writes.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { vreadFile } from "./vault-session.ts";

export interface JotMeeting {
  id: string; // "<folder>/<slug>", as Jot's meta.json writes it
  title: string;
  created: string;
  durationSec: number;
  people: string[];
  tags: string[];
  links: string[];
  dir: string;
}

export interface JotAction {
  meeting: string;
  title: string;
  created: string;
  text: string;
  done: boolean;
  owner?: string;
}

export function recordingsRoot(vault: string): string {
  return join(vault, "data", "apps", "jot", "recordings");
}

const read = (p: string): string | null => {
  try { return existsSync(p) ? vreadFile(p) : null; } catch { return null; }
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const visibleDirs = (p: string): string[] => {
  try { return readdirSync(p).filter((n) => !n.startsWith(".") && statSync(join(p, n)).isDirectory()); } catch { return []; }
};

/** Every recording with a meta.json, newest first. */
export function listMeetings(vault: string): JotMeeting[] {
  const root = recordingsRoot(vault);
  const out: JotMeeting[] = [];
  for (const folder of visibleDirs(root)) {
    for (const slug of visibleDirs(join(root, folder))) {
      const dir = join(root, folder, slug);
      const raw = read(join(dir, "meta.json"));
      if (!raw) continue;
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw); } catch { continue; }
      out.push({
        id: `${folder}/${slug}`,
        title: typeof m.title === "string" && m.title ? m.title : slug,
        created: typeof m.created === "string" ? m.created : "",
        durationSec: typeof m.duration_sec === "number" ? m.duration_sec : 0,
        people: strs(m.people),
        tags: strs(m.tags),
        links: strs(m.links),
        dir,
      });
    }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

/** One meeting by its id ("Recordings/<slug>") or bare slug. Matched against the listing, so an id can never reach outside it. */
export function findMeeting(vault: string, id: string): JotMeeting | null {
  const want = id.trim().replace(/^\/+|\/+$/g, "");
  if (!want) return null;
  const all = listMeetings(vault);
  return all.find((m) => m.id === want) ?? all.find((m) => m.id.split("/").pop() === want) ?? null;
}

/** The transcript: transcript.txt as written, else built from transcript.json's segments. */
export function meetingTranscript(m: JotMeeting): string {
  const txt = read(join(m.dir, "transcript.txt"));
  if (txt && txt.trim()) return txt.trim();
  const raw = read(join(m.dir, "transcript.json"));
  if (!raw) return "";
  try {
    const t = JSON.parse(raw) as { speakers?: Record<string, string>; segments?: { start?: number; speaker?: string; text?: string }[] };
    const names = t.speakers ?? {};
    return (t.segments ?? []).map((s) => {
      const sec = Math.max(0, Math.floor(s.start ?? 0));
      const stamp = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
      const who = s.speaker ? names[s.speaker] ?? s.speaker : "";
      return `[${stamp}] ${who ? `${who}: ` : ""}${(s.text ?? "").trim()}`;
    }).join("\n");
  } catch { return ""; }
}

/** notes.md without its front matter, split into sections by "## " heading. */
function noteSections(m: JotMeeting): Map<string, string> {
  const raw = read(join(m.dir, "notes.md")) ?? "";
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const out = new Map<string, string>();
  let head = "";
  let buf: string[] = [];
  const flush = () => { if (head || buf.join("").trim()) out.set(head.toLowerCase(), buf.join("\n").trim()); };
  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { flush(); head = h[1]!; buf = []; } else buf.push(line);
  }
  flush();
  return out;
}

/** Summary and decisions from notes.md (action items have their own tool). */
export function meetingSummary(m: JotMeeting): { summary: string; decisions: string[] } {
  const s = noteSections(m);
  const decisions = (s.get("decisions") ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
  return { summary: s.get("summary") ?? "", decisions };
}

const ACTION = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*(?:<!--\s*owner:\s*(.*?)\s*-->)?\s*$/;

export function meetingActions(m: JotMeeting): JotAction[] {
  const sec = noteSections(m).get("action items") ?? "";
  const out: JotAction[] = [];
  for (const line of sec.split("\n")) {
    const a = ACTION.exec(line);
    if (!a || !a[2]) continue;
    out.push({ meeting: m.id, title: m.title, created: m.created, text: a[2], done: a[1] !== " ", ...(a[3] ? { owner: a[3] } : {}) });
  }
  return out;
}

export interface JotHit { meeting: JotMeeting; where: string; snippet: string }

/** Meetings whose title, people, tags, links, notes or transcript hold every word of the query. */
export function searchMeetings(vault: string, query: string, opts: { since?: string; limit?: number } = {}): JotHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const hits: JotHit[] = [];
  for (const m of listMeetings(vault)) {
    if (opts.since && m.created && m.created.slice(0, 10) < opts.since) continue;
    if (!words.length) { hits.push({ meeting: m, where: "", snippet: "" }); continue; }
    const parts: [string, string][] = [
      ["title", m.title],
      ["people", [...m.people, ...m.links, ...m.tags].join(" ")],
      ["notes", read(join(m.dir, "notes.md")) ?? ""],
      ["transcript", meetingTranscript(m)],
    ];
    const all = parts.map((p) => p[1]).join("\n").toLowerCase();
    if (!words.every((w) => all.includes(w))) continue;
    const first = parts.find(([, t]) => t.toLowerCase().includes(words[0]!))!;
    const lines = first[1].split("\n");
    const line = lines.find((l) => l.toLowerCase().includes(words[0]!)) ?? "";
    hits.push({ meeting: m, where: first[0], snippet: line.trim().slice(0, 240) });
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

const mins = (sec: number) => (sec ? `${Math.round(sec / 60)} min` : "length unknown");
export const meetingLine = (m: JotMeeting) => `${m.id}  ${m.created.slice(0, 10) || "no date"}  ${mins(m.durationSec)}  ${m.title}${m.tags.length ? `  #${m.tags.join(" #")}` : ""}`;

// The four tool bodies, as text (or JSON with format: "json").
type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const missing = (id: string) => `No Jot meeting "${id}". Find one with search_meetings.`;

export function tSearchMeetings(args: Args, vault: string): string {
  const hits = searchMeetings(vault, s(args.query), { since: s(args.since) || undefined, limit: typeof args.limit === "number" ? args.limit : undefined });
  if (args.format === "json") return JSON.stringify(hits.map((h) => ({ ...h.meeting, dir: undefined, where: h.where || undefined, snippet: h.snippet || undefined })), null, 2);
  if (!hits.length) return s(args.query) ? `No Jot meeting mentions "${s(args.query)}".` : "No Jot meetings in this vault yet.";
  return hits.map((h) => meetingLine(h.meeting) + (h.snippet ? `\n    ${h.where}: ${h.snippet}` : "")).join("\n");
}

export function tMeetingTranscript(args: Args, vault: string): string {
  const m = findMeeting(vault, s(args.id));
  if (!m) return missing(s(args.id));
  const t = meetingTranscript(m);
  const max = typeof args.max_chars === "number" && args.max_chars > 0 ? args.max_chars : 200_000;
  const body = t.length > max ? `${t.slice(0, max)}\n[cut at ${max} of ${t.length} characters]` : t;
  return `${meetingLine(m)}\n\n${body || "No transcript yet."}`;
}

export function tMeetingSummary(args: Args, vault: string): string {
  const m = findMeeting(vault, s(args.id));
  if (!m) return missing(s(args.id));
  const sum = meetingSummary(m);
  const actions = meetingActions(m);
  if (args.format === "json") return JSON.stringify({ ...m, dir: undefined, ...sum, actions }, null, 2);
  const withWho = [...m.people, ...m.links];
  return [
    meetingLine(m),
    ...(withWho.length ? [`With: ${withWho.join(", ")}`] : []),
    "",
    "Summary:", sum.summary || "No summary yet.",
    ...(sum.decisions.length ? ["", "Decisions:", ...sum.decisions.map((d) => `- ${d}`)] : []),
    ...(actions.length ? ["", "Action items:", ...actions.map((a) => `- [${a.done ? "x" : " "}] ${a.text}${a.owner ? ` (${a.owner})` : ""}`)] : []),
  ].join("\n");
}

export function tMeetingActions(args: Args, vault: string): string {
  const id = s(args.id);
  let meetings: JotMeeting[];
  if (id) {
    const m = findMeeting(vault, id);
    if (!m) return missing(id);
    meetings = [m];
  } else {
    const since = s(args.since);
    meetings = listMeetings(vault).filter((m) => !since || !m.created || m.created.slice(0, 10) >= since);
  }
  const owner = s(args.owner).toLowerCase();
  const all = meetings.flatMap(meetingActions)
    .filter((a) => args.include_done === true || !a.done)
    .filter((a) => !owner || (a.owner ?? "").toLowerCase().includes(owner));
  if (args.format === "json") return JSON.stringify(all, null, 2);
  if (!all.length) return "No open action items in Jot's meetings.";
  return all.map((a) => `- [${a.done ? "x" : " "}] ${a.text}${a.owner ? ` (${a.owner})` : ""}  ${a.created.slice(0, 10)} ${a.title} [${a.meeting}]`).join("\n");
}
