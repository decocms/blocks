import { describe, expect, it } from "vitest";

import { buildExitUrl, buildShareUrl } from "./DraftPreviewBadge";

describe("buildShareUrl", () => {
  it("pins the exact draft version so a recipient sees the same working tree", () => {
    expect(buildShareUrl("https://fila.vtex.app/pdp/shoe", "abc.localhost:60534@v7")).toBe(
      "https://fila.vtex.app/pdp/shoe?__draft=abc.localhost%3A60534%40v7",
    );
  });

  it("preserves existing query params, only setting the draft token", () => {
    expect(buildShareUrl("https://fila.vtex.app/plp?sort=price", "h@v1")).toBe(
      "https://fila.vtex.app/plp?sort=price&__draft=h%40v1",
    );
  });

  it("replaces a stale token already in the URL rather than appending a second", () => {
    expect(buildShareUrl("https://fila.vtex.app/p?__draft=h@old", "h@new")).toBe(
      "https://fila.vtex.app/p?__draft=h%40new",
    );
  });
});

describe("buildExitUrl", () => {
  it("sets the ?__draft=off exit sentinel", () => {
    expect(buildExitUrl("https://fila.vtex.app/pdp/shoe")).toBe(
      "https://fila.vtex.app/pdp/shoe?__draft=off",
    );
  });

  it("overrides an active token with off (leaves preview from anywhere)", () => {
    expect(buildExitUrl("https://fila.vtex.app/p?__draft=h@v1")).toBe(
      "https://fila.vtex.app/p?__draft=off",
    );
  });
});
