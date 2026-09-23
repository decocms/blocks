import { describe, expect, it, vi } from "vitest";
import { createRenderJsonClient, isDeferred, RenderJsonError } from "./renderJson";

const BASE = "https://loja.example.com";

const page = (name = "Home Page") => ({
  name,
  path: "/",
  sections: [{ component: "site/sections/Images/Banner.tsx", props: { title: "hi" } }],
});

/** A fetch double that records calls and replays queued responses. */
function fakeFetch(responses: Array<{ status?: number; body?: unknown; etag?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const next = responses.shift() ?? { status: 200, body: page() };
    const headers = new Headers();
    if (next.etag) headers.set("ETag", next.etag);
    return new Response(next.status === 304 ? null : JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers,
    });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

describe("createRenderJsonClient — URL shape", () => {
  it("appends ?renderJson and the app variant flag", async () => {
    const { fetcher, calls } = fakeFetch([{ body: page() }]);
    await createRenderJsonClient({ baseUrl: BASE, fetcher }).fetchPage("/");
    const url = new URL(calls[0].url);
    expect(url.origin).toBe(BASE);
    expect(url.searchParams.has("renderJson")).toBe(true);
    expect(url.searchParams.get("app")).toBe("1");
  });

  it("omits the app flag when the variant is turned off", async () => {
    const { fetcher, calls } = fakeFetch([{ body: page() }]);
    await createRenderJsonClient({ baseUrl: BASE, appVariant: false, fetcher }).fetchPage("/");
    expect(new URL(calls[0].url).searchParams.has("app")).toBe(false);
  });

  it("preserves the page path and its own query params", async () => {
    const { fetcher, calls } = fakeFetch([{ body: page() }]);
    await createRenderJsonClient({ baseUrl: BASE, fetcher }).fetchPage(
      "/products/dad-hat-4438?skuId=9",
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/products/dad-hat-4438");
    expect(url.searchParams.get("skuId")).toBe("9");
  });

  it("defaults to the site root", async () => {
    const { fetcher, calls } = fakeFetch([{ body: page() }]);
    await createRenderJsonClient({ baseUrl: BASE, fetcher }).fetchPage();
    expect(new URL(calls[0].url).pathname).toBe("/");
  });
});

describe("createRenderJsonClient — ETag / 304", () => {
  it("sends If-None-Match on the second request and reuses the cached page on 304", async () => {
    // On a phone this is the difference between re-downloading a page payload
    // on every screen focus and sending ~200 bytes.
    const { fetcher, calls } = fakeFetch([
      { body: page("First"), etag: '"rj-abc"' },
      { status: 304 },
    ]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });

    const first = await client.fetchPage("/");
    const second = await client.fetchPage("/");

    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
    expect(calls[1].headers["If-None-Match"]).toBe('"rj-abc"');
    expect(second).toEqual(first);
    expect(second.name).toBe("First");
  });

  it("does not send If-None-Match when the response carried no ETag", async () => {
    const { fetcher, calls } = fakeFetch([{ body: page() }, { body: page() }]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await client.fetchPage("/");
    await client.fetchPage("/");
    expect(calls[1].headers["If-None-Match"]).toBeUndefined();
  });

  it("keeps ETags per path", async () => {
    const { fetcher, calls } = fakeFetch([
      { body: page("Home"), etag: '"rj-home"' },
      { body: page("PDP"), etag: '"rj-pdp"' },
      { status: 304 },
    ]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await client.fetchPage("/");
    await client.fetchPage("/products/x");
    const back = await client.fetchPage("/");
    expect(calls[2].headers["If-None-Match"]).toBe('"rj-home"');
    expect(back.name).toBe("Home");
  });
});

describe("createRenderJsonClient — errors", () => {
  it("flags 404 as notFound so the app can show its own empty state", async () => {
    const { fetcher } = fakeFetch([{ status: 404, body: { status: 404, notFound: true } }]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await expect(client.fetchPage("/nope")).rejects.toMatchObject({
      name: "RenderJsonError",
      status: 404,
      notFound: true,
    });
  });

  it("throws without notFound on a server error", async () => {
    const { fetcher } = fakeFetch([{ status: 500, body: {} }]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await expect(client.fetchPage("/")).rejects.toMatchObject({ status: 500, notFound: false });
  });

  it("is an Error subclass, so normal error handling works", async () => {
    const { fetcher } = fakeFetch([{ status: 500, body: {} }]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await expect(client.fetchPage("/")).rejects.toBeInstanceOf(RenderJsonError);
  });
});

describe("createRenderJsonClient — deferred sections", () => {
  it("resolves a lazyUrl against the base origin, leaving its query intact", async () => {
    // The worker builds this relative and it already carries `app=1` and the
    // section index; it is opaque by contract.
    const { fetcher, calls } = fakeFetch([
      { body: { component: "site/sections/Product/ProductShelf.tsx", props: {} } },
    ]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await client.fetchSection("/?renderJson=&app=1&__section=5");
    const url = new URL(calls[0].url);
    expect(url.origin).toBe(BASE);
    expect(url.searchParams.get("__section")).toBe("5");
    expect(url.searchParams.get("app")).toBe("1");
  });

  it("surfaces a failed section fetch as RenderJsonError", async () => {
    const { fetcher } = fakeFetch([{ status: 404, body: {} }]);
    const client = createRenderJsonClient({ baseUrl: BASE, fetcher });
    await expect(client.fetchSection("/?__section=9")).rejects.toBeInstanceOf(RenderJsonError);
  });
});

describe("isDeferred", () => {
  it("distinguishes a placeholder from a resolved section", () => {
    expect(isDeferred({ component: "a", lazyUrl: "/x" })).toBe(true);
    expect(isDeferred({ component: "a", props: {} })).toBe(false);
  });
});
