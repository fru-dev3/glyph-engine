// Standalone entry: `bun src/arena/synth/main.ts build --area insurance`.
// The Arena sidecar can also route `synth ...` to synthCommand (cli.ts).
import { synthCommand } from "./cli.ts";
process.exit(await synthCommand(process.argv.slice(2)));
