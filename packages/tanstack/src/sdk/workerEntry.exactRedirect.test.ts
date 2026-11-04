import type { Redirect } from "@decocms/blocks/sdk/redirects";
import { describe, expect, it } from "vitest";
import { withExactRedirect } from "./workerEntry";

const toResponse = (r: Redirect) =>
  new Response(null, { status: r.status, headers: { Location: r.to } });
const redirect = { from: "/old", to: "/new", status: 301 } as unknown as Redirect;
const later = <T>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const page = () => new Response("page", { status: 200 });

describe("withExactRedirect", () => {
  it("answers the redirect when the lookup settles first", async () => {
    const res = await withExactRedirect(later(page(), 30), Promise.resolve(redirect), toResponse);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/new");
  });

  it("still answers the redirect when the page settles first", async () => {
    const res = await withExactRedirect(Promise.resolve(page()), later(redirect, 30), toResponse);
    expect(res.status).toBe(301);
  });

  it("serves the page only after a lookup that finds nothing", async () => {
    let lookupDone = false;
    const lookup = later(null, 30).then((v) => {
      lookupDone = true;
      return v;
    });
    const res = await withExactRedirect(Promise.resolve(page()), lookup, toResponse);
    expect(lookupDone).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page");
  });

  it("swallows a failed render when the URL redirects", async () => {
    const res = await withExactRedirect(
      Promise.reject(new Error("boom")),
      later(redirect, 10),
      toResponse,
    );
    expect(res.status).toBe(301);
  });

  it("rethrows a failed render when there is no redirect", async () => {
    await expect(
      withExactRedirect(Promise.reject(new Error("boom")), Promise.resolve(null), toResponse),
    ).rejects.toThrow("boom");
  });
});
