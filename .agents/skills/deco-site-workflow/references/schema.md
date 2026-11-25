# Send the schema to Studio

Studio draws its editor forms from a schema the site sends. Studio never runs your code. If it has
no schema for the site, or an old one, its forms are missing or wrong. This page takes a site from
"Studio asks for the schema" to "every production deploy sends it", with nothing else to read.

## What the schema is

- `.deco/index.ts` (or `.deco/index.tsx`) default-exports the **block map**: an object of named
  functions. Each function's first parameter type becomes a form.
- `deco schema` reads that file with the site's own TypeScript and writes `.deco/schema.gen.json`.
  The file declares `"blocksMajor": 8`. Studio treats a site as v8 only from that field.
- `deco schema push` uploads that file to Studio for the site named by `DECO_SITE`.

How a Props type maps to fields (JSDoc tags, widgets, shapes that break a form) is the
`deco-cms-schema` skill.

## Step 1: generate it

Requirements: `@decocms/blocks` 8 and `typescript` (a peer dependency) installed in the site.

```bash
npx deco schema
```

On success it prints one line:

```text
wrote .deco/schema.gen.json from index.ts (12 sections, 3 loaders, 0 matchers, 2 pages, 1 content types)
```

(`unchanged` instead of `wrote` when the file was already up to date.) Commit
`.deco/schema.gen.json`.

If the schema has errors, the file is **not written**, so the committed file never holds a half-right
form. Fix the errors it prints and run it again. Common lines:

| Message | Fix |
|---|---|
| `no .deco/ found from <dir>; run inside your app or pass --root` | Run from the app folder, or `--root <dir>` |
| `no .deco/index.ts (or .deco/index.tsx) in <root>; it holds your block map` | Create the block map |
| `.deco/index.ts: no default export; export your block map as the default` | `export default { … } satisfies Blocks` |
| `.deco/index.ts: "<key>" isn't a function` | Every value in the map must be a function |
| `deco schema reads your types with TypeScript, which isn't installed: …` | Add `typescript` to devDependencies |
| warning `"<key>": its props are typed any, so its form is empty` | Type the first parameter |
| warning `"<key>": returns any, so it isn't offered for any field` | Type the return value |
| warning `"<key>": its first parameter isn't an object of props, so its form is empty` | Take one props object |
| `"<key>": has a "path" field but its type doesn't extend Route (name: string; path: string)` | A `path` field makes a block routable: give its type `name` and `path`, or rename the field |

Run `deco schema` before `dev` and `build`, so the file follows the code:

```json
{
  "scripts": {
    "predev": "deco schema",
    "prebuild": "deco schema"
  }
}
```

`deco schema --watch` regenerates on every `.ts`/`.tsx` change (it skips `node_modules`, `dist`,
`.git*` and `*.gen.ts`, and also watches files outside the root that the block map imports, such as
monorepo packages). Stop it with ctrl-c.

## Step 2: tell the CLI which site

The CLI reads `DECO_SITE`, first match wins:

1. the environment;
2. `.env`, then `.dev.vars`, in the folder that contains `.deco/`;
3. `vars.DECO_SITE` in `wrangler.jsonc`, `wrangler.json`, then `wrangler.toml` (the `[vars]` table or
   a top-level inline `vars = { … }`), same folder.

The value is Studio's site name: letters, digits, `.`, `_`, `-`, starting with a letter or digit.
Studio finds the organization from the site; the CLI never takes one. A `DECO_SITE` committed in
`wrangler.jsonc` `vars` (or another file in the list) is found in CI too, with no extra setup.

Missing everywhere: exit 64 with
`no Studio site: set DECO_SITE in the environment, or in <root>'s .env, .dev.vars, or vars.DECO_SITE of wrangler.jsonc, wrangler.json or wrangler.toml (looked in that order)`.

## Step 3: a token

The CLI sends `Authorization: Bearer <token>` to Studio. It takes the token from:

1. `DECO_TOKEN`, when set (this is the CI path): a Studio API key, or, for `deco schema push` only,
   the site's own site token (the one the site passes to `createCMS({ token })`, issued in the
   project's settings). A revoked site token gets 401;
2. else the output of `npx decocms auth token --target=<DECO_STUDIO_URL>` (Studio CLI's session; the
   CLI has no login of its own). Log in once with `npx decocms auth login --target=https://studio.decocms.com`.
   `deco login` prints that command.

No token: exit 3, `not logged in to https://studio.decocms.com; run: npx decocms auth login --target=https://studio.decocms.com`.
A token Studio rejects: exit 3, `Studio answered 401: … (check DECO_TOKEN, or log in again with npx decocms auth login)`.
A 403 is also exit 3: Studio refused the token for this site.

`DECO_STUDIO_URL` changes the Studio API base (default `https://studio.decocms.com`). Leave it unset
unless you run a local or staging Studio.

## Step 4: push it

```bash
npx deco schema push
```

It reads `.deco/schema.gen.json` as it is on disk (it does not regenerate it) and sends it to Studio.
Success:

```text
pushed .deco/schema.gen.json (a v8 schema)
```

`(not a v8 schema)` means the file has no `"blocksMajor": 8`: an older generator wrote it. Run
`deco schema` again, commit, push again.

| Message | Exit | Fix |
|---|---|---|
| `no .deco/schema.gen.json; run deco schema first` | 1 | Run `deco schema` |
| `.deco/schema.gen.json: invalid JSON: …` | 1 | Regenerate it |
| `deco schema push takes no --watch or --check` | 64 | Drop the flag |
| `Studio (…) unreachable (…)` / `timed out` | 4 | Network; retry |

Reload Studio. The forms now follow the pushed schema.

## Step 5: push it on every production deploy

Studio should describe the code that is live. So push from the job that deploys production, after
the deploy succeeds, and never from preview branches. In pull requests, check that the committed file
is current instead.

GitHub Actions, as a sketch (adapt the install and deploy steps to the site):

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      DECO_TOKEN: ${{ secrets.DECO_TOKEN }}   # a Studio API key, or the site token
      # DECO_SITE: my-store                   # only if it isn't in wrangler.* vars or .env
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx deco schema --check          # committed file matches the code
      - run: npx deco check                   # live content fits this code
      - run: npm run deploy                   # your deploy
      - run: npx deco schema push             # Studio's forms follow what just went live
```

```yaml
# pull requests
- run: npx deco schema --check
```

`deco schema --check` writes nothing. It exits 1 when the file is missing or stale and prints what
moved, for example `sections: new in code: hero` or `2 schema definitions changed (fields or
choices)`, then `Run \`deco schema\` and commit .deco/schema.gen.json.` It exits 0 with
`.deco/schema.gen.json is up to date with index.ts`.

If the deploy runs somewhere else (Cloudflare Workers Builds, a hosting control plane), run
`deco schema push` in that platform's production deploy command after the deploy, with `DECO_TOKEN`
as a secret build variable. Where deco's hosting keeps env vars and secrets is in
`deco-control-plane-ops` (decocms/skills). The ordering with `deco check` and `deco publish` is in
[deploy.md](./deploy.md).

## Checklist

- [ ] `typescript` installed; `deco schema` prints `wrote` or `unchanged`
- [ ] `.deco/schema.gen.json` committed, with `"blocksMajor": 8`
- [ ] `DECO_SITE` resolvable from the app folder
- [ ] `deco schema push` prints `(a v8 schema)`
- [ ] Production deploy job runs `deco schema push` with `DECO_TOKEN` from secrets
- [ ] Pull requests run `deco schema --check`
