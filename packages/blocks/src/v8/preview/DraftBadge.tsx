"use client";

/**
 * The "Preview mode" badge: v7's `DraftPreviewBadge`, unchanged on screen.
 *
 * A draft preview keeps its pointer in a cookie, so after the first click the
 * URL no longer shows `?__draft=` and a reviewer can mistake the draft for the
 * live site. While a draft is bound, this badge floats over the page; clicking
 * it offers the two things a reviewer needs: leave the preview, or copy a link
 * to this exact draft version.
 *
 * - Renders nothing without a `pointer`, so a binding can mount it on every
 *   page and pass the request's draft pointer (or `null`).
 * - `unavailable`: the link named a draft that can't be read anymore, and
 *   the page shows the published site. Outside a frame, a calm notice says
 *   so (nothing to fix, nothing to retry); inside Studio's frame, nothing.
 * - Hidden inside a frame: Studio's site editor shows the draft in an iframe
 *   with its own chrome. A reviewer who opens a shared link in their own tab
 *   still sees it.
 * - Starts hidden on the server and on the first client render, and shows only
 *   after an effect confirms the page isn't framed. Rendering it and hiding it
 *   later would flash it inside Studio and break hydration (the server has no
 *   `window`).
 * - Inline styles and an inlined mark: no dependency on the site's CSS or
 *   assets.
 *
 * `"use client"`: it has state and effects. In Next.js a Server Component can
 * render it directly.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DRAFT_PARAM } from "../draft.ts";
import { DECO_MARK_DATA_URI } from "./decoMark.ts";

export interface DraftBadgeProps {
  /**
   * The draft pointer this page was rendered from (`cms.draftPointer`). The
   * badge renders nothing when it's `null`, `undefined` or empty.
   */
  pointer: string | null | undefined;
  /**
   * Where "Exit preview" goes. Defaults to the current URL with
   * `?__draft=off`, which clears the draft cookie.
   */
  exitHref?: string;
  /**
   * The link's draft can't be read anymore (deleted, say): the binding
   * rendered the published site instead. Shows a calm notice outside a frame.
   */
  unavailable?: boolean;
}

/** What the notice says when a link's draft is gone. */
const DRAFT_UNAVAILABLE_MESSAGE =
  "This draft isn't available anymore. You're seeing the published site.";

/**
 * The link "Share preview" copies: the current URL with `?__draft=<pointer>`,
 * so the recipient sees this exact draft version.
 */
export function buildShareUrl(href: string, pointer: string): string {
  const url = new URL(href);
  url.searchParams.set(DRAFT_PARAM, pointer);
  return url.toString();
}

/** The current URL with `?__draft=off`: ends the preview and shows the published page. */
export function buildExitUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(DRAFT_PARAM, "off");
  return url.toString();
}

/**
 * Whether the page is in another page's frame (Studio's site editor). A
 * reference comparison, so it never throws across origins. No `window` (the
 * server) reads as not framed.
 */
export function isFramed(win: typeof window | undefined = globalThis.window): boolean {
  return typeof win !== "undefined" && win.top !== win;
}

const DECO_GREEN = "#0b3d1e";
/** The badge background, Deco lime; text sits on it in dark green. */
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

/** Sharing the draft: the three-node share glyph. */
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

export function DraftBadge({ pointer, exitHref, unavailable }: DraftBadgeProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The only place isFramed() runs: after mount, so the server render and the
  // first client render agree (both hidden).
  useEffect(() => {
    if (!isFramed()) setVisible(true);
  }, []);

  // Close the menu on an outside click or Escape.
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
    window.location.href = exitHref ?? buildExitUrl(window.location.href);
  }, [exitHref]);

  const sharePreviewLink = useCallback(async () => {
    if (!pointer) return;
    const link = buildShareUrl(window.location.href, pointer);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure context, a denied permission): let the
      // reviewer copy the link by hand.
      window.prompt("Copy preview link:", link);
    }
  }, [pointer]);

  if (!visible) return null;
  if (!pointer) return unavailable ? <UnavailableNotice /> : null;

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

/** The notice for a link whose draft is gone: the published site is what shows. */
function UnavailableNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      role="status"
      data-deco-preview-unavailable=""
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        zIndex: 2147483647,
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: "calc(100vw - 32px)",
        padding: "8px 8px 8px 12px",
        background: "#fff",
        color: "#1a1a1a",
        borderRadius: 12,
        boxShadow: "0 8px 30px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.05)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <img
        src={DECO_MARK_DATA_URI}
        alt=""
        width={18}
        height={18}
        style={{ display: "block", borderRadius: 4, flexShrink: 0 }}
      />
      <span>{DRAFT_UNAVAILABLE_MESSAGE}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          flexShrink: 0,
          padding: "2px 8px",
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ×
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
