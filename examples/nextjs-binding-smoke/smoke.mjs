// The header matrix against the built app on `next start`: run `bun run build && bun run smoke`.
// A local draft server answers the draft pointer (a loopback host, which the CMS accepts by
// default), so the draft route renders real draft content. A local OTLP sink receives the CMS's
// telemetry, where src/instrumentation.ts records http.server.request.duration from Next's request
// spans. Exits non-zero on any difference.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { assign, newVisitor, serializeVisitor } from "@decocms/blocks/experiments";
import { assignmentsRoutePath } from "@decocms/nextjs/proxy";

const PORT = Number(process.env.SMOKE_PORT ?? 8821);
const DRAFT_PORT = PORT + 1;
const OTLP_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const POINTER = `127.0.0.1:${DRAFT_PORT}/draft@v1`;
const DECO_HOST = { "x-forwarded-host": "binding-smoke.deco.site" };
const COOKIE = { cookie: `__deco_draft=${encodeURIComponent(POINTER)}` };

const shirt = JSON.parse(readFileSync(new URL("./.deco/blocks/ShirtPage.json", import.meta.url), "utf-8"));
shirt.sections[1].name = "Draft shirt";
const draftServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
  res.end(JSON.stringify({ set: { ShirtPage: shirt }, delete: [] }));
});
await new Promise((resolve) => draftServer.listen(DRAFT_PORT, "127.0.0.1", resolve));

// http.server.request.duration's data points, as the CMS sends them (OTLP/HTTP JSON, gzipped).
const requests = [];
const otlp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/v1/metrics") {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      for (const { scopeMetrics } of JSON.parse(body.toString()).resourceMetrics)
        for (const { metrics } of scopeMetrics)
          for (const metric of metrics.filter((m) => m.name === "http.server.request.duration"))
            for (const point of metric.histogram.dataPoints)
              requests.push({
                ...Object.fromEntries(point.attributes.map((a) => [a.key, a.value.stringValue])),
                count: Number(point.count),
                sum: point.sum,
              });
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise((resolve) => otlp.listen(OTLP_PORT, "127.0.0.1", resolve));

// No -H 127.0.0.1: Next's request URL names a loopback host "localhost", so with that bind
// a rewrite's origin differs from the server's and Next proxies it as an external URL.
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", SMOKE_OTLP_ENDPOINT: `http://127.0.0.1:${OTLP_PORT}` },
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures.push(name);
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", headers });
  return { res, body: await res.text() };
}

const draftLink = (path) => `${path}?__draft=${encodeURIComponent(POINTER)}`;

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${BASE}/blog`);
      break;
    } catch {
      if (i > 120) throw new Error(`next start did not start:\n${log}`);
      await sleep(500);
    }
  }

  const page = await get("/summer-shirt/p");
  check("a published page renders", page.res.status === 200 && page.body.includes("Summer shirt"), page.res.status);
  check("a published page is not noindex", !page.res.headers.has("x-robots-tag"));
  check("the layout mounts the Studio bridge", page.body.includes('data-site="binding-smoke"'));
  check(
    "the bridge answers Studio's origins (the package's STUDIO_ORIGINS)",
    page.body.includes(
      'data-origins="[&quot;https://studio.decocms.com&quot;,&quot;https://studio-stg.decocms.com&quot;,&quot;https://decocms.com&quot;,&quot;https://*.decocms.com&quot;]"',
    ),
    page.body.match(/data-origins="[^"]*"/)?.[0],
  );
  check(
    "next/image goes through the Deco image loader",
    page.body.includes("https://assets.decocms.com/image?fit=contain&amp;width=640&amp;src=binding-smoke/summer-shirt.jpg"),
    page.body.match(/srcSet="[^"]*"/)?.[0],
  );
  check("no draft badge on the release", !page.body.includes(POINTER));
  const visitorCookies = (res) => res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
  const [visitorCookie, ...moreVisitorCookies] = visitorCookies(page.res);
  check(
    "a first visit gets the visitor's cookie from the proxy, once",
    /^deco_segment=[^;]+; Path=\/; Max-Age=31536000; SameSite=Lax/.test(visitorCookie ?? "") &&
      moreVisitorCookies.length === 0,
    page.res.headers.getSetCookie().join(" | "),
  );
  // Another route, so the per-route request counts below stay as they are.
  const returning = await get("/blog", { cookie: (visitorCookie ?? "").split(";")[0] });
  check("a returning visitor gets no new cookie", visitorCookies(returning.res).length === 0, returning.res.headers.getSetCookie().join(" | "));

  const link = await get(draftLink("/summer-shirt/p"), DECO_HOST);
  check("a draft link on a Deco host renders the draft", link.res.status === 200 && link.body.includes("Draft shirt"), link.res.status);
  check("a draft is noindex", link.res.headers.get("x-robots-tag") === "noindex, nofollow");
  check(
    "a draft is never stored",
    // Next keeps the proxy's Cache-Control on the draft route; it sets Vary itself (rsc, …).
    link.res.headers.get("cache-control") === "no-store, private",
    link.res.headers.get("cache-control"),
  );
  check(
    "a draft link stores its cookie",
    (link.res.headers.get("set-cookie") ?? "").startsWith(`__deco_draft=${encodeURIComponent(POINTER)}; Path=/`),
    link.res.headers.get("set-cookie"),
  );
  check("the draft page mounts the badge for its draft", link.body.includes(POINTER));
  check("a preview never sends the visitor's cookie", visitorCookies(link.res).length === 0, link.res.headers.getSetCookie().join(" | "));

  const cookie = await get("/summer-shirt/p", { ...DECO_HOST, ...COOKIE });
  check("the cookie keeps the preview going", cookie.body.includes("Draft shirt"));
  check("the cookie alone sets no new cookie", !cookie.res.headers.has("set-cookie"));

  const off = await get("/summer-shirt/p?__draft=off", { ...DECO_HOST, ...COOKIE });
  check("?__draft=off renders the release", off.body.includes("Summer shirt") && !off.body.includes("Draft shirt"));
  check("?__draft=off expires the cookie", (off.res.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

  const elsewhere = await get(draftLink("/summer-shirt/p"));
  check(
    "a host outside the allowlist gets the release",
    elsewhere.res.status === 200 && elsewhere.body.includes("Summer shirt") && !elsewhere.body.includes("Draft shirt"),
  );
  check("and no draft cookie", !(elsewhere.res.headers.get("set-cookie") ?? "").includes("__deco_draft="));

  const forged = await get("/summer-shirt/p", { "x-deco-version": POINTER });
  check("a forged x-deco-version gets the release", forged.body.includes("Summer shirt") && !forged.body.includes("Draft shirt"));

  const direct = await get("/_draft/summer-shirt/p", { ...DECO_HOST, ...COOKIE });
  check("the draft route is reachable only through the proxy", direct.res.status === 404, direct.res.status);

  // http.server.request.duration: one point per request Next served, labelled with its route template.
  const failing = await get("/smoke/fail");
  check("a failing page is a 500", failing.res.status === 500, failing.res.status);
  const missing = await get("/no/such/page");
  check("an unknown path is a 404", missing.res.status === 404, missing.res.status);
  const edge = await get("/smoke/edge");
  check("an Edge route answers", edge.res.status === 200, edge.res.status);
  // The CMS sends metrics every 10 s.
  for (let i = 0; i < 60 && !requests.some((r) => r["http.route"] === "/smoke/fail"); i++) await sleep(500);
  const count = (labels) =>
    requests
      .filter((r) => Object.entries(labels).every(([k, v]) => r[k] === v))
      .reduce((n, r) => n + r.count, 0);
  check(
    // The published page, ?__draft=off, the host outside the allowlist and the forged header.
    "pages count under their route template",
    count({ "http.route": "/_assignments/[assignments]/[[...path]]", status_class: "2xx", cache: "BYPASS" }) === 4 &&
      count({ "http.route": "/blog", status_class: "2xx" }) >= 1,
    JSON.stringify(requests),
  );
  check(
    "a 404 counts under the page that answered it",
    count({ "http.route": "/_assignments/[assignments]/[[...path]]", status_class: "4xx" }) === 1,
  );
  check("a 5xx counts under its page", count({ "http.route": "/smoke/fail", status_class: "5xx" }) === 1);
  check(
    "a draft render is DRAFT, on the draft route",
    count({ "http.route": "/_draft/[[...path]]", status_class: "2xx", cache: "DRAFT" }) === 2 &&
      count({ cache: "DRAFT" }) === 2,
    JSON.stringify(requests.filter((r) => r.cache === "DRAFT")),
  );
  check(
    // The proxy runs through a handleRequest of its own, which is not counted; an Edge route has no
    // route template on the Node server's span.
    "the proxy's own runs are not requests; only the Edge route is unmatched",
    count({ "http.route": "unmatched" }) === 1,
    JSON.stringify(requests.filter((r) => r["http.route"] === "unmatched")),
  );
  check(
    "every point is a known method with a duration",
    requests.length > 0 && requests.every((r) => r["http.request.method"] === "GET" && r.sum > 0 && r.sum < 30 * r.count),
    JSON.stringify(requests),
  );

  // The assignments route: every CMS page renders on /_assignments/<assignments>/<path>, so Next's cache
  // keeps one entry per set of assignments (the 50% new-banner test, the running summer-sale) and
  // never one per visitor.
  const visitorOn = (inside) => {
    for (;;) {
      const visitor = newVisitor();
      if (assign({ "new-banner": 50 }, visitor)["new-banner"] === inside) return visitor;
    }
  };
  const as = (visitor) => ({ cookie: `deco_segment=${serializeVisitor(visitor)}` });
  const assignmentsOf = (body) => body.match(/<main data-assignments="([^"]*)"/)?.[1];
  const [inA, inB, out] = [visitorOn(true), visitorOn(true), visitorOn(false)];
  const sideA = await get("/sale", as(inA));
  const sideA2 = await get("/sale", as(inB));
  const sideB = await get("/sale", as(out));
  check(
    "a visitor in the test gets its side and the running campaign",
    sideA.res.status === 200 && sideA.body.includes("Banner B") && sideA.body.includes("Summer sale"),
    sideA.res.status,
  );
  check("a visitor out of it gets the other side", sideB.body.includes("Banner A") && sideB.body.includes("Summer sale"));
  check(
    "opposite sides render on different paths",
    assignmentsOf(sideA.body) && assignmentsOf(sideB.body) && assignmentsOf(sideA.body) !== assignmentsOf(sideB.body),
    `${assignmentsOf(sideA.body)} / ${assignmentsOf(sideB.body)}`,
  );
  check(
    "the same side renders on the same path, served from Next's cache",
    assignmentsOf(sideA2.body) === assignmentsOf(sideA.body) && sideA2.res.headers.get("x-nextjs-cache") === "HIT",
    `${assignmentsOf(sideA2.body)} ${sideA2.res.headers.get("x-nextjs-cache")}`,
  );
  check(
    "the URL asked for is private, so a CDN in front can't hand one side's page to the other",
    [sideA, sideA2, sideB].every(({ res }) => res.headers.get("cache-control") === "private, no-cache"),
    [sideA, sideA2, sideB].map(({ res }) => res.headers.get("cache-control")).join(" / "),
  );
  check(
    "the visitor's id is in no path and no page",
    ![sideA, sideA2, sideB].some(({ body }, i) => body.includes([inA, inB, out][i].id)),
  );
  check(
    "a test nobody is in and a campaign not started stay off",
    ![sideA, sideB].some(({ body }) => body.includes("Next season") || body.includes("Black Friday")),
  );
  const forgedPath = assignmentsRoutePath("/sale", {
    experiments: { "new-banner": true, "next-season": true },
    campaigns: { "black-friday": true, "summer-sale": true },
  });
  const forgedAssignments = await get(forgedPath);
  check("a typed assignments path is a 404: a path can't switch a test or a campaign on", forgedAssignments.res.status === 404, forgedAssignments.res.status);
  const draftOnSide = await get(draftLink("/sale"), { ...DECO_HOST, ...as(inA) });
  check(
    "a draft link renders on the draft route, never on a cached assignments path",
    draftOnSide.res.status === 200 &&
      draftOnSide.body.includes(POINTER) &&
      draftOnSide.body.includes("Banner B") &&
      assignmentsOf(draftOnSide.body) === undefined &&
      draftOnSide.res.headers.get("cache-control") === "no-store, private",
    `${draftOnSide.res.status} ${assignmentsOf(draftOnSide.body)} ${draftOnSide.res.headers.get("cache-control")}`,
  );
  // A preview link switches tests and campaigns: even a test at 0% and a campaign not started,
  // on the draft route only, never on a cached path.
  const switched = POINTER.replace(
    "@",
    `?__test=${encodeURIComponent("next-season=on")}&__campaign=${encodeURIComponent("black-friday=on")}@`,
  );
  const preview = await get(`/sale?__draft=${encodeURIComponent(switched)}`, { ...DECO_HOST, ...as(out) });
  check(
    "a preview link switches on a test at 0% and a campaign not started",
    preview.res.status === 200 &&
      preview.body.includes("Next season") &&
      preview.body.includes("Black Friday") &&
      assignmentsOf(preview.body) === undefined,
    `${preview.res.status} ${assignmentsOf(preview.body)}`,
  );

  // ISR, never force-static: the CMS pages are rendered again once they are 10 minutes old.
  const assignmentsPage = readFileSync("src/app/%5Fassignments/[assignments]/[[...path]]/page.tsx", "utf-8");
  const prerender = JSON.parse(readFileSync(".next/prerender-manifest.json", "utf-8"));
  check(
    "the assignments route is ISR at 600 seconds, rendered on demand and cached",
    /^export const revalidate = 600;$/m.test(assignmentsPage) &&
      !/dynamic = "force-static"/.test(assignmentsPage) &&
      "/_assignments/[assignments]/[[...path]]" in prerender.dynamicRoutes,
    Object.keys(prerender.dynamicRoutes).join(", "),
  );

  // The proxy bundle holds no block map: no section component, no React. (Block names do appear:
  // the proxy's CMS handle carries the content, which names each block's type.)
  const entry = readFileSync(".next/server/middleware.js", "utf-8");
  const chunks = [...entry.matchAll(/R\.c\("server\/([^"]+)"\)/g)].map((m) => join(".next/server", m[1]));
  const proxyCode = chunks.map((f) => readFileSync(f, "utf-8")).join("\n");
  check("the proxy bundle was found", chunks.length > 0 && proxyCode.includes("__deco_draft"), chunks.join(", "));
  check(
    "the proxy bundle has no block map and no React",
    !/CartButton|NumberFormat|useState|createElement|react-dom/.test(proxyCode),
    proxyCode.match(/CartButton|NumberFormat|useState|createElement|react-dom/)?.[0],
  );
} catch (error) {
  console.error(error);
  failures.push("crashed");
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
  draftServer.close();
  otlp.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failed\n${log.slice(-4000)}`);
  process.exit(1);
}
console.log("\nall passed");
