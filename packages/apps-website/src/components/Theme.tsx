import { cssSafe } from "@decocms/blocks/sdk/htmlSafe";
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

	// cssSafe on each token name/value so an attacker-influenceable design token
	// can't emit `</style>` and break out of the inline <style> below.
	const vars = [{ name: "--font-family", value: family }, ...variables]
		.map(({ name, value }) => `${cssSafe(name)}: ${cssSafe(value)}`)
		.join(";");

	const css = `* {${vars}}`;
	const html = colorScheme ? withPrefersColorScheme(colorScheme, css) : css;

	return (
		<>
			{fonts?.map(({ styleSheet }, idx) =>
				styleSheet ? (
					<style key={idx} type="text/css" dangerouslySetInnerHTML={{ __html: cssSafe(styleSheet) }} />
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
