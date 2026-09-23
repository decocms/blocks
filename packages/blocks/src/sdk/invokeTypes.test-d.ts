/**
 * Type-level guard for `NestedFromFlat`, the shape behind the typed invoke
 * proxy.
 *
 * It shipped broken and nothing caught it: the runtime worked, `tsc` on the
 * package passed, and the failure only appeared when a consumer wrote
 * `invoke.site.actions.newsletter.subscribe(...)` and got
 * "Property 'subscribe' does not exist on type 'never'".
 *
 * Two independent bugs, both invisible to a value-level test:
 *
 * 1. `BuildNested` terminated on `T extends string`. `never extends string` is
 *    **true**, so the terminal branch never ran and every key collapsed to
 *    `never`.
 * 2. `DeepMerge` recursed into functions. A function IS an object in
 *    TypeScript, so the leaf was rewritten into a record of its own properties
 *    and stopped being callable.
 *
 * This file is compiled by `tsc`, not run by vitest — `bun run typecheck`
 * fails if either regresses.
 */

import type { NestedFromFlat } from "./invoke";

type Handlers = {
  "site/actions/newsletter/subscribe": (p: { email: string }) => Promise<{ success: boolean }>;
  "site/loaders/cart/get": (p: unknown) => Promise<{ items: number }>;
  "vtex/actions/checkout/addItemsToCart": (p: { id: string }) => Promise<{ ok: true }>;
  flat: (p: number) => Promise<string>;
};

declare const invoke: NestedFromFlat<Handlers>;

/** Deep keys explode into a callable nested object. */
export async function deepKeysAreCallable() {
  const subscribed = await invoke.site.actions.newsletter.subscribe({ email: "a@b.c" });
  const cart = await invoke.site.loaders.cart.get({});
  const added = await invoke.vtex.actions.checkout.addItemsToCart({ id: "1" });
  // Return types survive the transform.
  const flags: [boolean, number, true] = [subscribed.success, cart.items, added.ok];
  return flags;
}

/** A key with no slash stays a top-level callable. */
export async function flatKeyStaysCallable() {
  const out: string = await invoke.flat(1);
  return out;
}

/** Sibling keys under one prefix merge instead of shadowing each other. */
export function siblingsMerge() {
  return [invoke.site.actions.newsletter.subscribe, invoke.site.loaders.cart.get] as const;
}

/** Input types are real, not `any` — the whole reason to generate this map. */
export function inputTypesAreEnforced() {
  // @ts-expect-error — `wrong` is not part of the handler's props
  return invoke.site.actions.newsletter.subscribe({ wrong: 1 });
}
