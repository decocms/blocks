# `deco check`: content against code

`deco check` validates saved blocks against `.deco/schema.gen.json`, the schema of the code in your
folder. It writes nothing, generates no schema and loads no TypeScript. So run `deco schema` first,
or it checks against a stale file.

## Which content it checks

| Command | Checks | Needs |
|---|---|---|
| `deco check` with `DECO_SITE` set | **Production**: the live release, read from the CDN | `DECO_SITE`; no token |
| `deco check` with no `DECO_SITE` anywhere | The local `.deco/blocks` (a bundled site) | nothing |
| `deco check --draft=<name>` | Production with that draft on top | `DECO_SITE` and a token |
| `deco check --revision=<id>` | One published revision (ids from `deco releases`) | `DECO_SITE` |

`--draft` and `--revision` together are a usage error (64). A malformed id is
`"<id>" isn't a revision id (deco releases lists them)` (64). An id the CDN doesn't have is
`no revision <id> on the CDN` (1).

**Trap:** on a hosted site, plain `deco check` ignores your local edits in `.deco/blocks`. It checks
production. To check edits, push them to a draft and run `deco check --draft=<name>`. Pushing never
publishes, so this is safe.

It prints `checking production (revision <id>)` (or the draft or revision), then problems grouped by
file, then a summary:

```text
.deco/blocks/Home.json
  sections[2].title: 214 characters, max 60
  warning: sections[4]: can never be picked: variants[0] has an always rule
39 saved blocks checked: 1 error, 1 warning
```

Exit 0 when there are no errors (warnings don't fail it), 1 otherwise. With `--json`, stdout is
`{ ok, blocks, errors, warnings, problems: [{ file, path, message, severity }] }`.

## Use it as a gate

- **Before a deploy:** `deco schema && deco check` checks that the live content fits the new code. A
  removed block type, a renamed or newly required field shows up here, before the deploy breaks pages.
- **Before a publish:** `deco check --draft=<name>`. `deco publish` doesn't check.
- **Before a rollback:** `deco check --revision=<id>`.

Where these go in CI: [deploy.md](./deploy.md).

## Field errors

Each line is `<path>: <message>`, with the path inside the block (`sections[2].title`).

| Message | Means | Fix |
|---|---|---|
| `required` | The type requires a field the content lacks | Add it, or make the field optional in the type |
| `unknown field` | The content has a field no type declares | Delete it, or add it to the type |
| `214 characters, max 60` / `min` | String length outside the type's limits | Shorten the text or relax the limit |
| `5, max 3` / `min`, `must be under`, `must be over` | Number out of range | |
| `4 items, max 3` / `min` | List length out of range | |
| `"xl" isn't one of "sm", "md", "lg"` | Not an allowed option | Use one of them, or add it to the type |
| `expected a string, got a number` | Wrong JSON type | |
| `"…" isn't a valid date-time` | Format check (`date`, `date-time`, `uri`) | ISO dates with an offset; absolute URLs |
| `doesn't match the pattern …` | Pattern check | |
| `doesn't match any allowed form` | A union where no branch fits | Compare with each branch of the type |

How types and JSDoc tags turn into these rules is the `deco-cms-schema` skill.

## Block errors

| Message | Means | Fix |
|---|---|---|
| `no saved block or block type "<name>"` | `__resolveType` names nothing: a deleted saved block still referenced, or a type the code no longer exports | Remove the reference, restore the block, or deploy the type first |
| `"<type>" doesn't fit here: its function doesn't return this field's type` | A block in a field whose type it doesn't produce | Use a block of the right kind |
| `"<type>" doesn't fit here: this field takes a plain value` | A block where a plain value is expected | Write the value |
| `saved block "<name>" (a "<type>") doesn't fit here: …` | A reference to a saved block of the wrong kind | Reference another block |
| `this field is Lazy<T>: wrap the value in a lazy block` / `a lazy block only fits a Lazy<T> field` | Lazy fields need `{ "__resolveType": "lazy", "value": … }`, and only they take one | Wrap or unwrap |
| `references form a cycle: A → B → A` | Saved blocks that reference each other | Break the loop |
| `saved block "<name>" has the name of an alias` | A saved block named like a v7 alias | Rename it |
| `"<path>" is also the path of "<other>"` / `matches the same URLs as …` | Two pages (or two redirect `from`s) route the same URLs | Change one path |
| `a rule must be a block whose function returns a boolean` | A variant `rule` that isn't a matcher | |
| `a variant's value must be a lazy block` | Variant values are wrapped in `lazy` | |
| `no test "<name>" in the saved block "experiments": this rule is always false` | An `experiment` rule names a missing test | Add the test or fix the name |
| `no campaign "<name>" in the saved block "campaigns": this rule is always false` | Same, for campaigns | |
| `unknown block type "date": …` | The prerelease `date` rule | Use a `campaign` rule as the message says |
| `unknown block type "secret"` (or `telemetry`, `analytics`, `date-windows`) `: …` | A removed built-in | Follow the message. Secrets belong in the deploy platform, read by code |

## Warnings

| Message | Fix |
|---|---|
| `can never be picked: variants[i] has an always rule` | Variants after an `always` rule are dead: reorder or delete |
| `this campaign rule names no campaign, so it is always false: …` | Name a campaign |
| `the campaign "<key>" ends before it starts, so it never runs: …` | Fix the dates |
| `not routed; move it into the redirects block` | A per-rule `redirect` block: move its rule into `Redirects` |
| `v7 redirect block (type …) isn't routed: …` | Fold its rules into `Redirects` and delete it |
| `another redirects block, "<name>", is the one routed; this one is ignored. …` | Keep one `redirects` block |
| `"CMS" is the name of the CMS settings block …`, `"experiments" is the saved block every experiment rule reads …` | A saved block uses a reserved role name with the wrong type: rename it |
| `the block map has its own "<name>", in place of the built-in: …` | Your block map replaces a built-in. Rename yours unless you mean it |
| `the site editor now keeps the addresses this site can be previewed on, …` | Delete the old `preview` field from the `CMS` block |

## File problems

| Message | Severity | Fix |
|---|---|---|
| `invalid JSON: …` | error | Fix the file |
| `a saved block must be a JSON object` | error | |
| `not a valid entry name (…); rename the file` | error | See the name rules in [content-layout.md](./content-layout.md) |
| `subfolders of .deco/blocks aren't read` | warning | Move the file up |
| `another spelling of "<name>"; <file> wins` | warning | Delete the other spelling |

A file error also stops `deco push` and `deco diff` before they send or compare anything.

## Schema file problems

| Message | Fix |
|---|---|
| `no .deco/schema.gen.json; run deco schema first` | `deco schema` |
| `… has no top-level "blocksMajor"; expected "blocksMajor": 8. …` | Regenerate with the v8 CLI, commit |
