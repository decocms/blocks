/**
 * Identity helpers for process-wide singletons (`createCMS`, `remoteLoader`):
 * keys go into the global symbol registry, so they're derived from the
 * configuration and never carry a secret.
 */
import type { Loader, Snapshot } from "./types.ts";

const OBJECT_IDS = Symbol.for("decocms.blocks.cms-loader-ids");

/**
 * `module:<root>` for a content module, which names the `.deco` folder it was
 * generated from in a `root` field `deco content` writes (not part of the
 * documented `Snapshot`); `loader#<id>`/`module#<id>` otherwise.
 */
export function contentIdentity(content: Snapshot | Loader): string {
  if (typeof (content as Loader).load === "function") return `loader#${objectId(content)}`;
  const root: unknown = (content as { root?: unknown }).root;
  return typeof root === "string" && root.length > 0
    ? `module:${root}`
    : `module#${objectId(content)}`;
}

/** A process-wide id per object (a loader, a root-less module), shared by every copy of this module. */
function objectId(object: object): number {
  const store = globalThis as unknown as Record<
    symbol,
    { ids: WeakMap<object, number>; next: number }
  >;
  store[OBJECT_IDS] ??= { ids: new WeakMap(), next: 1 };
  const registry = store[OBJECT_IDS];
  let id = registry.ids.get(object);
  if (id === undefined) {
    id = registry.next++;
    registry.ids.set(object, id);
  }
  return id;
}

/** FNV-1a, 32-bit: a non-cryptographic fingerprint that keeps secrets out of keys and logs. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Clears every global instance whose registry key starts with `prefix`. */
export function clearGlobals(prefix: string): void {
  const store = globalThis as unknown as Record<symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
    if (Symbol.keyFor(symbol)?.startsWith(prefix)) delete store[symbol];
  }
}
