/** The `deco` bin's entry: run the command line, then exit with its code. */
import { runCli } from "./run";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  },
);
