/**
 * `currentClient()`: the client whose resolve is running a block function.
 *
 * The inputs of a request (the visitor, the version) arrive as arguments to
 * `cms.client()`; this only hands that client to the functions it runs, so a
 * rule or a section can resolve other blocks through it (`experiments`,
 * `campaigns`) and read `client.visitor`, `client.version` and `client.date`.
 *
 * The resolver sets the client while it calls a block function, so every
 * runtime has it at the start of the function, before any `await`. Where an
 * `AsyncLocalStorage` exists (the `#async-store` import picks it by
 * condition, so this module imports no Node built-in) it also survives
 * `await`. The slot lives on `globalThis` under a `Symbol.for` key, so two
 * copies of the package share it, like the CMS instances.
 */
import { createAsyncStore } from "#async-store";
import type { AsyncStore } from "../async/types.ts";
import type { Client } from "./types.ts";

const SLOT = Symbol.for("decocms.blocks.currentClient");

/** What a client was given, test or campaign name → on or off. */
export type Overrides = Readonly<Record<string, boolean>>;

/**
 * The tests a client was given (`cms.client({ experiments })`): read by the
 * built-in `split-traffic`. `Symbol.for`, so a second copy of the package
 * reads it too.
 */
export const EXPERIMENT_OVERRIDES: unique symbol = Symbol.for("decocms.blocks.experimentOverrides");

/**
 * The campaigns a client was given (`cms.client({ campaigns })`): read by the
 * built-in `calendar`. `Symbol.for`, like `EXPERIMENT_OVERRIDES`.
 */
export const CAMPAIGN_OVERRIDES: unique symbol = Symbol.for("decocms.blocks.campaignOverrides");

interface Slot {
  /** Set while a block function runs synchronously. */
  active: Client | undefined;
  /** Carries the client across `await`, where the runtime has one. */
  store: AsyncStore<Client> | undefined;
}

function slot(): Slot {
  const global = globalThis as unknown as Record<symbol, Slot | undefined>;
  let current = global[SLOT];
  if (current === undefined || typeof current !== "object") {
    current = { active: undefined, store: createAsyncStore<Client>() };
    global[SLOT] = current;
  }
  return current;
}

/**
 * The client resolving the block function that calls it. Call it at the
 * start of the function: without `AsyncLocalStorage` (browsers, React
 * Native) it is only there before the function's first `await`. Throws
 * outside a block function.
 */
export function currentClient(): Client {
  const { active, store } = slot();
  const client = active ?? store?.getStore();
  if (client === undefined) {
    throw new Error(
      "currentClient() was called outside a block function, or after an await where the " +
        "runtime has no AsyncLocalStorage: call it at the start of the function, before any await",
    );
  }
  return client;
}

/** Runs `fn` with `client` as the current client (the resolver calls each block function this way). */
export function runWithClient<R>(client: Client, fn: () => R): R {
  const current = slot();
  const previous = current.active;
  current.active = client;
  try {
    return current.store === undefined ? fn() : current.store.run(client, fn);
  } finally {
    current.active = previous;
  }
}

/** The tests a client was given, by name; `undefined` when none. */
export function experimentOverrides(client: Client): Overrides | undefined {
  return overridesAt(client, EXPERIMENT_OVERRIDES);
}

/** The campaigns a client was given, by name; `undefined` when none. */
export function campaignOverrides(client: Client): Overrides | undefined {
  return overridesAt(client, CAMPAIGN_OVERRIDES);
}

function overridesAt(client: Client, key: symbol): Overrides | undefined {
  const value = (client as unknown as Record<symbol, unknown>)[key];
  return typeof value === "object" && value !== null ? (value as Overrides) : undefined;
}
