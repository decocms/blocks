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
 * In local dev, reads from process.env using the `name` field.
 * In production, the framework's ResolveSecretFn handles decryption
 * before the value reaches this loader.
 */
const getSecret = (props: Props): string | null => {
	const name = props?.name;
	if (name && process.env[name] !== undefined) {
		return process.env[name]!;
	}
	const encrypted = props?.encrypted;
	if (!encrypted) {
		return null;
	}
	// In production, the encrypted value should already be resolved
	// by the framework's ResolveSecretFn before reaching this loader.
	// If we get here with an encrypted value in dev, warn.
	if (process.env.NODE_ENV !== "production") {
		console.warn(
			`Secret "${name ?? "anonymous"}" has encrypted value but no env var set. Set ${name} in .env.`,
		);
	}
	return encrypted;
};

/**
 * @title Secret
 */
export default function SecretLoader(props: Props): Secret {
	const secretValue = getSecret(props);
	return {
		get: (): string | null => {
			return secretValue;
		},
	};
}
