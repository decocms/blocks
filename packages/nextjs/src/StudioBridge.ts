/**
 * `StudioBridge` of `@decocms/blocks/preview` with Studio's origins filled in
 * (`STUDIO_ORIGINS`, `./studio.ts`): the package owns where Studio runs, so a
 * site passes only its name. With it, the Studio channel (`StudioChannel`):
 * on every page, production included, framed by Studio's origin
 * (`studioOrigin` / `DECO_STUDIO_ORIGIN` / Studio's production origin) it loads
 * the editor's own modules from that origin; otherwise it does nothing. Two
 * inline scripts and no hooks, so a Server Component renders it as is.
 */
import {
  StudioBridge as BridgeScript,
  type StudioBridgeProps as BridgeScriptProps,
  StudioChannel,
} from "@decocms/blocks/preview";
import { createElement, Fragment, type ReactNode } from "react";
import { STUDIO_ORIGINS, studioOrigin } from "./studio.ts";

/** `site`, and optionally `editShortcut`, `page` and `nonce`; Studio's origins are the package's. */
export interface StudioBridgeProps extends Omit<BridgeScriptProps, "trustedOrigins"> {
  /**
   * Studio's origin for the Studio channel. Default: `DECO_STUDIO_ORIGIN`,
   * else Studio's production origin (`STUDIO_ORIGIN`). A site with a CSP
   * allows it in `script-src`.
   */
  studioOrigin?: string;
}

/**
 * Lets Studio's site editor select and edit sections on the page when Studio
 * frames it. Render it once, in the root layout's `<body>`.
 */
export function StudioBridge({ studioOrigin: origin, ...props }: StudioBridgeProps): ReactNode {
  return createElement(
    Fragment,
    null,
    createElement(BridgeScript, { ...props, trustedOrigins: STUDIO_ORIGINS }),
    createElement(StudioChannel, { studioOrigin: studioOrigin(origin), nonce: props.nonce }),
  );
}
