/**
 * `createCMS`: the block map plus the content, created once per process.
 *
 * Instances are process-wide singletons stored on `globalThis` under a
 * `Symbol.for("decocms.blocks.cms:…")` key derived from the configuration, so
 * a package loaded twice (two bundles, a dev reload) still shares one content
 * cache. See /next/api-reference#one-instance-per-process.
 */
import { runInBackground } from "./background";
import { builtIns } from "./builtins/index";
import { secretBlock } from "./builtins/secret";
import { CMSClient } from "./client";
import { ContentStore, isLoader, isSnapshot } from "./content";
import { clearGlobals, contentIdentity, fnv1a, readEnv } from "./identity";
import { remoteLoader, resetRemoteLoaders } from "./remoteLoader";
import { resolveDestination, setCurrentTelemetry, TelemetryPipeline } from "./telemetry";
import type { Blocks, Client, CMS, CMSConfig, Loader, Snapshot } from "./types";

const INSTANCE_PREFIX = "decocms.blocks.cms:";
const MIN_INTERVAL = 60_000;
/** Each check runs one interval, plus or minus up to this much, after the previous one. */
const JITTER = 10_000;

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
  readonly #telemetry: TelemetryPipeline | undefined;
  #blocks: Blocks;
  /**
   * When the next check is due. The first is on the first `forRelease()`, not
   * at construction: Workers read `Date.now()` as 0 at module scope.
   */
  #nextCheck: number | undefined;

  constructor(config: CMSConfig, interval: number) {
    this.config = config;
    this.#blocks = config.blocks;
    this.#interval = interval;
    this.#store = new ContentStore(contentOf(config));
    this.fingerprint = fingerprintOf(config, interval);
    const destination = resolveDestination(config.telemetry, config.site);
    if (destination !== null) {
      this.#telemetry = new TelemetryPipeline(destination);
      setCurrentTelemetry(this.#telemetry);
    }
    // Decrypted values never leave in telemetry: the pipeline redacts each one.
    const telemetry = this.#telemetry;
    const secret = secretBlock(config.secrets?.key, (value) => telemetry?.redact(value));
    this.#builtIns = Object.freeze({ ...builtIns, secret });
  }

  forRelease(): Client {
    this.#scheduleUpdate();
    const telemetry = this.#telemetry;
    if (telemetry === undefined) return this.#client(() => this.#store.release());
    return this.#client(() =>
      this.#store.release().then((snapshot) => {
        telemetry.useRelease(snapshot);
        return snapshot;
      }),
    );
  }

  forDraft(pointer: string): Client {
    return this.#client(() => this.#store.draft(pointer));
  }

  forRevision(revision: string): Client {
    return this.#client(() => this.#store.revision(revision));
  }

  update(): Promise<{ updated: boolean }> {
    this.#nextCheck = this.#due();
    return this.#store.update();
  }

  /** A later `createCMS` call with the same key hands in its (possibly hot-reloaded) map and content. */
  adopt(config: CMSConfig): void {
    this.#blocks = config.blocks;
    this.#store.replace(contentOf(config));
  }

  #client(load: () => Promise<Snapshot>): Client {
    return new CMSClient({
      load,
      blocks: this.#blocks,
      builtIns: this.#builtIns,
      onCollision: (name) => this.#warnCollision(name),
      telemetry: this.#telemetry?.forClient(),
    });
  }

  /**
   * Checks a content source with `update()` on first use and then every
   * `interval` (± up to 10 s), at an idle moment, never in front of a request.
   */
  #scheduleUpdate(): void {
    if (!this.#store.updatable) return;
    if (this.#nextCheck !== undefined && Date.now() < this.#nextCheck) return;
    this.#nextCheck = this.#due();
    runInBackground(() => this.#store.update());
  }

  #due(): number {
    return Date.now() + this.#interval + (Math.random() * 2 - 1) * JITTER;
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
  // A remoteLoader passed as `content` carries the `interval` it was created with.
  const own = (config.content as { interval?: unknown }).interval;
  const interval = resolveInterval(config.interval ?? (typeof own === "number" ? own : undefined));
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
  clearGlobals(INSTANCE_PREFIX);
  resetRemoteLoaders();
  setCurrentTelemetry(undefined);
}

/** With `site` and `token`, the content is the fallback of hosted releases and drafts. */
function contentOf(config: CMSConfig): Snapshot | Loader {
  if (!config.site || !config.token) return config.content;
  return remoteLoader(config.content, { site: config.site, token: config.token });
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
  const env = readEnv("DECO_CONTENT_INTERVAL");
  const raw = configured ?? (env ? Number(env) : MIN_INTERVAL);
  if (!Number.isFinite(raw)) return MIN_INTERVAL;
  if (raw < MIN_INTERVAL) {
    console.warn(
      `[decocms/blocks] interval ${raw} ms is below the minimum; raised to ${MIN_INTERVAL} ms.`,
    );
    return MIN_INTERVAL;
  }
  return raw;
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
  const content = contentIdentity(config.content);
  if (!config.site || !config.token) return content;
  return `${content}|site:${config.site}|token:${fnv1a(config.token)}`;
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
