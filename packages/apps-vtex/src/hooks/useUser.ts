/**
 * Client-side user/session hook for VTEX.
 *
 * Detects login state via the VTEX Sessions API (server-side accessible).
 * Does NOT attempt to read VtexIdclientAutCookie client-side — that cookie
 * is HttpOnly and inaccessible via document.cookie.
 *
 * @example
 * ```tsx
 * import { useUser } from "@decocms/apps/vtex/hooks/useUser";
 *
 * function UserGreeting() {
 *   const { user, isLoggedIn } = useUser();
 *   if (!isLoggedIn) return <a href="/account">Sign In</a>;
 *   return <span>Hello, {user?.email}</span>;
 * }
 * ```
 */

import { useQuery } from "@tanstack/react-query";

export interface VtexUser {
	email?: string;
	firstName?: string;
	lastName?: string;
	userId?: string;
	isLoggedIn: boolean;
}

const USER_QUERY_KEY = ["vtex", "user"] as const;

async function fetchUser(): Promise<VtexUser> {
	try {
		const res = await fetch(
			"/api/sessions?items=profile.email,profile.firstName,profile.lastName,profile.id",
			{ credentials: "include" },
		);
		if (!res.ok) return { isLoggedIn: false };

		const data = await res.json();
		const profile = data?.namespaces?.profile;

		const email = profile?.email?.value;
		if (!email) return { isLoggedIn: false };

		return {
			email,
			firstName: profile?.firstName?.value,
			lastName: profile?.lastName?.value,
			userId: profile?.id?.value,
			isLoggedIn: true,
		};
	} catch {
		return { isLoggedIn: false };
	}
}

export interface UseUserOptions {
	enabled?: boolean;
	staleTime?: number;
}

export function useUser(options?: UseUserOptions) {
	const query = useQuery({
		queryKey: USER_QUERY_KEY,
		queryFn: fetchUser,
		staleTime: options?.staleTime ?? 30_000,
		enabled: options?.enabled !== false,
	});

	return {
		user: query.data ?? null,
		isLoggedIn: query.data?.isLoggedIn ?? false,
		isLoading: query.isLoading,
		isError: query.isError,
		refetch: query.refetch,
	};
}
