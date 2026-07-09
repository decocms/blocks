/**
 * Website app singleton configuration.
 *
 * Uses globalThis to survive Vite module duplication (optimized deps
 * vs raw source imports can create separate module instances).
 */

import type { WebsiteConfig } from "./types";

const G = globalThis as unknown as { __decoWebsiteConfig?: WebsiteConfig };

export function configureWebsite(config: WebsiteConfig): void {
	G.__decoWebsiteConfig = config;
}

export function getWebsiteConfig(): WebsiteConfig {
	if (!G.__decoWebsiteConfig) {
		throw new Error("Website app not configured. Call configureWebsite() first.");
	}
	return G.__decoWebsiteConfig;
}
