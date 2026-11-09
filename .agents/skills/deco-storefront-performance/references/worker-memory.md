# Worker memory: measure per deploy, keep big data out of the isolate

Load when: the Worker logs "exceeded memory limit" (128 MB per isolate); memory P90 grew
after a deploy; a proxied sitemap, feed or export is large.

An isolate pays for everything reachable from module scope, for its whole life, in every
isolate. That is **resident** memory. A single request that holds a large body in JS is a
**peak**. They have different fixes, so find out which one you have first.

## 1. What v8 keeps in an isolate

| Holder | Size | Notes |
|---|---|---|
| Content, with `createCMS({ site })` | The release index (`latest.json`, at most 16 MiB) and the previous one; block bodies in an LRU bounded at 32 MiB of JSON text; up to three old revisions' indexes when Studio previews them | Not in the bundle: fetched from the delivery CDN at runtime. Parsed objects take more heap than their JSON text |
| Content without `site` (`content` from `.deco/blocks.gen`) | The whole content module | Bundled, so resident in every isolate |
| Your module scope | Anything you import or build at top level | Large JSON or CSV imports, generated tables, unbounded `Map` caches |
| One request | Whatever it buffers | `await response.text()` on a proxied sitemap is the classic peak |

On v7, the bundled decofile was the largest resident item. A v8 site with `site` set does
not have it. When memory is high on v8, look at your own module scope and your proxies.

## 2. Measure: Cloudflare GraphQL Analytics, per version

The dashboard rounds and hides the percentile you need. Query the same data.

- Endpoint: `https://api.cloudflare.com/client/v4/graphql`, with an API token that can
  read account analytics.
- Dataset: `workersInvocationsAdaptive`. Quantiles `memoryUsageBytesP50…P999` (bytes),
  `cpuTimeP50…P999` and `wallTimeP50…` (microseconds); sums `requests`, `errors`,
  `subrequests`; dimensions `scriptName`, `scriptVersion`, `datetimeHour`,
  `datetimeFiveMinutes`, `status`.

```graphql
query($a: String!, $n: String!, $s: Time!, $e: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 2000, orderBy: [datetimeHour_ASC],
      filter: { datetime_geq: $s, datetime_leq: $e, scriptName: $n }) {
      dimensions { datetimeHour scriptVersion }
      sum { requests }
      quantiles { memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99 cpuTimeP50 cpuTimeP99 wallTimeP50 }
    }
  } }
}
```

Group by `scriptVersion` to attribute memory to a deployed version directly. Narrow to
`datetimeFiveMinutes` once you know the hour. The versions list
(`GET /accounts/{account}/workers/scripts/{name}/versions`) has the deploy time under
`metadata.created_on`, not at the top level. A version's detail lists its bindings, which
answers "is that variable really set in production?".

### Compare two windows honestly

- **Report P90.** It is what sits against the limit. P50 flatters; P999 is noisy.
- **Read memory, CPU and wall time together.** High wall with low CPU is waiting on I/O.
  High CPU with low wall is computing. A story that fits two of them often fails the third.
- **Exclude the rollout** (5 to 10 minutes after the deploy, when two versions mix).
- **Compare windows of similar traffic** (check `sum { requests }`), take the median across
  5-minute buckets, and state how many buckets you used.

### Prove causation

A drop right after your deploy may be someone else's deploy. Any one of these upgrades a
correlation to a cause:

1. **A reversal.** Revert or switch off, and the metric moves back by the same amount.
2. **An independent magnitude match.** A local measurement (parse the same data with
   `node --expose-gc` and compare heap) predicts the same order of change.
3. **A binding diff.** When no commit explains a regression, compare the bindings of the
   last good version with the first bad one. On one store the only difference was one
   added variable, which switched on a code path that had sat inert for weeks.

Without one of these, call the attribution tentative.

## 3. Keep large tables out of the isolate

Any dataset bundled or built at module scope (redirect lists, geo tables, fixtures, a
product feed) is resident in every isolate. Measured on a v7 storefront: moving ~18k
redirect rows out of the bundle cut memory P90 by about 31 MB (−19%).

Move the long tail to Workers KV and look it up per request by key:

```ts
// src/worker-entry.ts — normalize() and withDeadline() are your own helpers
export default createDecoWorker<Env>({
  serverEntry, cms, dev: import.meta.env.DEV,
  routes: async (request, env) => {
    if (request.method !== "GET") return null;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/_serverFn/")) return null;
    const key = `redir:${normalize(url.pathname)}`; // the same normalisation as the upload script
    const hit = await withDeadline(env.REDIRECTS.get(key), 50); // fail open
    if (!hit) return null;
    const [status, to] = [Number(hit.slice(0, 3)), hit.slice(4)]; // value: "301:/new-path"
    return new Response(null, { status, headers: { Location: url.search ? `${to}${url.search}` : to } });
  },
});
```

- Store a small string (`"301:/new-path"`), not JSON: one read, no parse.
- Upload with the exact normalisation the lookup uses. A mismatch is a silent 100% miss.
  Wire the upload into the deploy script so KV is never behind the code.
- Point reads only. Never `list()` on a request path.
- `routes` runs for every request that gets past the CMS redirects, assets and server
  functions included. Return `null` early for paths that are never redirected, so they
  pay no KV read.
- Fail open: race the read against a short deadline and treat a timeout as "no redirect".
- Keep the editor-managed redirects in the `Redirects` block. They are few, and Studio
  edits them. The CMS redirects run before `routes`, so they win.
- A table of a few dozen entries is not worth a KV read per request. Leave it in code.

A large `Redirects` block costs CPU on every request as well as memory. Numbers in
[`render-location.md`](./render-location.md#4-a-large-redirects-block-is-paid-on-every-request).

Also check for module-level caches that never evict (`const cache = new Map()` filled per
request). They grow until the isolate dies. Bound them, or use an upstream cache
(`deco-storefront-caching`).

## 4. Stream large proxied bodies

KV fixes resident memory. A peak is one request materialising a big body: `await
response.text()` on a proxied sitemap, feed or CSV can push a lean isolate over the limit.
If you only rewrite a passthrough response, stream it:

```ts
function rewriteStream(body: ReadableStream<Uint8Array>, replacements: [string, string][]) {
  const to = new Map(replacements);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(replacements.map(([from]) => escape(from)).join("|"), "g");
  const keep = Math.max(...replacements.map(([from]) => from.length)) - 1;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let tail = "";
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      const text = tail + decoder.decode(chunk, { stream: true });
      const safe = text.length - keep; // a match starting here or later may be cut off
      let done = "";
      let last = 0;
      for (const m of text.matchAll(pattern)) {
        if (m.index >= safe) break;
        done += text.slice(last, m.index) + to.get(m[0]);
        last = m.index + m[0].length;
      }
      const cut = Math.max(last, safe);
      done += text.slice(last, cut);
      tail = text.slice(cut);
      if (done) out.enqueue(encoder.encode(done));
    },
    flush(out) {
      const rest = (tail + decoder.decode()).replace(pattern, (m) => to.get(m) ?? m);
      if (rest) out.enqueue(encoder.encode(rest));
    },
  }));
}

// in routes: return new Response(rewriteStream(upstream.body!, [[ORIGIN, url.origin]]), { headers });
```

The usual mistakes: no `flush` (drops the end of the body); holding back a fixed tail and
replacing only the part before it, which misses every match that straddles the cut (the
version above never emits text where a match could still start); and `decode(chunk)`
without `{ stream: true }` (breaks multi-byte characters split across chunks). Test with
chunk sizes from 1 byte up. Drop `content-length` from the copied headers, since the
length changes.

Find candidates: `grep -rnE "await (res|response|upstream)\.(text|arrayBuffer|json)\(\)" src/`
on proxy paths.

## Checklist

- [ ] P90 memory per `scriptVersion`, before and after, with the rollout excluded
- [ ] No large JSON, CSV or generated table imported at module scope
- [ ] No unbounded module-level `Map`
- [ ] Proxied large bodies streamed, never buffered
- [ ] The win proved with a reversal or an independent measurement
