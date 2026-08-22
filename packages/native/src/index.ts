/**
 * `@decocms/native` — Deco binding for React Native / Expo.
 *
 * A site on `@decocms/tanstack` already serves its CMS pages as JSON through
 * `?renderJson`. This package is the device-side half: fetch that envelope,
 * map each section's `__resolveType` to a native component, render.
 *
 * It is deliberately NOT a second copy of the framework — no resolver, no
 * decofile, no worker entry. Those live on the server and stay there.
 *
 * ```tsx
 * const client = createRenderJsonClient({ baseUrl: "https://loja.example.com" });
 * createNativeSetup({ sections: { "site/sections/Images/Banner.tsx": Banner } });
 *
 * function HomeScreen() {
 *   const { data } = useQuery(cmsScreenConfig({ client, path: "/" }));
 *   return (
 *     <ScrollView>
 *       <DecoSections sections={data?.sections ?? []} />
 *     </ScrollView>
 *   );
 * }
 * ```
 */

export type { CmsScreenConfig, CmsScreenOptions } from "./cmsScreenConfig";
export { cmsScreenConfig, deferredSectionConfig } from "./cmsScreenConfig";
export type { CookieJar, CookieJarOptions, CookieStorage } from "./cookies";
export { createCookieJar, readSetCookies, splitSetCookie, withCookieJar } from "./cookies";
export type {
  DecoSectionsProps,
  NativeRegistry,
  ResolvedDeferred,
} from "./DecoSections";
export { DecoSections } from "./DecoSections";
export type { NativeInvokeOptions } from "./invoke";
export { createNativeInvoke } from "./invoke";
export type {
  RenderJsonClient,
  RenderJsonClientOptions,
  RenderJsonPage,
  SerializedSection,
} from "./renderJson";
export { createRenderJsonClient, isDeferred, RenderJsonError } from "./renderJson";
export type { CmsRoute, RouteMatch, RoutePolicy, RoutePolicyOptions, RouteTarget } from "./routes";
export { createRoutePolicy, matchCmsRoute } from "./routes";
export type { NativeSetupOptions } from "./setup";
export { createNativeSetup } from "./setup";
