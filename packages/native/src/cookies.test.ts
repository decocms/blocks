import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CookieStorage,
  createCookieJar,
  readSetCookies,
  splitSetCookie,
  withCookieJar,
} from "./cookies";

/**
 * The comma-joined shape React Native's `whatwg-fetch` polyfill produces:
 * `Headers.prototype.append` does `old + ", " + value`, so five Set-Cookie
 * headers arrive as one string. Taken from a real VTEX cart round-trip.
 */
const VTEX_JOINED = [
  "checkout.vtex.com=__ofid=abc123; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly",
  "CheckoutOrderFormOwnership=xyz; Path=/; Secure",
  "segment=eyJjYW1wYWlnbnMi; Path=/; Max-Age=7776000",
  "sc=1; Path=/",
  "vtex_session=tok-999; Path=/; Expires=Thu, 22 Oct 2026 07:28:00 GMT",
].join(", ");

describe("splitSetCookie", () => {
  it("splits five cookies without breaking the ones carrying Expires dates", () => {
    // The naive `.split(",")` yields 8 fragments here and corrupts three
    // cookies, because `Expires=Wed, 21 Oct 2026` contains a comma.
    const parts = splitSetCookie(VTEX_JOINED);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toContain("Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parts[4]).toContain("Expires=Thu, 22 Oct 2026 07:28:00 GMT");
    expect(VTEX_JOINED.split(",").length).toBeGreaterThan(5);
  });

  it("handles a single cookie", () => {
    expect(splitSetCookie("a=1; Path=/")).toEqual(["a=1; Path=/"]);
  });

  it("handles a single cookie whose only comma is inside a date", () => {
    const one = "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/";
    expect(splitSetCookie(one)).toEqual([one]);
  });

  it("does not split on a comma inside a cookie value", () => {
    // Values are often base64/JSON and legitimately contain commas.
    const raw = 'pref={"a":1,"b":2}; Path=/, other=2; Path=/';
    const parts = splitSetCookie(raw);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('{"a":1,"b":2}');
  });

  it("returns nothing for an empty header", () => {
    expect(splitSetCookie("")).toEqual([]);
  });
});

describe("readSetCookies", () => {
  it("prefers a native getSetCookie when the runtime has one", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    // Node keeps these separate; RN would not.
    expect(readSetCookies(headers).sort()).toEqual(["a=1", "b=2"]);
  });

  it("falls back to splitting a joined header (the React Native path)", () => {
    const headers = {
      get: (name: string) => (name === "set-cookie" ? VTEX_JOINED : null),
    } as unknown as Headers;
    expect(readSetCookies(headers)).toHaveLength(5);
  });

  it("returns nothing when the response set no cookies", () => {
    expect(readSetCookies(new Headers())).toEqual([]);
  });

  it("splits even when getSetCookie hands back one already-joined value", () => {
    // Caught by an end-to-end run, not by reasoning: a Response built with
    // `headers: { "set-cookie": joined }` has a real getSetCookie() that
    // returns ONE element holding all five cookies. Trusting its shape stored
    // a single garbage cookie and silently lost the cart.
    const response = new Response("{}", { headers: { "set-cookie": VTEX_JOINED } });
    expect(readSetCookies(response.headers)).toHaveLength(5);
  });

  it("is idempotent for already-separated cookies", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    expect(readSetCookies(headers)).toHaveLength(2);
  });
});

describe("createCookieJar", () => {
  it("keeps every cookie from a joined header and replays them", async () => {
    const jar = createCookieJar();
    jar.apply({ get: () => VTEX_JOINED } as unknown as Headers);
    expect(jar.size).toBe(5);

    const header = jar.header() ?? "";
    // The cart is worthless without the orderFormId; that is the cookie the
    // naive split loses first.
    expect(header).toContain("checkout.vtex.com=__ofid=abc123");
    expect(header).toContain("vtex_session=tok-999");
    expect(header.split("; ")).toHaveLength(5);
  });

  it("overwrites a cookie when the server sets it again", () => {
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "sc=1; Path=/" }));
    jar.apply(new Headers({ "set-cookie": "sc=2; Path=/" }));
    expect(jar.header()).toBe("sc=2");
  });

  it("treats an already-expired cookie as a deletion — that is how logout works", () => {
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "vtex_session=tok; Path=/" }));
    expect(jar.size).toBe(1);
    jar.apply(
      new Headers({
        "set-cookie": "vtex_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      }),
    );
    expect(jar.size).toBe(0);
    expect(jar.header()).toBeUndefined();
  });

  it("prefers Max-Age over Expires, per RFC 6265", () => {
    vi.useFakeTimers();
    const jar = createCookieJar();
    // Expires is in the past, Max-Age keeps it alive.
    jar.apply(
      new Headers({
        "set-cookie": "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60",
      }),
    );
    expect(jar.header()).toBe("a=1");
    vi.advanceTimersByTime(61_000);
    expect(jar.header()).toBeUndefined();
  });

  it("drops expired cookies when building the header", () => {
    vi.useFakeTimers();
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "short=1; Max-Age=1" }));
    jar.apply(new Headers({ "set-cookie": "session=2; Path=/" }));
    vi.advanceTimersByTime(2_000);
    expect(jar.header()).toBe("session=2");
  });

  it("keeps session cookies (no Expires, no Max-Age) until cleared", () => {
    vi.useFakeTimers();
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "sc=1; Path=/" }));
    vi.advanceTimersByTime(10 * 365 * 24 * 3600 * 1000);
    expect(jar.header()).toBe("sc=1");
    jar.clear();
    expect(jar.header()).toBeUndefined();
  });

  it("ignores a malformed Set-Cookie instead of throwing", () => {
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "novalue" }));
    expect(jar.size).toBe(0);
  });
});

describe("createCookieJar — persistence", () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      map,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      } satisfies CookieStorage,
    };
  }

  it("survives a relaunch — the session outlives the process", async () => {
    const { storage } = memoryStorage();

    const first = createCookieJar({ storage });
    await first.hydrate();
    first.apply({ get: () => VTEX_JOINED } as unknown as Headers);

    const second = createCookieJar({ storage });
    await second.hydrate();
    expect(second.header()).toContain("checkout.vtex.com=__ofid=abc123");
    expect(second.size).toBe(5);
  });

  it("hydrates once, not on every request", async () => {
    const { storage } = memoryStorage();
    const spy = vi.spyOn(storage, "getItem");
    const jar = createCookieJar({ storage });
    await jar.hydrate();
    await jar.hydrate();
    await jar.hydrate();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("starts clean on a corrupt payload rather than wedging every request", async () => {
    const { storage, map } = memoryStorage();
    map.set("deco.cookies", "{not json");
    const jar = createCookieJar({ storage });
    await expect(jar.hydrate()).resolves.toBeUndefined();
    expect(jar.size).toBe(0);
  });

  it("clears persisted state on logout", async () => {
    const { storage, map } = memoryStorage();
    const jar = createCookieJar({ storage });
    await jar.hydrate();
    jar.apply(new Headers({ "set-cookie": "a=1" }));
    jar.clear();
    expect(map.get("deco.cookies")).toBeUndefined();
  });
});

describe("withCookieJar", () => {
  it("attaches the jar's cookies and captures the response's", async () => {
    const jar = createCookieJar();
    const seen: Array<string | null> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie"));
      return new Response("{}", { headers: { "set-cookie": "sc=1; Path=/" } });
    }) as unknown as typeof fetch;

    const wrapped = withCookieJar(jar, fetcher);
    await wrapped("https://loja.example.com/deco/invoke/x");
    await wrapped("https://loja.example.com/?renderJson");

    expect(seen[0]).toBeNull();
    // The whole point: a cookie set by an invoke is on the next renderJson.
    expect(seen[1]).toBe("sc=1");
  });

  it("does not override a Cookie the caller set explicitly", async () => {
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "a=jar" }));
    let sent: string | null = null;
    const fetcher = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("cookie");
      return new Response("{}");
    }) as unknown as typeof fetch;

    await withCookieJar(jar, fetcher)("https://x.test", { headers: { cookie: "a=explicit" } });
    expect(sent).toBe("a=explicit");
  });

  it("preserves other request headers and the method", async () => {
    const jar = createCookieJar();
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (_i: RequestInfo | URL, got?: RequestInit) => {
      init = got;
      return new Response("{}");
    }) as unknown as typeof fetch;

    await withCookieJar(jar, fetcher)("https://x.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe("{}");
  });

  it("hydrates persisted cookies before the first request goes out", async () => {
    const map = new Map<string, string>([
      ["deco.cookies", JSON.stringify({ sc: { value: "persisted" } })],
    ]);
    const storage: CookieStorage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
    let sent: string | null = null;
    const fetcher = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("cookie");
      return new Response("{}");
    }) as unknown as typeof fetch;

    await withCookieJar(createCookieJar({ storage }), fetcher)("https://x.test");
    expect(sent).toBe("sc=persisted");
  });
});

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("system cookie store bridge", () => {
  /** A stand-in for @react-native-cookies/cookies. */
  function fakeSystem(initial: Record<string, string> = {}) {
    const store = { ...initial };
    return {
      store,
      get: () => ({ ...store }),
      set: (_url: string, raw: string) => {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        store[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      },
    };
  }

  it("adopts a cookie the WebView set", async () => {
    // The reported bug: add-to-cart inside the WebView, native badge stays 0.
    const system = fakeSystem({ cart: "from-webview" });
    const jar = createCookieJar({ system, systemUrl: "https://loja.example.com" });
    await jar.syncFromSystem();
    expect(jar.header()).toBe("cart=from-webview");
  });

  it("lets the platform store win over a stale local value", async () => {
    // The jar's copy is the stale one by construction: the WebView is where
    // checkout and login happen, so it is what MOVED the session.
    const system = fakeSystem();
    const jar = createCookieJar({ system, systemUrl: "https://loja.example.com" });
    jar.apply(new Headers({ "set-cookie": "cart=older" }));
    // O WebView mexe DEPOIS — é a sequência real: o usuário sai da tela nativa,
    // faz algo numa página embutida, e volta.
    system.store.cart = "newer";
    await jar.syncFromSystem();
    expect(jar.header()).toBe("cart=newer");
  });

  it("mirrors a native response's cookie back so the WebView sees it", () => {
    // The other direction: add natively, then open checkout in the WebView.
    const system = fakeSystem();
    const jar = createCookieJar({ system, systemUrl: "https://loja.example.com" });
    jar.apply(new Headers({ "set-cookie": "cart=from-native; Path=/; HttpOnly" }));
    expect(system.store.cart).toBe("from-native");
  });

  it("is inert without a system store", async () => {
    const jar = createCookieJar();
    jar.apply(new Headers({ "set-cookie": "cart=local" }));
    await jar.syncFromSystem();
    expect(jar.header()).toBe("cart=local");
  });

  it("keeps working when the native module throws", async () => {
    // No WebView installed, or the store refused. A broken bridge must degrade
    // to the local jar, never fail the request.
    const jar = createCookieJar({
      system: {
        get: () => { throw new Error("no native module"); },
        set: () => { throw new Error("no native module"); },
      },
      systemUrl: "https://loja.example.com",
    });
    jar.apply(new Headers({ "set-cookie": "cart=local" }));
    await jar.syncFromSystem();
    expect(jar.header()).toBe("cart=local");
  });
});
