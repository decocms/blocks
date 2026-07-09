declare global {
	interface Window {
		dataLayer: unknown[];
		DECO: { events: { subscribe: (fn: (event: any) => void) => void } };
	}
}

export const getGTMIdFromSrc = (src: string | undefined) => {
	if (!src) return undefined;
	try {
		return new URL(src).searchParams.get("id") ?? undefined;
	} catch {
		return undefined;
	}
};

interface TagManagerProps {
	trackingId: string;
	src?: string;
}

export function GoogleTagManager(props: TagManagerProps) {
	const _isOnPremises = !!props.src;
	const hasTrackingId = "trackingId" in props;
	const id = _isOnPremises ? props.src : props.trackingId;
	const hostname = _isOnPremises ? props.src : "https://www.googletagmanager.com";
	const src = new URL(`/gtm.js?id=${hasTrackingId ? props.trackingId : ""}`, hostname);
	const noscript = new URL(`/ns.html?id=${hasTrackingId ? props.trackingId : ""}`, hostname);

	return (
		<>
			<script
				id={`gtm-script-${id}`}
				dangerouslySetInnerHTML={{
					__html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s);j.async=true;j.src=i;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer', '${src.href}');`,
				}}
			/>
			<noscript>
				<iframe
					title="Google Tag Manager"
					src={noscript.href}
					height="0"
					width="0"
					style={{ display: "none", visibility: "hidden" }}
				/>
			</noscript>
		</>
	);
}

export function GTAG({ trackingId }: Pick<TagManagerProps, "trackingId">) {
	const safeId = trackingId.replace(/[^a-zA-Z0-9_-]/g, "");
	return (
		<>
			<script async src={`https://www.googletagmanager.com/gtag/js?id=${safeId}`} />
			<script
				dangerouslySetInnerHTML={{
					__html: `window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag("js", new Date());
gtag("config", '${safeId}');`,
				}}
			/>
		</>
	);
}

/**
 * DataLayer event forwarding snippet.
 * Subscribes to DECO events and pushes them to the GTM dataLayer.
 */
const snippetCode = `
(function() {
  if (typeof globalThis.window !== "undefined" && globalThis.window.DECO && globalThis.window.DECO.events) {
    globalThis.window.DECO.events.subscribe(function(event) {
      globalThis.window.dataLayer = globalThis.window.dataLayer || [];
      if (!event || !globalThis.window.dataLayer || typeof globalThis.window.dataLayer.push !== "function") {
        return;
      }
      if (event.name === "deco") {
        globalThis.window.dataLayer.push({ event: event.name, deco: event.params });
        return;
      }
      globalThis.window.dataLayer.push({ ecommerce: null });
      globalThis.window.dataLayer.push({ event: event.name, ecommerce: event.params });
    });
  }
})();
`;

export interface Props {
	/**
	 * @description google tag manager container id. For more info: https://developers.google.com/tag-platform/tag-manager/web#standard_web_page_installation .
	 */
	trackingIds?: string[];
	/**
	 * @title GA Measurement Ids
	 * @label measurement id
	 * @description the google analytics property measurement id. For more info: https://support.google.com/analytics/answer/9539598
	 */
	googleAnalyticsIds?: string[];
	/**
	 * @description custom url for serving google tag manager.
	 */
	src?: string;
	/**
	 * @description Disable forwarding events into dataLayer
	 */
	disableAutomaticEventPush?: boolean;
}

export default function Analytics({
	trackingIds,
	src,
	googleAnalyticsIds,
	disableAutomaticEventPush,
}: Props) {
	const isDeploy = process.env.NODE_ENV === "production";
	// Backwards compat: extract GTM ID from src URL
	const trackingId = getGTMIdFromSrc(src) ?? "";

	return (
		<>
			{isDeploy && (
				<>
					{trackingIds?.map((id) => (
						<GoogleTagManager key={id} src={src} trackingId={id.trim()} />
					))}
					{googleAnalyticsIds?.map((id) => (
						<GTAG key={id} trackingId={id.trim()} />
					))}
					{src && !trackingIds?.length && <GoogleTagManager src={src} trackingId={trackingId} />}
				</>
			)}

			{disableAutomaticEventPush !== true && (
				<script defer id="analytics-script" dangerouslySetInnerHTML={{ __html: snippetCode }} />
			)}
		</>
	);
}
