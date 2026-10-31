// The Glyph Arena sidecar entry: `arena-engine <command> [--vault P] [--stream]`.
// Compiled on its own (bun build --compile) so the Arena app ships only what Arena needs.
import { arenaCommand, stdoutFlushed } from "./cli.ts";

// process.exit() drops whatever stdout has not been flushed, and on a PIPE (which
// is how the Arena app reads us) that cut lands at 64 KB: the app would parse half
// a JSON document. So wait for the pipe to drain, then exit with the code.
async function exitWhenWritten(code: number): Promise<void> {
  await stdoutFlushed();
  process.exit(code);
}

arenaCommand(process.argv.slice(2)).then(
  (code) => void exitWhenWritten(code),
  (e) => {
    process.stdout.write(`${JSON.stringify({ error: String(e?.message ?? e) })}\n`);
    void exitWhenWritten(1);
  },
);
