import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { beforeEach, describe, expect, it } from "vitest";

import { configureVtex, storefrontBaseUrl } from "../../client";

const ACCOUNT = { account: "examplestore" } as const;

describe("storefrontBaseUrl", () => {
	beforeEach(() => {
		configureVtex({ ...ACCOUNT });
	});

	it("uses the origin of the request being served", () => {
		configureVtex({ ...ACCOUNT, publicUrl: "https://secure.example.com/" });

		const origin = RequestContext.run(new Request("https://www.example.com/camisas?page=2"), () =>
			storefrontBaseUrl(),
		);

		expect(origin).toBe("https://www.example.com");
	});

	it("never returns the double-scheme origin a full publicUrl used to produce", () => {
		// `https://${publicUrl}` on "https://secure.example.com/" parsed with
		// host "https", so every product URL came out as https://https/<slug>/p.
		configureVtex({ ...ACCOUNT, publicUrl: "https://secure.example.com/" });

		const origin = storefrontBaseUrl();

		expect(origin).toBe("https://secure.example.com");
		expect(new URL("/camisa-paris/p", origin).href).toBe("https://secure.example.com/camisa-paris/p");
	});

	it("accepts a publicUrl stored without a scheme", () => {
		configureVtex({ ...ACCOUNT, publicUrl: "secure.example.com" });

		expect(storefrontBaseUrl()).toBe("https://secure.example.com");
	});

	it("falls back to the account host when publicUrl is absent", () => {
		expect(storefrontBaseUrl()).toBe("https://examplestore.vtexcommercestable.com.br");
	});

	it("honours a configured domain in the account-host fallback", () => {
		configureVtex({ ...ACCOUNT, domain: "com" });

		expect(storefrontBaseUrl()).toBe("https://examplestore.vtexcommercestable.com");
	});

	it("falls back to the account host rather than publish an unparseable publicUrl", () => {
		configureVtex({ ...ACCOUNT, publicUrl: "://" });

		expect(storefrontBaseUrl()).toBe("https://examplestore.vtexcommercestable.com.br");
	});

	it("returns an origin with no trailing slash", () => {
		configureVtex({ ...ACCOUNT, publicUrl: "https://secure.example.com/" });

		expect(storefrontBaseUrl()).not.toMatch(/\/$/);
	});
});
