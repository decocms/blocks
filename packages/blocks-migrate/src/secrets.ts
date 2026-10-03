/**
 * Secrets (spec: renames-and-migrations › Secrets). v7 saved each credential
 * as a `website/loaders/secret.ts` block holding `encrypted`, an AES-CBC
 * value under `DECO_CRYPTO_KEY`. The next major's `secret` block holds
 * `ciphertext`, encrypted with the site's public key (`.deco/secrets.pub`).
 * This step decrypts each v7 secret with v7's own crypto and re-encrypts it
 * with `encryptSecret`, in place, so the content commit carries the change.
 */
import fs from "node:fs";
import path from "node:path";
import { LEGACY_ALIASES } from "@decocms/blocks/cli";
import { serializeBlock } from "@decocms/blocks/protocol/keys";
import { decryptSecret } from "@decocms/blocks/sdk/crypto";
import { encryptSecret } from "@decocms/blocks/secrets";
import type { Report } from "./report";
import { forEachBlock, type JsonObject, readContent } from "./walk";

const DOCS = "/next/renames-and-migrations#secrets";

/** The v7 type names of a secret: every legacy alias of `secret`, with and without the extension. */
const LEGACY_SECRET_TYPES = new Set(
  Object.entries(LEGACY_ALIASES)
    .filter(([, target]) => target === "secret")
    .flatMap(([name]) => [name, name.replace(/\.tsx?$/, "")]),
);

function isLegacySecret(block: JsonObject & { __resolveType: string }): boolean {
  return LEGACY_SECRET_TYPES.has(block.__resolveType) && typeof block.encrypted === "string";
}

/** Re-encrypt every v7 secret in `.deco/blocks`. Reads `DECO_CRYPTO_KEY` from the environment. */
export async function reencryptSecrets(root: string, report: Report): Promise<void> {
  const { blocks, files } = readContent(root);
  const found: { entry: string; block: JsonObject }[] = [];
  for (const [entry, block] of Object.entries(blocks)) {
    forEachBlock(block, (node) => {
      if (isLegacySecret(node)) found.push({ entry, block: node });
    });
  }
  if (found.length === 0) return;

  const leave = (message: string) => {
    for (const { entry } of found) {
      report.manual.push({ step: "secrets", subject: files[entry], message });
    }
  };
  const publicKeyFile = path.join(root, ".deco", "secrets.pub");
  if (!fs.existsSync(publicKeyFile)) {
    leave(
      `a v7 secret: create the key pair (.deco/secrets.pub) and run again with DECO_CRYPTO_KEY set (${DOCS})`,
    );
    return;
  }
  if (!process.env.DECO_CRYPTO_KEY) {
    leave(`a v7 secret: run again with DECO_CRYPTO_KEY set to re-encrypt it (${DOCS})`);
    return;
  }
  const publicKey = fs.readFileSync(publicKeyFile, "utf8");

  const changed = new Set<string>();
  for (const { entry, block } of found) {
    const name = typeof block.name === "string" ? block.name : undefined;
    const value = block.encrypted ? await decryptSecret(block.encrypted as string) : null;
    if (value === null) {
      report.manual.push({
        step: "secrets",
        subject: files[entry],
        message: `secret${name ? ` ${name}` : ""} didn't decrypt with DECO_CRYPTO_KEY; save it again in the site editor`,
      });
      continue;
    }
    const { __resolveType, ciphertext } = await encryptSecret(publicKey, value);
    // Keep fields this step doesn't know; drop the v7 ones.
    delete block.encrypted;
    delete block.name;
    Object.assign(block, { __resolveType, ciphertext });
    changed.add(entry);
    report.done.push({
      step: "secrets",
      subject: files[entry],
      message: `re-encrypted secret${name ? ` ${name}` : ""} with .deco/secrets.pub`,
    });
  }
  for (const entry of changed) {
    fs.writeFileSync(
      path.join(root, ".deco", "blocks", files[entry]),
      serializeBlock(blocks[entry]),
    );
  }
}
