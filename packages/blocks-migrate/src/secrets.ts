/**
 * Secrets (spec: renames-and-migrations › Secrets). v7 saved each credential
 * as a `website/loaders/secret.ts` block holding `encrypted`, an AES-CBC
 * value under `DECO_CRYPTO_KEY`. The next major's `secret` block holds
 * `ciphertext`, encrypted with the site's public key (`.deco/secrets.pub`).
 * This step decrypts each v7 secret (v7's format, read here so nothing from
 * v7 is imported) and re-encrypts it with `encryptSecret`, in place, so the
 * content commit carries the change.
 */
import fs from "node:fs";
import path from "node:path";
import { LEGACY_ALIASES } from "@decocms/blocks/cli";
import { serializeBlock } from "@decocms/blocks/protocol/keys";
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

/**
 * v7's secret format: `DECO_CRYPTO_KEY` is base64 JSON `{ key, iv }` (byte
 * arrays) for AES-CBC, and `encrypted` is the ciphertext in hex. Returns null
 * when the value doesn't decrypt with that key.
 */
async function decryptV7(encryptedHex: string, cryptoKey: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(atob(cryptoKey));
    const bytes = (v: unknown) => new Uint8Array(Array.isArray(v) ? v : Object.values(v as object));
    const key = await crypto.subtle.importKey("raw", bytes(parsed.key), "AES-CBC", false, [
      "decrypt",
    ]);
    const data = Uint8Array.from(encryptedHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: bytes(parsed.iv) }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Re-encrypt every v7 secret in `.deco/blocks`. Reads `DECO_CRYPTO_KEY` from the environment. */
export async function reencryptSecrets(root: string, report: Report): Promise<void> {
  const { blocks, files } = readContent(root);
  const found: { entry: string; block: JsonObject }[] = [];
  for (const [entry, block] of Object.entries(blocks)) {
    forEachBlock(block, (node) => {
      if (!LEGACY_SECRET_TYPES.has(node.__resolveType)) return;
      if (typeof node.encrypted === "string") {
        found.push({ entry, block: node });
        return;
      }
      const env = typeof node.name === "string" ? ` (it read env ${node.name})` : "";
      report.manual.push({
        step: "secrets",
        subject: files[entry],
        message: `a v7 secret with no encrypted value${env}: save it in the site editor (${DOCS})`,
      });
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
  const cryptoKey = process.env.DECO_CRYPTO_KEY;
  if (!cryptoKey) {
    leave(`a v7 secret: run again with DECO_CRYPTO_KEY set to re-encrypt it (${DOCS})`);
    return;
  }
  const publicKey = fs.readFileSync(publicKeyFile, "utf8");

  const changed = new Set<string>();
  for (const { entry, block } of found) {
    const name = typeof block.name === "string" ? block.name : undefined;
    const value = await decryptV7(block.encrypted as string, cryptoKey);
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
