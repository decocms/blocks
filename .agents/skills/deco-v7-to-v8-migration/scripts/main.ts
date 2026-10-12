/** The migration's command line: `bun scripts/main.ts` (or `npx tsx scripts/main.ts`). */
import { parseArgs } from "node:util";
import { migrate } from "./migrate";
import { formatReport } from "./report";

const USAGE = `Usage: bun scripts/main.ts [--root <dir>] [--decofile <file>]

Migrates a v7 Deco site to the next major, in place, and prints what is left
to do. Run it on a clean working tree with DECO_CRYPTO_KEY set and
.deco/secrets.pub committed (see /next/renames-and-migrations).

  --root <dir>       the app root, with the site's package.json (default: .)
  --decofile <file>  content to split into .deco/blocks when the site has none
                     (the JSON served at <site>/.decofile)`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      decofile: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const report = await migrate({ root: values.root!, decofile: values.decofile });
  console.log(formatReport(report));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(USAGE);
    process.exitCode = 1;
  },
);
