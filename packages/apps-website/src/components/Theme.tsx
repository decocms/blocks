import { useId } from "react";
import type { Font, Variable } from "../types";

export interface Props {
	variables?: Variable[];
	fonts?: Font[];
	colorScheme?: "light" | "dark";
}

const withPrefersColorScheme = (scheme: "light" | "dark", css: string) =>
	`@media (prefers-color-scheme: ${scheme}) { ${css} }`;

/**
 * Theme component — injects CSS custom properties and font stylesheets.
 * React 19 / TanStack Start automatically hoists <style> into <head>.
 */
function Theme({ fonts = [], variables = [], colorScheme }: Props) {
	const id = useId();

	const family = fonts.reduce((acc, { family }) => (acc ? `${acc}, ${family}` : family), "");

	const vars = [{ name: "--font-family", value: family }, ...variables]
		.map(({ name, value }) => `${name}: ${value}`)
		.join(";");

	const css = `* {${vars}}`;
	const html = colorScheme ? withPrefersColorScheme(colorScheme, css) : css;

	return (
		<>
			{fonts?.map(({ styleSheet }, idx) =>
				styleSheet ? (
					<style key={idx} type="text/css" dangerouslySetInnerHTML={{ __html: styleSheet }} />
				) : null,
			)}
			{html && (
				<style
					type="text/css"
					id={`__DESIGN_SYSTEM_VARS-${id}`}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			)}
		</>
	);
}

export default Theme;
