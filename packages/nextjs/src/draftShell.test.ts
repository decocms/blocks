/**
 * `ensureDraft()` must bind from the middleware-forwarded `x-deco-draft` header
 * — the only pointer source a LAYOUT (app shell) can see: it receives no
 * `searchParams`, and on the entry request the cookie has only just been set on
 * the response. This is what lets shell-resolved Header/Footer reflect a draft,
 * not just page sections.
 */
import { clearDraftCache } from "@decocms/blocks/cms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable header/cookie state the mock reads, so each test drives its own.
let headerState = new Headers();
let cookieState: Record<string, string> = {};

vi.mock("next/headers", () => ({
  headers: async () => headerState,
  cookies: async () => ({
    get: (name: string) => (name in cookieState ? { name, value: cookieState[name] } : undefined),
  }),
}));

const { ensureDraft, DRAFT_HEADER, DRAFT_COOKIE } = await import("./draft");

const DRAFT_BLOCKS = { "pages-home": { title: "DRAFT" } };
const POINTER = "abc.localhost:60534@v1";

beforeEach(() => {
  headerState = new Headers({ host: "site.example" });
  cookieState = {};
  process.env.DECO_ALLOWED_PREVIEW_HOSTS = "site.example";
  clearDraftCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === "http://abc.localhost:60534/_sandbox/decofile") {
        return new Response(JSON.stringify(DRAFT_BLOCKS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DECO_ALLOWED_PREVIEW_HOSTS;
});

describe("ensureDraft — app-shell (layout) binding via the forwarded header", () => {
  it("binds the draft from x-deco-draft with no searchParams (the layout case)", async () => {
    headerState.set(DRAFT_HEADER, POINTER);
    // No searchParams (layouts get none) and no cookie (entry request).
    expect(await ensureDraft()).toBe(true);
  });

  it("still binds from the cookie when there is no forwarded header", async () => {
    cookieState[DRAFT_COOKIE] = POINTER;
    expect(await ensureDraft()).toBe(true);
  });

  it("does not bind when neither header, cookie, nor param is present", async () => {
    expect(await ensureDraft()).toBe(false);
  });

  it("stays gated by the host allowlist even with a forwarded header", async () => {
    headerState = new Headers({ host: "prod.example" });
    headerState.set(DRAFT_HEADER, POINTER);
    expect(await ensureDraft()).toBe(false);
  });
});
