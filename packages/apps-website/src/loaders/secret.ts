/**
 * @title Secret
 * @hideOption true
 */
export interface Secret {
	/** @ignore */
	get: () => string | null;
}

export interface Props {
	/**
	 * @title Secret Value
	 * @format secret
	 */
	encrypted: string;
	/**
	 * @title Secret Name
	 * @description Used in dev mode as a environment variable (should not contain spaces or special characters)
	 * @pattern ^[a-zA-Z_][a-zA-Z0-9_]*$
	 */
	name?: string;
}

/**
 * Resolve a secret value.
 *
 * - Local development: reads `process.env[name]` when set, so `.env` works.
 * - Everywhere else: AES-CBC decrypts `encrypted` with the site's
 *   `DECO_CRYPTO_KEY` (same as the legacy deco-cx/apps loader).
 *
 * Outside development the env var named by `name` is never read. Props can
 * come from the client (`/deco/render`, `/deco/invoke`), so reading it would
 * let any caller pick an env var and get its value.
 */
const isDevelopment = () => process.env.NODE_ENV === "development";

const getSecret = async (props: Props): Promise<string | null> => {
	const name = props?.name;
	if (isDevelopment() && name && process.env[name] !== undefined) {
		return process.env[name]!;
	}
	const encrypted = props?.encrypted;
	if (!encrypted) {
		return null;
	}
	const { decryptSecret } = await import("@decocms/blocks/sdk/crypto");
	const decrypted = await decryptSecret(encrypted);
	if (decrypted !== null) {
		return decrypted;
	}
	// No DECO_CRYPTO_KEY, or the value is not ciphertext for this key. Keep the
	// previous behavior and hand back the stored value as-is.
	if (process.env.NODE_ENV !== "production") {
		console.warn(
			`Secret "${name ?? "anonymous"}" could not be decrypted. Set ${name} in .env or DECO_CRYPTO_KEY.`,
		);
	}
	return encrypted;
};

/**
 * @title Secret
 */
export default async function SecretLoader(props: Props): Promise<Secret> {
	const secretValue = await getSecret(props);
	return {
		get: (): string | null => {
			return secretValue;
		},
	};
}
