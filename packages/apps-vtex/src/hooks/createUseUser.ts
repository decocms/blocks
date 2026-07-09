/**
 * Factory for the legacy invoke-based `useUser` hook.
 *
 * This is the API shape that migrated Fresh sites depend on:
 *   - module-level singleton state (no QueryClient required)
 *   - listener-based re-render (`forceRender` on a useState counter)
 *   - signal-shaped accessors (`user.value`, `loading.value`)
 *   - awaitable refresh (`await refresh()`)
 *
 * It is intentionally separate from the canonical `useUser` in
 * `vtex/hooks/useUser.ts`, which is built on TanStack Query and exposes
 * `{ user, isLoggedIn, isLoading, refetch }`. Both can coexist in a single site.
 *
 * @example
 * ```ts
 * // src/hooks/useUser.ts
 * import { createUseUser } from "@decocms/apps/vtex/hooks/createUseUser";
 * import { invoke } from "~/server/invoke";
 *
 * export const { useUser, resetUser } = createUseUser({ invoke });
 * export type { Person } from "@decocms/apps/vtex/loaders/user";
 * ```
 */

import { useEffect, useState } from "react";
import type { Person } from "../loaders/user";

/** Minimal structural shape of the invoke proxy this hook needs. */
export interface CreateUseUserInvoke {
	vtex: {
		loaders: {
			user: () => Promise<Person | null>;
		};
	};
}

export interface CreateUseUserOptions {
	invoke: CreateUseUserInvoke;
}

/** Build a per-site `useUser` plus its companions. */
export function createUseUser(opts: CreateUseUserOptions) {
	const { invoke } = opts;

	let _user: Person | null = null;
	let _loading = false;
	let _initStarted = false;
	let _initFailed = false;
	const _listeners = new Set<() => void>();

	function notify() {
		for (const fn of _listeners) fn();
	}
	function setUser(u: Person | null) {
		_user = u;
		notify();
	}
	function setLoading(v: boolean) {
		_loading = v;
		notify();
	}

	async function refresh(): Promise<Person | null> {
		setLoading(true);
		try {
			const u = await invoke.vtex.loaders.user();
			setUser(u);
			_initFailed = false;
			return u;
		} catch (err) {
			console.error("[useUser] refresh failed:", err);
			_initFailed = true;
			notify();
			return null;
		} finally {
			setLoading(false);
		}
	}

	/** Reset module-level user state so the next useUser() re-fetches. */
	function resetUser() {
		_user = null;
		_loading = false;
		_initStarted = false;
		_initFailed = false;
		notify();
	}

	function useUser() {
		const [, forceRender] = useState(0);

		useEffect(() => {
			const listener = () => forceRender((n) => n + 1);
			_listeners.add(listener);

			if (!_user && !_initStarted) {
				_initStarted = true;
				setLoading(true);
				invoke.vtex.loaders
					.user()
					.then((u) => {
						setUser(u);
					})
					.catch((err: unknown) => {
						console.error("[useUser] init failed:", err);
						_initFailed = true;
						notify();
					})
					.finally(() => setLoading(false));
			}

			return () => {
				_listeners.delete(listener);
			};
		}, []);

		return {
			user: {
				get value() {
					return _user;
				},
				set value(v: Person | null) {
					setUser(v);
				},
			},

			loading: {
				get value() {
					return _loading;
				},
			},

			isLoggedIn: {
				get value() {
					return !!_user?.email;
				},
			},

			initFailed: {
				get value() {
					return _initFailed;
				},
			},

			refresh,
		};
	}

	return {
		useUser,
		resetUser,
	};
}
