/**
 * Per-request context storage abstraction.
 *
 * Implementations may use AsyncLocalStorage (Node), explicit-pass (Next.js),
 * or no-op (client / non-server contexts). Decoupled here so framework-
 * agnostic core code never imports `node:async_hooks`.
 */
export interface RequestStore<T> {
  /** Returns the current value if inside a `run()` scope, else undefined. */
  get(): T | undefined;
  /** Invokes `fn` with the value made available via `get()` inside its scope. */
  run<R>(value: T, fn: () => R): R;
}

class NoopRequestStore implements RequestStore<unknown> {
  get(): undefined {
    return undefined;
  }
  run<R>(_value: unknown, fn: () => R): R {
    return fn();
  }
}

export const noopRequestStore: RequestStore<unknown> = new NoopRequestStore();
