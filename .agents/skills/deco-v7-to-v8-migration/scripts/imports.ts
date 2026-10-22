/**
 * The import codemod: v7 `@decocms/*` imports in the site's `src/`.
 *
 * It rewrites only what has a v8 equivalent with the same meaning:
 *
 * - an import of a vendored module (`@decocms/apps-shopify/loaders/…`)
 *   points at the copy in `src/vendor`;
 * - `createInstrumentedFetch` from `@decocms/blocks/sdk/instrumentedFetch`
 *   comes from `@decocms/blocks/fetch`, and `createInstrumentedFetch("x")`
 *   becomes `createInstrumentedFetch({ provider: "x" })`;
 * - names a v8 binding exports with v7's props and behaviour move to it
 *   (`MOVES`): `createDecoRouter` to `@decocms/tanstack/router`,
 *   `NavigationProgress` and, on a TanStack site, `Image`/`Picture`/`Source`
 *   to `@decocms/tanstack/react`, and so on; a name whose home depends on the
 *   binding (the draft names and Studio's origins: `@decocms/tanstack` or
 *   `@decocms/nextjs`, never `@decocms/blocks`) moves to the site's. An import
 *   declaration that mixes moved and other names is split.
 *
 * Every other v7 import is reported with where its replacement lives, name by
 * name where the bindings replace them (`NAME_HINTS`); none is shimmed.
 * Imports of the next major's documented entry points are left alone.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  COMPAT_MOVES,
  COMPAT_NAME_HINTS,
  COMPAT_V7_ENTRIES,
  compatCommerceSpecifier,
} from "./compat";
import { type Framework, siteBlocksVersion, siteFramework } from "./framework";
import {
  copyDecoCdnOptions,
  findImageCopies,
  type ImageCopy,
  leadingStripChanges,
} from "./imageCopy";
import { imageModule, writeImageUrl } from "./imageModule";
import type { Report } from "./report";
import { relativeSpecifier, resolvePackageFile } from "./vendor";

/** The next major's documented API (/next/api-reference): imports of these stay. */
export const V8_API: Record<string, ReadonlySet<string> | "*"> = {
  // The root's next-major exports (packages/blocks/src/index.ts, from ./v8).
  "@decocms/blocks": new Set([
    "Analytics",
    "Block",
    "BlockFunction",
    "Blocks",
    "Client",
    "ClientOptions",
    "CMS",
    "CMSError",
    "CMSSettings",
    "createCMS",
    "currentClient",
    "DraftPointer",
    "EffectiveSettings",
    "formatDraftPointer",
    "Lazy",
    "ListOptions",
    "Loader",
    "Match",
    "matchRoute",
    "Page",
    "parseDraftPointer",
    "parseVersion",
    "Redirect",
    "RequestLike",
    "RequestVersion",
    "Result",
    "Route",
    "remoteLoader",
    "resetForTests",
    "Secret",
    "Seo",
    "Snapshot",
    "Telemetry",
    "TelemetryConfig",
    "Variant",
  ]),
  "@decocms/blocks/fetch": "*",
  // Who is in which A/B test: pure helpers a site's own code may call.
  "@decocms/blocks/experiments": "*",
  "@decocms/blocks/analytics": "*",
  "@decocms/blocks/secrets": "*",
  "@decocms/blocks/cli": "*",
  // Platform-neutral image URLs only; a platform's URLs are its client's /image.
  "@decocms/blocks/image": new Set([
    "createImageUrl",
    "decoCdn",
    "DecoCdnOptions",
    "Fit",
    "ImageProvider",
    "ImageUrl",
    "parseSrcSet",
    "PreloadLink",
    "PreloadOptions",
    "preloadLink",
    "Quality",
    "QualityTier",
    "ResizeOptions",
    "SrcSetOptions",
    "srcSet",
  ]),
  // The platforms' image URL helpers (pure functions, for createImageUrl). v7 had no such subpath.
  "@decocms/apps-vtex/image": "*",
  "@decocms/apps-shopify/image": "*",
  "@decocms/blocks/vite": "*",
  // v7 had a /preview too, with other names (DraftPreviewBadge).
  "@decocms/blocks/preview": new Set([
    "DraftBadge",
    "DraftBadgeProps",
    "StudioBridge",
    "StudioBridgeProps",
    "StudioPage",
    "StudioPageInfo",
  ]),
  // The v8 bindings. Subpaths v7 never had are whole; the rest list v8's names.
  // The draft names and Studio's origins live in each binding's root, not in @decocms/blocks.
  "@decocms/tanstack": new Set([
    "ASSIGNMENTS_HEADER",
    "DRAFT_COOKIE",
    "DRAFT_PARAM",
    "draftResponseHeaders",
    "isStudioOrigin",
    "STUDIO_FRAME_ANCESTORS",
    "STUDIO_ORIGINS",
    "VERSION_HEADER",
    "VISITOR_HEADER",
  ]),
  "@decocms/tanstack/worker": "*",
  "@decocms/tanstack/server": "*",
  "@decocms/tanstack/start": "*",
  "@decocms/tanstack/router": "*",
  "@decocms/tanstack/react": "*",
  "@decocms/tanstack/scope": "*",
  "@decocms/tanstack/vite": new Set([
    "decoTanstack",
    "DecoTanstackOptions",
    "gitBuildHash",
    "resolveBuildHash",
  ]),
  "@decocms/nextjs/proxy": "*",
  "@decocms/nextjs/server": "*",
  "@decocms/nextjs/image-loader": "*",
  // v7's DraftPreviewIndicator kept its name but now shows what bindDraft bound: reported.
  "@decocms/nextjs": new Set([
    "ASSIGNMENTS_HEADER",
    "DRAFT_COOKIE",
    "DRAFT_PARAM",
    "DraftBadge",
    "DraftPreviewIndicatorProps",
    "draftResponseHeaders",
    "isStudioOrigin",
    "STUDIO_FRAME_ANCESTORS",
    "STUDIO_ORIGINS",
    "StudioBridge",
    "StudioBridgeProps",
    "StudioPage",
    "StudioPageInfo",
    "VERSION_HEADER",
    "VISITOR_HEADER",
  ]),
  "@decocms/nextjs/config": new Set([
    "DECO_DRAFT_HEADERS",
    "HeaderRule",
    "STUDIO_DEV_ORIGINS",
    "withDeco",
    "WithDecoOptions",
  ]),
  // v7's pure helpers, with v7's output (the product owner's one home for them).
  ...Object.fromEntries(COMPAT_V7_ENTRIES.map((e) => [e, "*" as const])),
};

const IMAGE_COMPONENTS = [
  "Image",
  "ImageProps",
  "Picture",
  "PictureProps",
  "Source",
  "SourceProps",
];

/** v7's image URL helpers (`@decocms/blocks/hooks`). */
const IMAGE_URL_NAMES = [
  "registerImageCdnDomain",
  "registerImageQuality",
  "getOptimizedMediaUrl",
  "getSrcSet",
];

/** The draft names and Studio's origins: each binding's root exports them, `@decocms/blocks` doesn't. */
export const BINDING_NAMES = [
  "DRAFT_COOKIE",
  "DRAFT_PARAM",
  "draftResponseHeaders",
  "isStudioOrigin",
  "STUDIO_FRAME_ANCESTORS",
  "STUDIO_ORIGINS",
];

/** A move's target: one entry point, or one per binding. */
type MoveTarget = string | Partial<Record<Framework, string>>;

/**
 * v7 names a v8 binding exports with the same props and behaviour, by v7
 * specifier: the codemod points the import at the binding. `only` limits a
 * move to sites on that binding; a per-binding target moves a name only on a
 * site with one of those bindings.
 */
export const MOVES: Record<string, { only?: Framework; names: Record<string, MoveTarget> }> = {
  // v7's helpers @decocms/compat-v7 has (./compat.ts), whatever the binding.
  ...Object.fromEntries(Object.entries(COMPAT_MOVES).map(([s, names]) => [s, { names }])),
  "@decocms/blocks": {
    names: {
      ...Object.fromEntries(
        BINDING_NAMES.map((n) => [n, { tanstack: "@decocms/tanstack", nextjs: "@decocms/nextjs" }]),
      ),
      ...COMPAT_MOVES["@decocms/blocks"],
    },
  },
  "@decocms/tanstack": {
    names: {
      createDecoRouter: "@decocms/tanstack/router",
      decoParseSearch: "@decocms/tanstack/router",
      decoStringifySearch: "@decocms/tanstack/router",
      NavigationProgress: "@decocms/tanstack/react",
      StableOutlet: "@decocms/tanstack/react",
    },
  },
  "@decocms/tanstack/sdk/serverFnFetch": {
    names: { decoServerFnFetch: "@decocms/tanstack/start" },
  },
  "@decocms/blocks/hooks": {
    only: "tanstack",
    names: Object.fromEntries(IMAGE_COMPONENTS.map((n) => [n, "@decocms/tanstack/react"])),
  },
};

const IMAGE_HELPERS =
  "createImageUrl and decoCdn from @decocms/blocks/image, vtexCatalog from @decocms/apps-vtex/image, shopifyCdn from @decocms/apps-shopify/image; keep both helpers whatever the site's platform, since v7 resized VTEX and Shopify images on every site";

/**
 * v7's image URLs as v8 code, for the `@decocms/blocks` 7.x version the site
 * ran: the platform helpers (their client packages' /image) before the Deco
 * CDN, with the `decoCdn` options that reproduce that release's `Image`
 * (checked against each release's `hooks/Image.tsx`):
 * - before 7.71.0: decoims.com was the default domain, every Deco asset host
 *   was stripped wherever it was, and no legacy host was stripped;
 * - 7.71.0 to 7.71.3: assets.decocms.com became the default, the rest alike;
 * - 7.71.4: only a leading asset host is stripped, and decoims.com on any CDN;
 *   decoCdn's default since 8.3 ("leading"), which the PO approved for the
 *   older releases too (2026-10-15): `rewriteImports` reports the URLs it changes;
 * - 7.71.5 on: decoims.com only on the Cloudflare CDNs (decoCdn's default);
 * - 7.77.1 on: Nuvemshop product images got the CDN's fixed sizes too, which
 *   no @decocms/apps-* package covers: such a store lists its own provider.
 */
export function v7ImageUrl(version: string | undefined): string {
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  const at = (m: number, p: number) => major === 7 && (minor > m || (minor === m && patch >= p));
  const nuvemshop =
    "; a store with Nuvemshop images lists its own provider before decoCdn (reference/framework-code.md)";
  const providers = (deco: string) =>
    `createImageUrl({ providers: [vtexCatalog(), shopifyCdn(), decoCdn({ ${deco} })] })`;
  const registered =
    "domain and quality as the site registered them with registerImageCdnDomain/registerImageQuality, else leave them out";
  if (major !== 7 || Number.isNaN(minor)) {
    return `${providers('domain, quality, sources: "all"')} (${IMAGE_HELPERS}; ${registered}; that is the latest 7.x, and reference/framework-code.md lists the decoCdn options for older 7.x releases${nuvemshop})`;
  }
  if (!at(71, 0)) {
    return `${providers('domain, quality, sources: "all", legacyHosts: []')} (${IMAGE_HELPERS}; domain as the site registered it with registerImageCdnDomain, else "decoims.com", the default before 7.71.0; quality as registered with registerImageQuality, else leave it out)`;
  }
  if (!at(71, 4)) {
    return `${providers('domain, quality, sources: "all", legacyHosts: []')} (${IMAGE_HELPERS}; ${registered})`;
  }
  if (!at(71, 5)) {
    return `${providers('domain, quality, sources: "all", legacyHosts: ["decoims.com"]')} (${IMAGE_HELPERS}; ${registered})`;
  }
  return `${providers('domain, quality, sources: "all"')} (${IMAGE_HELPERS}; ${registered}${at(77, 1) ? nuvemshop : ""})`;
}

/** Whether the `@decocms/blocks` 7.x release's `Image` stripped the asset hosts anywhere (before 7.71.4). */
export function v7StripsAnywhere(version: string | undefined): boolean {
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  if (major !== 7 || Number.isNaN(minor)) return false;
  return minor < 71 || (minor === 71 && !(patch >= 4));
}

/**
 * v7's image URLs as v8 code for a site that kept its own copy of v7's image
 * helper: the options are read from the copy (and what the site registers
 * with it), since the copy's URLs, not the release's, are what the site serves.
 */
export function copyImageUrl(
  copy: ImageCopy,
  registered: { domain?: string | null; quality?: string | null } = {},
): string | undefined {
  const rules = copy.rules;
  if (!rules) return undefined;
  const providers = [
    rules.vtex ? "vtexCatalog()" : "",
    rules.shopify ? "shopifyCdn()" : "",
    rules.nuvemshop ? "nuvemshop" : "",
    `decoCdn({ ${copyDecoCdnOptions(rules, registered)} })`,
  ].filter(Boolean);
  const helpers = [
    "createImageUrl and decoCdn from @decocms/blocks/image",
    rules.vtex ? "vtexCatalog from @decocms/apps-vtex/image" : "",
    rules.shopify ? "shopifyCdn from @decocms/apps-shopify/image" : "",
    rules.nuvemshop
      ? "nuvemshop: the store's own provider for v7's Nuvemshop rule (reference/framework-code.md)"
      : "",
  ].filter(Boolean);
  return `createImageUrl({ providers: [${providers.join(", ")}] }) (${helpers.join(", ")}; read from the site's copy of v7's image helper, ${copy.file}: these options reproduce its URLs, which win over its 7.x release's where they differ)`;
}

/** Stands for `v7ImageUrl(<the site's version>)` in a hint, replaced when reported. */
const V7_IMAGE_URL = "\u0001v7-image-url\u0001";

/** The hints for names the bindings replace, by v7 specifier: checked before `HINTS`. */
const NAME_HINTS: { specifier: RegExp; names: string[]; hint: string }[] = [
  ...COMPAT_NAME_HINTS,
  {
    specifier: /^@decocms\/(blocks|tanstack|nextjs)$/,
    names: ["DRAFT_HEADER"],
    hint: "VERSION_HEADER (x-deco-version) from the site's binding root: the request header carrying the version alone (a draft pointer or a release SHA); what the proxy or worker decided rides on ASSIGNMENTS_HEADER (x-deco-assignments), and contentClient reads both",
  },
  {
    specifier: /^@decocms\/tanstack$/,
    names: ["createDecoWorkerEntry"],
    hint: "createDecoWorker({ serverEntry, cms, pageCache }) from @decocms/tanstack/worker: drafts on the hosts Studio lists, liveness, Studio framing, CMS redirects and cookies are built in; the page cache is the site's own (pageCache: the worker-entry recipe in @decocms/tanstack's README, which the script writes with v7's buildSegment); what else the site's entry did goes in its options (csp, preload, routes)",
  },
  {
    specifier: /^@decocms\/tanstack$/,
    names: ["DecoRootLayout", "PreviewProviders", "DraftPreviewIndicator"],
    hint: "DecoDocument from @decocms/tanstack/react, the root route's component: it mounts StudioBridge and DraftBadge",
  },
  {
    specifier: /^@decocms\/tanstack$/,
    names: [
      "cmsRouteConfig",
      "cmsHomeRouteConfig",
      "loadCmsPage",
      "loadCmsHomePage",
      "CmsPage",
      "NotFoundPage",
      "withSiteGlobals",
      "DecoPageRenderer",
      "SectionRenderer",
      "SectionList",
      "loadDeferredSection",
    ],
    hint: "render pages with createCMS and matchRoute (/next/tanstack-start-descriptors), reading the draft the worker accepted with contentClient(cms) from @decocms/tanstack/server",
  },
  {
    specifier: /^@decocms\/tanstack$/,
    names: ["decoInvokeRouteConfig", "decoMetaRouteConfig", "decoRenderRouteConfig"],
    hint: "v7's admin and invoke routes: delete them (createDecoWorker answers 404 on v7's admin paths; /deco/invoke becomes server functions)",
  },
  {
    specifier: /^@decocms\/tanstack$/,
    names: ["setupTanstackFastDeploy", "kvLoader"],
    hint: "fast deploy is the hosted CMS: createCMS({ site, token }) (/next/content#create-the-cms)",
  },
  {
    specifier: /^@decocms\/nextjs$/,
    names: [
      "createDecoPage",
      "createDecoPreviewPage",
      "DecoPageRenderer",
      "SectionRenderer",
      "DeferredSectionBoundary",
      "ClientOnlySection",
      "DecoRootLayout",
    ],
    hint: "render pages with createCMS (/next/nextjs); drafts with bindDraft and contentClient from @decocms/nextjs/server, and StudioBridge from @decocms/nextjs in the root layout",
  },
  {
    specifier: /^@decocms\/nextjs$/,
    names: ["DraftPreviewIndicator"],
    hint: "the same name in @decocms/nextjs 8: it shows the draft bindDraft(cms, { searchParams, site }) from @decocms/nextjs/server bound for the page, so call that first",
  },
  {
    specifier: /^@decocms\/(nextjs|blocks\/preview)$/,
    names: [
      "DraftPreviewBadge",
      "DraftPreviewBadgeProps",
      "buildExitUrl",
      "buildShareUrl",
      "isFramed",
      "DECO_MARK_DATA_URI",
    ],
    hint: "DraftBadge from @decocms/blocks/preview (DecoDocument and DraftPreviewIndicator mount it)",
  },
  {
    specifier: /^@decocms\/nextjs\/config$/,
    names: ["DECO_REWRITES"],
    hint: "gone with v7's /deco/* handlers: withDeco from @decocms/nextjs/config adds no rewrites",
  },
  {
    specifier: /^@decocms\/blocks\/hooks$/,
    names: IMAGE_COMPONENTS,
    hint: "on Next.js, next/image with createDecoImageLoader from @decocms/nextjs/image-loader; elsewhere, URLs from createImageUrl, srcSet and preloadLink in @decocms/blocks/image, with the platform's helper listed first (vtexCatalog from @decocms/apps-vtex/image, shopifyCdn from @decocms/apps-shopify/image)",
  },
  {
    specifier: /^@decocms\/blocks\/hooks$/,
    names: [
      "registerImageCdnDomain",
      "registerImageQuality",
      "getImageCdnDomain",
      "getImageQuality",
      "getOptimizedMediaUrl",
      "getSrcSet",
      "FACTORS",
      "ImageQuality",
      "FitOptions",
    ],
    hint: `${V7_IMAGE_URL} gives v7's URLs; url(src, { width, height, fit }) and srcSet(url, src, …) replace getOptimizedMediaUrl and getSrcSet; on TanStack, pass it to ImageUrlProvider from @decocms/tanstack/react`,
  },
  {
    specifier: /^@decocms\/blocks\/hooks$/,
    names: ["LiveControls"],
    hint: "StudioBridge from @decocms/blocks/preview: DecoDocument (@decocms/tanstack/react) mounts it; a Next.js root layout renders StudioBridge from @decocms/nextjs",
  },
];

/** Where each v7 import's replacement lives, first match wins. */
const HINTS: [RegExp, string][] = [
  [/^@decocms\/start(\/|$)/, "a 6.x import: upgrade the site to 7.x first"],
  [
    /^@decocms\/blocks\/sdk\/cachedLoader$/,
    "cachedLoader is gone: an upstream cache is your own fetch, passed to createInstrumentedFetch (/next/caching#upstream-data)",
  ],
  [
    /(^|\/)(invoke|createInvoke)$|\/sdk\/invoke/,
    "/deco/invoke is gone: one server function per loader or action, imported by each call site, never a rebuilt invoke tree (/next/renames-and-migrations#loaders-actions-and-invoke)",
  ],
  [
    /^@decocms\/blocks-admin(\/|$)/,
    "next-major sites serve no admin endpoints; the site editor uses the content protocol (/next/studio-compatibility)",
  ],
  [
    /^@decocms\/blocks-cli(\/|$)/,
    "codegen is the deco CLI in @decocms/blocks: deco schema, deco content, deco check (/next/cli)",
  ],
  [
    /^@decocms\/blocks\/(setup|cms)(\/|$)/,
    "setup is createCMS from @decocms/blocks, with the block map in .deco/index.ts (/next/content#create-the-cms)",
  ],
  [
    /^@decocms\/blocks\/sdk\/instrumentedFetch$/,
    "createInstrumentedFetch({ provider, fetch?, retry?, circuitBreaker? }) from @decocms/blocks/fetch (/next/api-reference#createinstrumentedfetch-options)",
  ],
  [
    /^@decocms\/blocks\/(sdk\/(otel|observability|logger)|middleware\/observability)/,
    "telemetry is the telemetry option of createCMS (/next/telemetry)",
  ],
  [
    /(OneDollarStats|Analytics)$|^@decocms\/blocks\/sdk\/analytics$/,
    "AnalyticsScript and track from @decocms/blocks/analytics, with the analytics section of cms.settings() (/next/analytics)",
  ],
  [
    /^@decocms\/apps-salesforce(\/|$)|^@decocms\/apps\/salesforce(\/|$)/,
    "the Salesforce client is @decocms/apps-sfmc-personalization (/next/upstream-clients#what-a-client-is)",
  ],
  [
    /^@decocms\/apps-commerce(\/|$)/,
    "v7's app runtime (app-types, registry, resolve, manifest-utils) has no v8 equivalent: an app is its upstream client, created in code (/next/upstream-clients); v7's commerce types and helpers are @decocms/compat-v7/commerce/*",
  ],
  [
    /^@decocms\/apps\/commerce(\/|$)/,
    "a 6.x import: upgrade the site to 7.x first (7.x's @decocms/apps-commerce becomes @decocms/compat-v7/commerce)",
  ],
  [
    /^@decocms\/apps-website(\/|$)|^@decocms\/apps\/website(\/|$)/,
    "website features (SEO, sitemaps, redirects) live in your platform template (/next/upstream-clients#what-a-client-is)",
  ],
  [
    /^@decocms\/apps(-[a-z]+)?(\/|$)/,
    "apps are thin upstream clients now; call the platform's client from your own code (/next/upstream-clients)",
  ],
  [
    /^@decocms\/blocks\/sdk\/(cacheHeaders|responseCache|cacheStorage|mergeCacheControl)$/,
    "on TanStack Start, the page cache in the site's worker entry (the recipe in @decocms/tanstack's README: its PROFILES are v7's, change them there); a Next.js site keeps its own cache headers",
  ],
  [
    /^@decocms\/blocks\/sdk\/csp$/,
    "createDecoWorker's csp option (@decocms/tanstack/worker): Studio's frame-ancestors are always added",
  ],
  [
    /^@decocms\/blocks\/sdk\/redirects$/,
    "createDecoWorker applies the CMS redirects before any route",
  ],
  [
    /^@decocms\/blocks\/sdk\/abTesting$/,
    "withABTesting is abTestingRoutes({ worker: () => worker, ...the same options }) from @decocms/compat-v7/tanstack/worker, a handler run first in createDecoWorker's routes (not a wrapper around the worker): same KV entry, buckets, cookie and fallback proxy (reference/framework-code.md)",
  ],
  [
    /^@decocms\/tanstack\/vite$/,
    "decoTanstack({ buildHash }) from @decocms/tanstack/vite; it includes decoContent() from @decocms/blocks/vite",
  ],
  [
    /^@decocms\/tanstack\/sdk\/startEntry$/,
    "createStart(() => ({ serverFns: { fetch: decoServerFnFetch } })) with decoServerFnFetch from @decocms/tanstack/start; createDecoWorker decides the draft, so no draft middleware",
  ],
  [
    /^@decocms\/tanstack\/sdk\/cdnSegment$/,
    "the segment of the site's page cache (buildSegment in the worker entry); the cache passes the __cseg token to render({ csegToken }), DecoDocument publishes it and decoServerFnFetch sends it",
  ],
  [
    /^@decocms\/tanstack\/sdk\/cookiePassthrough$/,
    "createDecoWorker sends one Set-Cookie per cookie; a server function sets cookies with TanStack Start's own setCookie",
  ],
  [
    /^@decocms\/tanstack\/sdk\/deferredSectionLoader$/,
    "the next major has no async rendering (the script unwrapped the Lazy and Deferred sections)",
  ],
  [/^@decocms\/tanstack\/daemon$/, "local editing is deco serve (/next/cli)"],
  [
    /^@decocms\/nextjs\/routeHandlers$/,
    "v7's /deco/* route handlers: delete them; the site editor uses the content protocol (/next/studio-compatibility)",
  ],
  [
    /^@decocms\/nextjs\/setup$/,
    "setup is createCMS from @decocms/blocks, with the block map in .deco/index.ts (/next/content#create-the-cms)",
  ],
  [
    /^@decocms\/nextjs\/middleware$/,
    "draft previews and the visitor in proxy.ts: decideDraft, decideVisitor, draftRequestHeaders, visitorRequestHeaders, rewriteToDraftRoute, applyDraft and applyVisitor from @decocms/nextjs/proxy, or draftProxy",
  ],
  [
    /^@decocms\/tanstack(\/|$)/,
    "a v7 name: @decocms/tanstack 8 has createDecoWorker (/worker), DecoDocument and Image (/react), createDecoRouter (/router), decoServerFnFetch (/start), contentClient (/server) and decoTanstack (/vite); see the skill's import map",
  ],
  [
    /^@decocms\/nextjs(\/|$)/,
    "a v7 name: @decocms/nextjs 8 has the draft proxy (/proxy), bindDraft and contentClient (/server), withDeco (/config), createDecoImageLoader (/image-loader) and StudioBridge; see the skill's import map",
  ],
];
const DEFAULT_HINT = "no v8 equivalent";
/** Prerelease root exports that became CMS methods. */
const DRAFT_HELPERS = new Set(["draftPointer", "draftCookie"]);
const DRAFT_HINT =
  "draftPointer and draftCookie are the async cms.draftPointer and cms.draftCookie now: pass cms.draftPointer the request, or { url, headers } (/next/api-reference#draft-pointers); on TanStack Start and Next.js the binding decides the draft (contentClient from @decocms/tanstack/server, bindDraft from @decocms/nextjs/server)";
const BINDING_NAMES_HINT =
  "the draft names and Studio's origins come from the site's binding, not @decocms/blocks: @decocms/tanstack on TanStack Start, @decocms/nextjs on Next.js";

const SOURCE = /\.(tsx?|mts|cts)$/;

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !f.split(path.sep).includes("node_modules"));
}

interface Found {
  /** The string literal node holding the specifier. */
  literal: ts.StringLiteral;
  /** Named imports (`*` for a namespace or default import). */
  names: string[];
  declaration?: ts.ImportDeclaration;
}

function findImports(source: ts.SourceFile): Found[] {
  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names: string[] = [];
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name) names.push("default");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
      } else {
        names.push("*");
      }
      found.push({
        literal: node.moduleSpecifier,
        names,
        declaration: ts.isImportDeclaration(node) ? node : undefined,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ literal: node.arguments[0], names: ["*"] });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push({ literal: node.argument.literal, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The hint for each of `names` imported from `specifier`, names grouped by hint. */
function hintsFor(specifier: string, names: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (hint: string, name: string) => out.set(hint, [...(out.get(hint) ?? []), name]);
  const general = HINTS.find(([pattern]) => pattern.test(specifier))?.[1] ?? DEFAULT_HINT;
  for (const name of names) {
    if (specifier === "@decocms/blocks" && DRAFT_HELPERS.has(name)) {
      add(DRAFT_HINT, name);
      continue;
    }
    if (specifier === "@decocms/blocks" && BINDING_NAMES.includes(name)) {
      add(BINDING_NAMES_HINT, name);
      continue;
    }
    const byName = NAME_HINTS.find((h) => h.specifier.test(specifier) && h.names.includes(name));
    add(byName?.hint ?? general, name);
  }
  return out;
}

/** The names of `specifier` the next major doesn't export (all of them for an unknown entry point). */
function undocumented(specifier: string, names: string[]): string[] {
  const api = V8_API[specifier];
  if (api === "*") return [];
  return api ? names.filter((n) => !api.has(n)) : names;
}

/** `createInstrumentedFetch("x")` calls, or null when one has another argument shape. */
function instrumentedFetchCalls(source: ts.SourceFile, local: string): ts.CallExpression[] | null {
  const calls: ts.CallExpression[] = [];
  let convertible = true;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === local
    ) {
      const [arg] = node.arguments;
      if (node.arguments.length === 1 && arg && ts.isStringLiteralLike(arg)) calls.push(node);
      else convertible = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return convertible ? calls : null;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** How many changed URLs the report spells out; the rest are counted. */
const LISTED_URLS = 10;

/**
 * A site whose v7 image code stripped the Deco asset hosts anywhere in a
 * source now gets decoCdn's "leading" (approved, PO 2026-10-15): the report
 * counts the URLs in the content and code whose image URL changes.
 */
function reportLeadingStrip(root: string, report: Report, copy: string | undefined): void {
  const changes = leadingStripChanges(root);
  const by = copy
    ? `its copy of v7's image helper (${copy})`
    : "its 7.x release's Image (before 7.71.4)";
  const rule = `v7 stripped the Deco asset hosts (assets.decocache.com, the S3 bucket) anywhere in an image source, by ${by}; decoCdn strips only a leading one, an approved difference (PO 2026-10-15), so a source that merely contains an asset URL keeps it`;
  if (changes.length === 0) {
    report.done.push({
      step: "imports",
      subject: "image URLs",
      message: `${rule}. No URL in .deco/blocks or src/ changes`,
    });
    return;
  }
  const files = new Set(changes.map((c) => c.file));
  const listed = changes
    .slice(0, LISTED_URLS)
    .map((c) => `${c.url} (${c.file})`)
    .join(", ");
  const more = changes.length > LISTED_URLS ? `, +${changes.length - LISTED_URLS} more` : "";
  report.manual.push({
    step: "imports",
    subject: "image URLs",
    message: `${rule}. ${changes.length} URL${changes.length === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"} change${changes.length === 1 ? "s" : ""}: ${listed}${more}. List them as the approved difference in the PR; nothing to change`,
  });
}

/**
 * Rewrite and report the `@decocms/*` imports of every source file in `src/`.
 * `vendored` maps an installed source file to its copy in the site.
 */
export function rewriteImports(root: string, report: Report, vendored: Map<string, string>): void {
  const reported = new Map<string, { names: Set<string>; files: Set<string> }>();
  let rewrittenFiles = 0;
  const framework = siteFramework(root);
  const images = findImageCopies(root);
  const fromCopy = images.copies
    .map((copy) => copyImageUrl(copy, images.registered))
    .find((url) => url !== undefined);
  const version = siteBlocksVersion(root);
  const imageUrl = fromCopy ?? v7ImageUrl(version);
  const readCopy = images.copies.find((copy) => copy.rules !== null);
  const stripsAnywhere = readCopy
    ? readCopy.rules?.stripAssetHosts === "anywhere"
    : v7StripsAnywhere(version);
  /** Names moved to a binding, by target, for the report. */
  const moved = new Map<string, Set<string>>();
  /** Whether the site uses v7's image components or URL helpers. */
  let usesImages = images.copies.length > 0;

  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("@decocms/")) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const edits: Edit[] = [];
    const rel = path.relative(root, file).split(path.sep).join("/");

    for (const found of findImports(source)) {
      const specifier = found.literal.text;
      if (!specifier.startsWith("@decocms/")) continue;
      if (
        specifier === "@decocms/blocks/hooks" &&
        found.names.some((n) => IMAGE_COMPONENTS.includes(n) || IMAGE_URL_NAMES.includes(n))
      ) {
        usesImages = true;
      }
      const replace = (to: string) =>
        edits.push({
          start: found.literal.getStart(source) + 1,
          end: found.literal.getEnd() - 1,
          text: to,
        });

      // 1. A vendored module: import the copy.
      const target = resolvePackageFile(root, specifier);
      const copy = target ? vendored.get(target) : undefined;
      if (copy) {
        replace(relativeSpecifier(file, copy));
        continue;
      }

      // 1b. v7's commerce types and helpers: the same file under @decocms/compat-v7/commerce.
      const commerce = compatCommerceSpecifier(specifier);
      if (commerce) {
        replace(commerce);
        const set = moved.get("@decocms/compat-v7/commerce/*") ?? new Set();
        set.add(specifier.replace(/^@decocms\/(apps-commerce|apps\/commerce)\//, ""));
        moved.set("@decocms/compat-v7/commerce/*", set);
        continue;
      }

      // 2. createInstrumentedFetch moved to @decocms/blocks/fetch, options-only.
      const decl = found.declaration;
      const bindings = decl?.importClause?.namedBindings;
      if (
        specifier === "@decocms/blocks/sdk/instrumentedFetch" &&
        decl &&
        !decl.importClause?.isTypeOnly &&
        !decl.importClause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        (bindings.elements[0].propertyName ?? bindings.elements[0].name).text ===
          "createInstrumentedFetch"
      ) {
        const calls = instrumentedFetchCalls(source, bindings.elements[0].name.text);
        if (calls) {
          replace("@decocms/blocks/fetch");
          for (const call of calls) {
            const arg = call.arguments[0];
            edits.push({
              start: arg.getStart(source),
              end: arg.getEnd(),
              text: `{ provider: ${arg.getText(source)} }`,
            });
          }
          continue;
        }
      }

      // 3. Names a v8 binding exports unchanged: point them at it, splitting the declaration.
      let names = found.names;
      const move = MOVES[specifier];
      if (
        move &&
        (!move.only || move.only === framework) &&
        decl &&
        !decl.importClause?.name &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        const byTarget = new Map<string, ts.ImportSpecifier[]>();
        const rest: ts.ImportSpecifier[] = [];
        for (const el of bindings.elements) {
          const to = move.names[(el.propertyName ?? el.name).text];
          const target = typeof to === "string" ? to : framework && to?.[framework];
          if (target) byTarget.set(target, [...(byTarget.get(target) ?? []), el]);
          else rest.push(el);
        }
        if (byTarget.size > 0) {
          const typeOnly = decl.importClause?.isTypeOnly ? "type " : "";
          const quote = found.literal.getText(source)[0];
          const line = (els: ts.ImportSpecifier[], from: string) =>
            `import ${typeOnly}{ ${els.map((el) => el.getText(source)).join(", ")} } from ${quote}${from}${quote};`;
          const lines = [...byTarget].map(([target, els]) => line(els, target));
          if (rest.length > 0) lines.push(line(rest, specifier));
          edits.push({ start: decl.getStart(source), end: decl.getEnd(), text: lines.join("\n") });
          for (const [target, els] of byTarget) {
            const set = moved.get(target) ?? new Set();
            for (const el of els) set.add((el.propertyName ?? el.name).text);
            moved.set(target, set);
          }
          names = rest.map((el) => (el.propertyName ?? el.name).text);
          if (names.length === 0) continue;
        }
      }

      // 4. The next major's documented API: nothing to do.
      const left = undocumented(specifier, names);
      if (left.length === 0) continue;

      // 5. Everything else: report, by hint.
      const where = `${rel}:${source.getLineAndCharacterOfPosition(found.literal.getStart(source)).line + 1}`;
      for (const [hint, group] of hintsFor(specifier, left)) {
        const key = `${specifier}\0${hint}`;
        const entry = reported.get(key) ?? { names: new Set(), files: new Set() };
        for (const n of group) entry.names.add(n);
        entry.files.add(where);
        reported.set(key, entry);
      }
    }

    if (edits.length > 0) {
      let out = text;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
      }
      fs.writeFileSync(file, out);
      rewrittenFiles++;
    }
  }

  if (rewrittenFiles > 0) {
    report.done.push({
      step: "imports",
      subject: "src/",
      message: `rewrote imports in ${rewrittenFiles} files`,
    });
  }
  for (const [target, names] of [...moved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    report.done.push({
      step: "imports",
      subject: target,
      message: target.startsWith("@decocms/compat-v7/commerce")
        ? `${[...names].join(", ")} from @decocms/apps-commerce are the same files under @decocms/compat-v7/commerce (v7's types and helpers, with v7's output)`
        : target.startsWith("@decocms/compat-v7")
          ? `${[...names].join(", ")} now come from @decocms/compat-v7 (v7's own helpers, with v7's output)`
          : `${[...names].join(", ")} now come from the v8 binding`,
    });
  }
  const contextDevice = [
    ...(moved.get("@decocms/compat-v7/tanstack") ?? []),
    ...(moved.get("@decocms/compat-v7/nextjs") ?? []),
  ];
  if (contextDevice.includes("useDevice") || contextDevice.includes("DeviceProvider")) {
    report.manual.push({
      step: "imports",
      subject: "useDevice",
      message: `v7 seeded it from its request scope, which v8 has none of: render the page under <DeviceProvider value={device}> from @decocms/compat-v7/${framework}, with device = ${framework === "tanstack" ? "requestDevice()" : "await requestDevice()"} from @decocms/compat-v7/${framework}/server returned with the page's data, so the server and the browser render the same device; without a provider the server renders "desktop"`,
    });
  }
  if (framework === "tanstack" && usesImages) {
    const plan = imageModule(version, images);
    writeImageUrl(
      root,
      report,
      plan,
      `they take their URLs from ImageUrlProvider (@decocms/tanstack/react) now, and @decocms/tanstack knows no commerce platform: without a provider every source goes through the Deco image CDN, where v7 resized VTEX catalog and Shopify images on their own hosts. The script couldn't write src/imageUrl.ts (${plan.reason}): write imageUrl = ${imageUrl}, and wrap every page in <ImageUrlProvider value={imageUrl}> through createDecoRouter's Wrap option, so every URL stays v7's`,
    );
  }
  for (const copy of images.copies) {
    const url = copyImageUrl(copy, images.registered);
    report.manual.push({
      step: "imports",
      subject: copy.file,
      message: url
        ? `a copy of v7's image helper (getOptimizedMediaUrl): on v8, imageUrl = ${url}. url(src, { width, height, fit }) and srcSet(url, src, …) from @decocms/blocks/image replace its getOptimizedMediaUrl and getSrcSet, and on TanStack Start its Image, Picture and Source are @decocms/tanstack/react's under <ImageUrlProvider value={imageUrl}>. One difference, approved: an already-resized Deco CDN URL in the content (https://assets.decocms.com/image?…&src=…) is re-resized from its src, where the copy wrote src=image`
        : "a copy of v7's image helper (getOptimizedMediaUrl) whose URL rules the script can't read (it was edited): compare its URLs with createImageUrl's before replacing it, and pick the decoCdn options that reproduce them (reference/framework-code.md)",
    });
  }
  if (stripsAnywhere) reportLeadingStrip(root, report, readCopy?.file);
  const resolved = [...reported].map(
    ([key, entry]) => [key.replaceAll(V7_IMAGE_URL, imageUrl), entry] as const,
  );
  for (const [key, { names, files }] of resolved.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [specifier, hint] = key.split("\0");
    const list = [...files];
    const where = `${list.slice(0, 3).join(", ")}${list.length > 3 ? `, +${list.length - 3} more` : ""}`;
    report.manual.push({
      step: "imports",
      subject: `${specifier} {${[...names].join(", ")}}`,
      message: `${hint}; in ${where}`,
    });
  }
}
