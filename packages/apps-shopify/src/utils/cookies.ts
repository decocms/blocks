/**
 * Node.js-compatible cookie helpers.
 * Replaces Deno's std/http/cookie.ts.
 */

export function getCookies(headers: Headers): Record<string, string> {
	const cookieHeader = headers.get("cookie") || "";
	const cookies: Record<string, string> = {};
	for (const pair of cookieHeader.split(";")) {
		const [key, ...rest] = pair.trim().split("=");
		if (key) {
			cookies[key.trim()] = decodeURIComponent(rest.join("=").trim());
		}
	}
	return cookies;
}

export function setCookie(
	headers: Headers,
	options: {
		name: string;
		value: string;
		path?: string;
		expires?: Date;
		maxAge?: number;
		httpOnly?: boolean;
		secure?: boolean;
		sameSite?: "Strict" | "Lax" | "None";
	},
) {
	const parts = [`${options.name}=${encodeURIComponent(options.value)}`];
	if (options.path) parts.push(`Path=${options.path}`);
	if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
	if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
	if (options.httpOnly) parts.push("HttpOnly");
	if (options.secure) parts.push("Secure");
	if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

	headers.append("Set-Cookie", parts.join("; "));
}

export interface Cookie {
	name: string;
	value: string;
	path?: string;
	expires?: Date;
	maxAge?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

export function getSetCookies(headers: Headers): Cookie[] {
	const cookies: Cookie[] = [];
	const setCookieHeaders = headers.getSetCookie?.() ?? [];
	for (const header of setCookieHeaders) {
		const parts = header.split(";").map((p) => p.trim());
		const [nameValue, ...attrs] = parts;
		const [name, ...rest] = nameValue.split("=");
		const value = rest.join("=");
		const cookie: Cookie = { name: name.trim(), value };
		for (const attr of attrs) {
			const [k, v] = attr.split("=");
			const key = k.trim().toLowerCase();
			if (key === "path") cookie.path = v?.trim();
			if (key === "httponly") cookie.httpOnly = true;
			if (key === "secure") cookie.secure = true;
			if (key === "samesite") cookie.sameSite = v?.trim() as any;
			if (key === "max-age") cookie.maxAge = Number(v?.trim());
		}
		cookies.push(cookie);
	}
	return cookies;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
	let timer: ReturnType<typeof setTimeout>;
	return ((...args: any[]) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delay);
	}) as T;
}
