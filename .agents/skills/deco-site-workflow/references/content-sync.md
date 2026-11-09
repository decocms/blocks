# Edit content from the terminal

The remote commands move content between `.deco/blocks` and Studio's hosted CMS for the site named by
`DECO_SITE`. Reads of published content and drafts go to the public CDN. Writes go through the Studio
API with your token. Nothing retries on its own, and nothing goes live except `deco publish`.

Token and site setup: [schema.md](./schema.md), Steps 2 and 3.

## The edit loop

```bash
deco pull                              # or: deco pull --draft=summer-sale
# edit .deco/blocks/*.json (or add files)
deco diff                              # what you changed since the pull
deco push --draft=summer-sale          # one save; prints "preview: <link>"
deco check --draft=summer-sale         # the whole draft against the code
# open the preview link and look at the pages
deco publish --draft=summer-sale --message="Summer sale banners"
```

Adding a page, as an example: pull, copy an existing page's file (it already references the shared
`Header` and `Footer` blocks), give the copy a new file name, `name` and `path`, change its
`sections`, then diff, push, check and preview. Use a block type that is in the deployed code, or
`deco check` fails and Studio has no form for it. What a page's props mean is `deco-site-authoring`.

## pull

`deco pull [--draft=<name>] [--force]`

- Without `--draft`: writes production (the live release) into `.deco/blocks`. With it: production
  with that draft's changes on top.
- Makes the folder hold exactly that content: it writes each block and **removes every other block
  file**.
- Writes `.deco/pull.json`: per block, its hash and its version in the draft.
- Refuses when the folder has changes not pushed:
  `.deco/blocks has 3 changes not pushed (A, B, C); push them, or pull with --force to overwrite them`
  (exit 1). `--force` overwrites them.
- Prints `pulled 42 blocks from production (revision <id>)` or `… from draft <name> (over revision <id>)`.

## diff

`deco diff [--draft=<name>]`

- Without `--draft`: what `.deco/blocks` changes against `.deco/pull.json`, shown against what was
  pulled (or, after a draft pull, against that draft **as it is now**, which the label says).
  `nothing pulled yet: run deco pull` (exit 1) when there is no `pull.json`.
- With `--draft`: the folder against that draft as it is now, ignoring `pull.json`.
- One line per block: `M` changed, `A` new, `D` deleted, each with a field diff. Then
  `3 changes against …` or `no changes against …`.

## push

`deco push --draft=<name> [--ours | --theirs] [--prune]`

- Creates the draft if it doesn't exist (`created draft <name>`).
- Sends only blocks changed since the pull. A block that already equals what the draft shows is
  skipped. With no `pull.json`, every file is new.
- **Deletes are sent only with `--prune`.** Without it the push names what it skipped:
  `not sent: 1 deleted block (Old); push with --prune to send deletes`.
- Each block carries a precondition: its version in the draft when you pulled. If someone changed
  it since, nothing of the save is written and the push **exits 2**:

  ```text
  conflict: Home: changed by <user> at <time>; theirs (-) against yours (+)
  1 block changed in draft summer-sale while you pushed; nothing of this save was written. Pull again, or push with --ours (keep yours) or --theirs (take theirs)
  ```

  - `--ours`: send yours again over theirs.
  - `--theirs`: write their version into `.deco/blocks` for the conflicting blocks and send the rest.
  - `--ours` and `--theirs` together is a usage error (64).
- Pushing to a draft other than the one you pulled drops the preconditions: a name that draft already
  changed comes back as a conflict.
- One push is one save. It must fit **500 blocks and 8 MiB**, and each block **1 MiB**. Otherwise
  nothing is sent: `the 812 changed blocks don't fit one save (…); push fewer at a time`, or
  `block "<name>" is larger than a save can carry (1048576 bytes a block)`. To push a large folder,
  move part of the files out, push, move them back, push again: blocks already pushed are recorded in
  `pull.json` and skipped.
- Busy Studio (exit 5): `Studio is busy (…); 120 blocks saved, the rest not, run deco push again`.
  Run it again; what landed is recorded.
- A file that isn't a valid block stops the push before anything is sent (exit 1), for example
  `.deco/blocks/Home.json: invalid JSON: …`.
- Prints `pushed 3 blocks to draft summer-sale` and `preview: <link>`.

`deco push` does not run `deco check`. Run `deco check --draft=<name>` after it.

## drafts

| Command | Does |
|---|---|
| `deco drafts list` | Each draft: name, who created it, via what, when (`no drafts` when none) |
| `deco drafts new <name>` | Creates it (`draft <name> already exists` if it does) and prints its preview link |
| `deco drafts discard <name>` | Deletes the draft and its changes |
| `deco drafts url <name>` | Prints the preview URL; or the pointer, to open as `?__draft=<pointer>` on the site; or `draft <name> has no object yet: push to it first` |

Draft names: letters, digits and `/ . _ -` after the first character, at most 255. Anything else is
exit 64: `"<value>" isn't a draft name: …`.

## publish

`deco publish --draft=<name> [--message=<text>]`

- Prints what the draft changes against production (same `M`/`A`/`D` view), then publishes.
- `published revision <id>; it is live`. The site follows within about a minute
  ([delivery.md](./delivery.md)). No deploy.
- `nothing to publish: production already has every block of draft <name>` when there is nothing.
- A draft saved during the publish is not emptied, and the CLI warns:
  `draft <name> was saved during the publish, so it wasn't emptied: it still holds its blocks`.
- Exit 5 when production moved during the publish (Studio's `production_moved`): run it again.
- It does not run `deco check`. Run `deco check --draft=<name>` first.

## releases and rollback

`deco releases [--cursor=<cursor>]` lists published revisions, newest first, 50 a page:

```text
<id>  current  2026-11-06T21:10:38Z  <author> via <via>  draft summer-sale  "Summer sale banners"
<id>  2026-11-05T…  <author> via <via>  rollback to <id>
<id>  unreadable  (its meta.json couldn't be read)
more: deco releases --cursor=<cursor>
```

`current` marks the revision `latest.json` names.

There is no rollback command in the CLI. Roll back from Studio. A rollback publishes a new revision
that re-applies an old one, and shows in `deco releases` as `rollback to <id>`. Before you roll back,
check that the old content still fits the code that is deployed now:

```bash
deco check --revision=<id>
```

A rollback to content that uses a block type the code no longer has breaks those pages. Fix forward
with a draft instead in that case.

## Errors worth recognizing

| Message | Exit | Meaning |
|---|---|---|
| `no Studio site: set DECO_SITE …` | 64 | No `DECO_SITE` anywhere ([schema.md](./schema.md)) |
| `no .deco/ found from <dir>; run inside your app or pass --root` | 64 | Wrong folder |
| `deco push needs --draft=<name>` | 64 | `push` and `publish` always need a draft |
| `not logged in to …; run: npx decocms auth login --target=…` | 3 | No token |
| `Studio answered <status>: <message>` | 1, 3, 4 or 5 | Studio's own error, mapped to an exit code ([cli-reference.md](./cli-reference.md)) |
| `the CDN has no revision <id>` | 1 | `pull.json` names a revision the CDN doesn't have: pull again |
| `.deco/pull.json isn't one deco pull wrote; run deco pull` | 1 | Corrupt or hand-edited `pull.json` |
| `Studio refused the save: …` | 1 or 3 | Studio rejected the content or the token |
