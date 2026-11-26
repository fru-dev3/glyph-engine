// Making things that are not text: images, speech, video, and reading speech back.
// Provider HTTP APIs with the keys the engine already reads (PREVAIL_<ID>_KEY),
// whisper.cpp on this Mac for transcription. Every call is priced before it is made
// (the monthly cap in budget.ts) and every result is a file the run keeps.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { glyphHome } from "../glyph-home.ts";

export type MediaKind = "image" | "voice-tts" | "transcribe" | "video";

/** Rough price per call, used for the pre-flight cap check. Overridable in config.media_prices. */
export const MEDIA_PRICES: Record<string, number> = {
  "image": 0.04,
  "voice-tts": 0.01,
  "transcribe": 0.006,
  "video": 0.5,
};

const KEY: Record<string, string> = {
  openai: "PREVAIL_OPENAI_KEY",
  google: "PREVAIL_GOOGLE_KEY",
  replicate: "PREVAIL_REPLICATE_KEY",
};
// The same keys as they are named in an env file on disk. Only these four are ever read:
// nothing else in a file is looked at, and no key is printed or logged anywhere.
const DISK_NAME: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  replicate: "REPLICATE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
let diskKeys: Record<string, string> = {};

/** Read provider keys from env files (config.env_files). Replaces what was loaded before. */
export function loadKeyFiles(files: string[]): number {
  diskKeys = {};
  for (const f of files) {
    let raw = "";
    try { raw = readFileSync(f, "utf8"); } catch { continue; }
    for (const [prov, name] of Object.entries(DISK_NAME)) {
      if (diskKeys[prov]) continue;
      const m = raw.match(new RegExp(`^${name}=(.*)$`, "m"));
      const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (v) diskKeys[prov] = v;
    }
  }
  return Object.keys(diskKeys).length;
}

const keyOf = (provider: string): string | null => process.env[KEY[provider] ?? ""] || diskKeys[provider] || null;

export function mediaKeyPresent(provider: string): boolean {
  if (provider === "whisper") return !!whisperBin();
  return !!keyOf(provider);
}

export const providerKey = keyOf;

const key = (provider: string) => {
  const v = keyOf(provider);
  if (!v) throw new Error(`no key for ${provider}`);
  return v;
};

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** 16-bit mono PCM to a WAV file (Gemini speech comes back as raw L16). */
export function pcmToWav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const inlineData = (j: any): { data: string; mimeType: string } | null => {
  for (const c of j?.candidates ?? []) for (const p of c?.content?.parts ?? []) if (p?.inlineData?.data) return p.inlineData;
  return null;
};

/** Writes the result to outBase + extension; returns the file name written. */
export async function makeImage(provider: string, model: string, prompt: string, outBase: string, signal?: AbortSignal): Promise<string> {
  if (provider === "openai") {
    const j = await postJson("https://api.openai.com/v1/images/generations", { model, prompt, size: "1024x1024", n: 1 }, { authorization: `Bearer ${key("openai")}` }, signal);
    const b64 = j?.data?.[0]?.b64_json;
    if (b64) { writeFileSync(`${outBase}.png`, Buffer.from(b64, "base64")); return `${outBase}.png`; }
    const url = j?.data?.[0]?.url;
    if (url) return download(url, `${outBase}.png`, signal);
    throw new Error("no image in the reply");
  }
  if (provider === "google") {
    const j = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }, { "x-goog-api-key": key("google") }, signal);
    const d = inlineData(j);
    if (!d) throw new Error("no image in the reply");
    const ext = d.mimeType.includes("jpeg") ? "jpg" : d.mimeType.includes("webp") ? "webp" : "png";
    writeFileSync(`${outBase}.${ext}`, Buffer.from(d.data, "base64"));
    return `${outBase}.${ext}`;
  }
  if (provider === "replicate") return replicate(model, { prompt }, outBase, "png", signal);
  throw new Error(`no image maker for ${provider}`);
}

export async function makeSpeech(provider: string, model: string, script: string, outBase: string, signal?: AbortSignal): Promise<string> {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key("openai")}` },
      body: JSON.stringify({ model, voice: "alloy", input: script, response_format: "mp3" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    writeFileSync(`${outBase}.mp3`, Buffer.from(await res.arrayBuffer()));
    return `${outBase}.mp3`;
  }
  if (provider === "google") {
    const j = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{ parts: [{ text: script }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
    }, { "x-goog-api-key": key("google") }, signal);
    const d = inlineData(j);
    if (!d) throw new Error("no audio in the reply");
    const rate = Number(d.mimeType.match(/rate=(\d+)/)?.[1] ?? 24000);
    writeFileSync(`${outBase}.wav`, pcmToWav(Buffer.from(d.data, "base64"), rate));
    return `${outBase}.wav`;
  }
  throw new Error(`no speech maker for ${provider}`);
}

export async function makeVideo(provider: string, model: string, prompt: string, outBase: string, signal?: AbortSignal): Promise<string> {
  if (provider === "replicate") return replicate(model, { prompt }, outBase, "mp4", signal);
  throw new Error(`no video maker for ${provider}`);
}

/** Replicate's "run and wait": model is "owner/name". The output is a URL (or a list). */
async function replicate(model: string, input: Record<string, unknown>, outBase: string, ext: string, signal?: AbortSignal): Promise<string> {
  const j = await postJson(`https://api.replicate.com/v1/models/${model}/predictions`, { input }, { authorization: `Bearer ${key("replicate")}`, prefer: "wait=60" }, signal);
  let p = j;
  for (let i = 0; i < 60 && p?.status && !["succeeded", "failed", "canceled"].includes(p.status); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(p.urls.get, { headers: { authorization: `Bearer ${key("replicate")}` }, signal });
    p = await r.json();
  }
  if (p?.status !== "succeeded") throw new Error(`replicate: ${p?.status ?? "no status"} ${String(p?.error ?? "").slice(0, 200)}`);
  const url = Array.isArray(p.output) ? p.output[0] : p.output;
  if (typeof url !== "string") throw new Error("replicate: no output url");
  return download(url, `${outBase}.${ext}`, signal);
}

async function download(url: string, path: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

// ---- transcription -------------------------------------------------------

export function whisperBin(): string | null {
  for (const b of ["whisper-cli", "whisper-cpp"]) {
    const r = spawnSync("/usr/bin/which", [b], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

/** The whisper.cpp model: config.whisper_model, else <glyph home>/models/ggml-base.en.bin. */
export function whisperModel(configured?: string): string | null {
  const p = configured || join(glyphHome(), "models", "ggml-base.en.bin");
  return existsSync(p) ? p : null;
}

/** Transcribe a file. provider "whisper" runs whisper.cpp here; "openai" uses the API. */
export async function transcribe(provider: string, model: string, audioPath: string, opts: { whisperModel?: string; signal?: AbortSignal } = {}): Promise<string> {
  if (provider === "whisper") {
    const bin = whisperBin();
    const m = whisperModel(model && model !== "local" ? model : opts.whisperModel);
    if (!bin || !m) throw new Error("whisper.cpp or its model is not on this Mac");
    // whisper.cpp wants 16 kHz mono WAV
    const wav = `${audioPath}.16k.wav`;
    const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", wav], { encoding: "utf8" });
    if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr.slice(0, 200)}`);
    const r = spawnSync(bin, ["-m", m, "-f", wav, "-nt", "-np"], { encoding: "utf8", timeout: 600_000 });
    if (r.status !== 0) throw new Error(`whisper: ${r.stderr.slice(0, 200)}`);
    return r.stdout.replace(/\s+/g, " ").trim();
  }
  if (provider === "openai") {
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([readFileSync(audioPath)]), audioPath.split("/").pop()!);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key("openai")}` }, body: form, signal: opts.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return String(((await res.json()) as { text?: string }).text ?? "").trim();
  }
  throw new Error(`no transcriber for ${provider}`);
}

/** Word error rate: word-level edit distance over the reference length. */
export function wer(reference: string, hypothesis: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const r = norm(reference), h = norm(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round((prev[h.length]! / r.length) * 1000) / 1000;
}
