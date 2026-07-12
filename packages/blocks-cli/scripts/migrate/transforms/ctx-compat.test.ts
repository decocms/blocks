import { describe, expect, it } from "vitest";
import { transformCtxCompat } from "./ctx-compat";

const withLoader = (body: string) =>
  `export const loader = (props: Props, req: Request, ctx?: AppContext) => {\n${body}\n};`;

describe("transformCtxCompat", () => {
  it("optional-chains a deep app-state read", () => {
    const src = withLoader("  const ext = ctx.salesforce.cartExtension[0];");
    const r = transformCtxCompat(src);
    expect(r.changed).toBe(true);
    expect(r.content).toContain("ctx?.salesforce?.cartExtension?.[0]");
  });

  it("optional-chains ctx.device and ctx.invoke calls (harmless no-op safety)", () => {
    const src = withLoader(
      "  const isMobile = ctx.device !== 'desktop';\n  const page = await ctx.invoke.vtex.loaders.product.detailsPageGQL({ slug });",
    );
    const r = transformCtxCompat(src);
    expect(r.content).toContain("ctx?.device !== 'desktop'");
    expect(r.content).toContain("ctx?.invoke?.vtex?.loaders?.product?.detailsPageGQL({ slug })");
  });

  it("leaves already-optional chains intact (no double ??.)", () => {
    const src = withLoader("  const x = ctx?.salesforce?.cartExtension?.[0];");
    const r = transformCtxCompat(src);
    // No change needed → not flagged as changed.
    expect(r.content).toContain("ctx?.salesforce?.cartExtension?.[0]");
    expect(r.content).not.toContain("??.");
  });

  it("does not optional-chain an assignment target (would be a syntax error)", () => {
    const src = withLoader("  ctx.state.count = 1;");
    const r = transformCtxCompat(src);
    expect(r.content).toContain("ctx.state.count = 1;");
    expect(r.content).not.toContain("ctx?.state?.count =");
  });

  it("still rewrites reads while leaving assignment targets alone", () => {
    const src = withLoader("  ctx.state.count = ctx.state.count + 1;");
    const r = transformCtxCompat(src);
    // LHS untouched, RHS optional-chained.
    expect(r.content).toContain("ctx.state.count = ctx?.state?.count + 1;");
  });

  it("is a no-op on files without a loader export", () => {
    const src = "const ctx = canvas.getContext('2d');\nctx.fillRect(0, 0, 1, 1);";
    const r = transformCtxCompat(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });

  it("does not touch the ctx parameter declaration", () => {
    const src = withLoader("  return props;");
    const r = transformCtxCompat(src);
    expect(r.changed).toBe(false);
    expect(r.content).toContain("ctx?: AppContext");
  });

  it("does not match identifiers that merely contain ctx", () => {
    const src = withLoader("  const c = canvasCtx.foo;\n  const d = a.ctx.bar;");
    const r = transformCtxCompat(src);
    expect(r.content).toContain("canvasCtx.foo");
    expect(r.content).toContain("a.ctx.bar");
  });
});
