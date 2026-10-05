---
name: run-migration
description: "Dev loop for the migrator in this repo: reset a target site workspace to its Fresh/Deno state (origin/main) and run the local packages/blocks-cli migrate script against it. Use when testing a migrator change on a real site, or asked to 'run the migration' on a site from here. Not for sites already on TanStack that only need the @decocms/start 6.x → 7.x upgrade (use upgrades-decocms-v6-to-v7 in decocms/migrations)."
---

# Run Deco Migration (Fresh/Deno → TanStack)

Runs the Fresh→TanStack migrator from a local checkout of this repo against a target site. The migrator lives in `packages/blocks-cli/scripts/migrate/` (entry point `packages/blocks-cli/scripts/migrate.ts`, also published as the `deco-migrate` bin of `@decocms/blocks-cli`). It scaffolds directly onto the split 7.x packages (`@decocms/blocks`, `@decocms/tanstack`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/apps-*`).

**Scope check first:** this flow is for sites still on Fresh/Deno/Preact. If the target is already a TanStack Start site and only its `@decocms/start@6.x` + `@decocms/apps@5.x` dependencies are outdated, do NOT run the migrator — follow the `upgrades-decocms-v6-to-v7` skill in decocms/migrations instead.

## How to use

1. **Identify the target site workspace.** The user will specify which site to migrate. Its `origin/main` must hold the original Fresh/Deno code.

2. **Reset the target to Fresh/Deno state:**
   ```bash
   cd <target-dir>
   git checkout origin/main -- .
   git checkout -- .
   git clean -fd
   ```
   This restores the original Fresh/Deno source code.

3. **Remove old install artifacts** (migration generates a new package.json):
   ```bash
   rm -rf node_modules package-lock.json bun.lock
   ```

4. **Run the migrator from your local checkout of this repo:**
   ```bash
   cd <target-dir>
   npx tsx <path-to-this-repo>/packages/blocks-cli/scripts/migrate.ts --verbose
   ```
   The script uses `--source .` by default (current directory). Other flags: `--dry-run`, `--help`.

   Against published packages instead of a local checkout, the equivalent is `npx -p @decocms/blocks-cli deco-migrate [options]`.

5. **Check the output** for errors and review the generated `MIGRATION_REPORT.md`.

6. **If the user wants to test locally** after migration:
   ```bash
   cd <target-dir>
   bun install   # or: link the split packages against your local checkout first
                 # (bun link in each packages/* dir, then bun link <pkg> here)
                 # when testing unpublished framework changes
   bun run build
   bun run dev
   ```

7. **Post-migration passes** (both ship in blocks-cli): `npx -p @decocms/blocks-cli deco-post-cleanup` audits generated stubs and soft adapters (`--fix` applies the safe rules); the verification gates in the `upgrades-decocms-v6-to-v7` skill (decocms/migrations) (regeneration idempotency, typecheck baseline diff, dev smoke on `/`, `/live/_meta`, `/.decofile`) apply to migrated sites the same way.

## Important notes

- The migrator's phases (Analyze → Scaffold → Transform → Cleanup → Report → Verify) and its per-phase sources live in `packages/blocks-cli/scripts/migrate/` — changes there are picked up immediately when running via tsx (no build step).
- The migrator's DETECT patterns intentionally match legacy `@decocms/start` / `@decocms/apps` code in target sites — that is how it finds what to transform. Never "modernize" those patterns to the new package names.
- NEVER push migration results to the target site's remote without explicit user confirmation.
- After running, check for runtime errors and update the migration script if needed.
