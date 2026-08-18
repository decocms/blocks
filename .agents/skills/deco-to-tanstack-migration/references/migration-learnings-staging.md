# Migration Learnings Staging: Index-Per-Target-File From Day One

> Convention for any new epic-scale migration that stages learnings for later
> consolidation into this repo (mirroring what T40 of the farmrio-storefront
> migration did for this file's own `#52`–`#73` gotchas). Adopt this from the
> **first** target, not as a mid-epic restructure.

## The problem this prevents

An early wave of the farmrio-storefront migration staged every target's
learnings in one flat, append-only `migration/LEARNINGS.md`. By the time it
was restructured (2026-07-30), that file had grown to:

- **282,249 bytes (~280KB) / 3,875 lines / 103 entries across 30 targets**

Every subsequent target session that needed to check prior learnings before
starting had no way to slice the file — one giant document with
`## [T<ID>] title — date` headings and no index. A session handed the file
and told to check it, absent explicit "grep, don't read" instructions,
defaults to `Read`-ing the whole thing: **60k+ tokens** just to search,
pushing overall session costs to **150k+ tokens** — far more than comparable
migration-target sessions in other repos, where a target's own scoped
`targets/*.md` file averaged ~100 lines and its `blocks_refs` (the mandatory
domain-knowledge files) were 2–4 files of 300–600 lines each.

The root cause: the staging file had no internal structure to slice by,
despite the fact that it was explicitly staging content *for* the exact
convention this repo already uses for its own gotchas — `gotchas.md` is a
44-line **index** pointing at per-topic files, not one flat document. The
staging area never adopted the pattern it was producing output for.

## The fix, applied mid-epic (works better applied from day one)

Split the flat file into:

- `migration/learnings/INDEX.md` — one line per entry: target, date, title,
  file pointer. Append-only.
- One `migration/learnings/T<ID>.md` per target (plus `GOVERNANCE.md`,
  `T-ORCH.md` for cross-cutting/process entries).

Every load-bearing pointer across the epic's own tooling was updated to
match: the migration protocol doc's own "how to catch up" section, the
orchestration doc's claim-grepping step, hard rules, goal-string template,
and the per-target scaffold template's bootstrap instructions (explicit
"grep the index, don't `Read` the tree" wording).

Result: `INDEX.md` is **~4KB**; each `T<ID>.md` is **1–8KB**. A target
session now pays for grepping the index plus reading one file — typically
**under 2k tokens** — instead of the accumulated cost of every prior target
in the epic.

**The one exception**: the target that consolidates everything into an
upstream PR (this repo's own equivalent of T40) legitimately reads the whole
tree — it's producing the next migration's starting knowledge, a distinct
scope from keeping *mid-epic* sessions cheap.

## Convention for the next migration

1. Create `migration/learnings/INDEX.md` (header + empty entries table) and
   `migration/learnings/GOVERNANCE.md` (append-only rule, one entry per
   learning, never write content directly into `INDEX.md`) **before the
   first target starts**, not after the flat file becomes a problem.
2. Every target's own scaffold/bootstrap instructions should say: "grep
   `learnings/INDEX.md` for your target ID or a keyword, open only the
   matching file(s) it points to — do not `Read` the whole learnings tree."
3. The consolidation target (this epic's T40 equivalent) is the sole
   documented exception to rule 2 — its own bootstrap should say so
   explicitly, so a future session doesn't "optimize" it into scoped
   grepping and miss half the epic's learnings.
4. One entry per learning in `learnings/T<ID>.md` (create the file on first
   use), one line per entry back in `INDEX.md` pointing at it — never
   content in `INDEX.md` itself.
