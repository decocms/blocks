// The header matrix against the built app on workerd (`vite preview` runs the
// Worker in Miniflare): run `bun run build && bun run smoke`. Exits non-zero
// on the first difference.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { toJSONAsync } from "seroval";

const PORT = Number(process.env.SMOKE_PORT ?? 8811);
const BASE = `http://127.0.0.1:${PORT}`;
const POINTER = "studio.decocms.com/api/acme/decofile/store/main/changes?token=abc@9f3c1a";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";

const server = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures.push(name);
}

async function get(path, init = {}) {
  return fetch(`${BASE}${path}`, { redirect: "manual", ...init });
}

try {
  for (let i = 0; ; i++) {
    try {
      await get("/deco/_liveness");
      break;
    } catch {
      if (i > 120) throw new Error(`vite preview did not start:\n${log}`);
      await sleep(500);
    }
  }

  const live = await get("/deco/_liveness");
  check("liveness answers OK", live.status === 200 && (await live.text()) === "OK");
  for (const path of ["/deco/meta", "/live/_meta", "/.decofile"]) {
    check(`${path} is 404`, (await get(path)).status === 404);
  }

  const first = await get("/summer-shirt/p");
  const body = await first.text();
  check("a page renders", first.status === 200 && body.includes("Summer shirt"), first.status);
  check(
    "Studio may frame it, nothing else does",
    (first.headers.get("content-security-policy") ?? "").startsWith(
      "frame-ancestors 'self' https://studio.decocms.com",
    ) && !first.headers.has("x-frame-options"),
    first.headers.get("content-security-policy"),
  );
  check("security headers", first.headers.get("x-content-type-options") === "nosniff");
  check("product profile", first.headers.get("x-cache-profile") === "product");
  check(
    "the cache version is <build>.<revision>",
    /^[0-9a-f]{12}\.[0-9a-f]+$/.test(first.headers.get("x-cache-version") ?? ""),
    first.headers.get("x-cache-version"),
  );
  check("the CDN never keeps a document", first.headers.get("cdn-cache-control") === "no-store");
  check("the document mounts the Studio bridge", body.includes('data-site="tanstack-worker-smoke"'));
  const token = body.match(/window\.__DECO_CSEG="([0-9a-f]{8})"/)?.[1];
  check("the document publishes its CDN segment token", Boolean(token), "no __DECO_CSEG");
  check("data-theme=light", body.includes('data-theme="light"'));
  const visitorCookies = (res) => res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
  const [visitorCookie, ...moreVisitorCookies] = visitorCookies(first);
  check(
    "a first visit gets the visitor's cookie, once",
    /^deco_segment=[^;]+; Path=\/; Max-Age=31536000; SameSite=Lax/.test(visitorCookie ?? "") &&
      moreVisitorCookies.length === 0,
    first.headers.getSetCookie().join(" | "),
  );
  check("the visitor reaches the page's A/B test (promo-copy, 100%)", body.includes("Free shipping on every order"));
  const returning = await get("/summer-shirt/p", { headers: { cookie: (visitorCookie ?? "").split(";")[0] } });
  await returning.text();
  check("a returning visitor gets no new cookie", visitorCookies(returning).length === 0, returning.headers.getSetCookie().join(" | "));

  const second = await get("/summer-shirt/p");
  await second.text();
  check(
    "the second request is served by the edge cache",
    second.headers.get("x-cache") === "HIT",
    `${first.headers.get("x-cache")} then ${second.headers.get("x-cache")}`,
  );
  const phone = await get("/summer-shirt/p", { headers: { "user-agent": PHONE } });
  await phone.text();
  check("another device has its own entry", phone.headers.get("x-cache-segment") === "device=mobile");

  const redirect = await get("/old-products/summer-shirt?color=red");
  check(
    "a CMS redirect answers before the app",
    redirect.status === 301 && redirect.headers.get("location") === "/summer-shirt/p?color=red",
    `${redirect.status} ${redirect.headers.get("location")}`,
  );

  const empty = await get("/summer-shirt/p?q=");
  await empty.text();
  check("an empty query value is not redirected away (v7 #646)", empty.status === 200, empty.status);

  // The payload TanStack's client sends (seroval JSON), for a client-side navigation to the page.
  const payload = encodeURIComponent(
    JSON.stringify(await toJSONAsync({ data: { href: "/summer-shirt/p" } })),
  );
  const fnHeaders = { "x-tsr-serverfn": "true", "sec-fetch-dest": "empty" };
  // The page loader's server-function id, from the client bundle (`.handler(<rpc>("<id>"))`).
  const assets = new URL("./dist/client/assets/", import.meta.url);
  const fnId = readdirSync(assets)
    .map((f) => readFileSync(new URL(f, assets), "utf-8").match(/handler\(\w+\(`([0-9a-f]{64})`\)\)/)?.[1])
    .find(Boolean);
  check("the page loader's server function is in the client bundle", Boolean(fnId));
  const fnPath = fnId && `/_serverFn/${fnId}`;
  if (fnPath) {
    const fn = await get(`${fnPath}?payload=${payload}&__cseg=${token}`, { headers: fnHeaders });
    await fn.text();
    check(
      "navigation data with the page's token may be kept by the CDN",
      fn.headers.get("cdn-cache-control")?.startsWith("public"),
      fn.headers.get("cdn-cache-control"),
    );
    const forged = await get(`${fnPath}?payload=${payload}&__cseg=deadbeef`, { headers: fnHeaders });
    await forged.text();
    check("a forged token keeps no-store", forged.headers.get("cdn-cache-control") === "no-store");
  }

  const draft = await get(`/summer-shirt/p?__draft=${encodeURIComponent(POINTER)}`);
  const draftBody = await draft.text();
  check("a draft never reaches the site's page cache", !draft.headers.has("x-cache"), draft.headers.get("x-cache"));
  check("a draft is noindex", draft.headers.get("x-robots-tag") === "noindex, nofollow");
  check("a draft is no-store", draft.headers.get("cache-control") === "no-store, private");
  check("a draft link stores its cookie", (draft.headers.get("set-cookie") ?? "").startsWith("__deco_draft="));
  check("a preview never sends the visitor's cookie", visitorCookies(draft).length === 0, draft.headers.getSetCookie().join(" | "));
  const oldRelease = await get(`/summer-shirt/p?__draft=${"0".repeat(40)}`);
  await oldRelease.text();
  check(
    "an old release's SHA from a Studio link is a preview: no-store, its own cookie, no visitor cookie",
    oldRelease.headers.get("cache-control") === "no-store, private" &&
      (oldRelease.headers.get("set-cookie") ?? "").startsWith(`__deco_draft=${"0".repeat(40)};`) &&
      visitorCookies(oldRelease).length === 0,
    `${oldRelease.status} ${oldRelease.headers.get("cache-control")} ${oldRelease.headers.getSetCookie().join(" | ")}`,
  );
  check("the draft page publishes the draft for the badge", draftBody.includes("window.__DECO_DRAFT="));

  const purge = await get("/_cache/purge", { method: "POST", body: JSON.stringify({ paths: ["/summer-shirt/p"] }) });
  check("the purge route answers 401 without the PURGE_TOKEN secret", purge.status === 401, purge.status);
} catch (error) {
  console.error(error);
  failures.push("crashed");
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");
