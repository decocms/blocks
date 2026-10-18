/**
 * @decocms/compat-v7: v7's pure helpers on v8, with v7's output. No v7
 * runtime: no `ctx`, no invoke, no request scope. Each helper is also its own
 * subpath (`/device`, `/script`, `/clx`, `/types`, `/types/widgets`). The
 * matchers are only at `/matchers` and the section runner only at
 * `/sections`: their names (`device`, `location`, `compose`, …) are too
 * generic for the root. v7's commerce types and helpers are under
 * `/commerce/*`, and what needs a framework under `/tanstack*` and
 * `/nextjs*`.
 */
export { clx } from "./clx.ts";
export { type Device, detectDevice, isMobileUA, MOBILE_RE, TABLET_RE } from "./device.ts";
export { inlineScript, useScript, useScriptAsDataURI } from "./script.ts";
export type {
  ButtonWidget,
  Color,
  Flag,
  HTMLWidget,
  ImageWidget,
  LoadingFallbackProps,
  Resolved,
  RichText,
  Secret,
  SectionProps,
  TextArea,
  TextWidget,
  VideoWidget,
} from "./types/index.ts";
