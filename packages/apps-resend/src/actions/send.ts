import { getResendConfig } from "../client";
import type { CreateEmailOptions, CreateEmailResponse } from "../types";

/**
 * Send an email via Resend API.
 *
 * ```ts
 * import { sendEmail } from "@decocms/apps/resend/actions/send";
 *
 * const result = await sendEmail({
 *   subject: "Hello",
 *   html: "<p>World</p>",
 * });
 * ```
 *
 * Fields not provided fall back to the defaults set in `configureResend()`.
 */
export async function sendEmail(
	payload: Partial<CreateEmailOptions> & { subject?: string; html?: string },
): Promise<CreateEmailResponse> {
	const config = getResendConfig();

	const body: CreateEmailOptions = {
		from: payload.from ?? config.emailFrom ?? "Contact <onboarding@resend.dev>",
		to: payload.to ?? config.emailTo ?? [],
		subject: payload.subject ?? config.subject ?? "No subject",
		...(payload.bcc && { bcc: payload.bcc }),
		...(payload.cc && { cc: payload.cc }),
		...(payload.reply_to && { reply_to: payload.reply_to }),
		...(payload.html && { html: payload.html }),
		...(payload.text && { text: payload.text }),
		...(payload.headers && { headers: payload.headers }),
	};

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (!response.ok) {
		return {
			data: null,
			error: data,
		};
	}

	return {
		data,
		error: null,
	};
}
