/**
 * `StudioBridge` of `@decocms/blocks/preview` with Studio's origins filled in
 * (`STUDIO_ORIGINS`, `./studio.ts`): the package owns where Studio runs, so a
 * site passes only its name. With it, the Studio channel (`StudioChannel`):
 * on every page, production included, framed by one of Studio's origins
 * (`studioOrigins` / `DECO_STUDIO_ORIGIN` / Studio's production and staging
 * origins, each exact) it loads the editor's own modules from that origin;
 * otherwise it does nothing. Two inline scripts and no hooks, so a Server
 * Component renders it as is. The site's CSP allows the same origins with
 * `withStudioCsp`.
 */
import {
  StudioBridge as BridgeScript,
  type StudioBridgeProps as BridgeScriptProps,
  StudioChannel,
} from "@decocms/blocks/preview";
import { createElement, Fragment, type ReactNode } from "react";
import { STUDIO_ORIGINS, studioOrigins } from "./studio.ts";

/** `site`, and optionally `editShortcut`, `page` and `nonce`; Studio's origins are the package's. */
export interface StudioBridgeProps extends Omit<BridgeScriptProps, "trustedOrigins"> {
  /**
   * The Studio origins the Studio channel trusts, each an exact origin.
   * Default: `DECO_STUDIO_ORIGIN` (comma-separated), else Studio's production
   * and staging origins (`DEFAULT_STUDIO_ORIGINS`). A site with a CSP passes
   * the same list to `withStudioCsp`, which adds it to `script-src`.
   */
  studioOrigins?: readonly string[];
}

/**
 * Lets Studio's site editor select and edit sections on the page when Studio
 * frames it. Render it once, in the root layout's `<body>`.
 */
export function StudioBridge({ studioOrigins: origins, ...props }: StudioBridgeProps): ReactNode {
  return createElement(
    Fragment,
    null,
    createElement(BridgeScript, { ...props, trustedOrigins: STUDIO_ORIGINS }),
    createElement(StudioChannel, { studioOrigins: studioOrigins(origins), nonce: props.nonce }),
  );
}
