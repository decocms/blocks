/**
 * The lookup rule and its evaluation (see /next/how-resolution-works).
 *
 * One registry, later keys win: `{ ...savedBlocks, ...builtIns, ...blocks }`.
 * A function runs with its inputs resolved first (inside out, siblings
 * concurrently); an alias (the snapshot's table, then the built-in legacy one
 * in ./builtins/legacy) is a second key for a type, so like a function it wins
 * over a saved block of the same name; a saved block is replaced by
 * `{ ...saved, ...arguments }` and looked up again; anything else is
 * `UNKNOWN_BLOCK`. Two built-ins are special cases: `lazy`, whose `value` is
 * not resolved first, and `multivariate`, whose variants' rules resolve in
 * order and stop at the first `true` one (later rules never run, as in v7).
 *
 * A `Resolver` belongs to one client, so its memo (results per block function
 * and canonical inputs) never outlives a request. Within the request the memo
 * hands every occurrence of the same block the same result object, so results
 * are read-only (see `Client` in ./types): mutating one in place would change
 * the others, the class of bug behind the v7 layout-cache race.
 */
import { RESERVED_NAMES } from "./builtins/index.ts";
import { isLazyBuiltin } from "./builtins/lazy.ts";
import { LEGACY_ALIASES, wrapLegacyVariants } from "./builtins/legacy.ts";
import { isMultivariateBuiltin } from "./builtins/multivariate.ts";
import { errors, isResolutionError } from "./errors.ts";
import { canonicalKey, isPlainObject, type JsonObject, META_KEY, own } from "./json.ts";
import type { BlockFunction, Blocks, Lazy, Snapshot } from "./types.ts";

type Path = (string | number)[];

interface ResolverOptions {
  snapshot: Snapshot;
  blocks: Blocks;
  /** The built-ins, with this CMS's `secret`. */
  builtIns: Readonly<Blocks>;
  /** Called once per name a saved block shares with a function. */
  onCollision?: (name: string) => void;
  /** Called after each block function runs (telemetry: spans and failures). */
  onBlock?: (type: string, start: number, end: number, error?: unknown) => void;
}

export class Resolver {
  readonly #snapshot: Snapshot;
  readonly #blocks: Blocks;
  readonly #builtIns: Readonly<Blocks>;
  readonly #onCollision?: (name: string) => void;
  readonly #onBlock?: ResolverOptions["onBlock"];
  readonly #memo = new WeakMap<BlockFunction, Map<string, Promise<unknown>>>();
  readonly #keys = new WeakMap<object, string | null>();

  constructor({ snapshot, blocks, builtIns, onCollision, onBlock }: ResolverOptions) {
    this.#snapshot = snapshot;
    this.#blocks = blocks;
    this.#builtIns = builtIns;
    this.#onCollision = onCollision;
    this.#onBlock = onBlock;
  }

  /** The saved entry with this name, or `undefined`; never its `__meta`. */
  entry(name: string): unknown {
    const saved = own(this.#snapshot.blocks, name);
    if (!isPlainObject(saved) || !Object.hasOwn(saved, META_KEY)) return saved;
    const { [META_KEY]: _meta, ...content } = saved;
    return content;
  }

  /** The type an alias points at, or the type itself. */
  canonicalType(type: string): string {
    return this.#alias(type) ?? type;
  }

  /** The snapshot's alias table first, then the built-in legacy one. */
  #alias(type: string): string | undefined {
    return own(this.#snapshot.aliases, type) ?? own(LEGACY_ALIASES, type);
  }

  /** Resolves a saved entry by name (the target is known to exist). */
  resolveEntry(name: string): Promise<unknown> {
    return this.resolve(this.entry(name), [], [name], true);
  }

  /** Expands a saved entry by name without running anything. */
  expandEntry(name: string): unknown {
    return this.expand(this.entry(name), [], [name], true);
  }

  /**
   * Resolves any value. `chain` is the saved entries expanded on the current
   * path (for `CYCLE`); `fromContent` marks values that live in the snapshot,
   * which are always copied so no caller can mutate shared content.
   */
  async resolve(
    node: unknown,
    path: Path,
    chain: string[],
    fromContent: boolean,
  ): Promise<unknown> {
    if (Array.isArray(node)) {
      const results = await Promise.all(
        node.map((item, i) => this.resolve(item, [...path, i], chain, fromContent)),
      );
      const kept = results.filter((value) => value !== undefined);
      return !fromContent && sameItems(node, kept) ? node : kept;
    }
    if (!isPlainObject(node)) return node;
    if (typeof node.__resolveType === "string") {
      return this.#resolveBlock(node, node.__resolveType, path, chain, fromContent);
    }
    return this.#resolveFields(node, path, chain, fromContent);
  }

  /** Expands saved blocks in place without running any function (`{ run: false }`). */
  expand(node: unknown, path: Path, chain: string[], fromContent: boolean): unknown {
    if (Array.isArray(node)) {
      const items = node.map((item, i) => this.expand(item, [...path, i], chain, fromContent));
      return !fromContent && sameItems(node, items) ? node : items;
    }
    if (!isPlainObject(node)) return node;
    const type = node.__resolveType;
    if (
      typeof type === "string" &&
      this.#functionFor(type) === undefined &&
      this.#aliasFor(type) === undefined
    ) {
      const saved = this.entry(type);
      if (saved !== undefined) {
        const next = [...chain, type];
        if (chain.includes(type)) throw errors.cycle(next);
        return this.expand(mergeReference(saved, node), path, next, true);
      }
    }
    let changed = fromContent;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      // Metadata, never content (see META_KEY).
      if (key === META_KEY) {
        changed = true;
        continue;
      }
      const expanded = this.expand(value, [...path, key], chain, fromContent);
      if (expanded !== value) changed = true;
      out[key] = expanded;
    }
    return changed ? out : node;
  }

  async #resolveFields(
    node: JsonObject,
    path: Path,
    chain: string[],
    fromContent: boolean,
  ): Promise<JsonObject> {
    // Metadata, never content (see META_KEY).
    const keys = Object.keys(node).filter((key) => key !== META_KEY);
    const values = await Promise.all(
      keys.map((key) => this.resolve(node[key], [...path, key], chain, fromContent)),
    );
    let changed = fromContent || keys.length !== Object.keys(node).length;
    const out: JsonObject = {};
    keys.forEach((key, i) => {
      if (values[i] !== node[key]) changed = true;
      out[key] = values[i];
    });
    return changed ? out : node;
  }

  #resolveBlock(
    node: JsonObject,
    type: string,
    path: Path,
    chain: string[],
    fromContent: boolean,
    viaAlias = false,
  ): Promise<unknown> {
    const fn = this.#functionFor(type);
    if (fn !== undefined) {
      if (isLazyBuiltin(fn)) {
        return Promise.resolve(this.#lazy(node.value, [...path, "value"], chain, fromContent));
      }
      return this.#run(fn, type, node, path, chain);
    }

    // An alias is a second key for a type, so like a function it wins over a
    // saved block of the same name (with a warning; deco check rejects it).
    const alias = viaAlias ? undefined : this.#aliasFor(type);
    const saved = alias === undefined ? this.entry(type) : undefined;
    if (saved !== undefined) {
      const next = [...chain, type];
      if (chain.includes(type)) return Promise.reject(errors.cycle(next));
      if (RESERVED_NAMES.has(type)) this.#onCollision?.(type);
      return this.resolve(mergeReference(saved, node), path, next, true);
    }

    if (alias !== undefined) {
      return this.#resolveBlock(
        wrapLegacyVariants(type, node),
        alias,
        path,
        chain,
        fromContent,
        true,
      );
    }
    return Promise.reject(errors.unknownBlock(type, path));
  }

  /** The type an alias names (never itself); a saved block of the same name loses (with a warning). */
  #aliasFor(type: string): string | undefined {
    const alias = this.#alias(type);
    if (alias === undefined || alias === type) return undefined;
    if (this.entry(type) !== undefined) this.#onCollision?.(type);
    return alias;
  }

  /** Block map first, then built-ins; a saved block of the same name loses (with a warning). */
  #functionFor(type: string): BlockFunction | undefined {
    const fn = own(this.#blocks, type) ?? own(this.#builtIns, type);
    if (typeof fn !== "function") return undefined;
    if (this.entry(type) !== undefined) this.#onCollision?.(type);
    return fn;
  }

  #run(
    fn: BlockFunction,
    type: string,
    node: JsonObject,
    path: Path,
    chain: string[],
  ): Promise<unknown> {
    const key = canonicalKey(node, this.#keys);
    let results = this.#memo.get(fn);
    const hit = key === null ? undefined : results?.get(key);
    if (hit !== undefined) return hit;

    const pending = this.#call(fn, type, node, path, chain);
    if (key !== null) {
      if (results === undefined) {
        results = new Map();
        this.#memo.set(fn, results);
      }
      results.set(key, pending);
    }
    return pending;
  }

  async #call(
    fn: BlockFunction,
    type: string,
    node: JsonObject,
    path: Path,
    chain: string[],
  ): Promise<unknown> {
    // Inputs are always fresh objects: a function may mutate its props freely.
    const { __resolveType: _type, ...inputs } = node;
    const resolved =
      isMultivariateBuiltin(fn) && Array.isArray(inputs.variants)
        ? await this.#resolveFirstMatch(inputs, inputs.variants, path, chain)
        : await this.#resolveFields(inputs, path, chain, true);
    const start = Date.now();
    try {
      const value = await fn(resolved);
      this.#onBlock?.(type, start, Date.now());
      return value;
    } catch (error) {
      this.#onBlock?.(type, start, Date.now(), error);
      // A lazy block's failure escaping its caller keeps its own code and path.
      if (isResolutionError(error)) throw error;
      throw errors.blockFailed(type, path, error);
    }
  }

  /**
   * The built-in `multivariate`'s inputs: its other fields as usual, then the
   * variants one at a time, each rule before the rest of its variant, up to
   * the first rule that is `true`. Later variants are left out, so their
   * matchers never run.
   */
  async #resolveFirstMatch(
    inputs: JsonObject,
    variants: unknown[],
    path: Path,
    chain: string[],
  ): Promise<JsonObject> {
    const { variants: _variants, ...others } = inputs;
    const resolved = await this.#resolveFields(others, path, chain, true);
    const kept: unknown[] = [];
    for (const [i, variant] of variants.entries()) {
      const at = [...path, "variants", i];
      if (!isPlainObject(variant) || typeof variant.__resolveType === "string") {
        const value = await this.resolve(variant, at, chain, true);
        if (value === undefined) continue;
        kept.push(value);
        if (isPlainObject(value) && value.rule === true) break;
        continue;
      }
      const { rule, ...rest } = variant;
      const matched = await this.resolve(rule, [...at, "rule"], chain, true);
      kept.push({ rule: matched, ...(await this.#resolveFields(rest, at, chain, true)) });
      if (matched === true) break;
    }
    return { ...resolved, variants: kept };
  }

  #lazy(value: unknown, path: Path, chain: string[], fromContent: boolean): Lazy<unknown> {
    let pending: Promise<unknown> | undefined;
    return () => {
      pending ??= this.resolve(value, path, chain, fromContent);
      return pending;
    };
  }
}

/** `{ ...saved, ...arguments }`: shallow, and the saved block's type wins. */
function mergeReference(saved: unknown, reference: JsonObject): unknown {
  if (!isPlainObject(saved)) return saved;
  const { __resolveType: _ref, ...overrides } = reference;
  const merged: JsonObject = { ...saved, ...overrides };
  if ("__resolveType" in saved) merged.__resolveType = saved.__resolveType;
  else delete merged.__resolveType;
  return merged;
}

function sameItems(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
