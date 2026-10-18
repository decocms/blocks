# Running the script: before, and dependencies after

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

## Before you run the script

- **Install `@decocms/blocks@^8.4` first** (`^8` resolves to the accidental v7 build published as `8.0.0`). A v7 site already has `@decocms/blocks@7`, which has no `/cli` or `/protocol/keys`; the script fails to import. Keep v7 `@decocms/apps-*` installed until after the run: vendoring copies from them.
- **Commit the script's output unedited** (`046de4d`, `de03793`), then do the manual work in follow-up commits.
- **The script vendors every app loader the content calls**, including ones the v7 site never ran (a v7 Next.js site resolved many VTEX loader blocks to `null`). Check which ones actually rendered before keeping a vendored copy; delete the rest along with the saved blocks nothing references.

- **A generated `invoke.gen.ts` for another platform** (VTEX checkout and session actions on a Shopify store) that nothing imports: delete it and drop that `@decocms/apps-*` dependency; don't port its actions. Check with `grep` that no call site uses it first.
- **Don't reformat vendored request documents.** Running Prettier over `src/` reflows the GraphQL documents in a vendored `queries.ts`, which changes every request body sent upstream: a replaying parity harness then misses every call. Keep such files out of the formatter (`.prettierignore`).
- **Two lockfiles.** A stale `package-lock.json` next to the `bun.lock` the site really installs from (different `@decocms/*` versions) is a trap for CI and deploy tooling that picks the npm lock: delete the stale one in the dependency commit and say so.

## Dependencies

- `bun.lock`: don't commit a lock produced by `bun link`; regenerate once the v8 packages resolve from npm.
- A linked checkout writes `"version": "0.0.0"` into `.deco/schema.gen.json`; the published CLI writes its own version. Commit what a clean `install --frozen-lockfile && build` writes.
