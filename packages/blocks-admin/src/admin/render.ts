import { getSection, type ResolvedSection } from "@decocms/blocks/cms";
import { createElement } from "react";
import { buildHtmlShell } from "../sdk/htmlShell";
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

function wrapInHtmlShell(sectionHtml: string): string {
  return buildHtmlShell({ body: sectionHtml, script: LIVE_CONTROLS_SCRIPT });
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
  try {
    const resolution = await resolvePreviewRequest(request);
    if (resolution.type === "unknown") {
      const unknownHtml = wrapInHtmlShell(
        `<div style="padding:20px;color:red;">Unknown section: ${escapeHtml(resolution.component)}</div>`,
      );
      return new Response(unknownHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
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
      return new Response(wrapInHtmlShell(htmlParts.filter(Boolean).join("\n")), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const sectionHtml = await renderResolvedSection(resolution.sections[0]);
    return new Response(wrapInHtmlShell(sectionHtml), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const errorHtml = wrapInHtmlShell(
      `<div style="padding:20px;color:red;">Render error: ${escapeHtml((error as Error).message)}</div>`,
    );
    return new Response(errorHtml, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
}
