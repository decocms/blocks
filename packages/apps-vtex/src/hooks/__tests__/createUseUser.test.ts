/**
 * Tests for the `createUseUser` factory.
 *
 * Same approach as `createUseCart.test.ts`: apps-start does not pull
 * @testing-library/react, so we test factory shape and isolation. Hook
 * semantics are covered by site-level smoke tests.
 */

import { describe, expect, it } from "vitest";
import { type CreateUseUserInvoke, createUseUser } from "../createUseUser";

function makeInvoke(): CreateUseUserInvoke {
	return {
		vtex: {
			loaders: {
				user: async () => null,
			},
		},
	};
}

describe("createUseUser — factory shape", () => {
	it("returns useUser, resetUser", () => {
		const u = createUseUser({ invoke: makeInvoke() });
		expect(typeof u.useUser).toBe("function");
		expect(typeof u.resetUser).toBe("function");
	});

	it("two factory calls produce independent function references", () => {
		const a = createUseUser({ invoke: makeInvoke() });
		const b = createUseUser({ invoke: makeInvoke() });
		expect(a.useUser).not.toBe(b.useUser);
		expect(a.resetUser).not.toBe(b.resetUser);
	});

	it("does not throw at construction time even with a failing invoke", () => {
		const invoke: CreateUseUserInvoke = {
			vtex: {
				loaders: {
					user: async () => {
						throw new Error("boom");
					},
				},
			},
		};
		expect(() => createUseUser({ invoke })).not.toThrow();
	});
});
