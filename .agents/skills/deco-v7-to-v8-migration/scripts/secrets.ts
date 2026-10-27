/**
 * Secrets (spec: renames-and-migrations › Secrets). v7 saved each credential
 * as a `website/loaders/secret.ts` block, encrypted under `DECO_CRYPTO_KEY`.
 * The next major keeps no secrets in content: they live in the deploy
 * platform's secrets, and the site's code reads them and passes them as
 * params. This step decrypts nothing and writes nothing: it lists each v7
 * secret, with the variable v7 read it from when it names one, so the
 * developer moves its value to the deploy platform and deletes the block
 * (`deco check` points out any left).
 */
import type { Report } from "./report";
import { forEachBlock, readContent } from "./walk";

const DOCS = "/next/renames-and-migrations#secrets";

/** v7's secret type names, with and without the extension: the secrets step's, never the block map's. */
export const V7_SECRET_TYPES = new Set(["website/loaders/secret.ts", "website/loaders/secret"]);

/** Every v7 secret in `.deco/blocks`, as a manual step: move its value to the deploy platform. */
export function listSecrets(root: string, report: Report): void {
  const { blocks, files } = readContent(root);
  for (const [entry, block] of Object.entries(blocks)) {
    forEachBlock(block, (node) => {
      if (!V7_SECRET_TYPES.has(node.__resolveType)) return;
      const name = typeof node.name === "string" && node.name.length > 0 ? node.name : undefined;
      const where = node === block ? "a v7 secret" : `a v7 secret inside "${entry}"`;
      const variable = name ? `, such as ${name} (the variable v7 read it from)` : "";
      report.manual.push({
        step: "secrets",
        subject: files[entry],
        message: `${where}: secrets live in your deploy platform now, not in content. Put its value in the deploy platform's secrets${variable}, read it in the site's code and pass it as a param where the content used it, then delete it from content (${DOCS})`,
      });
    });
  }
}
