import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { nuvemshopAdmin } from "../../admin";
import { getNuvemshopConfig, nuvemshopFetch } from "../../client";

export interface Props {
  name: string;
  email: string;
  password: string;
  phone?: string;
  /** Cloudflare Turnstile token from the registration form. */
  captchaToken?: string;
}

export type RegisterResult =
  | { ok: true; customerId: number; emailValidationRequired: true }
  | {
      ok: false;
      error:
        | "invalid_input"
        | "email_taken"
        | "captcha_failed"
        | "captcha_not_configured"
        | "unknown";
    };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function verifyTurnstile(secret: string, token: string | undefined) {
  if (!token) return false;
  const remoteip = RequestContext.current?.request.headers.get("cf-connecting-ip") ?? "";
  const res = await nuvemshopFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret,
      response: token,
      ...(remoteip && { remoteip }),
    }).toString(),
  });
  return ((await res.json().catch(() => null)) as { success?: boolean } | null)?.success === true;
}

/**
 * @title Nuvemshop - Register
 * @description Creates a customer through the Admin API. The store's own form needs a reCAPTCHA
 * bound to its domain; the Admin API has none, so this action requires Cloudflare Turnstile
 * (`turnstileSecret`) unless `allowUnverifiedRegistration` is set. The store still emails a
 * validation link before the first login.
 */
export default async function register(props: Props): Promise<RegisterResult> {
  const { turnstileSecret, allowUnverifiedRegistration } = getNuvemshopConfig();
  const name = props?.name?.trim();
  const email = props?.email?.trim();
  if (!name || !email || !EMAIL.test(email) || !props.password || props.password.length < 6) {
    return { ok: false, error: "invalid_input" };
  }
  if (!allowUnverifiedRegistration) {
    if (!turnstileSecret) return { ok: false, error: "captcha_not_configured" };
    if (!(await verifyTurnstile(turnstileSecret, props.captchaToken))) {
      return { ok: false, error: "captcha_failed" };
    }
  }
  const res = await nuvemshopAdmin("/customers", {
    method: "POST",
    body: {
      name,
      email,
      password: props.password,
      ...(props.phone && { phone: props.phone }),
      send_email_invite: false,
    },
  });
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { email?: string[] };
    return {
      ok: false,
      error: body.email?.some((m) => /unique/i.test(m)) ? "email_taken" : "invalid_input",
    };
  }
  if (!res.ok) return { ok: false, error: "unknown" };
  const customer = (await res.json()) as { id: number };
  return { ok: true, customerId: customer.id, emailValidationRequired: true };
}
