/**
 * The Resend client: a thin client for the Resend REST API.
 * See /next/upstream-clients.
 *
 * Every request goes through `createInstrumentedFetch` (provider `resend`).
 * No retries or circuit breaker: sending an email isn't safe to repeat.
 * Default senders, recipients and subjects belong to the site.
 */
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import type { CreateEmailOptions, CreateEmailResponseSuccess } from "./types";

export interface ResendClientConfig {
  apiKey: string;
}

/** A Resend email; the API requires a sender. */
export type SendEmailOptions = CreateEmailOptions & { from: string };

export class ResendError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`resend ${operation} failed with HTTP ${status}`);
  }
}

export function createResendClient(
  config: ResendClientConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
) {
  const request = createInstrumentedFetch({ provider: "resend", fetch: options.fetch });

  return {
    /** Sends one email and returns its id. */
    async sendEmail(email: SendEmailOptions): Promise<CreateEmailResponseSuccess> {
      const response = await request("https://api.resend.com/emails", {
        operation: "sendEmail",
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(email),
      });
      if (!response.ok) throw new ResendError("sendEmail", response.status);
      return (await response.json()) as CreateEmailResponseSuccess;
    },
  };
}

export type ResendClient = ReturnType<typeof createResendClient>;
