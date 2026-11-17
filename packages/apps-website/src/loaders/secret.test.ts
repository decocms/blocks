import { afterEach, beforeAll, describe, expect, it } from "vitest";
import SecretLoader from "./secret";

const originalNodeEnv = process.env.NODE_ENV;

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same format the admin writes: DECO_CRYPTO_KEY = base64(JSON { key, iv }),
// secrets stored as hex AES-CBC ciphertext.
const rawKey = crypto.getRandomValues(new Uint8Array(32));
const iv = crypto.getRandomValues(new Uint8Array(16));

async function encrypt(value: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", rawKey, "AES-CBC", false, ["encrypt"]);
	const out = await crypto.subtle.encrypt(
		{ name: "AES-CBC", iv },
		key,
		new TextEncoder().encode(value),
	);
	return bytesToHex(new Uint8Array(out));
}

beforeAll(() => {
	process.env.DECO_CRYPTO_KEY = btoa(
		JSON.stringify({ key: Array.from(rawKey), iv: Array.from(iv) }),
	);
});

afterEach(() => {
	process.env.NODE_ENV = originalNodeEnv;
	delete process.env.MY_SECRET;
	delete process.env.EMPTY_SECRET;
});

describe("SecretLoader", () => {
	it("reads from process.env when name is set in development", async () => {
		process.env.NODE_ENV = "development";
		process.env.MY_SECRET = "super-secret";
		const result = await SecretLoader({ encrypted: "xxx", name: "MY_SECRET" });
		expect(result.get()).toBe("super-secret");
	});

	it("reads empty-string env var correctly in development", async () => {
		process.env.NODE_ENV = "development";
		process.env.EMPTY_SECRET = "";
		const result = await SecretLoader({ encrypted: "fallback", name: "EMPTY_SECRET" });
		expect(result.get()).toBe("");
	});

	it("returns null when encrypted is empty", async () => {
		const result = await SecretLoader({ encrypted: "", name: "NONEXISTENT" });
		expect(result.get()).toBeNull();
	});

	it("decrypts the block value with DECO_CRYPTO_KEY outside development", async () => {
		process.env.NODE_ENV = "production";
		const encrypted = await encrypt("decrypted-value");
		const result = await SecretLoader({ encrypted, name: "MY_SECRET" });
		expect(result.get()).toBe("decrypted-value");
	});

	it("does not read process.env outside development", async () => {
		process.env.NODE_ENV = "production";
		process.env.MY_SECRET = "from-env";
		const encrypted = await encrypt("from-block");
		const result = await SecretLoader({ encrypted, name: "MY_SECRET" });
		expect(result.get()).toBe("from-block");
	});

	it("does not leak an env var named by caller-supplied props outside development", async () => {
		process.env.NODE_ENV = "production";
		process.env.MY_SECRET = "from-env";
		const result = await SecretLoader({ encrypted: "FALLBACK", name: "MY_SECRET" });
		expect(result.get()).not.toBe("from-env");
	});

	it("returns the stored value when it is not ciphertext for this key", async () => {
		process.env.NODE_ENV = "test";
		const result = await SecretLoader({ encrypted: "plain-value", name: "NONEXISTENT" });
		expect(result.get()).toBe("plain-value");
	});
});
