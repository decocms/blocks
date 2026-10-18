/** The migration's command line: `bun scripts/main.ts` (or `npx tsx scripts/main.ts`). */
import { parseArgs } from "node:util";
import { migrate } from "./migrate";
import { formatReport } from "./report";
import { VTEX_INVOKE_MODES, VtexInvokeChoiceNeeded, type VtexInvokeMode } from "./vtexInvoke";

const USAGE = `Usage: bun scripts/main.ts [--root <dir>] [--decofile <file>] [--vtex-invoke keep|v8]

Migrates a v7 Deco site to the next major, in place, and prints what is left
to do. Run it on a clean working tree with DECO_CRYPTO_KEY set and
.deco/secrets.pub committed (see /next/renames-and-migrations).

  --root <dir>       the app root, with the site's package.json (default: .)
  --decofile <file>  content to split into .deco/blocks when the site has none
                     (the JSON served at <site>/.decofile)
  --vtex-invoke <mode>  the VTEX invoke keys v7's VTEX app answered from its own
                     invoke map (invoke.vtex.actions.checkout.addItemsToCart);
                     needed only when the site calls them, and it has no default:
                     keep  vendor v7's handler, so the call works as it did
                     v8    no v7 code: @decocms/apps-vtex's client where it has the
                           operation, else a stub that rejects and a report line`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      decofile: { type: "string" },
      "vtex-invoke": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const vtexInvoke = values["vtex-invoke"];
  if (vtexInvoke !== undefined && !VTEX_INVOKE_MODES.includes(vtexInvoke as VtexInvokeMode)) {
    throw new Error(`--vtex-invoke takes keep or v8, not "${vtexInvoke}"`);
  }
  const report = await migrate({
    root: values.root!,
    decofile: values.decofile,
    vtexInvoke: vtexInvoke as VtexInvokeMode | undefined,
  });
  console.log(formatReport(report));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    // A choice the migration needs explains itself; the usage is for a wrong command line.
    if (!(error instanceof VtexInvokeChoiceNeeded)) console.error(USAGE);
    process.exitCode = 1;
  },
);
