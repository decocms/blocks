// @vitest-environment node
/** The built-in `secret` block and `encryptSecret` (built-in-blocks.mdx#secrets, api-reference#secrets). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isSecretBlock } from "../protocol/secrets";
import { publicKeyPemFromDer } from "./ciphertext";
import { createCMS, resetForTests } from "./cms";
import { encryptSecret } from "./secrets";
import type { Block, Blocks, Snapshot } from "./types";

/** A 3072-bit key pair, as the docs' OpenSSL commands create (PKCS#8 private, SPKI public). */
async function keyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = btoa(String.fromCharCode(...pkcs8))
    .match(/.{1,64}/g)
    ?.join("\n");
  return {
    publicKey: publicKeyPemFromDer(spki),
    privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
  };
}

let keys: { publicKey: string; privateKey: string };
let other: { publicKey: string; privateKey: string };
let apiKey: Block;

beforeAll(async () => {
  [keys, other] = await Promise.all([keyPair(), keyPair()]);
  apiKey = await encryptSecret(keys.publicKey, "re_live_123");
}, 30_000);

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const newsletter = (props: { listId: string; apiKey: string }) => ({ ...props });

function snapshot(): Snapshot {
  return {
    revision: "rev-1",
    blocks: {
      Newsletter: { __resolveType: "newsletter", listId: "weekly", apiKey },
      NewsletterKey: apiKey,
    },
  };
}

function client(key: string | undefined, blocks: Blocks = { newsletter }) {
  return createCMS({ blocks, content: snapshot(), secrets: { key } }).forRelease();
}

describe("encryptSecret", () => {
  it("returns a ready secret block with a well-formed ciphertext", () => {
    expect(apiKey.__resolveType).toBe("secret");
    expect(isSecretBlock(apiKey)).toBe(true);
    expect(JSON.stringify(apiKey)).not.toContain("re_live_123");
  });

  it("encrypts each value with a fresh key", async () => {
    const again = await encryptSecret(keys.publicKey, "re_live_123");
    expect(again.ciphertext).not.toBe(apiKey.ciphertext);
  });
});

describe("the secret block", () => {
  it("resolves to the decrypted string on the server", async () => {
    const [value, error] = await client(keys.privateKey).resolve("Newsletter");
    expect(error).toBeNull();
    expect(value).toEqual({ listId: "weekly", apiKey: "re_live_123" });
  });

  it("resolves as a saved block, and inline", async () => {
    const c = client(keys.privateKey);
    await expect(c.resolve("NewsletterKey")).resolves.toEqual(["re_live_123", null]);
    await expect(c.resolve(apiKey)).resolves.toEqual(["re_live_123", null]);
  });

  it("keeps the ciphertext with { run: false } and in client.list", async () => {
    const c = client(keys.privateKey);
    const [read] = await c.resolve("Newsletter", { run: false });
    expect(read).toEqual({ __resolveType: "newsletter", listId: "weekly", apiKey });
    const [secrets] = await c.list("secret");
    expect(secrets).toEqual([apiKey]);
  });

  describe("a failure fails that block with BLOCK_FAILED", () => {
    async function failure(key: string | undefined, target: unknown = "Newsletter") {
      const [value, error] = await client(key).resolve(target);
      expect(value).toBeNull();
      expect(error?.code).toBe("BLOCK_FAILED");
      const text = `${error?.message} ${String((error?.cause as Error)?.message)}`;
      expect(text).not.toContain("re_live_123");
      expect(text).not.toContain("PRIVATE KEY");
      return error;
    }

    it("without a key", async () => {
      const error = await failure(undefined);
      expect(error?.path).toEqual(["apiKey"]);
      expect(error?.message).toContain("secret");
    });

    it("with the wrong key", async () => {
      expect((await failure(other.privateKey))?.path).toEqual(["apiKey"]);
    });

    it("with a key that isn't a PKCS#8 private key", async () => {
      await failure("not a pem");
      await failure(other.publicKey);
    });

    it("with a malformed ciphertext", async () => {
      await failure(keys.privateKey, { __resolveType: "secret", ciphertext: "v1.hunter2" });
      await failure(keys.privateKey, { __resolveType: "secret" });
    });

    it("in a browser", async () => {
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", {});
      await failure(keys.privateKey);
    });

    it("and the rest of the content still resolves", async () => {
      const c = client(undefined, {
        newsletter,
        hero: (props: { title: string }) => props,
      });
      expect((await c.resolve("Newsletter"))[1]?.code).toBe("BLOCK_FAILED");
      await expect(c.resolve({ __resolveType: "hero", title: "Hi" })).resolves.toEqual([
        { title: "Hi" },
        null,
      ]);
    });
  });

  it("uses the key of the first createCMS call for the same content", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = snapshot();
    createCMS({ blocks: { newsletter }, content, secrets: { key: keys.privateKey } });
    const second = createCMS({ blocks: { newsletter }, content, secrets: { key: "other" } });
    await expect(second.forRelease().resolve(apiKey)).resolves.toEqual(["re_live_123", null]);
  });

  it("is replaced by a secret key in the block map", async () => {
    const c = client(keys.privateKey, { secret: () => "mine" });
    await expect(c.resolve(apiKey)).resolves.toEqual(["mine", null]);
  });
});
