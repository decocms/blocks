# Generator Defaults → `.deco/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** blocks-cli generators default their outputs into `.deco/` (the framework's folder); release as 7.5.0; migrate the three tanstack sites and fila.

**Architecture:** Flip four default paths in `packages/blocks-cli/scripts/` (generate-blocks, generate-loaders, generate-sections, generate-schema) with a loud legacy-artifact warning; `generate-invoke` deliberately stays at `src/server/invoke.gen.ts` (app server-function code — TanStack Start's compiler transforms its `createServerFn().handler()` calls; framework artifacts vs app code is the declared boundary). Update the scaffolding CLI (`migrate.ts`), skills under `.agents/skills/`, and `packages/nextjs/README.md`. Release (feat → 7.5.0, lockstep). Then per site: bump, `git mv` artifacts, repoint imports, regenerate, verify, push.

**Tech Stack:** same as prior plan (bun monorepo, vitest; sites: vite/tanstack ×3 + Next/fila).

## Global Constraints

- User-approved BREAKING behavior change shipped as `feat:` (7.5.0) — v7 is the accepted breaking line; do NOT add a `BREAKING CHANGE` footer (it would trigger 8.0.0).
- New defaults: `generate-blocks` → `.deco/blocks.gen.ts` (and its sibling `.json` — read the script: the `.json` path may be derived or separate); `generate-loaders` → `.deco/loaders.gen.ts`; `generate-sections` → `.deco/sections.gen.ts`; `generate-schema` → `.deco/meta.gen.json`. `generate-invoke` default UNCHANGED (`src/server/invoke.gen.ts`) — document why in its header comment.
- Legacy guard in each flipped script: when NO explicit out flag was passed AND the old default file exists on disk, print a one-line stderr warning (old path found, new default, "move the file and update its importers") — then write to the NEW default anyway.
- Explicit flags always win, no warning when a flag is passed.
- Existing tests must stay green; add coverage for the flipped default + the warning where the script already has a test harness (generate-sections.test.ts / generate-schema tests); don't build new harnesses for scripts without one (generate-blocks has generate-blocks.test.ts — check what it covers).
- `.deco/` may not exist in a fresh site — every flipped script must `mkdirSync(dirname(outFile), { recursive: true })` (some already do; verify each).
- Do NOT edit `docs/superpowers/plans/2026-07-08-nextjs-glue-tier.md` (historical record).
- Monorepo gates per task: `bun run --filter='./packages/blocks-cli' test` + `typecheck`.
- Site gates: tanstack sites' known pre-existing typecheck baselines (~32/41/42 errors) must not grow; dev-boot smoke: `/` 200 + `/live/_meta` 200; fila: tsc clean, deco jest suites, `/.decofile` + `/live/_meta` 200.
- No `git clean`; never delete untracked files beyond explicit moves.

---

### Task 1: blocks-cli — flip defaults + legacy warnings + scaffolding/doc updates

**Files:**
- Modify: `packages/blocks-cli/scripts/generate-blocks.ts`, `generate-loaders.ts`, `generate-sections.ts`, `generate-schema.ts` (default path constants + legacy warning + mkdir check)
- Modify: `packages/blocks-cli/scripts/generate-invoke.ts` (header comment only: why it stays in src/)
- Modify: `packages/blocks-cli/scripts/migrate.ts` (the site scaffolder writes files at / references the old defaults — grep `src/server/cms`, `src/server/admin` and update every scaffolded path + template import statements it emits)
- Modify: `packages/nextjs/README.md` (recipe: scripts no longer need `--out`/`--out-file` flags; artifact paths in prose/examples → `.deco/…`; consumers import via a `deco/*` tsconfig path alias → show adding `"deco/*": [".deco/*"]` to paths)
- Modify: `examples/nextjs-smoke` + `examples/tanstack-smoke` if they generate or import any of the four artifacts (grep first; update paths + regenerate if so)
- Test: extend `generate-sections.test.ts` + generate-schema tests

**Steps:**
- [ ] Write failing tests: (a) generate-sections with no `--out-file` writes `.deco/sections.gen.ts` in the fixture dir; (b) when the fixture pre-seeds `src/server/cms/sections.gen.ts` and no flag is passed, stderr contains a legacy warning naming both paths and the new file is still written. Mirror for generate-schema if its test harness supports subprocess fixtures (it may be unit-only — then cover schema via one subprocess case following generate-sections.test.ts's pattern).
- [ ] Implement: shared helper `warnLegacyArtifact(oldPath, newPath)` in `scripts/lib/` (one-line stderr), flip the four defaults, ensure mkdir-recursive before write in each.
- [ ] generate-blocks: read the script first — it emits BOTH `blocks.gen.ts` and `blocks.gen.json` (tanstack sites have both); make both land in `.deco/` and keep their relative sibling import intact.
- [ ] Update migrate.ts scaffolding + skills references are Task 2's; here update only in-package docs (script header comments, README).
- [ ] Gates: `bun run --filter='./packages/blocks-cli' test && typecheck`; also `bun run --filter='./packages/nextjs' test` (README-only, but cheap).
- [ ] Commit: `feat(blocks-cli): generator outputs default into .deco/ (framework artifacts live in the framework's folder)` — body documents the four flips, the invoke exception + rationale, and the legacy warning.

### Task 2: deco-start skills + remaining docs

**Files:** every hit of `grep -rln "src/server/cms\|src/server/admin" .agents docs --include="*.md"` EXCEPT the two historical plan files under docs/superpowers/plans/. Known: `.agents/skills/deco-to-tanstack-migration/references/{search.md,platform-hooks-factories.md,platform-hooks/README.md,server-functions/README.md}`, `.agents/skills/deco-migrate-script/SKILL.md`.

**Steps:**
- [ ] For each file: update artifact paths to `.deco/…` where they refer to generate-blocks/loaders/sections/schema outputs; `src/server/invoke.gen.ts` references stay (unchanged default) — read surrounding context, don't blind-replace.
- [ ] Re-grep to confirm only historical plans + invoke references remain.
- [ ] Commit: `docs(skills): generated-artifact paths moved to .deco/`.

### Task 3: release 7.5.0

- [ ] `bun run typecheck && bun run test` (monorepo) green; push v7; monitor `gh run list --repo decocms/blocks --branch v7`; on success verify `npm view @decocms/blocks-cli@7.5.0 version` + spot-check 3 more packages. (Recovery notes if the run fails: delete any orphaned `blocks-v7.5.0` tag before rerunning; npm is pinned to 11.x in release.yml — don't unpin.)

### Task 4: migrate the three tanstack sites (parallel-safe: separate repos)

Per site (`~/code/baggagio-tanstack`, `~/code/casaevideo-tanstack`, `~/code/lebiscuit-tanstack`) — each may have UNCOMMITTED @decocms bump changes in its tree from earlier sessions (package.json/bun.lock at ^7.3.1/^7.4.0): fold them into this commit.

- [ ] `bun update <every @decocms/* dep in package.json>` to ^7.5.0; verify `node_modules/@decocms/blocks-cli/package.json` says 7.5.0.
- [ ] `git mv src/server/cms/{blocks.gen.json,blocks.gen.ts,loaders.gen.ts,sections.gen.ts} .deco/ && git mv src/server/admin/meta.gen.json .deco/` (paths per site — verify with `find src -name "*.gen.*"` first; `site-globals.gen.ts` and `invoke.gen.ts` and `routeTree.gen.ts` STAY).
- [ ] Repoint importers (grep `blocks.gen\|loaders.gen\|sections.gen\|meta.gen` in src/): `src/setup.ts` (three imports), `src/setup/commerce-loaders.ts` (loaders.gen). These sites have no `deco/*` alias — use relative imports (`../.deco/sections.gen` from src/setup.ts; adjust depth per file) OR add the `"deco/*": [".deco/*"]` tsconfig paths alias and use it if vite/vitest resolve tsconfig paths in that site (check for vite-tsconfig-paths or existing paths usage; pick whichever pattern the site already supports, relative is the safe default).
- [ ] Regenerate via the site's own chain (`bun run build` runs generate:*): confirm the generators now write the `.deco/` copies and no stale `src/server/` artifacts reappear (delete any regenerated strays ONLY if the generator wrote them due to explicit flags in the site's package.json scripts — if the site's scripts pass explicit old-path flags, DELETE THE FLAGS to ride the new defaults).
- [ ] Gates: typecheck error count ≤ baseline (32/41/42); dev boot on an isolated port → `/` 200 + `/live/_meta` 200 with real JSON; build completes (lebiscuit + casaevideo have a KNOWN pre-existing `cookiePassthrough.ts` client-bundle build failure — reproduce-on-base rule applies: only require build success where it succeeded at 7.4.0).
- [ ] Commit (fold any pre-existing uncommitted bump changes; message `refactor(deco): gen artifacts in .deco/, bump @decocms/* to 7.5.0`) and push to each site's default branch upstream (check branch + remote state first; if a site's tree has OTHER unrelated uncommitted changes beyond the @decocms bumps, commit only the migration+bump files and report the leftovers).

### Task 5: fila cleanup + final verification

- [ ] `~/code/faststore-fila`: bump @decocms/* to ^7.5.0 (`bun update` + `yarn install`); DROP the now-redundant `--out-file .deco/sections.gen.ts` / `--out .deco/meta.gen.json` flags from the two scripts (defaults now match — keep `--registry`, `--namespace site --site fila --skip-apps`).
- [ ] Regenerate (`bun run generate`), confirm byte-stable artifacts (only regenerated-if-changed noise), gates: tsc clean, `bun jest src/sdk/deco/` 6/6, dev boot `/.decofile` + `/live/_meta` 200, `yarn build`.
- [ ] Commit + push (fetch first — this branch gets external pushes).
- [ ] Ledger + update the setup-reference artifact page (scripts section: flags gone).
