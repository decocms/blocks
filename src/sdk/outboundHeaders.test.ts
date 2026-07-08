import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _uninstallDefaultUserAgentForTests,
  DECO_POWERED_BY,
  DECO_USER_AGENT,
  installDefaultUserAgent,
} from "./outboundHeaders";

/** Headers the wrapped baseFetch would put on the wire for a given call. */
function wireHeaders(call: readonly [RequestInfo | URL, RequestInit?]): Headers {
  const [input, init] = call;
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

describe("installDefaultUserAgent", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    _uninstallDefaultUserAgentForTests();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function install(userAgent?: string) {
    const baseFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    );
    globalThis.fetch = baseFetch as unknown as typeof fetch;
    installDefaultUserAgent(userAgent);
    return baseFetch;
  }

  it("sets the default UA on a bare string fetch", async () => {
    const baseFetch = install();
    await fetch("https://api.example.com/products");

    const headers = wireHeaders(baseFetch.mock.calls[0]);
    expect(headers.get("user-agent")).toBe(DECO_USER_AGENT);
  });

  it("keeps the caller's UA from init.headers", async () => {
    const baseFetch = install();
    await fetch("https://api.example.com/", {
      headers: { "user-agent": "deco-aws-app/1.0" },
    });

    // Untouched call: init passed through verbatim.
    expect(baseFetch.mock.calls[0][1]).toEqual({
      headers: { "user-agent": "deco-aws-app/1.0" },
    });
  });

  it("keeps the UA of a Request input", async () => {
    const baseFetch = install();
    const req = new Request("https://api.example.com/", {
      headers: { "User-Agent": "decocx/1.0" },
    });
    await fetch(req);

    expect(baseFetch.mock.calls[0][0]).toBe(req);
    expect(baseFetch.mock.calls[0][1]).toBeUndefined();
  });

  it("preserves a Request's other headers when injecting the UA", async () => {
    const baseFetch = install();
    await fetch(
      new Request("https://api.example.com/", {
        headers: { accept: "application/json", "x-api-key": "k" },
      }),
    );

    const headers = wireHeaders(baseFetch.mock.calls[0]);
    expect(headers.get("user-agent")).toBe(DECO_USER_AGENT);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe("k");
  });

  it("preserves non-header init members (method, body, signal)", async () => {
    const baseFetch = install();
    const controller = new AbortController();
    await fetch("https://api.example.com/", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });

    const init = baseFetch.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("user-agent")).toBe(DECO_USER_AGENT);
  });

  it("honors a custom UA value", async () => {
    const baseFetch = install("MyStore-Migration/1.0");
    await fetch("https://api.example.com/");

    expect(wireHeaders(baseFetch.mock.calls[0]).get("user-agent")).toBe("MyStore-Migration/1.0");
  });

  it("is idempotent — a second install does not re-wrap", () => {
    install();
    const wrapped = globalThis.fetch;
    installDefaultUserAgent();
    expect(globalThis.fetch).toBe(wrapped);
  });

  it("exposes the old-runtime-parity x-powered-by value", () => {
    expect(DECO_POWERED_BY).toMatch(/^deco@\d+\.\d+\.\d+/);
  });
});
