// The Glyph Arena sidecar entry: `arena-engine <command> [--vault P] [--stream]`.
// Compiled on its own (bun build --compile) so the Arena app ships only what Arena needs.
import { arenaCommand } from "./cli.ts";

arenaCommand(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stdout.write(`${JSON.stringify({ error: String(e?.message ?? e) })}\n`);
    process.exit(1);
  },
);
