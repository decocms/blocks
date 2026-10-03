/**
 * `createCMS`: the block map plus the content, created once per process.
 *
 * Instances are process-wide singletons stored on `globalThis` under a
 * `Symbol.for("decocms.blocks.cms:…")` key derived from the configuration, so
 * a package loaded twice (two bundles, a dev reload) still shares one content
 * cache. See /next/api-reference#one-instance-per-process.
 */
import { builtIns } from "./builtins/index";
import { secretBlock } from "./builtins/secret";
import { CMSClient } from "./client";
import { ContentStore, isLoader, isSnapshot } from "./content";
import type { Blocks, Client, CMS, CMSConfig, Loader, Snapshot } from "./types";

const INSTANCE_PREFIX = "decocms.blocks.cms:";
const OBJECT_IDS = Symbol.for("decocms.blocks.cms-loader-ids");
const MIN_INTERVAL = 60_000;

/** Options that must agree between two `createCMS` calls sharing an instance. */
interface Fingerprint {
  interval: number;
  telemetry: string;
  secrets: string;
}

class CMSInstance implements CMS {
  readonly config: Readonly<CMSConfig>;
  readonly fingerprint: Fingerprint;
  readonly #store: ContentStore;
  readonly #interval: number;
  readonly #warned = new Set<string>();
  /** The built-ins with a `secret` that holds this instance's key (the first call's). */
  readonly #builtIns: Readonly<Blocks>;
  #blocks: Blocks;
  /**
   * When the source was last checked. It starts on the first `forRelease()`,
   * not at construction: Workers read `Date.now()` as 0 at module scope, which
   * would make the first request start a check straight away.
   */
  #lastCheck: number | undefined;

  constructor(config: CMSConfig, interval: number) {
    this.config = config;
    this.#blocks = config.blocks;
    this.#builtIns = Object.freeze({ ...builtIns, secret: secretBlock(config.secrets?.key) });
    this.#interval = interval;
    this.#store = new ContentStore(config.content);
    this.fingerprint = fingerprintOf(config, interval);
  }

  forRelease(): Client {
    this.#scheduleUpdate();
    return this.#client(() => this.#store.release());
  }

  forDraft(pointer: string): Client {
    return this.#client(() => this.#store.draft(pointer));
  }

  forRevision(revision: string): Client {
    return this.#client(() => this.#store.revision(revision));
  }

  update(): Promise<{ updated: boolean }> {
    this.#lastCheck = Date.now();
    return this.#store.update();
  }

  /** A later `createCMS` call with the same key hands in its (possibly hot-reloaded) map and content. */
  adopt(config: CMSConfig): void {
    this.#blocks = config.blocks;
    this.#store.replace(config.content);
  }

  #client(load: () => Promise<Snapshot>): Client {
    return new CMSClient({
      load,
      blocks: this.#blocks,
      builtIns: this.#builtIns,
      onCollision: (name) => this.#warnCollision(name),
    });
  }

  /** Checks a content source with `update()` every `interval`, never in front of a request. */
  #scheduleUpdate(): void {
    if (!this.#store.updatable) return;
    const now = Date.now();
    if (this.#lastCheck === undefined) {
      this.#lastCheck = now;
      return;
    }
    if (now - this.#lastCheck < this.#interval) return;
    this.#lastCheck = now;
    void Promise.resolve().then(() => this.#store.update());
  }

  #warnCollision(name: string): void {
    if (this.#warned.has(name)) return;
    this.#warned.add(name);
    console.warn(
      `[decocms/blocks] the saved block "${name}" has the name of a block type or built-in; ` +
        "the function wins. Rename the saved block (deco check reports this).",
    );
  }
}

/**
 * Creates the CMS, or returns the instance this configuration already has.
 * Create it once, at module scope, and ask it for a client per request.
 */
export function createCMS(config: CMSConfig): CMS {
  validate(config);
  const interval = resolveInterval(config.interval);
  const key = Symbol.for(INSTANCE_PREFIX + identityOf(config));
  const store = globalThis as unknown as Record<symbol, CMSInstance | undefined>;
  const existing = store[key];
  if (existing instanceof Object && typeof existing.adopt === "function") {
    warnOnConflict(existing.fingerprint, fingerprintOf(config, interval));
    existing.adopt(config);
    return existing;
  }
  const instance = new CMSInstance(config, interval);
  store[key] = instance;
  return instance;
}

/** Clears every stored CMS instance, so a test starts clean. */
export function resetForTests(): void {
  const store = globalThis as unknown as Record<symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
    if (Symbol.keyFor(symbol)?.startsWith(INSTANCE_PREFIX)) delete store[symbol];
  }
}

function validate(config: CMSConfig): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("createCMS: expected a config object");
  }
  if (config.blocks === null || typeof config.blocks !== "object") {
    throw new TypeError("createCMS: `blocks` must be your block map (an object of functions)");
  }
  if (!isLoader(config.content) && !isSnapshot(config.content)) {
    throw new TypeError(
      "createCMS: `content` must be the content module ({ revision, blocks }) or a loader with load()",
    );
  }
}

function resolveInterval(configured: number | undefined): number {
  const raw = configured ?? Number(readEnv("DECO_CONTENT_INTERVAL"));
  return Number.isFinite(raw) && raw > MIN_INTERVAL ? raw : MIN_INTERVAL;
}

function readEnv(name: string): string | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[name];
  } catch {
    return undefined;
  }
}

/**
 * The instance key: the content's identity (never its revision, so a hot
 * reload keeps the instance) and, with the hosted Deco CMS, the site and a
 * hash of the token, which never appears in the global symbol registry.
 *
 * A content module is identified by the `.deco` folder it was generated from
 * (its `root`). One without a `root` is identified by the object itself, so
 * two such modules never share an instance; a hot reload of one then gets a
 * new instance instead of updating the old.
 */
function identityOf(config: CMSConfig): string {
  const content = isLoader(config.content)
    ? `loader#${objectId(config.content)}`
    : contentIdentity(config.content);
  if (!config.site || !config.token) return content;
  return `${content}|site:${config.site}|token:${fnv1a(config.token)}`;
}

/** `module:<root>` for a module that names its `.deco` folder, `module#<id>` otherwise. */
function contentIdentity(snapshot: Snapshot): string {
  const root: unknown = snapshot.root;
  return typeof root === "string" && root.length > 0
    ? `module:${root}`
    : `module#${objectId(snapshot)}`;
}

/** A process-wide id per object (a loader, a root-less module), shared by every copy of this module. */
function objectId(object: Loader | Snapshot): number {
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

function fingerprintOf(config: CMSConfig, interval: number): Fingerprint {
  return {
    interval,
    telemetry: stableJson(config.telemetry ?? null),
    secrets: config.secrets?.key ? fnv1a(config.secrets.key) : "",
  };
}

function warnOnConflict(first: Fingerprint, next: Fingerprint): void {
  const conflicts = (Object.keys(first) as (keyof Fingerprint)[]).filter(
    (name) => first[name] !== next[name],
  );
  if (conflicts.length === 0) return;
  console.warn(
    `[decocms/blocks] createCMS was called again for the same content with different options ` +
      `(${conflicts.join(", ")}); keeping the first instance's options.`,
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** FNV-1a, 32-bit: a non-cryptographic fingerprint that keeps secrets out of keys and logs. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
