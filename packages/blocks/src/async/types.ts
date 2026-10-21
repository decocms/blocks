/** The part of `AsyncLocalStorage` the client slot uses. */
export interface AsyncStore<T> {
  run<R>(value: T, fn: () => R): R;
  getStore(): T | undefined;
}
