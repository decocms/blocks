export { sendEmail } from "./actions/send";
export { configureResend, getResendConfig } from "./client";
export type {
	CreateEmailOptions,
	CreateEmailResponse,
	CreateEmailResponseSuccess,
	ErrorResponse,
	ResendConfig,
	ResendErrorCodeKey,
} from "./types";
