/**
 * @title Environment
 * @hideOption true
 */
export interface Environment {
	/** @ignore */
	get: () => string | null;
}

export interface Props {
	/**
	 * @title Environment Value
	 */
	value: string;
	/**
	 * @title Environment Name
	 * @description Used in dev mode as a environment variable (should not contain spaces or special characters)
	 * @pattern ^[a-zA-Z_][a-zA-Z0-9_]*$
	 */
	name?: string;
}

const getEnvironment = (props: Props): string | null => {
	const name = props?.name;
	if (name && process.env[name] !== undefined) {
		return process.env[name]!;
	}
	const value = props?.value;
	if (!value) {
		return null;
	}
	return value;
};

/**
 * @title Environment
 */
export default function EnvironmentLoader(props: Props): Environment {
	const environmentValue = getEnvironment(props);
	return {
		get: (): string | null => {
			return environmentValue;
		},
	};
}
