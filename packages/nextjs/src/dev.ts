/**
 * `createCMS({ dev })` for a Next.js app (audit item 16): `@decocms/blocks`
 * reads no environment variable, so a site that leaves `dev` out lets
 * `next dev` swap in the hosted release over the local content files.
 *
 * ```ts
 * createCMS({ blocks, content, dev: isNextDev(process.env.NODE_ENV) })
 * ```
 *
 * The site passes the value: Next.js inlines `process.env.NODE_ENV` in every
 * bundle (server, proxy and client), and the package reads no environment.
 */
export function isNextDev(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}
