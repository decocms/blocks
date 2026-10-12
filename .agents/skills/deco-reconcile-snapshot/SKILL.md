---
name: deco-reconcile-snapshot
description: v7 only (7.x branch). MOVED to decocms/migrations as the skill `tools-reconcile-snapshot`. Reconciling a migrated TanStack repo against source-repo changes after the migration cut. The `deco-reconcile` CLI itself still lives here, in @decocms/blocks-cli — only the playbook moved.
---

# Moved: snapshot reconciliation

> **v7 only.** This skill targets v7 sites (`@decocms/blocks` 7.x with `@decocms/tanstack`/`@decocms/nextjs`) and is maintained on the [`7.x` branch](https://github.com/decocms/blocks/tree/7.x); paths such as `packages/blocks-cli`, `packages/tanstack` or `packages/apps-*` loaders refer to that branch. To move a v7 site to the next major, use `deco-v7-to-v8-migration`.

This playbook now lives in **`decocms/migrations`**, as `tools-reconcile-snapshot`
(`tools/reconcile-snapshot/SKILL.md`), translated to English.

The **`deco-reconcile` CLI stays here**, in `@decocms/blocks-cli` — it is
framework tooling. What moved is the procedure for using it during a
migration, which only makes sense with a source that kept moving and a target
cut from it.

The `parity` plugin vendors it and runs it in its `source-drift` phase, which
also records the commit the migration was cut from — the one input
`deco-reconcile --snapshot` cannot work without.

**Do not re-create the playbook here.** Edit it in `decocms/migrations`.
