/**
 * Ambient shims for the Eitri runtime libraries.
 *
 * Eitri apps import UI primitives from `eitri-luminus` and the native SDK from
 * `eitri-bifrost`/`eitri-commons`, but those packages are resolved by the
 * external `eitri-cli` toolchain, not installed in the app's node_modules. When
 * generating a `.deco` we only need the section `Props` interfaces (which use
 * plain primitives), so these shims exist purely to keep an author's editor and
 * `tsc` from erroring on the imports — they are intentionally loose (`any`).
 *
 * `deco-eitri init` copies this file into your app's `src/` (as
 * `eitri-env.d.ts`) so it is picked up by `include: ["src"]` with no path
 * gymnastics. If you install the real `eitri-luminus` types, delete the copy.
 */
declare module "eitri-luminus" {
  // Every luminus component (View, Text, Image, Page, Button, ...) is exposed
  // as a permissive component type. Named + default imports both resolve.
  const luminus: Record<string, any>;
  export = luminus;
}

declare module "eitri-bifrost" {
  const Eitri: any;
  export default Eitri;
  export = Eitri;
}

declare module "eitri-commons" {
  const commons: any;
  export = commons;
}
