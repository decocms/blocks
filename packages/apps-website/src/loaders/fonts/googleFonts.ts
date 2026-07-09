import type { Font } from "../../types";

interface Props {
	fonts: GoogleFont[];
}

/**
 * @title {{weight}} {{#italic}}Italic{{/italic}}{{^italic}}{{/italic}}
 */
interface FontVariation {
	weight: "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900";
	italic?: boolean;
}

/** @titleBy family */
interface GoogleFont {
	family: string;
	variations: FontVariation[];
}

const getFontVariations = (variations: FontVariation[]) => {
	if (variations.length === 0) {
		return "";
	}

	let hasItalic = false;
	const sortedVariations = [...variations]
		.sort((a, b) => {
			a.italic ??= false;
			b.italic ??= false;

			if (a.italic !== b.italic) {
				hasItalic = true;
				if (a.italic) return 1;
				if (!a.italic) return -1;
			}

			return Number.parseInt(a.weight, 10) - Number.parseInt(b.weight, 10);
		})
		.filter(
			(item, index, self) =>
				index === self.findIndex((t) => t.weight === item.weight && t.italic === item.italic),
		);

	const variants: string[] = [];

	for (const { weight, italic } of sortedVariations) {
		if (!hasItalic) {
			variants.push(weight);
			continue;
		}
		variants.push(`${italic ? "1," : "0,"}${weight}`);
	}

	return `:${hasItalic ? "ital," : ""}wght@${variants.join(";")}`;
};

const NEW_BROWSER_KEY = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
};

const OLD_BROWSER_KEY = {
	"User-Agent": "deco-cx/1.0",
};

const loader = async (props: Props): Promise<Font> => {
	const { fonts = [] } = props;

	if (fonts.length === 0) {
		return { family: "", styleSheet: "" };
	}

	const url = new URL("https://fonts.googleapis.com/css2?display=swap");

	const reduced = fonts.reduce(
		(acc, font) => {
			const { family, variations } = font;
			acc[family] = acc[family] ?? { family, variations: [] };
			acc[family].variations = [...acc[family].variations, ...variations];
			return acc;
		},
		{} as Record<string, GoogleFont>,
	);

	for (const font of Object.values(reduced)) {
		url.searchParams.append("family", `${font.family}${getFontVariations(font.variations)}`);
	}

	const logFontError = (label: string, fontUrl: URL, e: unknown) => {
		const message = e instanceof Error ? e.message : String(e);
		const short = message.length > 300 ? `${message.slice(0, 300)}…` : message;
		console.error(`Error fetching font (${label}): ${fontUrl.toString()} - ${short}`);
	};

	const sheets = await Promise.all([
		fetch(url, { headers: OLD_BROWSER_KEY })
			.then((res) => res.text())
			.catch((e) => {
				logFontError("OLD_UA", url, e);
				return "";
			}),
		fetch(url, { headers: NEW_BROWSER_KEY })
			.then((res) => res.text())
			.catch((e) => {
				logFontError("NEW_UA", url, e);
				return "";
			}),
	]);

	const styleSheet = sheets.join("\n");

	return {
		family: Object.keys(reduced).join(", "),
		styleSheet,
	};
};

export default loader;
