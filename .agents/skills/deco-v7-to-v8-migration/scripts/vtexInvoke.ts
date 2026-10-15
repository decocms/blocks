/**
 * The VTEX invoke keys v7's VTEX app answered from its own invoke map (PO
 * decision 7, 2026-10-15). v7's `setupApps` registered every named export of
 * the app's loader and action modules under `<module>/<export>`, so
 * `invoke.vtex.actions.checkout.addItemsToCart(props)` reached
 * `addItemsToCart` in `vtex/actions/checkout`, a module with no default
 * export and so no handler file of its own. Each migration chooses what
 * those keys become (`--vtex-invoke`):
 *
 * - `keep` (the default): v7's handler, vendored into `src/vendor` like any
 *   app loader, so the call works as it did;
 * - `v8`: no v7 code. A key the v8 VTEX client (`@decocms/apps-vtex`) has an
 *   operation for becomes a function over that client in
 *   `src/server/vtex-invoke.server.ts`; any other is the
 *   `unportedVtexInvoke` stub, which rejects, and a report line.
 */
import fs from "node:fs";
import path from "node:path";
import type { Framework } from "./framework";
import { locateAppModule, relativeSpecifier } from "./vendor";

export type VtexInvokeMode = "keep" | "v8";
export const VTEX_INVOKE_MODES: readonly VtexInvokeMode[] = ["keep", "v8"];

/** A key of v7's VTEX invoke map: a named export of one of the app's modules. */
export interface VtexInvokeMapKey {
  /** The module's v7 key, `vtex/actions/checkout`. */
  moduleKey: string;
  /** The export v7 called, `addItemsToCart`. */
  exportName: string;
  /** The installed module. */
  module: NonNullable<ReturnType<typeof locateAppModule>>;
}

/** The invoke-map entry `key` names, when the installed v7 VTEX app has that module and export. */
export function vtexInvokeMapKey(root: string, key: string): VtexInvokeMapKey | undefined {
  const match = /^(vtex\/(?:loaders|actions)\/.+)\/([A-Za-z_$][\w$]*)$/.exec(key);
  if (!match) return undefined;
  const [, moduleKey, exportName] = match;
  const module = locateAppModule(root, moduleKey);
  if (!module) return undefined;
  const text = fs.readFileSync(module.file, "utf8");
  const exported = new RegExp(
    `\\bexport\\s+(?:async\\s+)?function\\s*\\*?\\s*${exportName}\\b|\\bexport\\s+(?:const|let)\\s+${exportName}\\b|\\bexport\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`,
  );
  return exported.test(text) ? { moduleKey, exportName, module } : undefined;
}

/** One v7 invoke-map key on the v8 VTEX client. */
interface V8Operation {
  /** The function in the generated module. */
  name: string;
  /** The props v7's handler took (the ones the call uses). */
  props: string;
  /** The call, over `vtex` (the client) and `shopper` (the shopper's cookies). */
  call: string;
  /** Whether VTEX's Set-Cookie values come back (`VtexResponse`) and go to the browser. */
  cookies: boolean;
  /** What differs from v7's handler, for the report. */
  differs: string;
}

const NO_HTTPS = "item images keep VTEX's http: URLs (v7 rewrote them to https:)";

/** The v7 VTEX invoke-map keys the v8 client has an operation for. */
export const V8_VTEX_OPERATIONS: Record<string, V8Operation> = {
  "vtex/actions/checkout/getOrCreateCart": {
    name: "getOrCreateCart",
    props: "{ orderFormId?: string }",
    call: "vtex.checkout.orderForm(shopper)",
    cookies: true,
    differs: `the cart comes from the shopper's checkout.vtex.com cookie (v7 fetched props.orderFormId when given); ${NO_HTTPS}`,
  },
  "vtex/actions/checkout/addItemsToCart": {
    name: "addItemsToCart",
    props:
      "{ orderFormId: string; orderItems: { id: string | number; seller: string; quantity: number }[] }",
    call: "vtex.checkout.addItems(props.orderFormId, props.orderItems.map((item) => ({ ...item, id: Number(item.id) })), shopper)",
    cookies: true,
    differs: `no allowedOutdatedData=paymentData (v7's default), and each SKU id is sent as a number (the v8 client's type; v7 sent it as given); ${NO_HTTPS}`,
  },
  "vtex/actions/checkout/updateCartItems": {
    name: "updateCartItems",
    props: "{ orderFormId: string; orderItems: { index: number; quantity: number }[] }",
    call: "vtex.checkout.updateItems(props.orderFormId, props.orderItems, shopper)",
    cookies: true,
    differs: `no allowedOutdatedData=paymentData and no noSplitItem; ${NO_HTTPS}`,
  },
  "vtex/actions/checkout/addCouponToCart": {
    name: "addCouponToCart",
    props: "{ orderFormId: string; text: string }",
    call: "vtex.checkout.addCoupon(props.orderFormId, props.text, shopper)",
    cookies: true,
    differs: NO_HTTPS,
  },
  "vtex/actions/checkout/updateOrderFormAttachment": {
    name: "updateOrderFormAttachment",
    props:
      "{ orderFormId: string; attachment: string; body: Record<string, unknown>; expectedOrderFormSections?: string[] }",
    call: "vtex.checkout.attachment(props.orderFormId, props.attachment, { ...(props.expectedOrderFormSections ? { expectedOrderFormSections: props.expectedOrderFormSections } : {}), ...props.body }, shopper)",
    cookies: true,
    differs: `expectedOrderFormSections only when the caller passes it (v7 sent its full section list); ${NO_HTTPS}`,
  },
  "vtex/actions/checkout/simulateCart": {
    name: "simulateCart",
    props:
      "{ items: { id: number | string; quantity: number; seller: string }[]; postalCode: string; country?: string }",
    call: 'vtex.checkout.simulation({ items: props.items.map((item) => ({ ...item, id: String(item.id) })), postalCode: props.postalCode, country: props.country ?? "BRA" }, shopper)',
    cookies: false,
    differs:
      "no RnbBehavior=1 (v7's default), and the cookies VTEX sets on a simulation aren't forwarded",
  },
  "vtex/actions/checkout/getSellersByRegion": {
    name: "getSellersByRegion",
    props: "{ postalCode: string; salesChannel?: string }",
    call: 'vtex.checkout.regions({ postalCode: props.postalCode, country: "BRA", salesChannel: props.salesChannel }, shopper).then((regions) => (regions[0]?.sellers?.length ? regions[0] : null))',
    cookies: false,
    differs: "the cookies VTEX sets on the call aren't forwarded",
  },
};

/** Where the generated functions go. */
export const V8_VTEX_FILE = path.join("src", "server", "vtex-invoke.server.ts");

/**
 * The v8 operation for `key` on `framework`, or the reason there is none.
 * Next.js server actions set cookies only through `cookies()`, which
 * percent-encodes the value (`checkout.vtex.com=__ofid=…` would reach VTEX as
 * `__ofid%3D…`), so a cart call that returns VTEX's cookies isn't mapped there.
 */
export function v8Operation(
  key: string,
  framework: Framework,
): { operation: V8Operation } | { reason: string } {
  const operation = V8_VTEX_OPERATIONS[key];
  if (!operation) {
    return {
      reason:
        "@decocms/apps-vtex's client has no operation for it (its checkout, sessions, masterdata and io.graphql cover the rest by hand)",
    };
  }
  if (framework === "nextjs" && operation.cookies) {
    return {
      reason: `the v8 call (${operation.call.replace(/,? shopper\)/, ")")}) returns VTEX's Set-Cookie values, and a Next.js server action can only set cookies through cookies(), which percent-encodes them (checkout.vtex.com's __ofid=… would reach VTEX as __ofid%3D…): call it from a route handler that appends its setCookies to the Response`,
    };
  }
  return { operation };
}

/** `src/server/vtex-invoke.server.ts`: the mapped keys over the site's VTEX client. */
export function writeV8Module(
  root: string,
  framework: Framework,
  keys: string[],
): { file: string; clientFile: string | undefined } {
  const file = path.join(root, V8_VTEX_FILE);
  const clientFile = ["vtex.ts", "vtex.tsx"]
    .map((f) => path.join(root, "src", "clients", f))
    .find((f) => fs.existsSync(f));
  const operations = keys.map((key) => [key, V8_VTEX_OPERATIONS[key]] as const);
  const usesCookies = operations.some(([, op]) => op.cookies);
  const lines = [
    "/**",
    " * v7's VTEX invoke calls on the v8 VTEX client (@decocms/apps-vtex), migrated with --vtex-invoke v8:",
    " * no v7 code. Each takes (props, request) as v7's handler did, and is called by its server function.",
    " * Generated by the deco-v7-to-v8-migration skill; it's your code now.",
    " */",
    ...(usesCookies && framework === "tanstack"
      ? ['import { getResponseHeaders } from "@tanstack/react-start/server";']
      : []),
    ...(usesCookies ? ['import type { VtexResponse } from "@decocms/apps-vtex";'] : []),
    `import { vtexClient } from "${relativeSpecifier(file, clientFile ?? path.join(root, "src", "clients", "vtex.ts"))}";`,
    "",
    "/** The shopper's cookies, sent to VTEX (the client drops malformed pairs). */",
    'const shopperOf = (request: Request) => ({ cookie: request.headers.get("cookie") ?? undefined });',
  ];
  if (usesCookies) {
    lines.push(
      "",
      "/**",
      " * VTEX's Set-Cookie values, sent to the browser as v7's VTEX app sent them: Intelligent Search's",
      " * session cookies stay on the server, and each cookie's Domain is this site's host.",
      " */",
      "async function forward<T>(response: Promise<VtexResponse<T>>, request: Request): Promise<T> {",
      "  const { data, setCookies } = await response;",
      "  const host = new URL(request.url).hostname;",
      "  const headers = getResponseHeaders();",
      "  for (const cookie of setCookies) {",
      '    if (cookie.startsWith("vtex_is_session=") || cookie.startsWith("vtex_is_anonymous=")) continue;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated source with a template literal
      '    headers.append("set-cookie", cookie.replace(/(;\\s*)domain=[^;]*/i, `$1Domain=${host}`));',
      "  }",
      "  return data;",
      "}",
    );
  }
  for (const [key, op] of operations) {
    lines.push(
      "",
      `/** ${key}. Differs from v7's: ${op.differs}. */`,
      `export async function ${op.name}(props: ${op.props}, request: Request) {`,
      "  const vtex = vtexClient();",
      "  const shopper = shopperOf(request);",
      op.cookies ? `  return forward(${op.call}, request);` : `  return ${op.call};`,
      "}",
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return { file, clientFile };
}
