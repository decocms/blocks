import { describe, expect, it } from "vitest";
import type { MigrationContext } from "../types";
import { generatePackageJson } from "./package-json";

const ctx = {
  siteName: "acme-store",
  platform: "vtex",
  importMap: {},
  discoveredNpmDeps: {},
} as unknown as MigrationContext;

describe("generatePackageJson — generate scripts", () => {
  // generatePackageJson does one `npm view` lookup for the framework version
  // (falls back silently when offline), hence the generous timeout.
  it("emits ONE unified generate command instead of the 5-script chain", () => {
    const pkg = JSON.parse(generatePackageJson(ctx));

    expect(pkg.scripts.generate).toBe(
      "tsx node_modules/@decocms/blocks-cli/scripts/generate.ts --site acme-store " +
        "--exclude vtex/loaders,vtex/actions,loaders/vtex-auth-loader," +
        "loaders/reviews/productReviews,loaders/product/buyTogether," +
        "loaders/search/productListPageCollection,loaders/search/intelligenseSearch," +
        "loaders/Layouts/ProductCard",
    );

    // The old hand-chained per-generator scripts must be gone — the
    // orchestrator owns selection/ordering now. (The individual scripts are
    // still shipped and runnable by path; sites just don't scaffold them.)
    for (const legacy of [
      "generate:blocks",
      "generate:schema",
      "generate:invoke",
      "generate:sections",
      "generate:loaders",
    ]) {
      expect(pkg.scripts[legacy], `${legacy} should not be scaffolded`).toBeUndefined();
    }

    // tsr is TanStack's generator, not ours — it stays a separate script.
    expect(pkg.scripts["generate:routes"]).toBe("tsr generate");
    expect(pkg.scripts.build).toBe("npm run generate && tsr generate && vite build");
  }, 30_000);
});
