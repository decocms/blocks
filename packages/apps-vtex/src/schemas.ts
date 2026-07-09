/**
 * Registers the real props schemas for VTEX loaders/actions into the CMS
 * schema registry, so `GET /deco/meta` publishes full props forms (enums,
 * titles, required) instead of the `__resolveType`-only stubs that
 * registerCommerceLoaders() auto-registers.
 *
 * The schemas come from `schemas.gen.ts`, generated at build time by
 * @decocms/blocks-cli's generate-app-schemas.ts (`bun run generate:schemas`)
 * — Props are TypeScript types, erased at runtime, so extraction cannot
 * happen in the site.
 *
 * Called from every server entrypoint a site can wire VTEX through
 * (createVtexCommerceLoaders, mod.configure). Idempotent; real schemas also
 * take precedence over stubs inside the registry, so call order relative to
 * registerCommerceLoaders() doesn't matter.
 */
import { registerAppSchemas } from "@decocms/blocks/cms/client";
import { actionSchemas, loaderSchemas } from "./schemas.gen";

let registered = false;

export function registerVtexSchemas(): void {
	if (registered) return;
	registered = true;
	registerAppSchemas({
		namespace: "vtex",
		loaders: loaderSchemas,
		actions: actionSchemas,
	});
}
