"use client";

/**
 * Preview-mode indicator — the shared, framework-agnostic badge.
 *
 * Both bindings render this exact component: `@decocms/nextjs` mounts it from a
 * Server Component that reads the request-scoped pointer, and `@decocms/tanstack`
 * mounts it from its isomorphic root layout. It takes only a `pointer` prop and
 * touches nothing framework-specific (no `next/*`, no TanStack Router), so it
 * lives in the runtime core and neither binding owns a copy.
 *
 * The draft-preview flow carries the pointer in a cookie across in-preview
 * navigation, so after the first click the URL no longer shows `?__draft=` — a
 * reviewer can forget they are looking at unpublished content and mistake it
 * for what is live. This badge is the always-on signal: whenever a draft is
 * bound it floats over the page, and clicking it offers the two things a
 * reviewer actually needs — leave preview, or hand the exact draft version to
 * someone else.
 *
 * Deliberately self-contained: `"use client"`, inline styles (no dependency on
 * the host site's CSS/Tailwind), and a very high z-index, so it renders the
 * same on any consumer site. Only mounted when a draft is active (the binding's
 * indicator gates it), so it never costs ordinary traffic.
 *
 * Hidden inside an iframe (`isFramed`): Studio's own preview surface embeds
 * this exact draft render in an iframe that already has its own chrome
 * (toolbar, version status) — floating a second "you're in preview" badge
 * inside that frame would be redundant clutter, not a signal a reviewer
 * needs. A reviewer following a shared preview link in their own top-level
 * tab still sees it; only the embedded case is suppressed.
 *
 * Renders NOTHING until a client-side effect confirms it's safe to show —
 * fails closed, not open. `isFramed()` needs `window`, so it can only ever
 * be evaluated in the browser; rendering the badge by default and hiding it
 * once framing is detected would flash it for a beat inside Studio's own
 * iframe before it disappeared, and would hydration-mismatch (server has no
 * `window`, so it would always render the "unframed" branch). Starting
 * hidden on both the server and the client's matching first render, then
 * revealing via `useEffect` only when confirmed unframed, avoids both.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DECO_MARK_DATA_URI } from "./decoMark";

/**
 * Query param that enters/leaves draft mode. Kept as a local literal so this
 * client-bundle-safe module never imports the server-only `@decocms/blocks/cms`
 * barrel (which pulls in `node:async_hooks`). It mirrors `DRAFT_QUERY_PARAM`
 * there — the public URL contract, and stable.
 */
const DRAFT_PARAM = "__draft";

export interface DraftPreviewBadgeProps {
  /** The `<host>@<version>` token this render is bound to. */
  pointer: string;
}

/**
 * URL that re-enters this exact draft version — what "Share Preview Link"
 * copies. Pins the version (the token carries the content ETag), so the
 * recipient sees the same working-tree state, not merely "some draft".
 *
 * Pure and exported for tests: builds off a full href so it needs no DOM.
 */
export function buildShareUrl(href: string, pointer: string): string {
  const url = new URL(href);
  url.searchParams.set(DRAFT_PARAM, pointer);
  return url.toString();
}

/**
 * URL that leaves preview mode — `?__draft=off`, the exit sentinel the
 * middleware/page pair understands (it clears the cookie and renders
 * published). Pure and exported for tests.
 */
export function buildExitUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(DRAFT_PARAM, "off");
  return url.toString();
}

/**
 * Whether this render is embedded in another page's iframe — Studio's own
 * preview surface, primarily. `window.top !== window` is a same-origin
 * reference comparison, so it never throws cross-origin (unlike reading a
 * cross-origin frame's properties). No `window` reports not-framed — a safe
 * default for the function itself, though the badge only ever calls this
 * from a `useEffect`, where `window` always exists. Pure and exported for
 * tests.
 */
export function isFramed(win: typeof window | undefined = globalThis.window): boolean {
  return typeof win !== "undefined" && win.top !== win;
}

const DECO_GREEN = "#0b3d1e";
/** Toast background — the deco lime. Text sits on it in dark green for contrast. */
const DECO_LIME = "#d0ec1a";

/** Leaving preview: an arrow back to the published site. */
function ExitIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

/** Sharing the draft: the classic three-node share glyph. */
function ShareIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx={18} cy={5} r={3} />
      <circle cx={6} cy={12} r={3} />
      <circle cx={18} cy={19} r={3} />
      <path d="M8.59 13.51l6.83 3.98" />
      <path d="M15.41 6.51l-6.82 3.98" />
    </svg>
  );
}

export function DraftPreviewBadge({ pointer }: DraftPreviewBadgeProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reveal only after mount, and only when confirmed unframed — fails
  // closed. Server and client's matching first render both start at this
  // same `false`, so there's no hydration mismatch; this effect (client
  // only, runs once) is the sole place `isFramed()` is ever evaluated. See
  // the module doc for why the alternative (render then hide) is worse.
  useEffect(() => {
    if (!isFramed()) setVisible(true);
  }, []);

  // Dismiss on outside click or Escape — standard popover behaviour, and it
  // keeps the badge from trapping focus on a reviewer's own page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const exitPreview = useCallback(() => {
    window.location.href = buildExitUrl(window.location.href);
  }, []);

  const sharePreviewLink = useCallback(async () => {
    const link = buildShareUrl(window.location.href, pointer);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions): fall back to a
      // prompt so the reviewer can still copy the link by hand rather than
      // silently doing nothing.
      window.prompt("Copy preview link:", link);
    }
  }, [pointer]);

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      data-deco-preview-badge=""
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        zIndex: 2147483647,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            minWidth: 200,
            background: "#fff",
            color: "#1a1a1a",
            borderRadius: 12,
            boxShadow: "0 8px 30px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.05)",
            overflow: "hidden",
          }}
        >
          <MenuItem onClick={exitPreview} label="Exit preview" icon={<ExitIcon />} />
          <div style={{ height: 1, background: "rgba(0,0,0,0.07)" }} />
          <MenuItem
            onClick={sharePreviewLink}
            label={copied ? "Copied!" : "Share preview"}
            icon={<ShareIcon />}
          />
        </div>
      ) : null}

      <button
        type="button"
        aria-expanded={open}
        aria-label="Preview mode"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px 7px 8px",
          background: DECO_LIME,
          color: DECO_GREEN,
          border: "none",
          borderRadius: 9999,
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
        }}
      >
        <img
          src={DECO_MARK_DATA_URI}
          alt=""
          width={18}
          height={18}
          style={{ display: "block", borderRadius: 4 }}
        />
        <span>Preview mode</span>
      </button>
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  icon,
}: {
  onClick: () => void;
  label: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        background: "transparent",
        border: "none",
        color: "inherit",
        cursor: "pointer",
        fontSize: 13,
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(0,0,0,0.05)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ display: "inline-flex", flexShrink: 0, color: DECO_GREEN }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
