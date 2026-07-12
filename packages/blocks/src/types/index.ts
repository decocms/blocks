/**
 * Types that match @deco/deco's type exports.
 * These allow storefront sites to use the same type interfaces
 * without depending on the Deno-specific @deco/deco package.
 */

/**
 * Compat context handed to ported deco.cx (Fresh) section loaders as the 3rd
 * argument (issue #305). `state` is the app state; `device`/`invoke`/`response`
 * mirror what Fresh's `ctx` exposed, and the index signature lets migrated
 * loaders read per-app state directly off `ctx` (`ctx.vtex`, `ctx.salesforce`).
 * Deep reads should still be optional-chained — an unconfigured app is
 * `undefined`. See `@decocms/blocks/cms`'s `SectionLoaderContext` for the
 * runtime shape.
 */
export interface FnContext<TState = any> {
  state: TState;
  device?: "mobile" | "tablet" | "desktop";
  invoke?: any;
  response?: { headers: Headers };
  getAppState?: <T>(appName: string) => T | undefined;
  [key: string]: any;
}

export type App<TManifest = any, TState = any, TDeps extends any[] = any[]> = {
  state: TState;
  manifest: TManifest;
  dependencies?: TDeps;
};

export type AppContext<TApp extends App = App> = FnContext<TApp["state"]>;

export type Section<TProps = any> = {
  Component: import("react").ComponentType<TProps>;
  props: TProps;
};

export type SectionProps<TLoader = any, TAction = TLoader> = TLoader extends (
  ...args: any[]
) => Promise<infer R>
  ? R
  : TLoader;

export type Resolved<T> = T;

export interface LoadingFallbackProps<TProps = any> {
  [key: string]: any;
}

export type Flag = {
  name: string;
  value: boolean;
};
