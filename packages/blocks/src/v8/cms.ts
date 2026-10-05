/**
 * `createCMS`: the block map plus the content, created once per process.
 *
 * Instances are process-wide singletons stored on `globalThis` under a
 * `Symbol.for("decocms.blocks.cms:…")` key derived from the configuration, so
 * a package loaded twice (two bundles, a dev reload) still shares one content
 * cache. See /next/api-reference#one-instance-per-process.
 */
import { runInBackground } from "./background.ts";
import { SETTINGS_BLOCK, SETTINGS_TYPE } from "./builtins/data.ts";
import { builtIns } from "./builtins/index.ts";
import { secretBlock } from "./builtins/secret.ts";
import { CMSClient } from "./client.ts";
import { ContentStore, isLoader, isSnapshot } from "./content.ts";
import { draftCookieFor, endsPreview, parseDraftPointer, readDraftPointer } from "./draft.ts";
import { allowsHost, type HostPattern, parseHostPattern } from "./hosts.ts";
import { clearGlobals, contentIdentity, fnv1a, readEnv } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import { remoteLoader, resetRemoteLoaders } from "./remoteLoader.ts";
import {
  defaultSettings,
  isStatic,
  parseCodeHosts,
  readSettings,
  type SettingsCaps,
} from "./settings.ts";
import {
  resolveDestination,
  setCurrentTelemetry,
  TelemetryPipeline,
  telemetryLimits,
} from "./telemetry.ts";
import type {
  Blocks,
  Client,
  CMS,
  CMSConfig,
  EffectiveSettings,
  Loader,
  RequestLike,
  Snapshot,
} from "./types.ts";
import { forceVariants } from "./variants.ts";

const INSTANCE_PREFIX = "decocms.blocks.cms:";
const MIN_INTERVAL = 60_000;
/** Each check runs one interval, plus or minus up to this much, after the previous one. */
const JITTER = 10_000;
/** How often telemetry reads its settings again when the release hasn't changed (date rules). */
const TELEMETRY_SETTINGS_MS = 60_000;

/** Options that must agree between two `createCMS` calls sharing an instance. */
interface Fingerprint {
  interval: number;
  telemetry: string;
  preview: string;
  secrets: string;
}

/**
 * The state one content root shares across `createCMS` calls: the content
 * store, caps, telemetry and secret key. Each call gets its own handle
 * holding its own block map (see `CMSHandle`).
 */
class CMSInstance {
  readonly config: Readonly<CMSConfig>;
  readonly fingerprint: Fingerprint;
  readonly #store: ContentStore;
  readonly #interval: number;
  readonly #warned = new Set<string>();
  /** The built-ins with a `secret` that holds this instance's key (the first call's). */
  readonly #builtIns: Readonly<Blocks>;
  readonly #telemetry: TelemetryPipeline | undefined;
  readonly #caps: SettingsCaps;
  /** Settings of a `CMS` block with nothing to run, per release snapshot. */
  #staticSettings = new WeakMap<Snapshot, EffectiveSettings>();
  /** The release and time telemetry last read its section. */
  #telemetryRead: { snapshot: Snapshot; at: number } | undefined;
  /** One handle per block map, so the same config returns the same object. */
  readonly #handles = new WeakMap<Blocks, CMS>();
  /**
   * When the next check is due. The first is on the first `forRelease()` or `forDraft()`, not
   * at construction: Workers read `Date.now()` as 0 at module scope.
   */
  #nextCheck: number | undefined;

  constructor(config: CMSConfig, interval: number) {
    this.config = config;
    this.#interval = interval;
    this.#store = new ContentStore(contentOf(config));
    this.fingerprint = fingerprintOf(config, interval);
    this.#caps = {
      hosts: parseCodeHosts(config.preview),
      limits: telemetryLimits(config.telemetry),
    };
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

  forRelease(blocks: Blocks): Client {
    this.#scheduleUpdate();
    const telemetry = this.#telemetry;
    if (telemetry === undefined) return this.#client(blocks, () => this.#store.release());
    return this.#client(blocks, () =>
      this.#store.release().then(async (snapshot) => {
        telemetry.useRelease(snapshot);
        await this.#followTelemetrySettings(blocks, telemetry, snapshot);
        return snapshot;
      }),
    );
  }

  /**
   * The release's settings, from memory: never a draft, never a fetch. The
   * `CMS` block resolves on each call, so a field with variants is decided
   * where it's called; one with nothing to run is resolved once per release.
   */
  settings(blocks: Blocks): Promise<EffectiveSettings> {
    return this.#settingsOf(blocks, this.#store.current());
  }

  async draftPointer(blocks: Blocks, request: RequestLike): Promise<string | null> {
    const pointer = readDraftPointer(request);
    if (pointer === null) return null;
    return (await this.#previewAllowed(blocks, request)) ? pointer : null;
  }

  async draftCookie(blocks: Blocks, request: RequestLike): Promise<string | null> {
    const cookie = draftCookieFor(request);
    if (cookie === null) return null;
    // Ending a preview is allowed anywhere, so a cookie set before a host was removed still goes.
    if (endsPreview(request)) return cookie;
    return (await this.#previewAllowed(blocks, request)) ? cookie : null;
  }

  /**
   * The draft, with the variants the pointer forces (even over a source with no
   * drafts). A draft client is a production client reading a draft pointer, so
   * it schedules the release check like any other client.
   */
  forDraft(blocks: Blocks, pointer: string): Client {
    this.#scheduleUpdate();
    const variants = parseDraftPointer(pointer)?.variants;
    if (variants === undefined) return this.#client(blocks, () => this.#store.draft(pointer));
    return this.#client(blocks, () =>
      this.#store.draft(pointer).then((snapshot) => forceVariants(snapshot, variants)),
    );
  }

  forRevision(blocks: Blocks, revision: string): Client {
    return this.#client(blocks, () => this.#store.revision(revision));
  }

  update(): Promise<{ updated: boolean }> {
    this.#nextCheck = this.#due();
    return this.#store.update();
  }

  /** The handle for a block map: this instance, resolving with that map. */
  handle(blocks: Blocks): CMS {
    let handle = this.#handles.get(blocks);
    if (handle === undefined) {
      handle = new CMSHandle(this, blocks);
      this.#handles.set(blocks, handle);
    }
    return handle;
  }

  /**
   * A later `createCMS` call with the same key hands in its (possibly
   * hot-reloaded) content. Its block map stays with its own handle: another
   * bundle in the same process (Next's proxy) must not replace the app's.
   */
  adopt(config: CMSConfig): void {
    this.#store.replace(contentOf(config));
    this.#staticSettings = new WeakMap();
    this.#telemetryRead = undefined;
  }

  async #settingsOf(blocks: Blocks, snapshot: Snapshot | undefined): Promise<EffectiveSettings> {
    if (snapshot === undefined) return defaultSettings(this.#caps);
    const cached = this.#staticSettings.get(snapshot);
    if (cached !== undefined) return cached;
    const settings = await readSettings(
      snapshot,
      () =>
        new CMSClient({
          load: () => Promise.resolve(snapshot),
          blocks,
          builtIns: this.#builtIns,
          onCollision: (name) => this.#warnCollision(name),
        }),
      this.#caps,
    );
    // A block map's own cms-settings function may answer differently per call.
    const entry = snapshot.blocks[SETTINGS_BLOCK];
    const fixed = !isPlainObject(entry) || isStatic(entry);
    if (fixed && !Object.hasOwn(blocks, SETTINGS_TYPE)) {
      this.#staticSettings.set(snapshot, settings);
    }
    return settings;
  }

  /** Whether the release's preview hosts allow this request's host. */
  async #previewAllowed(blocks: Blocks, request: RequestLike): Promise<boolean> {
    const { hosts } = (await this.settings(blocks)).preview;
    const patterns = hosts
      .map((raw) => parseHostPattern(raw))
      .filter((pattern): pattern is HostPattern => pattern !== null);
    return allowsHost(patterns, request.url);
  }

  /**
   * Telemetry follows the release's `telemetry` section, read outside any
   * request's choices: when the release changes (before its first client
   * runs) and then at most once a minute, so date rules take effect.
   */
  async #followTelemetrySettings(
    blocks: Blocks,
    telemetry: TelemetryPipeline,
    snapshot: Snapshot,
  ): Promise<void> {
    const last = this.#telemetryRead;
    const now = Date.now();
    if (last?.snapshot === snapshot && now - last.at < TELEMETRY_SETTINGS_MS) return;
    this.#telemetryRead = { snapshot, at: now };
    const read = this.#settingsOf(blocks, snapshot).then((settings) => {
      if (this.#telemetryRead?.snapshot === snapshot) telemetry.apply(settings.telemetry);
    });
    // A new release waits for its rates; a periodic re-read doesn't hold up the request.
    if (last?.snapshot !== snapshot) await read;
  }

  #client(blocks: Blocks, load: () => Promise<Snapshot>): Client {
    return new CMSClient({
      load,
      blocks,
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
      `[decocms/blocks] the saved block "${name}" has the name of a block type, built-in or alias; ` +
        "the function wins. Rename the saved block (deco check reports this).",
    );
  }
}

/** `Symbol.for`, so a second copy of this module still reads it. */
const INSTANCE = Symbol.for("decocms.blocks.cms.instance");

/**
 * What `createCMS` returns: the shared instance plus the block map of this
 * call. Every handle on one content root shares its content, caps, telemetry
 * and secret key; each resolves with the block map it was created with.
 */
class CMSHandle implements CMS {
  readonly #instance: CMSInstance;
  readonly #blocks: Blocks;

  constructor(instance: CMSInstance, blocks: Blocks) {
    this.#instance = instance;
    this.#blocks = blocks;
  }

  /** The shared instance (tests use it to tell whether two handles share one). */
  get [INSTANCE](): CMSInstance {
    return this.#instance;
  }

  forRelease(): Client {
    return this.#instance.forRelease(this.#blocks);
  }

  forDraft(pointer: string): Client {
    return this.#instance.forDraft(this.#blocks, pointer);
  }

  forRevision(revision: string): Client {
    return this.#instance.forRevision(this.#blocks, revision);
  }

  update(): Promise<{ updated: boolean }> {
    return this.#instance.update();
  }

  settings(): Promise<EffectiveSettings> {
    return this.#instance.settings(this.#blocks);
  }

  draftPointer(request: RequestLike): Promise<string | null> {
    return this.#instance.draftPointer(this.#blocks, request);
  }

  draftCookie(request: RequestLike): Promise<string | null> {
    return this.#instance.draftCookie(this.#blocks, request);
  }
}

/** The shared instance behind a `createCMS` result; `undefined` for anything else. */
export function instanceOf(cms: CMS): object | undefined {
  const instance = (cms as unknown as Record<symbol, unknown>)[INSTANCE];
  return instance instanceof Object ? instance : undefined;
}

/**
 * Creates the CMS: a handle on the one instance this content root has in the
 * process, holding this call's block map. Create it once, at module scope, and
 * ask it for a client per request.
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
    return existing.handle(config.blocks);
  }
  const instance = new CMSInstance(config, interval);
  store[key] = instance;
  return instance.handle(config.blocks);
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
  parseCodeHosts(config.preview);
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
    preview: stableJson(config.preview ?? null),
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
