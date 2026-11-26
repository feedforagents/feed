import path from "node:path";
import { commands, runCli } from "./index.ts";

const rootDir = path.resolve(import.meta.dirname, "../../..");

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  commands,
  rootDir,
  cwd: process.cwd(),
  io: {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  },
});
