import { describe, expect, it } from "vitest";
import { createContext } from "../types";
import type { MigrationContext } from "../types";
import { generateServerEntry } from "./server-entry";

/**
 * Regression guard for #368: createUseUser/createUseWishlist
 * (@decocms/apps-vtex/hooks) require invoke.vtex.loaders.user/wishlist and
 * invoke.vtex.actions.addToWishlist/removeFromWishlist. Before this fix, the
 * scaffolded invoke only wired `vtex.actions` from invoke.gen.ts, so any
 * scaffolded site rendering useUser()/useWishlist() crashed the Header on
 * mount (`Cannot read properties of undefined (reading 'user')`).
 */
function makeVtexCtx(): MigrationContext {
  const ctx = createContext("/tmp/vtex-invoke-scaffold-fixture-site");
  ctx.siteName = "acme-storefront";
  ctx.platform = "vtex";
  ctx.vtexAccount = "acme";
  return ctx;
}

describe("VTEX invoke scaffold wires vtex.loaders + wishlist actions (#368)", () => {
  const files = generateServerEntry(makeVtexCtx());
  const invokeSrc = files["src/server/invoke.ts"];

  it("scaffolds invoke.vtex.loaders.user and invoke.vtex.loaders.wishlist", () => {
    expect(invokeSrc).toContain("loaders: {");
    expect(invokeSrc).toContain("user: _vtexUser");
    expect(invokeSrc).toContain("wishlist: _vtexWishlist");
  });

  it("scaffolds invoke.vtex.actions.addToWishlist and removeFromWishlist", () => {
    expect(invokeSrc).toContain("addToWishlist: _addToWishlist");
    expect(invokeSrc).toContain("removeFromWishlist: _removeFromWishlist");
  });

  it("still spreads the generated checkout/session/masterData/newsletter actions", () => {
    expect(invokeSrc).toContain("...vtexActions,");
  });

  it("imports getUser/getWishlist/addItem/removeItem from @decocms/apps-vtex", () => {
    expect(invokeSrc).toContain('from "@decocms/apps-vtex/loaders/user"');
    expect(invokeSrc).toContain('from "@decocms/apps-vtex/loaders/wishlist"');
    expect(invokeSrc).toContain('from "@decocms/apps-vtex/actions/wishlist"');
  });

  it("derives shopperId from the auth JWT instead of a hardcoded value", () => {
    expect(invokeSrc).toContain("getShopperId");
    expect(invokeSrc).toContain("parseVtexAuthJwt");
  });
});
