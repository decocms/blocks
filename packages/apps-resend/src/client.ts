import type { ResendConfig } from "./types";

let _config: ResendConfig | null = null;

/**
 * Configure the Resend client. Call once in your site's setup.ts.
 *
 * ```ts
 * import { configureResend } from "@decocms/apps/resend/client";
 *
 * configureResend({
 *   apiKey: process.env.RESEND_API_KEY!,
 *   emailFrom: "Contact <hello@example.com>",
 *   emailTo: ["team@example.com"],
 *   subject: "Contact form submission",
 * });
 * ```
 *
 * TODO(secrets-decrypt): Add an `initResendFromBlocks(blocks, blockKey?)`
 * helper that mirrors magento/algolia/vtex. The Deco CMS Resend block
 * stores `apiKey` as an encrypted Secret reference (`{ encrypted, name }`)
 * — sites currently have to call `configureResend()` with a manually
 * resolved env var, missing the AES-CBC decrypt path via
 * `@decocms/start/sdk/crypto#resolveSecret`. Until that ships, sites
 * keep passing a string they obtain from `process.env` or a custom
 * resolver.
 */
export function configureResend(config: ResendConfig) {
	_config = config;
}

export function getResendConfig(): ResendConfig {
	if (!_config) {
		throw new Error(
			"Resend not configured. Call configureResend() in setup.ts before using Resend actions.",
		);
	}
	return _config;
}
