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

  // The scanner walks raw characters, so without a literal/comment guard it
  // rewrote `ctx.` inside strings too — patching the call site correctly while
  // silently corrupting the message next to it.
  it("does not rewrite ctx inside string literals", () => {
    const r = transformCtxCompat(withLoader("  console.log('ctx.device:', ctx.device);"));
    expect(r.content).toContain("'ctx.device:'");
    expect(r.content).toContain("console.log('ctx.device:', ctx?.device)");
  });

  it("does not rewrite ctx inside double-quoted strings or escaped quotes", () => {
    const r = transformCtxCompat(
      withLoader('  const s = "he said \\"ctx.device\\""; return ctx.device;'),
    );
    expect(r.content).toContain('"he said \\"ctx.device\\""');
    expect(r.content).toContain("return ctx?.device");
  });

  it("does not rewrite ctx inside comments", () => {
    const r = transformCtxCompat(
      withLoader("  // don't touch ctx.device here\n  /* nor ctx.invoke */\n  return ctx.device;"),
    );
    expect(r.content).toContain("// don't touch ctx.device here");
    expect(r.content).toContain("/* nor ctx.invoke */");
    expect(r.content).toContain("return ctx?.device");
  });

  it("does not rewrite template text but DOES rewrite ${} interpolation", () => {
    const r = transformCtxCompat(withLoader("  const u = `ctx.device is ${ctx.vtex.account}`;"));
    // literal text stays, the interpolated expression is real code
    expect(r.content).toContain("`ctx.device is ${ctx?.vtex?.account}`");
  });

  it("handles nested template literals", () => {
    const r = transformCtxCompat(withLoader("  const u = `a${`b${ctx.device}`}c`;"));
    expect(r.content).toContain("`a${`b${ctx?.device}`}c`");
  });

  it("does not match identifiers that merely contain ctx", () => {
    const src = withLoader("  const c = canvasCtx.foo;\n  const d = a.ctx.bar;");
    const r = transformCtxCompat(src);
    expect(r.content).toContain("canvasCtx.foo");
    expect(r.content).toContain("a.ctx.bar");
  });
});
