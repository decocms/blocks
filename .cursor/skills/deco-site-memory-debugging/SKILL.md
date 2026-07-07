---
name: deco-site-memory-debugging
description: Debug memory issues on current deco-start sites. Cloudflare Workers (@decocms/tanstack) sites are diagnosed via the tail-worker exceededMemory/exceededCpu capture in ClickHouse plus wrangler tail/dev — there is no live production process to attach to. Node/RSC (@decocms/next) sites use Node's own --inspect CDP flow (process.memoryUsage(), forced GC, heap snapshots).
---

# Deco Site Memory Debugging

Two runtime targets, two different diagnostic stories — pick the section that matches how the site is deployed.

| Site built on... | Runtime | Diagnostic path |
|---|---|---|
| `@decocms/tanstack` | Cloudflare Workers (`wrangler deploy`) | No persistent process to attach a debugger to. Diagnose via tail-worker-captured `exceededMemory`/`exceededCpu` outcomes in ClickHouse, `wrangler tail`, and local repro under `wrangler dev`. See **Part 1** below. |
| `@decocms/next` | Node/RSC | Real CDP flow via `node --inspect` — same underlying methodology as the old Deno flow (force GC, heap snapshot, Response-leak detection), different API surface. See **Part 2** below, `cdp-connection.md`, `memory-analysis.md`. |

> **Superseded content.** This skill previously assumed Deno-on-Kubernetes
> (`Deno.memoryUsage()`, CDP over `kubectl port-forward` into a pod's port
> 9229, Deno-specific V8 inspector quirks). That deployment model does not
> exist for current deco-start sites — neither Cloudflare Workers nor
> Node/RSC exposes `Deno.memoryUsage()` or lives in a `kubectl`-managed
> pod. `cdp-connection.md` and `memory-analysis.md` are now written for
> **Node/RSC (`@decocms/next`)** specifically; if you're debugging a
> legacy Deno/Fresh/Knative site outside this package split, pull the
> Deno-flow version of this skill from git history instead of following
> the current files.

## When to Use This Skill

- A Cloudflare Workers site is hitting `exceededMemory` / `exceededCpu` outcomes (128 MB / CPU-time isolate limits)
- A Node/RSC site's process memory is high or growing over time
- Need to identify what's consuming memory inside a Node process
- Investigating Response/Request body leaks
- Need to determine if memory is a real leak vs lazy GC (Node target only — Workers isolates don't live long enough for "lazy GC accumulation" to be the diagnosis)

## Quick Start

```
Cloudflare Workers (@decocms/tanstack) — Part 1, no live debugger:
  1. QUERY TAIL CAPTURE   → ClickHouse otel_logs, _source='tail-worker', _outcome IN (exceededMemory, exceededCpu)
  2. STREAM LIVE          → wrangler tail <worker-name> --format pretty
  3. REPRO LOCALLY        → wrangler dev, attach via chrome://inspect (Chrome-shaped CDP)
  4. FIX AT THE CODE LEVEL → no --max-old-space-size knob exists on Workers; reduce actual allocations

Node/RSC (@decocms/next) — Part 2, real CDP flow:
  1. CONNECT INSPECTOR    → node --inspect / kill -USR1 <pid>
  2. GET WS URL           → curl http://127.0.0.1:9229/json/list
  3. CONNECT CDP          → WebSocket to the debuggerUrl
  4. FORCE GC             → HeapProfiler.collectGarbage
  5. ANALYZE MEMORY       → process.memoryUsage() + queryObjects + heap snapshot
  6. DIAGNOSE             → Is it a leak or lazy GC?
  7. RECOMMEND            → Tune NODE_OPTIONS=--max-old-space-size or fix leak
```

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | This overview, the Workers-vs-Node split, and Part 1 (Workers) in full |
| `cdp-connection.md` | Node/RSC only — how to connect to a Node process's inspector and common pitfalls (Node vs the old Deno quirks) |
| `memory-analysis.md` | Node/RSC only — step-by-step memory analysis procedures via CDP |

## Part 1: Cloudflare Workers (`@decocms/tanstack`)

### Why there's no live-heap CDP flow in production

Workers isolates are ephemeral and horizontally distributed — there is no
single addressable "pod" to `kubectl port-forward` into, and no long-running
process to attach a debugger to mid-incident. Memory is hard-capped at
128 MB per isolate; when an isolate exceeds it, Cloudflare kills the isolate
before any in-Worker code — including a would-be CDP responder — can run.
This is a fundamentally different failure mode from a long-running Deno
process slowly accumulating garbage.

### What you actually get

1. **`exceededMemory` / `exceededCpu` outcomes**, captured 100% by the tail
   worker (`deco-otel-tail`) and landing in ClickHouse `otel_logs` with
   `Attributes['_source'] = 'tail-worker'`. See `docs/observability.md`,
   "Error capture — three-channel model".

   ```sql
   SELECT Timestamp, ServiceName,
          Attributes['_outcome'] AS outcome,
          Body
   FROM otel_logs
   WHERE ServiceName = '<site-worker-name>'
     AND Attributes['_source'] = 'tail-worker'
     AND Attributes['_outcome'] IN ('exceededMemory', 'exceededCpu')
     AND Timestamp > now() - INTERVAL 24 HOUR
   ORDER BY Timestamp DESC
   LIMIT 50;
   ```

   Requires the site to have adopted the tail worker per
   `docs/tail-worker-recipe.md` (check `tail_consumers` in the site's
   `wrangler.jsonc` first). If it hasn't, this query returns nothing —
   either onboard the recipe or fall back to the Cloudflare dashboard's
   own per-Worker Metrics panel, which shows exceeded-limit invocation
   counts without the tail worker.

2. **`wrangler tail <worker-name> --format pretty`** for live streaming
   during an active incident. Doesn't show history, but useful for
   reproducing the failure live against real traffic shape.

3. **Cloudflare dashboard → Workers & Pages → \<worker\> → Metrics** shows
   CPU-time percentiles and exceeded-limit counts natively.

### Diagnosing WHY, not just THAT

You can't attach a debugger to the isolate that actually failed, so
root-causing `exceededMemory` means code-level investigation rather than
live inspection — but the *smells* to look for are the same ones the old
Deno methodology targeted:

- **Buffered instead of streamed bodies** — `await res.arrayBuffer()` /
  `.text()` on a large upstream response instead of streaming or bounding
  it. Same "Response body leak" class of bug as before, different
  consequence (128 MB hard kill instead of slow RSS growth).
- **Unbounded per-isolate caches** — isolates are reused across several
  requests, so an in-memory `Map`/array that's never evicted grows
  request-over-request within one isolate's lifetime. Check any hand-rolled
  cache in site code for a missing eviction policy.
- **Large synchronous `JSON.parse`** of full multi-MB commerce API
  responses (VTEX catalog/search payloads in particular) instead of
  extracting only the needed fields.
- **Local repro**: run the same request pattern against `wrangler dev`,
  which runs a real `workerd` isolate under Miniflare and enforces the same
  128 MB limit. `wrangler dev` exposes a real inspector — open
  `chrome://inspect` (or pass `--inspect`) and attach. This is
  **Chrome-shaped CDP**, the opposite of the old Deno quirk:
  `Runtime.queryObjects` returns its array under `result.result`, not
  `result.objects`.
- **No `--max-old-space-size` knob.** The 128 MB ceiling is a platform
  limit, not a tunable V8 flag on Workers — there is no "lower the GC
  threshold" fix here. The only fix is reducing what's actually allocated.

## Part 2: Node/RSC (`@decocms/next`)

If the site's Node process runs as a normal long-lived server (not
serverless/edge), the old Deno flow's underlying methodology still holds —
force GC, compare before/after, take a heap snapshot if memory is really
retained — but every concrete command changes. See `cdp-connection.md` for
the connection flow and `memory-analysis.md` for the analysis procedures,
both rewritten for Node's inspector and `process.memoryUsage()` instead of
Deno's.

This repo does not prescribe a hosting/orchestration layer for
`@decocms/next` sites — if the Node process runs inside a container or
orchestrator, forward its inspector port (9229 by default) the way that
infra provides today (`docker exec` + published port, an SSH tunnel, or
your PaaS's own port-forwarding CLI). There is no `kubectl`-specific step
here because deco-start itself makes no Kubernetes assumption for the
Node/RSC target.

## Key Concept: GC is Lazy (Node/RSC target)

**V8's garbage collector is lazy by design.** It won't collect garbage until memory pressure forces it to. A Node process showing 1.8 GB RSS might drop to 700 MB after a forced GC — meaning there was no leak, just uncollected garbage. (This is the one piece of the old methodology that has no Workers-side analog — see Part 1's "no `--max-old-space-size` knob" note.)

**Always force GC before concluding there's a leak:**

```
HeapProfiler.collectGarbage  (via CDP)
```

Then check `process.memoryUsage()` again. The difference between before-GC and after-GC tells you how much was reclaimable garbage vs actual retained memory.

### Recommendation: Reduce Max Heap Size

If post-GC memory is reasonable but pre-GC memory is causing OOM kills or high process memory:

**Decrease the V8 max old space size** so GC runs more frequently:

```
NODE_OPTIONS=--max-old-space-size=512
```

This forces V8 to GC more aggressively instead of letting garbage accumulate. For most Deco sites this doesn't affect performance because the actual live heap is much smaller than the default limit. The GC runs are fast (milliseconds) and the trade-off is worth it to keep RSS predictable.

Example:
```bash
NODE_OPTIONS=--max-old-space-size=512 node server.js
```

## Memory Breakdown Model (Node/RSC target)

RSS is composed of multiple layers. You must understand what each layer represents:

```
RSS = V8 Heap + V8 External (incl. ArrayBuffers) + Native (untracked)

V8 Heap     → JavaScript objects, closures, strings, compiled code
V8 External → ArrayBuffers, Buffers, TypedArrays
Native      → Node's own C++ runtime, libuv, JIT code cache, mmap'd files, thread stacks
```

Use `process.memoryUsage()` to get the breakdown:
- `rss`: Total resident set size
- `heapUsed`: V8 JavaScript heap
- `heapTotal`: V8 heap capacity
- `external`: V8 external allocations
- `arrayBuffers`: the subset of `external` that's `ArrayBuffer`/`Buffer` — Node reports this as its own field, unlike Deno which folds it into `external` only
- `rss - heapUsed - external` = native/untracked memory

**The native gap is normal.** For a large Next.js/RSC app with thousands of modules, several hundred MB of native memory is expected (JIT compiled code, libuv, module cache). This is NOT a leak by itself.

## Common Memory Consumers

| What | Typical Size | Is It a Problem? |
|------|-------------|-----------------|
| V8 JIT compiled code | ~200-500 MB | No — proportional to loaded modules |
| Response bodies not consumed | Variable, grows | **YES — leak if bodyUsed=false** |
| OpenTelemetry export buffers | ~10-50 MB | Minor — accumulates slowly |
| Rendered HTML / RSC payload strings | ~20-100 MB | Monitor — should be bounded |
| Unbounded in-memory caches (Map/LRU) | Variable, grows | **YES if no eviction policy** |

## Diagnostic Decision Tree (Node/RSC target)

```
Process memory high?
├── Force GC → Memory drops significantly?
│   ├── YES → Not a leak. Recommend reducing NODE_OPTIONS=--max-old-space-size
│   └── NO → Real retained memory. Continue investigation:
│       ├── Check Response objects (queryObjects Response.prototype)
│       │   └── bodyUsed=false count high? → Response body leak
│       ├── Check ArrayBuffers
│       │   └── Many large OTEL/JSON buffers? → Export/cache leak
│       ├── Check heap snapshot top consumers
│       │   └── Large HTML/RSC strings? → SSR cache unbounded
│       └── Large native gap (RSS - heap - external)?
│           └── Normal for large Node apps (JIT + libuv); only a concern if it grows unboundedly over time
```

For the Cloudflare Workers target, there is no equivalent decision tree to
walk through against a live process — see Part 1's "Diagnosing WHY, not
just THAT" instead, which substitutes code-review of the same failure
classes for live inspection.

## Related Skills

- `deco-site-scaling-tuning` — now scoped to legacy Deno/Kubernetes sites only; no current scaling-tuning equivalent exists for Cloudflare Workers or Node/RSC (see that skill's note)
- `deco-incident-debugging` — for general incident response and triage
- `deco-performance-audit` — for deep performance analysis
