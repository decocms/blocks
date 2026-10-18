const formatters = new Map<string, Intl.NumberFormat>();

const formatter = (currency: string, locale: string) => {
	const key = `${currency}::${locale}`;

	if (!formatters.has(key)) {
		formatters.set(
			key,
			new Intl.NumberFormat(locale, {
				style: "currency",
				currency,
			}),
		);
	}

	return formatters.get(key)!;
};

export const formatPrice = (
	price: number | undefined | null,
	currency = "BRL",
	locale = "pt-BR",
) => (price != null && Number.isFinite(price) ? formatter(currency, locale).format(price) : null);

/**
 * Formats a "min:max" range string (as VTEX/Shopify Intelligent Search
 * facets emit) into a localised price range like "R$ 10,00 - R$ 50,00".
 *
 * Returns the original input untouched if either bound fails to parse,
 * so this never crashes a filter UI on a bad facet value.
 */
export const formatPriceRange = (
	value: string,
	currency = "BRL",
	locale = "pt-BR",
	separator = " - ",
): string => {
	if (typeof value !== "string" || !value.includes(":")) return value;
	const [rawMin, rawMax] = value.split(":");
	const min = formatPrice(Number(rawMin), currency, locale);
	const max = formatPrice(Number(rawMax), currency, locale);
	if (min == null || max == null) return value;
	return `${min}${separator}${max}`;
};
