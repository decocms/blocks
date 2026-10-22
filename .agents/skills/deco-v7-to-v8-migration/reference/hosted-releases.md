# Hosted releases, bundled content and v7 leftovers

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

## Hosted releases and bundled content

**v7 fast deploy becomes the hosted CMS.** A v7 TanStack site that published content without a deploy (`DECO_FAST_DEPLOY` plus a `DECO_KV` namespace) needs `site` on `createCMS` for the same feature (and `token` for hosted telemetry): the site reads its own `DECO_SITE` var and `DECO_SITE_TOKEN` secret and passes them, since the SDK reads no environment variable; without `site` every content change needs a deploy. Put the two `wrangler secret put` commands in the deploy checklist. v7's fast deploy also kept the content out of the bundle; v8 bundles it, and hosted mode loads a second copy. On a site with ~300 saved blocks (11 MB of JSON), Node measured about 13 MB per parsed copy, plus the bundled module's source (about the size of the JSON) and a transient string up to twice the JSON while a snapshot parses: under the Workers 128 MB limit, but measure memory and cold start with `wrangler tail` on a preview before turning it on.

With `site` set on `createCMS`, a published release goes live without a deploy, but only for what reads through the CMS client. Before turning it on, grep for direct imports of `.deco/blocks/*.json` (redirects, proxy tables, config blocks) and for build-time scripts that read `.deco/blocks`: those stay on the last deploy. v7 behaved the same, so it isn't a parity break; route them through the client or document the limitation and keep hosted releases off until you do.

## v7 leftovers to delete

- Env vars and comments for the v7 admin protocol (`DANGEROUSLY_ALLOW_PUBLIC_ACCESS`, admin public keys) and for settings that lived in the v7 `site` app block.
- Middleware/proxy exclusions for `/deco`, `/live` and `/.decofile`: the routes are gone. Removing the exclusion sends these paths down the unknown-path route, which may ask upstream (a redirect lookup) on every stray hit from old tooling and scanners; keeping it may send them to a catch-all that does worse (a search fallback answering 200). Skip the upstream work for them explicitly, and check the status (404) and the upstream calls for each path in the parity run.
- Add the site's new env vars (`DECO_SITE`, `DECO_SITE_TOKEN`, which the site passes as `createCMS({ site, token })`) to its env example, the token marked secret, and blank them in parity runs.
- **Editor settings that disappear with the `site` block.** Deleting the v7 `site` app block (apps are code now) also deletes any setting editors changed there, such as the site's name. Moving it to code is fine, but it is an editor-visible change: list it for the product owner. Its preview hosts need nothing: Studio writes where each site previews into the release metadata, and `createCMS({ site })` reads them.
