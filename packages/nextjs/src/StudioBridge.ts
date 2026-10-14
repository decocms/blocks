/**
 * `StudioBridge` of `@decocms/blocks/preview` with Studio's origins filled in
 * (`STUDIO_ORIGINS`, `./studio.ts`): the package owns where Studio runs, so a
 * site passes only its name. One inline script and no hooks, so a Server
 * Component renders it as is.
 */
import {
  StudioBridge as BridgeScript,
  type StudioBridgeProps as BridgeScriptProps,
} from "@decocms/blocks/preview";
import { createElement, type ReactNode } from "react";
import { STUDIO_ORIGINS } from "./studio.ts";

/** `site`, and optionally `editShortcut` and `nonce`; Studio's origins are the package's. */
export type StudioBridgeProps = Omit<BridgeScriptProps, "trustedOrigins">;

/**
 * Lets Studio's site editor select and edit sections on the page when Studio
 * frames it. Render it once, in the root layout's `<body>`.
 */
export function StudioBridge(props: StudioBridgeProps): ReactNode {
  return createElement(BridgeScript, { ...props, trustedOrigins: STUDIO_ORIGINS });
}
