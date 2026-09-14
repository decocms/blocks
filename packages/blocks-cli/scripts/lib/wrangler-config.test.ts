import { describe, expect, it } from "vitest";
import { setKvNamespaceIdInJsonc } from "./wrangler-config";

describe("setKvNamespaceIdInJsonc", () => {
  // The scaffolded wrangler.jsonc carries the comments explaining why each
  // binding exists; a parse-and-restringify round trip would drop every one.
  const WRANGLER = `{
  "name": "acme",
  "kv_namespaces": [
    // Fast Deploy content store.
    { "binding": "DECO_KV", "id": "" },
    // A/B testing assignments.
    { "binding": "SITES_KV", "id": "" }
  ],
  "vars": { "DECO_FAST_DEPLOY": "1" }
}`;

  it("writes the id into the DECO_KV entry and leaves comments intact", () => {
    const out = setKvNamespaceIdInJsonc(WRANGLER, "ns-123");
    expect(out).toContain('{ "binding": "DECO_KV", "id": "ns-123" }');
    expect(out).toContain("// Fast Deploy content store.");
    expect(out).toContain("// A/B testing assignments.");
  });

  it("does not touch a different binding's id", () => {
    const out = setKvNamespaceIdInJsonc(WRANGLER, "ns-123");
    expect(out).toContain('{ "binding": "SITES_KV", "id": "" }');
  });

  it("targets the requested binding", () => {
    const out = setKvNamespaceIdInJsonc(WRANGLER, "ab-9", "SITES_KV");
    expect(out).toContain('{ "binding": "SITES_KV", "id": "ab-9" }');
    expect(out).toContain('{ "binding": "DECO_KV", "id": "" }');
  });

  it("handles reversed field order and an entry with no id yet", () => {
    const src = '{ "kv_namespaces": [{ "id": "old", "binding": "DECO_KV" }] }';
    expect(setKvNamespaceIdInJsonc(src, "new")).toContain('"id": "new"');
    const noId = '{ "kv_namespaces": [{ "binding": "DECO_KV" }] }';
    expect(setKvNamespaceIdInJsonc(noId, "new")).toContain('"id": "new"');
  });

  it("returns the source unchanged when the binding is absent", () => {
    // Not an error: the builder re-forces the id from CF_KV_NAMESPACE_ID on
    // every build, so a repo without the binding is just nothing to personalize.
    const src = '{ "kv_namespaces": [{ "binding": "SITES_KV", "id": "x" }] }';
    expect(setKvNamespaceIdInJsonc(src, "ns-123")).toBe(src);
  });
});
