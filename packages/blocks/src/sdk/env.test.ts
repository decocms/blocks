import { afterEach, describe, expect, it, vi } from "vitest";

// isDevMode() memoises its result in module-level state after the first
// call, so each case below resets modules and re-imports fresh to get an
// unmemoised read for the NODE_ENV value it's stubbing.
describe("isDevMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECO_PREVIEW", "");
    vi.resetModules();
    const { isDevMode } = await import("./env");
    expect(isDevMode()).toBe(false);
  });

  it("is true when NODE_ENV is development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { isDevMode } = await import("./env");
    expect(isDevMode()).toBe(true);
  });

  it("is true when DECO_PREVIEW=true even if NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DECO_PREVIEW", "true");
    vi.resetModules();
    const { isDevMode } = await import("./env");
    expect(isDevMode()).toBe(true);
  });
});
