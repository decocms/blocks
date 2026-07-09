import type { Segment } from "./types";

const removeNonLatin1Chars = (str: string) => str.replace(/[^\x00-\xFF]/g, "");

export const SEGMENT_COOKIE_NAME = "vtex_segment";
export const SALES_CHANNEL_COOKIE = "VTEXSC";

export interface WrappedSegment {
	payload: Partial<Segment>;
	token: string;
}

export const DEFAULT_SEGMENT: Partial<Segment> = {
	utmi_campaign: null,
	utmi_page: null,
	utmi_part: null,
	utm_campaign: null,
	utm_source: null,
	utm_medium: null,
	channel: "1",
	cultureInfo: "pt-BR",
	currencyCode: "BRL",
	currencySymbol: "R$",
	countryCode: "BRA",
};

/**
 * Stable serialization.
 *
 * Even if attributes are in a different order, the final segment
 * value will be the same. This improves cache hits.
 */
export const serializeSegment = ({
	campaigns,
	channel,
	priceTables,
	regionId,
	utm_campaign,
	utm_source,
	utm_medium,
	utmi_campaign,
	utmi_page,
	utmi_part,
	currencyCode,
	currencySymbol,
	countryCode,
	cultureInfo,
	channelPrivacy,
}: Partial<Segment>): string => {
	const seg = {
		campaigns,
		channel,
		priceTables,
		regionId,
		utm_campaign: utm_campaign && removeNonLatin1Chars(utm_campaign).replace(/[/[\]{}()<>.]/g, ""),
		utm_source: utm_source && removeNonLatin1Chars(utm_source).replace(/[/[\]{}()<>.]/g, ""),
		utm_medium: utm_medium && removeNonLatin1Chars(utm_medium).replace(/[/[\]{}()<>.]/g, ""),
		utmi_campaign: utmi_campaign && removeNonLatin1Chars(utmi_campaign),
		utmi_page: utmi_page && removeNonLatin1Chars(utmi_page),
		utmi_part: utmi_part && removeNonLatin1Chars(utmi_part),
		currencyCode,
		currencySymbol,
		countryCode,
		cultureInfo,
		channelPrivacy,
	};
	return btoa(JSON.stringify(seg));
};

export const parseSegment = (cookie: string): Partial<Segment> | null => {
	try {
		return JSON.parse(atob(cookie));
	} catch {
		return null;
	}
};

const SEGMENT_QUERY_PARAMS = [
	"utmi_campaign",
	"utmi_page",
	"utmi_part",
	"utm_campaign",
	"utm_source",
	"utm_medium",
] as const;

export const buildSegmentFromParams = (searchParams: URLSearchParams): Partial<Segment> => {
	const partialSegment: Partial<Segment> = {};
	for (const qs of SEGMENT_QUERY_PARAMS) {
		const param = searchParams.get(qs);
		if (param) {
			partialSegment[qs] = param;
		}
	}

	const sc = searchParams.get("sc");
	if (sc) {
		partialSegment.channel = sc;
	}

	return partialSegment;
};

export const withSegmentCookie = (segment: WrappedSegment, headers?: Headers): Headers => {
	const h = new Headers(headers);
	if (!segment) return h;

	h.set("cookie", `${SEGMENT_COOKIE_NAME}=${segment.token}`);
	return h;
};

function getCookieValue(cookieHeader: string, name: string): string | null {
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match?.[1] ?? null;
}

/**
 * Build a complete segment from request cookies.
 * Reads both vtex_segment and VTEXSC cookies.
 * VTEXSC contains the sales channel and overrides the segment channel.
 */
export const buildSegmentFromCookies = (cookieHeader: string): Partial<Segment> => {
	const segmentCookie = getCookieValue(cookieHeader, SEGMENT_COOKIE_NAME);
	const vtexsc = getCookieValue(cookieHeader, SALES_CHANNEL_COOKIE);

	const base = segmentCookie ? parseSegment(segmentCookie) : null;
	const segment: Partial<Segment> = { ...DEFAULT_SEGMENT, ...base };

	if (vtexsc) {
		segment.channel = vtexsc;
	}

	return segment;
};

/**
 * Check if the current segment represents an anonymous user
 * (no campaigns, no UTMs, no regionId, no custom priceTables).
 */
export const isAnonymous = (segment: Partial<Segment>): boolean => {
	return (
		!segment.campaigns &&
		!segment.utm_campaign &&
		!segment.utm_source &&
		!segment.utm_medium &&
		!segment.utmi_campaign &&
		!segment.utmi_page &&
		!segment.utmi_part &&
		!segment.regionId &&
		!segment.priceTables
	);
};
