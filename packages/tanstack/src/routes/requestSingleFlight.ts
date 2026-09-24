/** Share pending work only among callers belonging to the same HTTP request. */
export function createRequestSingleFlight<T>() {
  const requests = new WeakMap<Request, Map<string, Promise<T>>>();

  return (request: Request, key: string, run: () => Promise<T>): Promise<T> => {
    const pending = requests.get(request) ?? new Map<string, Promise<T>>();
    requests.set(request, pending);
    const existing = pending.get(key);
    if (existing) return existing;

    const promise = Promise.resolve()
      .then(run)
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
