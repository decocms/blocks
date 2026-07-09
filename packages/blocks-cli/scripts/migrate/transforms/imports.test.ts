import { describe, expect, it } from "vitest";
import { transformImports } from "./imports";

describe("transformImports — shopify hooks", () => {
  it("rewrites the three known Shopify hooks to the site-local scaffolded files, mirroring VTEX", () => {
    const src =
      `import { useUser } from "apps/shopify/hooks/useUser.ts";\n` +
      `import { useCart } from "apps/shopify/hooks/useCart.ts";\n` +
      `import { useWishlist } from "apps/shopify/hooks/useWishlist.ts";\n`;

    const r = transformImports(src);

    expect(r.changed).toBe(true);
    expect(r.content).toContain(`import { useUser } from "~/hooks/useUser";`);
    expect(r.content).toContain(`import { useCart } from "~/hooks/useCart";`);
    expect(r.content).toContain(
      `import { useWishlist } from "~/hooks/useWishlist";`,
    );
    // Must never point at the nonexistent @decocms/apps-shopify/hooks/* target.
    expect(r.content).not.toContain("@decocms/apps-shopify/hooks");
  });

  it("does not rewrite an unknown shopify hook name to a nonexistent package export", () => {
    // No shopify hook other than useCart/useUser/useWishlist has ever existed
    // (verified against full git history), so there is no generic fallback
    // rule anymore. Unhandled "apps/*" imports fall through to the general
    // apps/ catch-all, which removes the import line entirely — surfacing as
    // an obvious break at the usage site rather than an unresolvable module.
    const src = `import { useSomethingElse } from "apps/shopify/hooks/useSomethingElse.ts";\n`;

    const r = transformImports(src);

    expect(r.content).not.toContain("@decocms/apps-shopify/hooks");
    expect(r.content).not.toContain("apps/shopify/hooks");
  });

  it("still rewrites shopify utils/actions/loaders to the real @decocms/apps-shopify package", () => {
    const src =
      `import { formatMoney } from "apps/shopify/utils/formatMoney.ts";\n` +
      `import { addItems } from "apps/shopify/actions/cart/addItems.ts";\n` +
      `import ProductList from "apps/shopify/loaders/ProductList.ts";\n`;

    const r = transformImports(src);

    expect(r.content).toContain(
      `import { formatMoney } from "@decocms/apps-shopify/utils/formatMoney";`,
    );
    expect(r.content).toContain(
      `import { addItems } from "@decocms/apps-shopify/actions/cart/addItems";`,
    );
    expect(r.content).toContain(
      `import ProductList from "@decocms/apps-shopify/loaders/ProductList";`,
    );
  });
});

describe("transformImports — splitDecoHooksImports", () => {
  it("splits a mixed useDevice + non-useDevice named import from the legacy @deco/deco/hooks specifier", () => {
    const src = `import { useDevice, useScript, useSection } from "@deco/deco/hooks";\n`;

    const r = transformImports(src);

    expect(r.changed).toBe(true);
    expect(r.content).toContain(
      `import { useDevice } from "@decocms/blocks/sdk/useDevice";`,
    );
    expect(r.content).toContain(
      `import { useScript, useSection } from "@decocms/blocks/sdk/useScript";`,
    );
    expect(r.notes).toContain(
      "Split useDevice into separate import from @decocms/blocks/sdk/useDevice",
    );
  });

  it("emits only the useDevice import when useDevice is the sole named import", () => {
    const src = `import { useDevice } from "@deco/deco/hooks";\n`;

    const r = transformImports(src);

    expect(r.content).toBe(
      `import { useDevice } from "@decocms/blocks/sdk/useDevice";\n`,
    );
    expect(r.content).not.toContain("@decocms/blocks/sdk/useScript");
  });

  it("leaves a non-useDevice-only import pointed at useScript, unsplit", () => {
    const src = `import { useScript, useSection } from "@deco/deco/hooks";\n`;

    const r = transformImports(src);

    expect(r.content).toBe(
      `import { useScript, useSection } from "@decocms/blocks/sdk/useScript";\n`,
    );
    expect(r.content).not.toContain("@decocms/blocks/sdk/useDevice");
  });

  it("handles a `type` import with mixed useDevice/non-useDevice specifiers", () => {
    const src = `import type { useDevice, useScript } from "@deco/deco/hooks";\n`;

    const r = transformImports(src);

    // The base IMPORT_RULES rewrite fires first (regardless of `type`), then
    // splitDecoHooksImports re-splits the resulting line — confirming the
    // regex-chain order (rewriteSpecifier → splitDecoHooksImports) still
    // matches `import type { ... }` shapes, not just bare `import { ... }`.
    expect(r.content).toContain(
      `import { useDevice } from "@decocms/blocks/sdk/useDevice";`,
    );
    expect(r.content).toContain(
      `import { useScript } from "@decocms/blocks/sdk/useScript";`,
    );
  });

  it("preserves aliased specifiers (useDevice as useDeviceHook) on the split line", () => {
    const src = `import { useDevice as useDeviceHook, useScript } from "@deco/deco/hooks";\n`;

    const r = transformImports(src);

    expect(r.content).toContain(
      `import { useDevice as useDeviceHook } from "@decocms/blocks/sdk/useDevice";`,
    );
    expect(r.content).toContain(
      `import { useScript } from "@decocms/blocks/sdk/useScript";`,
    );
  });

  it("does not touch @decocms/blocks/sdk/useScript imports that were never routed through @deco/deco/hooks", () => {
    // Guards the order-of-operations: splitDecoHooksImports must only ever
    // fire as a post-process of the IMPORT_RULES rewrite, not independently
    // match any pre-existing import already targeting useScript.
    const src = `import { useScript } from "@decocms/blocks/sdk/useScript";\n`;

    const r = transformImports(src);

    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });
});
