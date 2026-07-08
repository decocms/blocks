/**
 * VTEX Authentication Actions
 *
 * Ported from deco-cx/apps vtex/actions/authentication/*.ts
 * Cookie forwarding happens automatically via RequestContext.responseHeaders.
 * @see https://github.com/deco-cx/apps/tree/main/vtex/actions/authentication
 */

import { getVtexConfig, vtexFetchWithCookies } from "../client";
import { VTEX_AUTH_COOKIE } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthProvider {
	providerName: string;
	className: string;
	expectedContext: unknown[];
}

export interface StartAuthentication {
	authenticationToken: string | null;
	oauthProviders: AuthProvider[];
	showClassicAuthentication: boolean;
	showAccessKeyAuthentication: boolean;
	showPasskeyAuthentication: boolean;
	authCookie: string | null;
	isAuthenticated: boolean;
	selectedProvider: string | null;
	samlProviders: unknown[];
}

export interface AuthResponse {
	authStatus: string | "WrongCredentials" | "BlockedUser" | "Success";
	promptMFA: boolean;
	clientToken: string | null;
	authCookie: { Name: string; Value: string } | null;
	accountAuthCookie: { Name: string; Value: string } | null;
	expiresIn: number;
	userId: string | null;
	phoneNumber: string | null;
	scope: string | null;
}

export interface RefreshTokenResponse {
	status: string;
	userId: string;
	refreshAfter: string;
}

/**
 * Cookies to set after a successful login.
 * Caller (server function) should use these to set cookies on the response.
 */
export interface LoginCookies {
	authCookieName: string;
	authCookieValue: string;
	accountAuthCookieName?: string;
	accountAuthCookieValue?: string;
	expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORM_HEADERS = {
	"Content-Type": "application/x-www-form-urlencoded",
	Accept: "application/json",
};

/**
 * Extract login cookies from an AuthResponse.
 * Returns null if auth failed.
 */
export function extractLoginCookies(response: AuthResponse): LoginCookies | null {
	if (response.authStatus !== "Success" || !response.authCookie) {
		return null;
	}
	return {
		authCookieName: response.authCookie.Name,
		authCookieValue: response.authCookie.Value,
		accountAuthCookieName: response.accountAuthCookie?.Name,
		accountAuthCookieValue: response.accountAuthCookie?.Value,
		expiresInSeconds: response.expiresIn,
	};
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface StartAuthenticationProps {
	callbackUrl?: string;
	returnUrl?: string;
	locale?: string;
	appStart?: boolean;
}

export async function startAuthentication(
	props?: StartAuthenticationProps,
): Promise<StartAuthentication> {
	const config = getVtexConfig();
	const {
		callbackUrl = "/",
		returnUrl = "/",
		locale = config.locale ?? "pt-BR",
		appStart = true,
	} = props ?? {};

	const params = new URLSearchParams({
		locale,
		scope: config.account,
		appStart: String(appStart),
		callbackUrl,
		returnUrl,
	});

	return vtexFetchWithCookies<StartAuthentication>(
		`/api/vtexid/pub/authentication/start?${params}`,
	);
}

export interface ClassicSignInProps {
	email: string;
	password: string;
	authenticationToken?: string;
}

/**
 * Classic email + password sign-in.
 * Calls startAuthentication internally if no authenticationToken provided.
 * Set-Cookie headers from both calls are forwarded via RequestContext.responseHeaders.
 */
export async function classicSignIn(props: ClassicSignInProps): Promise<AuthResponse> {
	const { email, password } = props;
	let token = props.authenticationToken;
	if (!token) {
		const startResult = await startAuthentication();
		token = startResult.authenticationToken ?? undefined;
		if (!token) throw new Error("Failed to obtain authentication token from startAuthentication");
	}

	const body = new URLSearchParams({
		email,
		password,
		authenticationToken: token,
	});
	return vtexFetchWithCookies<AuthResponse>("/api/vtexid/pub/authentication/classic/validate", {
		method: "POST",
		body,
		headers: FORM_HEADERS,
	});
}

export interface AccessKeySignInProps {
	email: string;
	accessKey: string;
	authenticationToken: string;
}

/**
 * Passwordless sign-in via email access key.
 */
export async function accessKeySignIn(props: AccessKeySignInProps): Promise<AuthResponse> {
	const { email, accessKey, authenticationToken } = props;
	const body = new URLSearchParams({
		login: email,
		accessKey,
		authenticationToken,
	});

	return vtexFetchWithCookies<AuthResponse>("/api/vtexid/pub/authentication/accesskey/validate", {
		method: "POST",
		body,
		headers: FORM_HEADERS,
	});
}

/**
 * Logout — returns list of cookie names that must be cleared (Max-Age=0).
 */
export function logout(): { cookiesToClear: string[] } {
	const { account } = getVtexConfig();
	return {
		cookiesToClear: [
			VTEX_AUTH_COOKIE,
			`${VTEX_AUTH_COOKIE}_${account}`,
			"vid_rt",
			`vid_rt_${account}`,
		],
	};
}

export interface RefreshTokenProps {
	fingerprint?: string;
}

/**
 * Refreshes the VTEX auth token using existing session cookies.
 * Cookies are read automatically from RequestContext.
 */
export async function refreshToken(props?: RefreshTokenProps): Promise<RefreshTokenResponse> {
	return vtexFetchWithCookies<RefreshTokenResponse>("/api/vtexid/refreshtoken/webstore", {
		method: "POST",
		body: JSON.stringify({ fingerprint: props?.fingerprint }),
	});
}

export interface RecoveryPasswordProps {
	email: string;
	newPassword: string;
	accessKey: string;
	authenticationToken: string;
	locale?: string;
}

/**
 * Sets a new password using an email access key (password-recovery flow).
 */
export async function recoveryPassword(props: RecoveryPasswordProps): Promise<AuthResponse> {
	const { email, newPassword, accessKey, authenticationToken, locale } = props;
	const config = getVtexConfig();

	const params = new URLSearchParams({
		scope: config.account,
		locale: locale ?? config.locale ?? "pt-BR",
	});

	const body = new URLSearchParams({
		login: email,
		accessKey,
		newPassword,
		authenticationToken,
	});

	return vtexFetchWithCookies<AuthResponse>(
		`/api/vtexid/pub/authentication/classic/setpassword?${params}`,
		{ method: "POST", body, headers: FORM_HEADERS },
	);
}

export interface ResetPasswordProps {
	email: string;
	currentPassword: string;
	newPassword: string;
	authenticationToken?: string;
	locale?: string;
}

/**
 * Resets password for an already-authenticated user.
 * Calls startAuthentication internally if no authenticationToken provided.
 * Set-Cookie headers from both calls are forwarded via RequestContext.responseHeaders.
 */
export async function resetPassword(props: ResetPasswordProps): Promise<AuthResponse> {
	const { email, currentPassword, newPassword, locale } = props;
	const config = getVtexConfig();

	let token = props.authenticationToken;
	if (!token) {
		const startResult = await startAuthentication({ locale });
		token = startResult.authenticationToken ?? undefined;
		if (!token) throw new Error("Failed to obtain authentication token from startAuthentication");
	}

	const params = new URLSearchParams({
		scope: config.account,
		locale: locale ?? config.locale ?? "pt-BR",
	});

	const body = new URLSearchParams({
		login: email,
		currentPassword,
		newPassword,
		authenticationToken: token,
	});

	return vtexFetchWithCookies<AuthResponse>(
		`/api/vtexid/pub/authentication/classic/setpassword?${params}`,
		{ method: "POST", body, headers: FORM_HEADERS },
	);
}

export interface SendEmailVerificationProps {
	email: string;
	authenticationToken?: string;
	locale?: string;
	parentAppId?: string;
}

/**
 * Sends an access-key verification email.
 * Calls startAuthentication internally if no authenticationToken provided.
 * Returns { success, authenticationToken }.
 */
export async function sendEmailVerification(props: SendEmailVerificationProps): Promise<{
	success: boolean;
	authenticationToken: string | null;
}> {
	const { email, locale, parentAppId } = props;
	try {
		let token = props.authenticationToken;

		if (!token) {
			const startResult = await startAuthentication({ locale });
			token = startResult.authenticationToken ?? undefined;
			if (!token) throw new Error("Failed to obtain authentication token");
		}

		const body = new URLSearchParams({ authenticationToken: token, email });
		if (locale) body.append("locale", locale);
		if (parentAppId) body.append("parentAppId", parentAppId);

		const result = await vtexFetchWithCookies<Record<string, string>>(
			"/api/vtexid/pub/authentication/accesskey/send?deliveryMethod=email",
			{ method: "POST", body, headers: FORM_HEADERS },
		);

		if (result?.authStatus === "InvalidToken") {
			throw new Error("Authentication token is invalid");
		}

		return {
			success: true,
			authenticationToken: token,
		};
	} catch (error) {
		console.error("[sendEmailVerification]", error);
		return { success: false, authenticationToken: null };
	}
}
