---
name: deco-reconcile-snapshot
description: MOVED to decocms/migrations as the skill `tools-reconcile-snapshot`. Reconciling a migrated TanStack repo against source-repo changes after the migration cut. The `deco-reconcile` CLI itself still lives here, in @decocms/blocks-cli — only the playbook moved.
---

# Moved: snapshot reconciliation

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
