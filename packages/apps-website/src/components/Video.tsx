/**
 * TODO: Implement video preload with link[rel="preload"] tags once
 * browsers support it. More info at: https://stackoverflow.com/a/68368601
 */
import { forwardRef } from "react";

import { getOptimizedMediaUrl } from "@decocms/blocks/hooks";

export interface Props {
	src: string;
	/** @description Improves Web Vitals (CLS|LCP) */
	width: number;
	/** @description Improves Web Vitals (CLS|LCP) */
	height: number;
	/** @description Force video through the optimization engine */
	forceOptimizedSrc?: boolean;
	className?: string;
	style?: React.CSSProperties;
	autoPlay?: boolean;
	loop?: boolean;
	muted?: boolean;
	playsInline?: boolean;
	controls?: boolean;
	poster?: string;
}

const Video = forwardRef<HTMLVideoElement, Props>((props, ref) => {
	const { forceOptimizedSrc, src: originalSrc, width, height, ...rest } = props;

	const src = forceOptimizedSrc
		? getOptimizedMediaUrl({
				originalSrc,
				width,
				height,
				fit: "cover",
			})
		: originalSrc;

	return <video {...rest} preload={undefined} src={src} width={width} height={height} ref={ref} />;
});

Video.displayName = "Video";

export default Video;
