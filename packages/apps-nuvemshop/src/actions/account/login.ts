import { storeFetch } from "../../store";

export interface Props {
  email: string;
  password: string;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; error: "invalid_credentials" | "email_not_validated" | "unknown" };

/**
 * @title Nuvemshop - Login
 * @description Signs the buyer into the store session (the theme's login form, server-side).
 * Success is a redirect to /account/; on failure the login page carries the reason.
 */
export default async function login(props: Props): Promise<LoginResult> {
  if (!props?.email || !props?.password) return { ok: false, error: "invalid_credentials" };
  const res = await storeFetch("/account/login/", {
    method: "POST",
    form: { email: props.email, password: props.password },
  });
  if (res.location && new URL(res.location).pathname === "/account/") return { ok: true };

  const page = await (await storeFetch("/account/login/", { cookie: res.cookie })).text();
  if (page.includes("js-account-validation-pending"))
    return { ok: false, error: "email_not_validated" };
  if (page.includes("js-login-general-error")) return { ok: false, error: "invalid_credentials" };
  return { ok: false, error: "unknown" };
}
