"use client";
/**
 * The browser half of `SegmentCookie` (`@decocms/compat-v7/nextjs/server`).
 * Not an export of its own.
 *
 * On a full page load the inline script sets the cookie before hydration. On
 * a client-side navigation React renders the new page itself, and React never
 * runs a `<script>` it renders in the browser, so the effect sets the same
 * cookie. Without it, a visitor who first reached an A/B page through a link
 * would get a fresh draw on the next full load.
 *
 * `"use client"`: Next's server components render it as a client component
 * (and TanStack ignores the directive).
 */
import { createElement, type ReactElement, useEffect } from "react";
import { segmentCookieScript } from "./shared.ts";

export interface SegmentCookieWriterProps {
  /** The `Set-Cookie` value to write. */
  setCookie: string;
  /** The CSP nonce for the inline script. */
  nonce?: string;
}

/** Writes `setCookie` with an inline script on the server render, and again in an effect. */
export function SegmentCookieWriter({ setCookie, nonce }: SegmentCookieWriterProps): ReactElement {
  useEffect(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: the cookie must be written raw, byte for byte as v7's Set-Cookie
    document.cookie = setCookie;
  }, [setCookie]);
  return createElement("script", {
    nonce,
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: segmentCookieScript(setCookie) },
  });
}
