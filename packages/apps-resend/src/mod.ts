/**
 * Resend app module — standard autoconfig contract.
 *
 * Exports `configure` and `handlers` following the AppModContract pattern.
 * The framework's `autoconfigApps()` calls these generically — no hardcoded
 * app knowledge needed in the framework.
 */

import type { AppDefinition, AppHandler, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import { sendEmail } from "./actions/send";
import { configureResend } from "./client";
import manifest from "./manifest.gen";
import type { ResendConfig } from "./types";

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

export interface ResendState {
	config: ResendConfig;
}

// -------------------------------------------------------------------------
// Configure
// -------------------------------------------------------------------------

/**
 * Configure Resend from CMS block data.
 * Returns an AppDefinition or null if missing credentials.
 */
export async function configure(
	block: any,
	resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<ResendState> | null> {
	const apiKey = await resolveSecret(block.apiKey, "RESEND_API_KEY");
	if (!apiKey) return null;

	const config: ResendConfig = {
		apiKey,
		emailFrom: block.emailFrom
			? `${block.emailFrom.name || "Contact"} <${block.emailFrom.domain || "onboarding@resend.dev"}>`
			: undefined,
		emailTo: block.emailTo,
		subject: block.subject,
	};

	// Bridge: maintain global singleton for backward compat
	configureResend(config);

	return {
		name: "resend",
		manifest,
		state: { config },
	};
}

/**
 * Invoke handlers registered under /deco/invoke/{key}.
 * Both with and without .ts suffix for compatibility.
 */
export const handlers: Record<string, AppHandler> = {
	"resend/actions/emails/send": (props) => sendEmail(props),
	"resend/actions/emails/send.ts": (props) => sendEmail(props),
};

/** Placeholder preview for CMS editor — evolves when admin supports it. */
export const preview = undefined;
