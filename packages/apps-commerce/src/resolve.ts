/**
 * App composition utilities.
 *
 * Merges manifests and chains middleware from multiple AppDefinitions
 * into a single resolved structure.
 *
 * @example
 * ```ts
 * import { resolveApps } from "@decocms/apps/commerce/resolve";
 * import * as vtexApp from "@decocms/apps/vtex/mod";
 * import * as resendApp from "@decocms/apps/resend/mod";
 *
 * const apps = await Promise.all([
 *   vtexApp.configure(blocks.vtex, resolveSecret),
 *   resendApp.configure(blocks.resend, resolveSecret),
 * ]);
 *
 * const resolved = resolveApps(apps.filter(Boolean));
 * // resolved.manifest — merged manifest from all apps
 * // resolved.middleware — chained middleware (or undefined)
 * ```
 */

import type { AppDefinition, AppManifest, AppMiddleware } from "./app-types";

export interface ResolvedApps {
	manifest: AppManifest;
	middleware: AppMiddleware | undefined;
	resolvables: Record<string, { __resolveType: string; [key: string]: unknown }>;
}

/**
 * Resolve an array of app definitions into a single merged structure.
 *
 * - Manifests are merged (loaders/actions from all apps).
 * - Middleware is chained in array order (first app runs outermost).
 */
export function resolveApps(apps: AppDefinition[]): ResolvedApps {
	const mergedManifest: AppManifest = {
		name: "resolved",
		loaders: {},
		actions: {},
		sections: {},
	};

	const middlewares: AppMiddleware[] = [];
	const resolvables: Record<string, { __resolveType: string; [key: string]: unknown }> = {};

	for (const app of flattenDependencies(apps)) {
		Object.assign(mergedManifest.loaders, app.manifest.loaders);
		Object.assign(mergedManifest.actions, app.manifest.actions);

		if (app.manifest.sections) {
			Object.assign(mergedManifest.sections!, app.manifest.sections);
		}

		if (app.resolvables) {
			Object.assign(resolvables, app.resolvables);
		}

		if (app.middleware) {
			middlewares.push(app.middleware);
		}
	}

	return {
		manifest: mergedManifest,
		middleware: middlewares.length > 0 ? chainMiddleware(middlewares) : undefined,
		resolvables,
	};
}

/**
 * Flatten the dependency graph (depth-first, dependencies before dependents).
 * Deduplicates by app name.
 */
function flattenDependencies(apps: AppDefinition[]): AppDefinition[] {
	const seen = new Set<string>();
	const result: AppDefinition[] = [];

	function visit(app: AppDefinition) {
		if (seen.has(app.name)) return;
		seen.add(app.name);

		if (app.dependencies) {
			for (const dep of app.dependencies) {
				visit(dep);
			}
		}

		result.push(app);
	}

	for (const app of apps) {
		visit(app);
	}

	return result;
}

/**
 * Chain multiple middleware functions into a single one.
 * First middleware in the array runs outermost (wraps the rest).
 */
function chainMiddleware(middlewares: AppMiddleware[]): AppMiddleware {
	return async (request, next) => {
		const run = async (i: number): Promise<Response> => {
			if (i < 0) return next();
			return middlewares[i](request, () => run(i - 1));
		};

		return run(middlewares.length - 1);
	};
}
