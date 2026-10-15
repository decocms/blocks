/**
 * @decocms/compat-v7: v7's pure helpers on v8, with v7's output. No v7
 * runtime: no `ctx`, no invoke, no request scope. Each helper is also its own
 * subpath (`/device`, `/script`, `/clx`, `/types`, `/types/widgets`).
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
