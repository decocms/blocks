# `/deco/invoke` → server functions

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

v8 has no invoke endpoint. Every call the browser made through `/deco/invoke` becomes a TanStack Start server function (`createServerFn`, e.g. `src/server/site.functions.ts`) or a Next server action/route handler, taking the request and response headers explicitly (`89895c3`). Validate inputs with zod; reject protocol-relative hrefs. Loaders that 404'd through invoke and fell back to placeholders now return real state: check those flows.

- **One server function per key, imported by the call site.** Name it after the key (`site/loaders/gateway/wishlist/add-item` → `$siteLoadersGatewayWishlistAddItem`) and rewrite each call: `invoke.a.b(props)` → `$aB({ data: props })` (a script over the call sites does most of it; chains split across lines and bracket keys like `["can-spin"]` are the usual misses). The server function imports its handler module and calls it with the props and the request, then forwards the cookies the handler set. Never a `runInvoke(key)` lookup over the commerce-loader map: that is v7's endpoint again.
- **v7's invoke passed no app context.** It called `handler(body, request)`. A site loader that reads its third argument (account, secrets) worked when a page ran it (the block map passed them) and threw through invoke. Give its server function the context the block map passes.
- **Keys v7 had no handler for** failed with "handler not found". Keep them failing explicitly at the call site (a rejected promise with a comment saying v7 failed too), not as stubs in a rebuilt `invoke` tree, and list them as follow-ups.
- **Check the client bundle.** TanStack Start's compiler replaces each handler with an RPC stub and drops its imports; grep `dist/client` JavaScript (not source maps) for secret env names and `node:async_hooks` after the build.
- v7's generated `invoke.gen.ts` (cart and session actions) is site code now: export each action as its own server function and delete the ones nothing calls.
