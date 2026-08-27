// @vitest-environment node

import { registerSection, setBlocks } from "@decocms/blocks/cms";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRender } from "./render";

// A section that renders a caller-controlled prop straight into an HTML sink —
// i.e. exactly the reflected-XSS shape /deco/render exposes (marquee text,
// title-box rich text, …). The CSP is what must neutralize it.
const XSS_SINK = "site/sections/XssSink.tsx";
const PAYLOAD = `<img src=x onerror="alert(document.domain)">`;

beforeEach(() => {
  setBlocks({});
  registerSection(XSS_SINK, async () => ({
    default: ({ html }: { html?: string }) =>
      createElement("div", {
        dangerouslySetInnerHTML: { __html: html ?? "" },
      }),
  }));
});

async function renderPayload(): Promise<{ response: Response; html: string }> {
  const props = encodeURIComponent(JSON.stringify({ html: PAYLOAD }));
  const response = await handleRender(
    new Request(`http://localhost/live/previews/${encodeURIComponent(XSS_SINK)}?props=${props}`),
  );
  return { response, html: await response.text() };
}

function scriptSrcOf(csp: string): string {
  const part = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  return part ?? "";
}

describe("handleRender CSP hardening", () => {
  it("stamps a nonce-based Content-Security-Policy with no unsafe-inline script", async () => {
    const { response } = await renderPayload();
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("default-src 'none'");
    const scriptSrc = scriptSrcOf(csp);
    expect(scriptSrc).toMatch(/'nonce-[^']+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("reflects the payload (proving the sink) but the CSP renders it inert", async () => {
    const { response, html } = await renderPayload();
    // The section really did write the attacker HTML into the document…
    expect(html).toContain("onerror=");
    // …but the response carries the policy that stops that handler from firing.
    expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-");
  });

  it("tags the framework's own inline script with the same nonce it authorizes", async () => {
    const { response, html } = await renderPayload();
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = scriptSrcOf(csp).match(/'nonce-([^']+)'/)?.[1];

    expect(nonce).toBeTruthy();
    // The LIVE_CONTROLS_SCRIPT <script> must carry the nonce, or the preview's
    // own editor bridge would be blocked by the same policy.
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("editor::inject");
  });

  it("uses a fresh nonce per response (no reuse across requests)", async () => {
    const a = await renderPayload();
    const b = await renderPayload();
    const nonceOf = (r: Response) =>
      scriptSrcOf(r.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];
    expect(nonceOf(a.response)).toBeTruthy();
    expect(nonceOf(a.response)).not.toBe(nonceOf(b.response));
  });

  it("applies the CSP to the error path too", async () => {
    // Force resolvePreviewRequest deeper paths to still carry the header:
    // an unknown component returns HTML via the same htmlResponse helper.
    const response = await handleRender(
      new Request("http://localhost/live/previews/site%2Fsections%2FDoesNotExist.tsx"),
    );
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
