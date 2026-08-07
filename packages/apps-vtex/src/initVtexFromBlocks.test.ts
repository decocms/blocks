/**
 * Regression test: initVtexFromBlocks runs on every resolve (wired as the
 * `initPlatform` → `onBeforeResolve` hook) and only understands plain-string
 * appKey/appToken. The CMS stores them encrypted, decrypted elsewhere by
 * autoconfigApps' configure(). initVtexFromBlocks must NOT clobber those
 * decrypted credentials with `undefined` when the block value is an encrypted
 * object — doing so makes privileged VTEX calls (MasterData writes) go out
 * anonymous (VTEX 403 "Cannot write in private fields"). This shipped and broke
 * Bagaggio's lead-capture form.
 */

import { describe, expect, it } from "vitest";
import { configureVtex, getVtexConfig, initVtexFromBlocks } from "./client";

describe("initVtexFromBlocks", () => {
  it("preserves already-decrypted creds when the block appKey is an encrypted object", () => {
    // Simulate autoconfigApps.configure() having decrypted + installed the creds.
    configureVtex({
      account: "lojabagaggio",
      appKey: "vtexappkey-decrypted",
      appToken: "decrypted-token",
    });

    // A decofile block carries the secrets encrypted (not plain strings).
    initVtexFromBlocks({
      "deco-vtex": {
        account: "lojabagaggio",
        appKey: { __resolveType: "website/loaders/secret.ts", encrypted: "abc" },
        appToken: { __resolveType: "website/loaders/secret.ts", encrypted: "def" },
      },
    });

    const cfg = getVtexConfig();
    expect(cfg.appKey).toBe("vtexappkey-decrypted");
    expect(cfg.appToken).toBe("decrypted-token");
    expect(cfg.account).toBe("lojabagaggio");
  });

  it("still applies a plain-string appKey/appToken from the block", () => {
    configureVtex({ account: "old", appKey: "stale", appToken: "stale" });

    initVtexFromBlocks({
      "deco-vtex": {
        account: "lojabagaggio",
        appKey: "plain-key",
        appToken: "plain-token",
      },
    });

    const cfg = getVtexConfig();
    expect(cfg.appKey).toBe("plain-key");
    expect(cfg.appToken).toBe("plain-token");
  });
});
