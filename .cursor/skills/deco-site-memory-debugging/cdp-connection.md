# CDP Connection Guide (Node/RSC — `@decocms/next`)

> This file covers **Node/RSC (`@decocms/next`) sites only**. Cloudflare
> Workers (`@decocms/tanstack`) sites have no equivalent production
> connection flow — there's no long-running process to attach to. See
> Part 1 of `SKILL.md` for the Workers diagnostic path (tail-worker +
> ClickHouse + `wrangler tail`/`wrangler dev`).

How to connect to a Node process's built-in inspector for memory debugging.

## Prerequisites

- Network access to the Node process's inspector port (default `9229`) — how you get that access depends on your hosting/orchestration layer (see "Reaching the port" below). deco-start does not prescribe a specific host for `@decocms/next`.
- Python 3 with `websockets` package (`pip3 install websockets`)
- The Node process must be started with the inspector enabled, or have it enabled at runtime (see Step 1)

## Step 1: Enable the Inspector

If you control the start command, launch with the inspector already listening:

```bash
node --inspect=0.0.0.0:9229 server.js
# or the break-on-start variant, useful for reproducing a startup-time leak:
node --inspect-brk=0.0.0.0:9229 server.js
```

If the process is already running and you don't want to restart it, send `SIGUSR1` — Node toggles the inspector on/off on this signal without a restart:

```bash
kill -USR1 <pid>
# Node logs the listening address to stderr, e.g.:
# Debugger listening on ws://127.0.0.1:9229/...
```

Check current process memory quickly without the inspector, as a sanity check before going further:

```bash
# From inside the container/host, or via an exec shell into it:
ps -o pid,rss,vsz,comm -p <pid>
```

## Step 2: Reach the Port

`0.0.0.0:9229` only binds locally to that host/container — it does not
publish the port externally. Forward it the way your infrastructure
provides today:

```bash
# Docker
docker exec -it <container> sh -c 'kill -USR1 1'   # enable inspector on PID 1
docker port <container> 9229                        # if published at run time
# or, if not published, an SSH tunnel into the host:
ssh -L 9229:127.0.0.1:9229 <host>

# Any orchestrator with its own port-forward primitive
# (ECS exec, Nomad, a PaaS CLI, etc.) — use its equivalent of
# "open a tunnel to this task's port 9229"
```

There is no `kubectl port-forward` step here — this repo makes no
Kubernetes assumption for `@decocms/next` sites. Replace this step with
whatever your deployment target's actual port-forwarding mechanism is.

## Step 3: Get WebSocket URL

```bash
curl -s http://127.0.0.1:9229/json/list | jq '.[0].webSocketDebuggerUrl'
```

This returns something like:
```
ws://127.0.0.1:9229/f9cf0f05-6e67-4ad6-865f-f418f6b4856c
```

**The UUID changes every time the inspector is re-enabled or the process restarts.** Always fetch a fresh URL.

## Step 4: Connect via Python

```python
import asyncio, json, websockets

WS = "ws://127.0.0.1:9229/<UUID>"
MSG_ID = 0

async def send_cmd(ws, method, params=None):
    global MSG_ID
    MSG_ID += 1
    msg = {"id": MSG_ID, "method": method}
    if params:
        msg["params"] = params
    await ws.send(json.dumps(msg))
    for _ in range(10000):
        raw = await asyncio.wait_for(ws.recv(), timeout=30)
        data = json.loads(raw)
        if data.get("id") == MSG_ID:
            return data
    return None

async def evaluate(ws, expr):
    r = await send_cmd(ws, "Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
        "awaitPromise": True,
        "timeout": 30000,
    })
    if r and "result" in r and "result" in r["result"]:
        return r["result"]["result"].get("value")
    return None

async def main():
    async with websockets.connect(WS, max_size=50*1024*1024) as ws:
        await send_cmd(ws, "Runtime.enable")
        # Your analysis code here...

asyncio.run(main())
```

Note there's no `contextId: 1` pin in `evaluate` above — see pitfall #1
below for why that Deno-specific requirement doesn't apply to Node.

## Common Mistakes and Pitfalls (Node, and how they differ from the old Deno flow)

### 1. `contextId` pinning is NOT required (unlike the old Deno flow)

The previous (Deno) version of this doc required always passing
`contextId: 1` to `Runtime.evaluate` because Deno's inspector floods
`Runtime.consoleAPICalled` events after `Runtime.enable`, occasionally
enough to make an unpinned evaluate target the wrong context. Node's
inspector does not exhibit this specific failure mode — omitting
`contextId` is safe and Node will evaluate in the default context. If you
do see context-mismatch errors in a multi-worker-thread Node process
(`node:worker_threads`), pass the specific `executionContextId` from the
`Runtime.executionContextCreated` event for the thread you care about —
that's a different, legitimate multi-context scenario, not the Deno flood
issue.

### 2. `queryObjects` returns under `result.result`, not `result.objects`

**This is the mirror image of the old Deno pitfall.** Deno's V8 inspector
returned the array under `result.objects`; Node uses the standard CDP
shape, `result.result`:

```python
# CORRECT for Node:
async def query_objects(ws, proto_expr):
    proto_r = await send_cmd(ws, "Runtime.evaluate", {"expression": proto_expr})
    proto_id = proto_r["result"].get("result", {}).get("objectId")
    if not proto_id:
        return None
    qr = await send_cmd(ws, "Runtime.queryObjects", {"prototypeObjectId": proto_id})
    if not qr or "result" not in qr:
        return None
    return qr["result"].get("result", {}).get("objectId")  # <-- result.result, not result.objects
```

If you're porting a script written against the old Deno-flow doc, this is
the single most common bug you'll hit — it'll silently return `None`
instead of erroring.

### 3. Event flooding is lighter, but the drain-loop pattern is still safe to keep

`Runtime.enable` on Node also replays buffered console events, but at a
much smaller scale than Deno's flood in typical Deco workloads. Keeping
the generous drain loop from the old doc is harmless:

```python
for _ in range(10000):
    raw = await asyncio.wait_for(ws.recv(), timeout=30)
    data = json.loads(raw)
    if data.get("id") == MSG_ID:
        return data
```

### 4. The inspector connection drops on process restart, not "port-forward flakiness"

**Symptom.** `ConnectionClosedError` or `ConnectionRefusedError`.

**Cause.** Either the Node process restarted (new PID, new inspector
session, new WebSocket UUID) or whatever tunnel/forward you set up in
Step 2 dropped — there's no Kubernetes-specific "port-forward drops under
load" behavior here since the transport is now whatever your own infra
uses (SSH tunnel, Docker port publish, etc.), so the fix is specific to
that transport.

**Fix.**
1. Confirm the process is still running (`ps`/orchestrator status)
2. Re-establish whatever tunnel you're using
3. Get a fresh WebSocket URL (step 3) — the UUID always changes
4. Script should handle reconnection gracefully

### 5. WebSocket message too large

**Symptom:** `PayloadTooBig` error when taking heap snapshots.

**Fix:** Increase `max_size` on the WebSocket connection:
```python
async with websockets.connect(WS, max_size=100*1024*1024) as ws:
```

### 6. `process.memoryUsage()` shape differs from Deno's

Node's `process.memoryUsage()` breaks `arrayBuffers` out as its own field,
separate from `external` — Deno folded `ArrayBuffer`/external allocations
into a single `external` number. See `memory-analysis.md` and the Memory
Breakdown Model in `SKILL.md` for the corrected field list.

### 7. No `/proc` permission gate — but also no Deno-style resource listing

Deno's permission system blocked `/proc` reads unless explicitly granted;
Node has no such gate, so `/proc/self/fd` (Linux) works unconditionally if
you need open-file-descriptor counts. There's also no direct Node
equivalent of `Deno.resources()` (already removed in Deno 2.x anyway) —
use `process._getActiveHandles()` / `process._getActiveRequests()`
(undocumented but stable in practice across current Node LTS versions) or
`/proc/self/fd` for a coarser count.

### 8. `callFunctionOn` for object analysis — unchanged from the old flow

This part carries over as-is:
```python
async def call_on(ws, obj_id, func):
    r = await send_cmd(ws, "Runtime.callFunctionOn", {
        "objectId": obj_id,
        "functionDeclaration": func,
        "returnByValue": True,
    })
    if not r or "result" not in r:
        return None
    return r["result"].get("result", {}).get("value")

# Example: count Response objects and check bodyUsed
body_info = await call_on(ws, resp_array_id, """function() {
    let used = 0, notUsed = 0;
    for (let i = 0; i < this.length; i++) {
        if (this[i].bodyUsed) used++;
        else notUsed++;
    }
    return JSON.stringify({used, notUsed});
}""")
```
