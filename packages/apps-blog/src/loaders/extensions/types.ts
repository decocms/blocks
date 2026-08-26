/**
 * An enrichment step applied to a loader's already-resolved output.
 *
 * In `deco-cx/apps` this type comes from `website/loaders/extension.ts`, which
 * also ships the generic `extension` loader that composes a list of these over
 * one data source. That loader has not been ported into
 * `@decocms/apps-website`, so the type is declared here rather than imported —
 * the *composition* plumbing is a website-app concern and porting it into
 * apps-blog would put it in the wrong package (see this package's README for
 * the tracked gap).
 *
 * Each extension below is therefore usable directly: call it to obtain the
 * enrichment function, then apply that to the loader result.
 */
export type ExtensionOf<T> = (data: T) => Promise<T>;
