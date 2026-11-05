/**
 * A Map that forgets its least recently used entries past `limit`, counted by
 * `size` (one per entry unless given). An entry larger than the limit on its
 * own is kept until the next `set`.
 */
export class BoundedMap<K, V> {
  readonly #map = new Map<K, V>();
  #total = 0;
  constructor(
    readonly limit: number,
    readonly size: (value: V) => number = () => 1,
  ) {}

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  set(key: K, value: V): void {
    this.delete(key);
    this.#map.set(key, value);
    this.#total += this.size(value);
    for (const [oldest, old] of this.#map) {
      if (this.#total <= this.limit || oldest === key) break;
      this.#map.delete(oldest);
      this.#total -= this.size(old);
    }
  }

  delete(key: K): void {
    if (!this.#map.has(key)) return;
    this.#total -= this.size(this.#map.get(key) as V);
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
    this.#total = 0;
  }

  /** The total size held. */
  get total(): number {
    return this.#total;
  }
}
