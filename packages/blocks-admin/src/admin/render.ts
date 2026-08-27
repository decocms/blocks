import { getSection, type ResolvedSection } from "@decocms/blocks/cms";
import { buildRenderCSP, generateCSPNonce } from "@decocms/blocks/sdk/csp";
import { createElement } from "react";
import { buildHtmlShell } from "../sdk/htmlShell";
import { getAdminOrigins } from "./cors";
import { LIVE_CONTROLS_SCRIPT } from "./liveControls";
import { resolvePreviewRequest } from "./resolvePreview";
import { getPreviewWrapper } from "./setup";

export { setPreviewWrapper, setRenderShell } from "./setup";

/** Escape user-controlled strings before interpolating into HTML. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Cache the dynamic import — avoids re-importing per section render
let _renderToString: ((element: any) => string) | null = null;
async function getRenderToString() {
  if (!_renderToString) {
    const mod = await import("react-dom/server");
    _renderToString = mod.renderToString;
  }
  return _renderToString;
}

function wrapInHtmlShell(sectionHtml: string, nonce: string): string {
  return buildHtmlShell({
    body: sectionHtml,
    script: LIVE_CONTROLS_SCRIPT,
    nonce,
  });
}

/**
 * Build the preview HTML `Response` with the hardened CSP.
 *
 * `/deco/render` is an unauthenticated endpoint that reflects fully
 * caller-controlled section props into `text/html`, so a rich-text prop
 * reaching an HTML sink is reflected XSS. The nonce-based CSP is the
 * execution-layer mitigation — it blocks injected inline handlers / scripts
 * while allowing the framework's own `nonce`-tagged preview script (see
 * `buildRenderCSP`). Applied on EVERY response path so no branch (including
 * the error/unknown fallbacks, which interpolate messages) ships without it.
 */
function htmlResponse(html: string, nonce: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": buildRenderCSP({
        nonce,
        adminOrigins: getAdminOrigins(),
      }),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Render a single ResolvedSection to an HTML string.
 * Uses the pre-cached renderToString and the preview wrapper.
 */
async function renderResolvedSection(section: ResolvedSection): Promise<string> {
  const sectionLoader = getSection(section.component);
  if (!sectionLoader) {
    return `<div style="padding:8px;color:orange;font-size:12px;border:1px dashed orange;margin:4px 0;">Unsupported: ${escapeHtml(section.component)}</div>`;
  }

  const renderToString = await getRenderToString();
  const mod = await sectionLoader();
  const element = createElement(mod.default, section.props);
  const Wrapper = getPreviewWrapper();
  const wrapped = Wrapper ? createElement(Wrapper, null, element) : element;
  return renderToString(wrapped);
}

/**
 * Handles /live/previews/* -- renders sections to HTML for the admin preview.
 *
 * Supports:
 * - Page compositor (website/pages/Page.tsx): resolves + renders all child sections
 * - Single section render with full __resolveType resolution
 * - Per-request decofile override via AsyncLocalStorage
 */
export async function handleRender(request: Request): Promise<Response> {
  // One nonce per response, generated before the try so the catch path can
  // reuse it. Every return below goes through htmlResponse(), which stamps the
  // CSP built from this nonce.
  const nonce = generateCSPNonce();
  try {
    const resolution = await resolvePreviewRequest(request);
    if (resolution.type === "unknown") {
      const unknownHtml = wrapInHtmlShell(
        `<div style="padding:20px;color:red;">Unknown section: ${escapeHtml(resolution.component)}</div>`,
        nonce,
      );
      return htmlResponse(unknownHtml, nonce);
    }

    if (resolution.previewType === "page") {
      const htmlParts = await Promise.all(
        resolution.sections.map(async (section) => {
          try {
            return await renderResolvedSection(section);
          } catch (error) {
            return `<div style="padding:8px;color:red;font-size:12px;">Error rendering ${escapeHtml(section.component)}: ${escapeHtml((error as Error).message)}</div>`;
          }
        }),
      );
      return htmlResponse(wrapInHtmlShell(htmlParts.filter(Boolean).join("\n"), nonce), nonce);
    }

    const sectionHtml = await renderResolvedSection(resolution.sections[0]);
    return htmlResponse(wrapInHtmlShell(sectionHtml, nonce), nonce);
  } catch (error) {
    const errorHtml = wrapInHtmlShell(
      `<div style="padding:20px;color:red;">Render error: ${escapeHtml((error as Error).message)}</div>`,
      nonce,
    );
    return htmlResponse(errorHtml, nonce);
  }
}
