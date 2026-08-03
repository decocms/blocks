"use client";

/**
 * Preview-mode indicator.
 *
 * The draft-preview flow (see `draft.ts`) carries the pointer in a cookie
 * across in-preview navigation, so after the first click the URL no longer
 * shows `?__draft=` — a reviewer can forget they are looking at unpublished
 * content and mistake it for what is live. This badge is the always-on signal:
 * whenever a draft is bound it floats over the page, and clicking it offers the
 * two things a reviewer actually needs — leave preview, or hand the exact draft
 * version to someone else.
 *
 * Deliberately self-contained: `"use client"`, inline styles (no dependency on
 * the host site's CSS/Tailwind), and a very high z-index, so it renders the
 * same on any consumer site. Only mounted when a draft is active
 * (`DraftPreviewIndicator` gates it), so it never costs ordinary traffic.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DECO_MARK_DATA_URI } from "./decoMark";
import { DRAFT_PARAM } from "./draftConstants";

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
  const rootRef = useRef<HTMLDivElement>(null);

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
