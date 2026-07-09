# Memory Analysis Procedures (Node/RSC — `@decocms/nextjs`)

> This file covers **Node/RSC (`@decocms/nextjs`) sites only**. For
> Cloudflare Workers (`@decocms/tanstack`) sites, see Part 1 of `SKILL.md`
> — there is no live CDP session against a production Workers isolate, so
> these step-by-step procedures don't apply there; the tail-worker /
> ClickHouse query plus code-level review of the same failure classes is
> the available substitute.

Step-by-step procedures for analyzing memory in Node processes via CDP.
The underlying methodology (force GC first, then escalate to object/
snapshot inspection only if memory is really retained) is unchanged from
the old Deno-flow version of this skill — only the connection layer and
two API-shape details differ. See `cdp-connection.md` for how `ws` is
established and for `evaluate`/`query_objects`/`call_on` helper
definitions.

## Procedure 1: Quick Memory Check

**Goal:** Determine if memory is a leak or lazy GC. Takes 2 minutes.

```python
# 1. Get memory BEFORE GC
mem_before = await evaluate(ws, "JSON.stringify(process.memoryUsage())")

# 2. Force GC
await send_cmd(ws, "HeapProfiler.collectGarbage")
await asyncio.sleep(0.5)
await send_cmd(ws, "HeapProfiler.collectGarbage")  # twice for thoroughness

# 3. Get memory AFTER GC
mem_after = await evaluate(ws, "JSON.stringify(process.memoryUsage())")
```

**Interpretation:**
- RSS drops >30%? → Lazy GC, not a leak. **Recommend reducing `NODE_OPTIONS=--max-old-space-size`.**
- RSS drops <10%? → Real retained memory. Continue to Procedure 2.

**Recommendation for lazy GC:**
If most memory is reclaimable by GC, the process doesn't have a leak — V8 is just being lazy about collecting garbage. Reduce the max old space size so GC triggers more frequently:

```bash
# In the process's environment or start command:
NODE_OPTIONS=--max-old-space-size=512 node server.js
# or even 256 for small sites
```

This keeps RSS predictable without affecting performance. V8's incremental GC is fast (typically <10ms pauses) so more frequent runs have negligible impact on request latency. Unlike on Cloudflare Workers (no configurable ceiling — see Part 1 of `SKILL.md`), this flag is real and effective on Node.

## Procedure 2: Object Leak Detection

**Goal:** Find leaked Response/Request objects and unconsumed bodies.

### Check Response Objects

```python
resp_id = await query_objects(ws, "Response.prototype")
if resp_id:
    info = await call_on(ws, resp_id, """function() {
        let used = 0, notUsed = 0;
        const leakedUrls = [];
        for (let i = 0; i < this.length; i++) {
            if (this[i].bodyUsed) used++;
            else {
                notUsed++;
                if (leakedUrls.length < 20)
                    leakedUrls.push({
                        url: this[i].url.substring(0, 120),
                        status: this[i].status
                    });
            }
        }
        return JSON.stringify({total: this.length, used, notUsed, leakedUrls});
    }""")
```

**Interpretation:**
- `notUsed` < 5? → Normal (in-flight requests)
- `notUsed` > 50? → **Response body leak.** Bodies are fetched but never consumed (`.text()`, `.json()`, `.arrayBuffer()`, or `.body.cancel()`).
- Check the URLs to identify which code path is leaking (commonly a commerce-app fetch helper in `src/customizations/src/graphql/*/resolvers/`)

### Check Request Objects

```python
req_id = await query_objects(ws, "Request.prototype")
if req_id:
    info = await call_on(ws, req_id, """function() {
        const hosts = {};
        for (let i = 0; i < this.length; i++) {
            try {
                const h = new URL(this[i].url).host;
                hosts[h] = (hosts[h] || 0) + 1;
            } catch(e) {}
        }
        return JSON.stringify({total: this.length, hosts});
    }""")
```

**Interpretation:**
- Hundreds of Request objects to the same host → possible fetch loop or unbounded cache
- `localhost` requests → RSC self-fetches / internal route handlers (normal for Next.js App Router server actions)

## Procedure 3: ArrayBuffer Analysis

**Goal:** Identify large memory consumers in ArrayBuffers.

```python
ab_id = await query_objects(ws, "ArrayBuffer.prototype")
if ab_id:
    info = await call_on(ws, ab_id, """function() {
        let totalBytes = 0;
        const buckets = {
            '0-1KB': 0, '1-10KB': 0, '10-100KB': 0,
            '100KB-1MB': 0, '1-10MB': 0, '10MB+': 0
        };
        const large = [];
        for (let i = 0; i < this.length; i++) {
            const sz = this[i].byteLength;
            totalBytes += sz;
            if (sz < 1024) buckets['0-1KB']++;
            else if (sz < 10240) buckets['1-10KB']++;
            else if (sz < 102400) buckets['10-100KB']++;
            else if (sz < 1048576) buckets['100KB-1MB']++;
            else if (sz < 10485760) buckets['1-10MB']++;
            else buckets['10MB+']++;

            if (sz > 100000 && large.length < 20) {
                try {
                    const preview = new TextDecoder().decode(
                        new Uint8Array(this[i], 0, Math.min(200, sz))
                    );
                    large.push({sizeMB: sz/1024/1024, preview});
                } catch(e) {
                    large.push({sizeMB: sz/1024/1024, preview: '(binary)'});
                }
            }
        }
        return JSON.stringify({
            count: this.length,
            totalMB: totalBytes/1024/1024,
            buckets,
            large
        });
    }""")
```

**Known ArrayBuffer patterns (Node/RSC target — no ~304 MB static V8/ICU buffer here; that was a Deno-specific baseline, not present in stock Node):**
- **`resourceMetrics` JSON buffers (0.3-0.6 MB each)** — OpenTelemetry export batches accumulating. Minor but grows over time.
- **Large JSON buffers (>1 MB)** — ProductListingPage or similar commerce API responses. If appearing in PAIRS, might indicate response body read + original buffer both retained.
- **`data:application/json;base64,...`** — Source maps. Normal, proportional to loaded modules (bigger for dev builds; production builds should have these disabled or externalized).
- **`<!DOCTYPE html>...`** — Rendered HTML / RSC payload strings. If many, SSR/RSC render cache might be unbounded.

## Procedure 4: Heap Snapshot

**Goal:** Get a comprehensive view of all heap objects.

```python
await send_cmd(ws, "HeapProfiler.enable")

MSG_ID += 1
snap_id = MSG_ID
await ws.send(json.dumps({
    "id": snap_id,
    "method": "HeapProfiler.takeHeapSnapshot",
    "params": {"reportProgress": False, "treatGlobalObjectsAsRoots": True}
}))

chunks = []
for _ in range(200000):
    raw = await asyncio.wait_for(ws.recv(), timeout=120)
    data = json.loads(raw)
    if data.get("method") == "HeapProfiler.addHeapSnapshotChunk":
        chunks.append(data["params"]["chunk"])
    elif data.get("id") == snap_id:
        break

snapshot = json.loads("".join(chunks))
```

Alternative for Node without going through CDP manually: the built-in
`v8` module can write a snapshot to disk directly from inside the process
(useful if you can execute code in-process, e.g. via a debug-only admin
route gated to non-production):

```js
import { writeHeapSnapshot } from "node:v8";
const path = writeHeapSnapshot(); // writes a .heapsnapshot file, returns its path
```

That file opens directly in Chrome DevTools' Memory panel (`chrome://inspect` → Memory → Load) without needing a live CDP connection at all — useful when you can get filesystem access to the running container but not a network path to port 9229.

**Parsing the snapshot (via CDP path):**

```python
snap_meta = snapshot.get("snapshot", {})
node_count = snap_meta.get("node_count", 0)
nodes = snapshot.get("nodes", [])
strings = snapshot.get("strings", [])

# Node's snapshot format has a populated `snapshot.meta.node_fields` array
# (unlike Deno's, which was sometimes empty) — prefer reading field count
# from it when present, falling back to the same inference as before:
node_fields = snap_meta.get("meta", {}).get("node_fields", [])
field_count = len(node_fields) if node_fields else len(nodes) // node_count

# V8 node type indices (standard order):
# 0=hidden, 1=array, 2=string, 3=object, 4=code,
# 5=closure, 6=regexp, 7=number, 8=native,
# 9=synthetic, 10=concatenated string, 11=sliced string,
# 12=symbol, 13=bigint, 14=object shape

# Aggregate by type
type_agg = {}
for i in range(0, node_count * field_count, field_count):
    node_type = nodes[i]      # index 0 = type
    name_idx = nodes[i + 1]   # index 1 = name (string table index)
    self_size = nodes[i + 3]  # index 3 = self_size
    # aggregate...
```

**What to look for in the snapshot:**
- `string` type >100 MB → HTML/RSC payload strings or JSON cached in memory
- `native` (type 8) → ArrayBuffers (cross-reference with Procedure 3)
- `closure` count very high → possible listener/callback leak
- `object` with specific names → identify which data structures hold memory

## Procedure 5: Additional Checks

### Open File Descriptors

```python
fds = await evaluate(ws, """
(async () => {
    try {
        const fs = require('fs/promises');
        const entries = await fs.readdir('/proc/self/fd');
        const types = {socket: 0, pipe: 0, file: 0, other: 0};
        for (const entry of entries) {
            try {
                const link = await fs.readlink('/proc/self/fd/' + entry);
                if (link.startsWith('socket:')) types.socket++;
                else if (link.startsWith('pipe:')) types.pipe++;
                else if (link.startsWith('/')) types.file++;
                else types.other++;
            } catch(e) { types.other++; }
        }
        return JSON.stringify({count: entries.length, types});
    } catch(e) { return JSON.stringify({error: e.message}); }
})()
""")
```

No permission system to work around here (unlike Deno's `--allow-read`
gate) — `/proc/self/fd` is available to any Node process on Linux with no
extra flags. On non-Linux hosts, fall back to `process._getActiveHandles().length`.

- 50-100 FDs → normal
- 500+ FDs → possible connection leak or file handle leak

### Map/Set Objects (potential caches)

```python
map_id = await query_objects(ws, "Map.prototype")
if map_id:
    info = await call_on(ws, map_id, """function() {
        const large = [];
        for (let i = 0; i < this.length; i++) {
            if (this[i].size > 10) {
                let keys = [];
                let j = 0;
                for (const k of this[i].keys()) {
                    if (j++ >= 3) break;
                    keys.push(String(k).substring(0, 80));
                }
                large.push({size: this[i].size, keys});
            }
        }
        large.sort((a,b) => b.size - a.size);
        return JSON.stringify({total: this.length, large: large.slice(0, 15)});
    }""")
```

### Node Version and Process Info

```python
ver = await evaluate(ws, """
JSON.stringify({
    node: process.version,
    pid: process.pid,
    platform: process.platform,
    uptimeSec: process.uptime(),
})
""")
```

There is no Node equivalent of Deno's on-disk `DENO_DIR` module-cache walk
— Node resolves modules from `node_modules` on disk but doesn't maintain a
separate compiled-module cache directory in the same sense, so that check
from the old Deno-flow doc has no replacement here and should be skipped
entirely for Node/RSC sites.

## Procedure 6: LRU / In-Memory Cache Inspection

Same generic technique as before — walk `globalThis` (or known module
singletons) looking for objects shaped like an LRU cache. Deco's own
LRU cache (used in the commerce-fetch layer) stores `true` as the value —
a metadata index for tracking, NOT the response bodies themselves — so a
high `calculatedSize` there reflects tracked `Content-Length` totals, not
actual retained memory:

```python
lru = await evaluate(ws, """
(() => {
    const results = [];
    function findLRU(obj, path, depth) {
        if (depth > 3 || !obj) return;
        try {
            for (const key of Object.keys(obj)) {
                try {
                    const val = obj[key];
                    if (val && typeof val === 'object' &&
                        typeof val.max === 'number' &&
                        typeof val.size === 'number' &&
                        typeof val.calculatedSize === 'number') {
                        results.push({
                            path: path + '.' + key,
                            size: val.size,
                            calcSizeMB: val.calculatedSize / 1024 / 1024,
                            max: val.max,
                            maxSizeMB: val.maxSize ? val.maxSize / 1024 / 1024 : null,
                        });
                    }
                    if (depth < 2) findLRU(val, path + '.' + key, depth + 1);
                } catch(e) {}
            }
        } catch(e) {}
    }
    findLRU(globalThis, 'globalThis', 0);
    return JSON.stringify(results);
})()
""")
```

**Interpretation:**
- `size` = number of entries in the LRU
- `calculatedSize` = sum of Content-Length values tracked (metadata, NOT actual memory)
- `max` = maximum number of entries
- `maxSize` = maximum calculatedSize before eviction

If a cache here has no `max`/`maxSize` at all (a plain unbounded `Map`
someone reached for instead of an LRU), that's the leak — flag it for a
real eviction policy rather than tuning GC around it.

## Summary: What's Normal vs What's a Leak (Node/RSC target)

| Metric | Normal Range | Concern Threshold |
|--------|-------------|-------------------|
| RSS after GC | 300-1000 MB | >1.5 GB or growing continuously |
| Heap used | 100-300 MB | >500 MB after GC |
| Response objects (bodyUsed=false) | <10 | >50 |
| ArrayBuffers | <100 MB | >500 MB |
| Open FDs | 50-100 | >500 |
| Promises | 1000-5000 | >50000 |
| RSS drop after GC | 10-50% | If <5%, memory is truly retained |

Baselines are lower than the old Deno-flow doc's numbers because there's
no ~304 MB static V8/ICU buffer baked in and Node's module system doesn't
carry the same on-disk module-cache overhead Deno did — treat these as a
starting point, not an exact transplant from the old thresholds.

## Typical Healthy Memory Profile (after GC)

For a mid-size Next.js/RSC storefront:

```
RSS:       ~600-900 MB
├── Heap:  ~150-250 MB (JS objects)
├── External: ~50-150 MB (ArrayBuffers/Buffers)
└── Native: ~300-500 MB (Node runtime + libuv + JIT + modules)
    ├── V8 JIT compiled code: ~150-300 MB
    ├── Node/libuv runtime: ~100-150 MB
    └── Libraries + thread stacks: ~50-100 MB
```

The native gap is expected for apps loading many modules. It's stable and
should not grow continuously over time — if it does, suspect a native
addon or a large number of long-lived closures rather than the JS heap.
