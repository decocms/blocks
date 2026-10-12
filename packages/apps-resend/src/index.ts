/**
 * `@decocms/apps-resend`: the Resend client (`createResendClient`).
 * See /next/upstream-clients.
 */
export {
  createResendClient,
  type ResendClient,
  type ResendClientConfig,
  ResendError,
  type SendEmailOptions,
} from "./emails.ts";
export type { CreateEmailOptions, CreateEmailResponseSuccess } from "./types.ts";
