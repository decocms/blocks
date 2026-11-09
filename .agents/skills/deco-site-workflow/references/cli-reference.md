# `deco` CLI reference (@decocms/blocks 8.10+)

The `deco` bin ships in `@decocms/blocks` (`npx deco`, `bunx deco`, or `deco` in package scripts).
The same commands are importable from `@decocms/blocks/cli` (`runCli`, `schema`, `check`,
`content`).

## Commands

| Command | Flags | Does |
|---|---|---|
| `deco login` | | Prints how to log in: `npx decocms auth login --target=<studio>`, or set `DECO_TOKEN` in CI. Logs nothing in itself |
| `deco pull` | `--draft=<name>`, `--force` | Production, or production plus a draft, into `.deco/blocks` |
| `deco diff` | `--draft=<name>` | `.deco/blocks` against what was pulled, or against a draft |
| `deco push` | `--draft=<name>` (required), `--ours` \| `--theirs`, `--prune` | Changed blocks into a draft, as one save; deletes only with `--prune` |
| `deco publish` | `--draft=<name>` (required), `--message=<text>` | Makes a draft live |
| `deco drafts` | `list` \| `new <name>` \| `discard <name>` \| `url <name>` | Manage drafts |
| `deco releases` | `--cursor=<cursor>` | Published revisions, newest first, 50 a page |
| `deco check` | `--draft=<name>` \| `--revision=<id>` | Content against `.deco/schema.gen.json` |
| `deco content` | `--watch` | `.deco/blocks` into `.deco/blocks.gen.ts`, for content without a site |
| `deco schema` | `--watch` \| `--check` | `.deco/index.ts` into `.deco/schema.gen.json` |
| `deco schema push` | | Uploads `.deco/schema.gen.json` to Studio |
| `deco help`, `--help`, `-h` | | Usage (exit 0). No command at all prints usage and exits 64 |

Details: [content-sync.md](./content-sync.md) (pull, diff, push, drafts, publish, releases),
[check.md](./check.md), [schema.md](./schema.md).

`deco serve` (removed in 8.10.0), `deco dev`, `deco build`, `deco generate` and `deco migrate` are not
commands: `unknown command "<name>"`, exit 64. See [serve-and-studio.md](./serve-and-studio.md).

`deco skills install` copies the skills shipped in `@decocms/blocks` into the site's `.claude/skills`.
It is added separately from the commands above; if `deco --help` doesn't list it, your version
doesn't have it.

## Flags every command takes

| Flag | Does |
|---|---|
| `--root <dir>` | The folder that contains `.deco/` (else: walk up from the current folder) |
| `--json` | stdout carries exactly one JSON object; everything a person reads goes to stderr |
| `--color` / `--no-color` | Force colour on or off (default: on when stdout and stderr are terminals and no `--json`) |

Flag values take `--name=value` or `--name value`. Boolean flags take no value
(`--force=true` is a usage error). Unknown flags and extra arguments are usage errors (64).

## Environment

| Variable | Used for | Default |
|---|---|---|
| `DECO_SITE` | The Studio site of every remote command | none. Looked up in the environment, then `.env`, `.dev.vars`, `wrangler.jsonc`, `wrangler.json`, `wrangler.toml` (`vars.DECO_SITE`) in the root |
| `DECO_TOKEN` | Bearer token for Studio (a Studio API key) | the output of `npx decocms auth token --target=<DECO_STUDIO_URL>` |
| `DECO_STUDIO_URL` | Studio API base | `https://studio.decocms.com` |

Reads of production and of past revisions go to `https://delivery.decocms.com` with no token. Drafts
are resolved through Studio, so they need one.

## Exit codes

| Code | Name | When |
|---|---|---|
| 0 | ok | |
| 1 | failed | `deco check` found errors; `deco schema` had errors or `--check` found the file stale; a bad local file; the CDN answered 4xx; Studio answered another 4xx; any other failure |
| 2 | conflict | `deco push`: a block changed in the draft since your pull |
| 3 | auth | No token; Studio answered 401 or 403; a save refused as unauthorized |
| 4 | network | Studio or the CDN unreachable or timed out (Studio 120 s, CDN 10 s); a 5xx |
| 5 | busy | Studio answered 429, 503 `unavailable`, or 409 `production_moved`; a save stopped part way. Run the same command again |
| 64 | usage | Unknown command or flag, bad flag value, bad draft or revision name, missing `--draft`, no `DECO_SITE`, no `.deco/` for a remote command |

`deco check` and the local commands exit 1 (not 64) when no `.deco/` is found.

## `--json`

Success: `{ "ok": true, …result }`. Failure:

```json
{ "ok": false, "exitCode": 2, "error": { "code": "conflict", "message": "…" }, "conflicts": { … } }
```

`error.code` values worth matching: `usage`, `not_logged_in`, `unauthorized`, `network`,
`unavailable`, `conflict`, `unpushed_changes`, `not_pulled`, `too_large`, `invalid_local_block`,
`invalid_config`, `revision_not_found`, `block_not_found`, `no_schema`, `invalid_schema`,
`check_failed`, `bad_answer`, `http_<status>`, and Studio's own codes (such as `production_moved`).

Per command, the result carries:

| Command | Fields |
|---|---|
| `pull` | `draft`, `revision`, `blocks` (count) |
| `diff` | `draft`, `revision`, `changes: [{ name, status }]` (`changed`, `new`, `deleted`) |
| `push` | `draft`, `pushed`, `batches`, `tookTheirs`, `previewUrl`, `pointer` |
| `publish` | `draft`, `result` (`published` or `up-to-date`), `revision`, `previous` (when published), `draftEmptied`, `changes` |
| `drafts` | `list`: `drafts`. `new`: `draft`. `discard`: `draft`, `discarded`. `url`: `draft`, `previewUrl`, `pointer` |
| `releases` | `live`, `revisions: [{ id, status, meta }]` (`status`: `current`, `listed`, `unreadable`), `nextCursor` |
| `check` | `blocks`, `errors`, `warnings`, `problems` |
| `schema push` | `etag`, `blocksMajor` |
| `login` | `command` |

## Common errors before any command runs

| Message | Exit | Fix |
|---|---|---|
| `no .deco/ found from <dir>; run inside your app or pass --root` | 64 (remote) / 1 | `cd` into the app or `--root` |
| `no .deco/ in <dir>; pass the folder that contains .deco/ as --root` | 64 / 1 | Fix `--root` |
| `no Studio site: set DECO_SITE …` | 64 | Set `DECO_SITE` |
| `DECO_SITE (from <source>) isn't a site name: "<value>"` | 64 | Letters, digits, `.`, `_`, `-` |
| `wrangler.jsonc: invalid JSON: …` | 1 | The CLI parses wrangler files to find `DECO_SITE` |
| `not logged in to <studio>; run: npx decocms auth login --target=<studio>` | 3 | Log in, or set `DECO_TOKEN` |
| `Studio answered 401: … (check DECO_TOKEN, or log in again with npx decocms auth login)` | 3 | New token |
| `Studio (<url>) unreachable (…)` / `timed out`, `the CDN (…) unreachable (…)` | 4 | Network; retry |
