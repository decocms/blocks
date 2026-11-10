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
import { CMSClient } from "./client.ts";
import { ContentStore, isLoader, isSnapshot } from "./content.ts";
import type { IndexedContent } from "./contentIndex.ts";
import type { Overrides } from "./current.ts";
import { draftCookieFor, endsPreview, parseClientVersion, readVersion } from "./draft.ts";
import { parseDraftHosts } from "./draftChanges.ts";
import { allowsHost, type HostPattern, parseHostPattern } from "./hosts.ts";
import { clearGlobals, contentIdentity, fnv1a } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import type { Selection } from "./pin.ts";
import { remoteLoader, resetRemoteLoaders } from "./remoteLoader.ts";
import {
  deepFreeze,
  defaultSettings,
  isStatic,
  parseCodeHosts,
  previewHosts,
  readSettings,
  type SavedSettings,
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
  ClientOptions,
  CMS,
  CMSConfig,
  EffectiveSettings,
  Loader,
  ReleaseCheckOptions,
  RequestLike,
  RequestVersion,
  Snapshot,
} from "./types.ts";

const INSTANCE_PREFIX = "decocms.blocks.cms:";
/** The interval when none is given: how often a server checks for a new release. */
const DEFAULT_INTERVAL = 60_000;
/** The shortest interval allowed; lower values are raised to it. */
const MIN_INTERVAL = 5_000;
/**
 * Each check runs one interval, plus or minus up to a fifth of it (never more
 * than `MAX_JITTER`), after the previous one: a fixed spread wider than the
 * interval would make a check due on almost every request.
 */
const JITTER_RATIO = 0.2;
const MAX_JITTER = 10_000;
/** How often telemetry reads its settings again when the release hasn't changed (date rules). */
const TELEMETRY_SETTINGS_MS = 60_000;

/** Options that must agree between two `createCMS` calls sharing an instance. */
interface Fingerprint {
  interval: number;
  telemetry: string;
  preview: string;
  token: string;
}

/**
 * The state one content root shares across `createCMS` calls: the content
 * store, caps and telemetry. Each call gets its own handle
 * holding its own block map (see `CMSHandle`).
 */
class CMSInstance {
  readonly config: Readonly<CMSConfig>;
  readonly fingerprint: Fingerprint;
  readonly #store: ContentStore;
  readonly #interval: number;
  readonly #warned = new Set<string>();
  readonly #telemetry: TelemetryPipeline | undefined;
  readonly #caps: SettingsCaps;
  /** Settings of a `CMS` block with nothing to run, per release index. */
  #staticSettings = new WeakMap<IndexedContent, SavedSettings>();
  /** Code's `preview.hosts`, parsed: added to the release's own preview hosts, or the only list without a site. */
  readonly #codeHosts: readonly HostPattern[] | undefined;
  /** The release and time telemetry last read its section. */
  #telemetryRead: { content: IndexedContent; at: number } | undefined;
  /** One handle per block map, so the same config returns the same object. */
  readonly #handles = new WeakMap<Blocks, CMS>();
  /**
   * When the next check is due. The first is on the first `client()`, not
   * at construction: Workers read `Date.now()` as 0 at module scope.
   */
  #nextCheck: number | undefined;

  constructor(config: CMSConfig, interval: number) {
    this.config = config;
    this.#interval = interval;
    this.#store = new ContentStore(contentOf(config), parseDraftHosts(config.preview));
    this.fingerprint = fingerprintOf(config, interval);
    this.#codeHosts = parseCodeHosts(config.preview);
    this.#caps = { limits: telemetryLimits(config.telemetry) };
    const destination = resolveDestination(config.telemetry, config.site, config.token);
    if (destination !== null) {
      this.#telemetry = new TelemetryPipeline(destination);
      setCurrentTelemetry(this.#telemetry);
    }
  }

  /**
   * A client for one request: the version it reads (the current release, a
   * published release by its revision id, or a draft pointer), the visitor it
   * decides tests for and the date it checks campaigns at (default: now),
   * all passed in, with the tests and campaigns it is given on top.
   */
  client(blocks: Blocks, options: ClientOptions = {}): Client {
    this.#scheduleUpdate();
    const version = typeof options.version === "string" ? options.version : undefined;
    const date = options.date instanceof Date ? options.date.getTime() : Number.NaN;
    const inputs = {
      version,
      visitor: options.visitor ?? null,
      date: Number.isNaN(date) ? Date.now() : date,
      experiments: overridesOf(options.experiments),
      campaigns: overridesOf(options.campaigns),
    };
    if (version === undefined) return this.#client(blocks, this.#release(blocks), inputs);
    const parsed = parseClientVersion(version);
    // A version that doesn't parse fails on the first read, as an invalid pointer always has.
    const check = options.releaseCheck;
    if (parsed === null)
      return this.#client(blocks, () => this.#store.draft(version, check), inputs);
    if (parsed.kind === "revision") {
      return this.#client(blocks, () => this.#store.revision(parsed.id), inputs);
    }
    return this.#client(blocks, () => this.#store.draft(version, check), inputs);
  }

  /** Loads the current release, keeping telemetry on the release's settings. */
  #release(blocks: Blocks): () => Promise<Selection> {
    const telemetry = this.#telemetry;
    if (telemetry === undefined) return () => this.#store.release();
    return () =>
      this.#store.release().then(async (selection) => {
        telemetry.useRelease(selection.current);
        await this.#followTelemetrySettings(blocks, telemetry, selection.current);
        return selection;
      });
  }

  /**
   * The release's settings, from memory: never a draft, never a fetch. The
   * `CMS` block resolves on each call, so a field with variants is decided
   * where it's called; one with nothing to run is resolved once per release.
   */
  async settings(blocks: Blocks): Promise<EffectiveSettings> {
    const [saved, hosts] = await Promise.all([
      this.#settingsOf(blocks, this.#store.current()),
      this.#store.previewHosts(true),
    ]);
    return deepFreeze({ ...saved, preview: { hosts: previewHosts(hosts, this.#codeHosts) } });
  }

  async readVersion(
    request: RequestLike,
    options: ReleaseCheckOptions = {},
  ): Promise<RequestVersion | null> {
    const version = readVersion(request);
    if (version === null) return null;
    // The request's release check first: it reads `latest.json`, the preview hosts with it.
    if (typeof options.releaseCheck === "string") {
      await this.#store.waitForCheck(options.releaseCheck);
    }
    return (await this.#previewAllowed(request)) ? version : null;
  }

  /** A release check for one draft request (see `ContentStore.checkRelease`); it counts as the background's too. */
  checkRelease(releaseCheck?: string | null): Promise<string> {
    if (this.#store.updatable) this.#nextCheck = this.#due();
    return this.#store.checkRelease(releaseCheck);
  }

  async draftCookie(request: RequestLike): Promise<string | null> {
    const cookie = draftCookieFor(request);
    if (cookie === null) return null;
    // Ending a preview is allowed anywhere, so a cookie set before a host was removed still goes.
    if (endsPreview(request)) return cookie;
    return (await this.#previewAllowed(request)) ? cookie : null;
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

  /**
   * The settings of a release index: the `CMS` body comes from memory (held
   * by local content, inline in a hosted index as `data`), never a fetch.
   */
  async #settingsOf(blocks: Blocks, content: IndexedContent | undefined): Promise<SavedSettings> {
    if (content === undefined) return defaultSettings(this.#caps);
    const cached = this.#staticSettings.get(content);
    if (cached !== undefined) return cached;
    const entry = settingsBody(content);
    const settings = await readSettings(
      entry,
      () =>
        new CMSClient({
          load: () => Promise.resolve({ current: content }),
          blocks,
          builtIns,
          date: Date.now(),
          onCollision: (name) => this.#warnCollision(name),
        }),
      this.#caps,
    );
    // A block map's own cms-settings function may answer differently per call.
    const fixed = !isPlainObject(entry) || isStatic(entry);
    if (fixed && !Object.hasOwn(blocks, SETTINGS_TYPE)) {
      this.#staticSettings.set(content, settings);
    }
    return settings;
  }

  /**
   * Whether the current release's preview hosts (the release metadata's,
   * read once if this process hasn't yet) or code's allow this request's host.
   * No list published (or no remote site and no code list): every host; a
   * failed read of the metadata: code's list alone (see `previewHosts`).
   */
  async #previewAllowed(request: RequestLike): Promise<boolean> {
    const hosts = previewHosts(await this.#store.previewHosts(), this.#codeHosts);
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
    content: IndexedContent,
  ): Promise<void> {
    const last = this.#telemetryRead;
    const now = Date.now();
    if (last?.content === content && now - last.at < TELEMETRY_SETTINGS_MS) return;
    this.#telemetryRead = { content, at: now };
    const read = this.#settingsOf(blocks, content).then((settings) => {
      if (this.#telemetryRead?.content === content) telemetry.apply(settings.telemetry);
    });
    // A new release waits for its rates; a periodic re-read doesn't hold up the request.
    if (last?.content !== content) await read;
  }

  /** A client with its inputs (each client copies its visitor, so none is shared). */
  #client(
    blocks: Blocks,
    load: () => Promise<Selection>,
    inputs: {
      version: string | undefined;
      visitor: ClientOptions["visitor"];
      date: number;
      experiments: Overrides | undefined;
      campaigns: Overrides | undefined;
    },
  ): Client {
    return new CMSClient({
      load,
      blocks,
      builtIns,
      ...inputs,
      onCollision: (name) => this.#warnCollision(name),
      telemetry: this.#telemetry?.forClient(),
    });
  }

  /**
   * Checks a content source with `update()` on first use and then every
   * `interval` (± up to a fifth of it, 10 s at most), at an idle moment, never in front of a release
   * request (a draft read waits for a check of its own: `ContentStore.draft`).
   */
  #scheduleUpdate(): void {
    if (!this.#store.updatable) return;
    if (this.#nextCheck !== undefined && Date.now() < this.#nextCheck) return;
    this.#nextCheck = this.#due();
    runInBackground(() => this.#store.update());
  }

  #due(): number {
    const jitter = Math.min(this.#interval * JITTER_RATIO, MAX_JITTER);
    return Date.now() + this.#interval + (Math.random() * 2 - 1) * jitter;
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

/** The `CMS` block's body from memory: held (local content) or inline (`data`, hosted). */
function settingsBody(content: IndexedContent): unknown {
  if (content.held?.has(SETTINGS_BLOCK)) return content.held.get(SETTINGS_BLOCK);
  const entry = Object.hasOwn(content.blocks, SETTINGS_BLOCK)
    ? content.blocks[SETTINGS_BLOCK]
    : undefined;
  return entry?.data;
}

/** `Symbol.for`, so a second copy of this module still reads it. */
const INSTANCE = Symbol.for("decocms.blocks.cms.instance");

/**
 * What `createCMS` returns: the shared instance plus the block map of this
 * call. Every handle on one content root shares its content, caps and
 * telemetry; each resolves with the block map it was created with.
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

  client(options: ClientOptions = {}): Client {
    return this.#instance.client(this.#blocks, options);
  }

  forRelease(): Client {
    return this.#instance.client(this.#blocks);
  }

  forDraft(pointer: string, options: ReleaseCheckOptions = {}): Client {
    return this.#instance.client(this.#blocks, {
      version: pointer,
      releaseCheck: options.releaseCheck ?? null,
    });
  }

  checkRelease(releaseCheck?: string | null): Promise<string> {
    return this.#instance.checkRelease(releaseCheck);
  }

  update(): Promise<{ updated: boolean }> {
    return this.#instance.update();
  }

  settings(): Promise<EffectiveSettings> {
    return this.#instance.settings(this.#blocks);
  }

  readVersion(request: RequestLike, options?: ReleaseCheckOptions): Promise<RequestVersion | null> {
    return this.#instance.readVersion(request, options);
  }

  async draftPointer(request: RequestLike): Promise<string | null> {
    return (await this.#instance.readVersion(request))?.version ?? null;
  }

  draftCookie(request: RequestLike): Promise<string | null> {
    return this.#instance.draftCookie(request);
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
  const own = (config.content as { interval?: unknown } | undefined)?.interval;
  const interval = resolveInterval(config.interval ?? (typeof own === "number" ? own : undefined));
  const key = Symbol.for(INSTANCE_PREFIX + identityOf(config));
  const store = globalThis as unknown as Record<symbol, CMSInstance | undefined>;
  const existing = store[key];
  // An instance an older copy of this package stored (a dev reload across
  // versions) has no handles: it's replaced rather than adopted.
  if (
    existing instanceof Object &&
    typeof existing.adopt === "function" &&
    typeof existing.handle === "function"
  ) {
    warnOnConflict(existing.fingerprint, fingerprintOf(config, interval));
    existing.adopt(config);
    return existing.handle(config.blocks);
  }
  const instance = new CMSInstance(config, interval);
  store[key] = instance;
  return instance.handle(config.blocks);
}

/**
 * Hands a new content module to every CMS created for its `.deco` folder, as
 * a later `createCMS` call with the same content would, but without the
 * site's config: each instance keeps its own options. Only content without
 * `site` comes from a content module (with `site`, it comes from the CDN).
 * Returns how many instances took it; none when no CMS has been created for
 * that folder yet (the first `createCMS` call then reads the new module) or
 * when the module has no `root` to match on.
 *
 * The dev server's content reload (`@decocms/blocks/vite`) calls it when
 * Vite swaps `.deco/blocks.gen.ts`, so the module that created the CMS never
 * runs again.
 */
export function adoptContent(content: Snapshot): number {
  if (!isSnapshot(content)) return 0;
  const identity = contentIdentity(content);
  if (!identity.startsWith("module:")) return 0;
  const own = INSTANCE_PREFIX + identity;
  const store = globalThis as unknown as Record<symbol, unknown>;
  let adopted = 0;
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
    const key = Symbol.keyFor(symbol);
    if (key !== own) continue;
    const instance = store[symbol] as Partial<CMSInstance> | undefined;
    if (
      !(instance instanceof Object) ||
      typeof instance.adopt !== "function" ||
      !isPlainObject(instance.config)
    ) {
      continue;
    }
    instance.adopt({ ...instance.config, content } as CMSConfig);
    adopted++;
  }
  return adopted;
}

/**
 * A client's own frozen copy of the tests or campaigns it is given: the
 * entries that are `true` or `false`; `undefined` for none.
 */
function overridesOf(given: unknown): Overrides | undefined {
  if (typeof given !== "object" || given === null || Array.isArray(given)) return undefined;
  const out = Object.create(null) as Record<string, boolean>;
  for (const [name, on] of Object.entries(given as Record<string, unknown>)) {
    if (typeof on === "boolean") out[name] = on;
  }
  return Object.freeze(out);
}

/** Clears every stored CMS instance, so a test starts clean. */
export function resetForTests(): void {
  clearGlobals(INSTANCE_PREFIX);
  resetRemoteLoaders();
  setCurrentTelemetry(undefined);
}

/** With `site`, hosted releases from the delivery CDN, at runtime only; without, the content given. */
function contentOf(config: CMSConfig): Snapshot | Loader {
  if (!config.site) return config.content as Snapshot | Loader;
  return remoteLoader(undefined, { site: config.site });
}

function validate(config: CMSConfig): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("createCMS: expected a config object");
  }
  if (config.blocks === null || typeof config.blocks !== "object") {
    throw new TypeError("createCMS: `blocks` must be your block map (an object of functions)");
  }
  if (config.site) {
    // Content is never bundled: with site, it comes from the delivery CDN at runtime.
    if (config.content !== undefined) {
      throw new TypeError(
        "createCMS: with site, content comes from the delivery CDN at runtime; remove content",
      );
    }
  } else if (!isLoader(config.content) && !isSnapshot(config.content)) {
    throw new TypeError(
      "createCMS: `content` must be a snapshot ({ revision, blocks }) or a loader with load(), or pass site",
    );
  }
  // The token is the site's credential: it means nothing without the site it belongs to.
  if (config.token && !config.site) {
    throw new TypeError("createCMS: token needs site: pass both, or site alone");
  }
  parseCodeHosts(config.preview);
  parseDraftHosts(config.preview);
}

function resolveInterval(configured: number | undefined): number {
  const raw = configured ?? DEFAULT_INTERVAL;
  if (!Number.isFinite(raw)) return DEFAULT_INTERVAL;
  if (raw < MIN_INTERVAL) {
    console.warn(
      `[decocms/blocks] interval ${raw} ms is below the minimum; raised to ${MIN_INTERVAL} ms.`,
    );
    return MIN_INTERVAL;
  }
  return raw;
}

/**
 * The instance key: with hosted releases, the site; otherwise the content's
 * identity (never its revision, so a hot reload keeps the instance).
 *
 * A content module is identified by the `.deco` folder it was generated from
 * (its `root`). One without a `root` is identified by the object itself, so
 * two such modules never share an instance; a hot reload of one then gets a
 * new instance instead of updating the old.
 */
function identityOf(config: CMSConfig): string {
  if (config.site) return `site:${config.site}`;
  return contentIdentity(config.content as Snapshot | Loader);
}

function fingerprintOf(config: CMSConfig, interval: number): Fingerprint {
  return {
    interval,
    telemetry: stableJson(config.telemetry ?? null),
    preview: stableJson(config.preview ?? null),
    token: config.token ? fnv1a(config.token) : "",
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
