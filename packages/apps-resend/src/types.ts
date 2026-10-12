// The Resend API shapes the client sends and receives (https://resend.com/docs/api-reference/emails/send-email).

export interface CreateEmailResponseSuccess {
  /** The ID of the newly created email. */
  id: string;
}

export interface CreateEmailOptions {
  from?: string;
  to: string | string[];
  subject: string;
  bcc?: string | string[];
  cc?: string | string[];
  reply_to?: string | string[];
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}
