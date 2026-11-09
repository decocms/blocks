---
name: deco-site-workflow
description: "End-to-end workflow for a site on @decocms/blocks 8 with the `deco` CLI it ships. Covers where content lives (.deco/index.ts, .deco/schema.gen.json, .deco/blocks, block names and files), generating the schema (`deco schema`, `--check`, `--watch`) and sending it to Studio (`deco schema push`, run on every production deploy with a DECO_TOKEN), validating content (`deco check` against production, a draft or a revision), syncing content (`pull`, `diff`, `push --draft`, `drafts`, `publish`, `releases`, rollback), editing a site in deco Studio now that `deco serve` is gone (8.10+), how published releases reach the site from the CDN, every command, flag, env var (DECO_SITE, DECO_TOKEN, DECO_STUDIO_URL, DECO_STUDIO_ORIGIN) and exit code. Load it when setting up or deploying a v8 site, when Studio asks you to send the schema or connect deco serve, when a deco command fails or exits non-zero, when `deco check` fails, or when content differs between Studio, a draft, local dev and production."
---

# Deco site workflow (@decocms/blocks 8)

A v8 site has two things that change on different schedules:

- **Code**: the block map in `.deco/index.ts` and the functions it registers. It ships with a deploy.
  `deco schema` turns its types into `.deco/schema.gen.json`, which Studio uses to draw forms.
- **Content**: saved blocks (JSON). With `createCMS({ blocks, site })` the site reads them at runtime
  from the delivery CDN. Studio and the `deco` CLI write drafts. Only `deco publish` (or Studio's
  publish) makes a draft live, and no deploy is needed.

The `deco` CLI is the `bin` of `@decocms/blocks`. It connects the two: it sends the schema to Studio,
checks content against the code, and moves content between `.deco/blocks` and Studio.

This skill covers the 8.10+ CLI (content on the CDN). `deco serve` was removed in 8.10.0. See
[serve-and-studio.md](./references/serve-and-studio.md).

## When to load what

| Reference | Load it when |
|---|---|
| [`references/schema.md`](./references/schema.md) | Studio says to send the schema; forms are missing or stale; wiring `deco schema push` into CI or the deploy; `deco schema` fails |
| [`references/serve-and-studio.md`](./references/serve-and-studio.md) | Studio says to connect `deco serve`; connecting a site to Studio; the page doesn't load or edit inside Studio; a draft link shows production |
| [`references/content-sync.md`](./references/content-sync.md) | Editing content from the terminal: `pull`, `diff`, `push --draft`, conflicts, `drafts`, `publish`, `releases`, rollback |
| [`references/check.md`](./references/check.md) | `deco check` prints errors or warnings, or you want it as a gate |
| [`references/content-layout.md`](./references/content-layout.md) | What each file in `.deco/` is, block names and file names, `__resolveType`, references, the built-in blocks, what goes in git |
| [`references/delivery.md`](./references/delivery.md) | A publish doesn't show on the site; a site fails with `LOADER_FAILED`; how the CDN, polling and draft previews work |
| [`references/deploy.md`](./references/deploy.md) | Setting up CI and the deploy: order of schema push, check and publish; where `DECO_SITE`, `DECO_TOKEN` and other secrets live |
| [`references/cli-reference.md`](./references/cli-reference.md) | The exact flags, env vars, exit codes, `--json` output and common error lines of every command |

## The loop, in commands

```bash
# code changed
deco schema                       # .deco/index.ts -> .deco/schema.gen.json (commit it)
deco check                        # production content against this code
# ...deploy, then on production only:
deco schema push                  # Studio's forms follow the deployed code

# content from the terminal
deco pull                         # production into .deco/blocks (or --draft=<name>)
# edit .deco/blocks/*.json
deco diff
deco push --draft=my-change       # never goes live; prints a preview link
deco check --draft=my-change      # the draft as a whole, against this code
deco publish --draft=my-change    # goes live; no deploy
```

Every command finds `.deco/` by walking up from the current folder (or takes `--root`). Every command
takes `--json`.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | |
| 1 | failed (check errors, bad file, missing schema, CDN 4xx) | Read the message |
| 2 | conflict on `deco push` | Pull again, or push with `--ours` / `--theirs` |
| 3 | auth: no token, or Studio answered 401/403 | Set `DECO_TOKEN`, or `npx decocms auth login` |
| 4 | network: Studio or CDN unreachable, timed out, or 5xx | Retry later |
| 5 | busy: Studio answered 429, 503 `unavailable` or 409 `production_moved` | Run the same command again |
| 64 | usage: unknown command or flag, no `DECO_SITE`, no `.deco/` for a remote command | Fix the command line or config |

## Get these skills into a site

These skills live in the `decocms/blocks` repository, under `.agents/skills/` on `main`. The
`@decocms/blocks` package doesn't ship them and the `deco` CLI has no command that installs them.
Copy or link the folders you need into the site's `.claude/skills`.

## Related skills

- `deco-cms-schema`: how a Props type becomes a form, and the shapes that break it.
- `deco-site-authoring`: writing sections, pages and loaders.
- `deco-tanstack-site` / `deco-nextjs-site`: wiring `createCMS`, routes, the worker, the Studio bridge.
- `deco-make-editable`: turning hardcoded content into blocks and seeding it with `deco push`.
- `deco-variants`: multivariate blocks, tests and campaigns.
- `deco-storefront-caching`: page caches keyed on the content revision.
- `deco-v7-to-v8-migration`: sites still on v7 or on bundled content.
- `deco-control-plane-ops` (decocms/skills): env vars, secrets and deploys on deco's hosting.

## Rules

- Never commit a token. `DECO_TOKEN` lives in CI secrets or your shell, not in `.env` files in git.
- `deco push` never publishes. Only `deco publish` goes live. Check the draft before you publish it.
- Commit `.deco/schema.gen.json`. For a site with `DECO_SITE`, keep `.deco/blocks/` and
  `.deco/pull.json` out of git: they are a working copy of Studio's content.
- Push the schema only from production deploys. A preview branch that pushes makes Studio's forms
  describe code that isn't live.
