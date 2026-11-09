# Deploy: order, CI and secrets

Code ships with a deploy. Content ships with a publish. The schema is how Studio learns about the
code. Each of the three can break the others if they go out in the wrong order.

## Variables and secrets

| Name | Read by | Secret? | Where it lives |
|---|---|---|---|
| `DECO_SITE` | the CLI; your code, to pass `createCMS({ site })` | no | `wrangler.jsonc` `vars` (Workers), `.env`, or CI env. The CLI also reads `.dev.vars` |
| `DECO_TOKEN` | the CLI only | **yes** | CI secrets, or your shell. Never in the site's runtime env or in git |
| `DECO_STUDIO_URL` | the CLI only | no | Unset, except for a local or staging Studio |
| `DECO_STUDIO_ORIGIN` | the bindings, at runtime | no | Unset, except to trust a local Studio's origin |
| the site token passed as `createCMS({ token })` | your code | **yes** | A runtime secret (for example a Worker secret). Only for hosted telemetry |

Commerce keys and other upstream credentials are runtime secrets of the deploy platform, read by code
and passed as params. Content never holds secrets: `deco check` rejects the old `secret` blocks. On
deco's own hosting, how env vars and secrets are set is `deco-control-plane-ops` (decocms/skills).

`DECO_TOKEN` is a Studio API key. Without it, the CLI runs `npx decocms auth token`, which works on a
laptop after `npx decocms auth login` but not in CI.

## Which commands need what

| Command | `DECO_SITE` | Token |
|---|---|---|
| `deco schema`, `deco schema --check`, `deco content` | no | no |
| `deco check` (production) | yes (else it checks local `.deco/blocks`) | no |
| `deco check --revision` | yes | no |
| `deco pull`, `deco diff` (production) | yes | no |
| `deco pull --draft`, `deco diff --draft`, `deco check --draft`, `deco push`, `deco publish`, `deco drafts`, `deco releases`, `deco schema push` | yes | yes |

## The production pipeline

```text
pull request:  deco schema --check
production:    install -> deco schema --check -> deco check -> deploy -> deco schema push
```

- `deco schema --check` fails when the committed schema doesn't match the code.
- `deco check` checks the **live content** against the **new code**, before the deploy. It catches a
  removed block type, a renamed field or a newly required field while production still runs the old
  code.
- `deco schema push` runs **after** the deploy succeeds, so Studio's forms never describe code that
  isn't live, and only on production. A preview deploy that pushes would let editors save content the
  live code can't render.

GitHub Actions and other platforms: [schema.md](./schema.md#step-5-push-it-on-every-production-deploy).

A content publish from Studio can also break the next deploy's `deco check` (an editor saves something
the next code rejects). That is the gate working: fix the content in a draft, or the code.

## Changes that touch both code and content

**Content needs new code** (a new section, a new field):

1. Merge and deploy the code. The pipeline pushes the schema.
2. Edit in Studio, or `deco push --draft=<name>`.
3. `deco check --draft=<name>`, preview, `deco publish --draft=<name>`.

Publishing first would put content in production that the live code can't resolve.

**Code removes or narrows something content uses** (delete a block type, rename a field, make a field
required):

1. Publish content that no longer uses it, or that fills the new field.
2. Deploy the code. The pipeline's `deco check` passes only after step 1.

To find what uses a block type, `deco pull` and grep `.deco/blocks` for `"__resolveType": "<type>"`
and for references to the saved blocks of that type.

**First deploy of a hosted site:** publish a first release before the deploy that sets `site`, or
every page fails with `LOADER_FAILED`. See [serve-and-studio.md](./serve-and-studio.md#step-3-publish-a-first-release-before-you-deploy-with-site).

## Rollback

- Code: redeploy the previous build. Then run `deco schema && deco schema push` from that commit so
  Studio's forms match it again.
- Content: the CLI has no rollback command; roll back in Studio. First run `deco check --revision=<id>`
  against the code that is live.
  See [content-sync.md](./content-sync.md#releases-and-rollback).

## Page caches

A page cache must key on the content revision, or a publish doesn't show until entries expire. The
TanStack helper `cacheVersion(cms, buildHash, page.url)` gives `<build>.<revision>`. Cache design is
`deco-storefront-caching`.
