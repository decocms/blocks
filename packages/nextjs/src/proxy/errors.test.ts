// @vitest-environment node
import { NextRequest } from "next/server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const intake = vi.hoisted(() => ({
  ERROR_REPORT_PATH: "/deco/_errors",
  handleErrorReport: vi.fn(async (_request: Request) => new Response(null, { status: 204 })),
}));
vi.mock("@decocms/blocks/telemetry", () => intake);

const { draftProxy, ERROR_REPORT_PATH, handleErrorReport } = await import("./index.ts");

beforeEach(() => {
  intake.handleErrorReport
    .mockReset()
    .mockResolvedValue(
      new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }),
    );
});

describe("Next loopback URL normalization", () => {
  const body = JSON.stringify({ name: "Error", message: "local render failed", source: "render" });
  const request = (url: string, origin: string, fetchSite?: string) =>
    new Request(`${url}${ERROR_REPORT_PATH}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(fetchSite === undefined ? {} : { "Sec-Fetch-Site": fetchSite }),
        "X-Forwarded-Host": "ignored.example",
      },
      body,
    });

  it.each([
    ["http://localhost:3000", "http://127.0.0.1:3000"],
    ["http://localhost:3000", "http://[::1]:3000"],
    ["http://127.0.0.1:3000", "http://localhost:3000"],
    ["https://localhost", "https://127.0.0.1"],
  ])("restores the same-origin browser alias from %s to %s", async (url, origin) => {
    const incoming = request(url, origin, "same-origin");
    await handleErrorReport(incoming);
    const forwarded = intake.handleErrorReport.mock.calls[0]![0];
    expect(new URL(forwarded.url).origin).toBe(origin);
    expect(forwarded.headers.get("Origin")).toBe(origin);
    expect(forwarded.headers.get("Sec-Fetch-Site")).toBe("same-origin");
    expect(await forwarded.text()).toBe(body);
  });

  it.each([
    ["http://localhost:3000", "http://127.0.0.1:3000", undefined],
    ["http://localhost:3000", "http://127.0.0.1:3000", "same-site"],
    ["http://localhost:3000", "http://127.0.0.1:3000", "cross-site"],
    ["http://localhost:3000", "http://127.0.0.1:3001", "same-origin"],
    ["http://localhost:3000", "https://127.0.0.1:3000", "same-origin"],
    ["https://localhost", "https://127.0.0.1:80", "same-origin"],
    ["https://store.example", "https://localhost", "same-origin"],
    ["https://localhost", "https://outside.example", "same-origin"],
    ["https://localhost", "https://localhost.evil.example", "same-origin"],
  ])("keeps strict rejection for %s, Origin %s and Fetch-Site %s", async (url, origin, fetchSite) => {
    intake.handleErrorReport.mockImplementationOnce(
      async (incoming) =>
        new Response(null, {
          status: incoming.headers.get("Origin") === new URL(incoming.url).origin ? 204 : 403,
        }),
    );
    const incoming = request(url, origin, fetchSite);
    const response = await handleErrorReport(incoming);
    expect(response.status).toBe(403);
    expect(intake.handleErrorReport).toHaveBeenCalledExactlyOnceWith(incoming);
    expect(incoming.bodyUsed).toBe(false);
  });
});

describe("browser errors in the proxy", () => {
  it("handles the intake before content, assignment rewrites or visitor cookies", async () => {
    const cms = new Proxy({} as Parameters<typeof draftProxy>[0], {
      get() {
        throw new Error("The intake must not resolve content");
      },
    });
    const rewrite = vi.fn(() => true);
    const assignments = vi.fn(() => true);
    const request = new NextRequest(`https://shop.example.com${ERROR_REPORT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://shop.example.com" },
      body: JSON.stringify({ name: "Error", message: "render failed", source: "render" }),
    });
    const response = await draftProxy(cms, { rewrite, assignments })(request);
    expect(intake.handleErrorReport).toHaveBeenCalledExactlyOnceWith(request);
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.has("x-middleware-rewrite")).toBe(false);
    expect(rewrite).not.toHaveBeenCalled();
    expect(assignments).not.toHaveBeenCalled();
  });

  it("preserves a rejected report response instead of forwarding it to a page", async () => {
    intake.handleErrorReport.mockResolvedValueOnce(
      new Response("Rejected", { status: 403, headers: { "Cache-Control": "no-store" } }),
    );
    const response = await draftProxy({} as Parameters<typeof draftProxy>[0])(
      new NextRequest(`https://shop.example.com${ERROR_REPORT_PATH}`, { method: "POST" }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Rejected");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("x-middleware-next")).toBe(false);
  });
});
