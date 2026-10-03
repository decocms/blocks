/**
 * `@decocms/apps-resend`: the Resend client (`createResendClient`).
 * See /next/upstream-clients.
 *
 * `sendEmail`, `configureResend` and `getResendConfig` are the v7 surface,
 * kept for v7 sites.
 */
export { sendEmail } from "./actions/send";
export { configureResend, getResendConfig } from "./client";
export {
  createResendClient,
  type ResendClient,
  type ResendClientConfig,
  ResendError,
  type SendEmailOptions,
} from "./emails";
export type {
  CreateEmailOptions,
  CreateEmailResponse,
  CreateEmailResponseSuccess,
  ErrorResponse,
  ResendConfig,
  ResendErrorCodeKey,
} from "./types";
