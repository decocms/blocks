---
name: deco-migrate-script
description: "Internals of the Fresh/Deno to TanStack Start migrator (deco-migrate) in @decocms/blocks-cli: code layout under packages/blocks-cli/scripts/migrate, MigrationContext, phases, transforms, templates, analyzers, smoke checks, Tailwind rename tables, deco-post-cleanup rules, tests. Use when editing or debugging anything under packages/blocks-cli/scripts/migrate* or adding a transform/rule. For running a migration on a site use tools-migrate-script (decocms/migrations)."
---

# Developing the migration script

`deco-migrate` (`packages/blocks-cli/scripts/migrate.ts`, bin `deco-migrate`)
converts a Fresh/Preact/Deno storefront to TanStack Start/React/Cloudflare
Workers in one pass, in place on `--source`. This skill is for changing it.
How to run it, what each phase does from the user's side, the flags, the
`.deco-migrate.config.json` format and how to read `MIGRATION_REPORT.md` live
in the **`tools-migrate-script`** skill in `decocms/migrations` — keep the two
in step when a flag, phase or report section changes.

| Reference | Load it when |
|---|---|
| [`references/extending.md`](./references/extending.md) | Adding a transform, template, smoke check or analyzer; the core types; debugging a transform at the code level |

## Code layout

```
packages/blocks-cli/scripts/migrate.ts   ← entry: arg parsing, phases 0–9, bootstrap, provisioning
packages/blocks-cli/scripts/migrate/
├── types.ts               ← MigrationContext, FileRecord, DetectedPattern, ReviewItem, TransformResult
├── config.ts              ← .deco-migrate.config.json load/validate, resolveSectionConventions
├── source-layout.ts       ← phase 0: classic / modern / mixed / empty
├── colors.ts              ← terminal formatting
├── delete-sets.ts         ← what cleanup deletes
├── phase-analyze.ts       ← 1: scan source, categorise files, detect patterns, extract metadata
├── phase-scaffold.ts      ← 2: generate config + infra files
├── phase-transform.ts     ← 3: the transform pipeline, plus post-transform ~/islands/ repointing
├── phase-cleanup.ts       ← 4: delete old artifacts, static/ → public/
├── phase-report.ts        ← 5: MIGRATION_REPORT.md (isCssReviewItem feeds the CSS section)
├── phase-verify.ts        ← 6: static smoke checks (critical / warning)
├── phase-compile.ts       ← 8: tsc --noEmit, optional vite build, CSS compile check
├── css-compile-check.ts   ← compiles app.css with the site's @tailwindcss/cli
├── phase-cleanup-audit.ts ← 9: runs post-cleanup/ read-only (never --fix from here)
├── analyzers/             ← tailwind-config, theme-extractor, section-metadata,
│                            loader-inventory, island-classifier, htmx-analyze
├── transforms/            ← imports (70+ rules), jsx, htmx-on-events, use-script-handlers,
│                            fresh-apis, ctx-compat, dead-code, deno-isms, timer-types,
│                            picture, tailwind, tailwind-renames, css, color-oklch,
│                            section-conventions
├── templates/             ← package-json (fetches latest npm versions), tsconfig,
│                            vite-config, wrangler, knip-config, routes (__root, index,
│                            $, deco/*), setup, server-entry (server.ts, worker-entry.ts,
│                            runtime.ts), app-css, CI workflow ymls, hooks, commerce-*,
│                            lib-utils, …
└── post-cleanup/          ← rules.ts, runner.ts, shim-classify.ts (deco-post-cleanup)
```

Phase 7 (bootstrap: `bun install`, `generate-blocks`, `generate-invoke`,
`tsr generate`) and the control-plane/analytics provisioning live in
`migrate.ts` itself, not in a phase file.

## Where each playbook phase is implemented

The script covers phases 0–6 of the manual playbook (`deco-to-tanstack-migration`):

| Playbook phase | Implemented in |
|---|---|
| 0 Scaffold | `phase-scaffold.ts` + `templates/` |
| 1 Imports | `transforms/imports.ts` |
| 2 Signals | `transforms/imports.ts` — bulk only; `useSignal` → `useState` stays manual |
| 3 Deco framework | `transforms/fresh-apis.ts`, `transforms/ctx-compat.ts`, `transforms/deno-isms.ts` |
| 4 Commerce | `transforms/imports.ts` |
| 6 Islands | `phase-cleanup.ts` (deletes the directory) + `phase-transform.ts` (repoints imports) |

Platform hooks (5) and phases 7–12 are manual by design.

## Rules that are easy to break

- **One Tailwind rename table.** `transforms/tailwind-renames.ts` is imported by
  `transforms/tailwind.ts` (`className=` rewriter), `templates/app-css.ts`
  (`@apply` rewriter) and the standalone `scripts/tailwind-lint.ts` shipped into
  migrated sites. They used to be three drifting copies — never inline a rename
  table anywhere else. Scale-shift entries are applied by per-token map lookup,
  not sequential regex, so `shadow-sm→shadow-xs` and `shadow→shadow-sm` cannot
  cascade. DaisyUI renames stay conservative: confirmed 1:1 only; structural
  breaks go through `detectDaisyUiV5StructuralIssues` /
  `detectLogicalPropertyConflict` as `MANUAL:` notes.
- **Read before delete.** `analyzers/tailwind-config.ts` extracts
  `tailwind.config.ts` during analyze because cleanup deletes it (it used to be
  deleted unread — #369). Extraction is ts-morph static analysis, never code
  execution: spreads, calls and imported constants become `ReviewItem`s.
- **Transition stubs throw.** Generated stubs (`templates/lib-utils.ts`) must
  throw at runtime pointing at the canonical replacement, never return
  `{}`/`null` — a silent stub typechecks and ships a broken cookie/segment path.
- **The audit is read-only inside the migrator.** `phase-cleanup-audit.ts` never
  passes `--fix`; auto-fix is opt-in through the standalone CLI only, to keep
  the migration's mutation surface predictable. Detection in `post-cleanup/`
  mirrors the post-migration cleanup checklist of the playbook — change both.
- **Compile and audit are complementary.** `phase-compile` catches what `tsc`
  sees (TS5097 from a leftover `.ts` extension, #105; missing exports). Silent
  stubs have valid signatures, so only the audit's pattern matching finds them.
  A new class of silent failure needs an audit rule, not a compile tweak.

## Why not `npx @tailwindcss/upgrade`

Evaluated and rejected for the pipeline. It needs an installed v3 Node project
with a clean git tree, but the Fresh source is Deno (no `package.json` /
`node_modules`); running it on the *migrated* tree would mean synthesizing a
throwaway v3 project that fights the scaffolded `vite.config.ts`/`app.css`; and
it has no stable programmatic API. Its rename table and config→CSS semantics
are mirrored in `transforms/tailwind-renames.ts` and
`analyzers/tailwind-config.ts` instead, where Deno-specific quirks stay under
our control. The CSS compile check likewise shells out to `@tailwindcss/cli`
rather than the internal `@tailwindcss/node` API, which is less stable across
versions.

## Tests

Colocated `*.test.ts` next to each phase, transform, template, analyzer and
post-cleanup module (`scripts/migrate/**`). Run from the repo root:

```bash
bun run --filter @decocms/blocks-cli test
# or one file
bunx vitest run --root . packages/blocks-cli/scripts/migrate/transforms/ctx-compat.test.ts
```

Post-cleanup: CLI `scripts/migrate-post-cleanup.ts`, logic
`scripts/migrate/post-cleanup/`, tests in `post-cleanup/runner.test.ts`.
