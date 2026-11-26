// The local model. Synthetic generation reads real notes, so it only ever talks to
// Ollama on this machine: any other host is refused before a byte is sent.
export type Llm = (prompt: string, opts?: { system?: string; temperature?: number }) => Promise<string>;

export function ollamaLlm(model: string, baseUrl = "http://localhost:11434"): Llm {
  const host = new URL(baseUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error(`synth only uses a local model, refusing ${host}`);
  return async (prompt, opts = {}) => {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model, prompt, system: opts.system, stream: false, think: false, options: { temperature: opts.temperature ?? 0.4, num_predict: 400 } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    return String(((await res.json()) as { response?: string }).response ?? "").trim();
  };
}

export async function ollamaUp(baseUrl = "http://localhost:11434"): Promise<boolean> {
  try { return (await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
