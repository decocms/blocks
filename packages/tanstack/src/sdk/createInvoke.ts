/**
 * Type-only marker for apps-* `invoke.ts` codegen templates (e.g.
 * `@decocms/apps-vtex/invoke.ts`) — NOT a real, callable createServerFn
 * wrapper. Deliberately does not call `createServerFn` at runtime.
 *
 * `invoke.ts` files are never imported/executed by any real site — they
 * are a source-of-truth that `blocks-cli`'s `generate-invoke.ts` statically
 * parses (via AST inspection of each `createInvokeFn(action, opts)` call
 * site's arguments) to emit real, literal top-level `createServerFn(...)`
 * declarations into each site's own `src/server/invoke.gen.ts`. This
 * function's ONLY job is to give those template files a correctly-typed
 * call site to author against.
 *
 * It must not contain a real `createServerFn(...)` call: TanStack Start's
 * compiler statically scans every file reachable by a site's SSR bundle for
 * that literal pattern and throws "createServerFn must be assigned to a
 * variable!" on ANY occurrence that isn't a top-level declarator — even one
 * inside a function body that's never actually invoked. `invoke.ts` isn't
 * supposed to be reachable by a site's bundler at all (it's excluded from
 * every apps-* package's public exports map), but Vite's `optimizeDeps`
 * pre-bundling has been observed sweeping it in regardless of that
 * exports-map restriction — so the only fully robust fix is for this file
 * to never contain the literal pattern the compiler is looking for, full
 * stop, regardless of what does or doesn't end up bundled.
 *
 * @example
 * ```ts
 * import { createInvokeFn } from "@decocms/tanstack/sdk/createInvoke";
 * import { addItemsToCart } from "./actions/checkout";
 *
 * export const invoke = {
 *   vtex: {
 *     actions: {
 *       addItemsToCart: createInvokeFn(
 *         (input: { orderFormId: string; orderItems: CartItem[] }) =>
 *           addItemsToCart(input.orderFormId, input.orderItems),
 *         { unwrap: true },
 *       ),
 *     },
 *   },
 * };
 * ```
 *
 * The real, callable version of each action above only exists in the
 * site's generated `src/server/invoke.gen.ts` (run `npm run generate:invoke`),
 * which uses real top-level `createServerFn(...)` calls directly — never
 * this function.
 */

export interface InvokeFnOpts {
  /**
   * When true, extracts `.data` from the result before returning.
   * Use for VTEX checkout functions that return VtexFetchResult<T>
   * (i.e. `{ data: T, setCookies: string[] }`).
   */
  unwrap?: boolean;
}

/**
 * Template-only — see the module doc comment above. Throws if actually
 * called at runtime, since that would mean something imported an
 * `invoke.ts` template file directly instead of using the site's generated
 * `invoke.gen.ts`, which is itself a bug worth surfacing loudly rather than
 * silently returning wrong behavior.
 */
export function createInvokeFn<TInput, TOutput>(
  _action: (input: TInput) => Promise<TOutput>,
  _opts?: InvokeFnOpts,
): (ctx: { data: TInput }) => Promise<TOutput> {
  return () => {
    throw new Error(
      "createInvokeFn() is a codegen-time-only template marker and was never meant to be called at " +
        "runtime. If you're seeing this, something imported an apps-*/invoke.ts template file directly " +
        "instead of using the site's generated src/server/invoke.gen.ts (run `npm run generate:invoke`).",
    );
  };
}
