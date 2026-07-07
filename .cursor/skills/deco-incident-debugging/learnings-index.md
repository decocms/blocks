# Learnings Index - Quick Reference

**Status: `learnings/` does not exist in this repo (verified — no
`learnings/` directory anywhere under the repo root or relative to this
skill).** Everything below that references a specific learning filename is
illustrative of the *category* of issue to look for, not a file you can
actually open. Do not `cat` or link to any filename in this document without
first confirming it exists.

## What to use instead, right now

Two real sources document past incidents/fixes in this repo:

1. **`CHANGELOG.md`** (repo root) — human-curated, includes at least one
   behavior-change entry that reads like an incident writeup: "Unreleased —
   Admin async (⚡) toggle is the source of truth for deferral" (fixes
   [#266](https://github.com/decocms/deco-start/issues/266) — sections were
   silently rendering client-side due to position-based auto-deferral).
2. **`git log`** — commit messages tagged `fix(...)` are past incident
   fixes. Example: `a3f9b9c test(cms): add regression test for the
   layout-cache index-corruption race` is a real regression with a root
   cause you can read directly from the diff.

```bash
# Search CHANGELOG.md by symptom keyword
grep -ri "SYMPTOM_KEYWORD" CHANGELOG.md

# Search commit history for past fixes
git log --oneline --grep="fix\|regression\|incident" -i -30
git log --oneline -20 -- <affected-path>

# Read a specific past fix in full
git show <commit-sha>
```

If `learnings/` has been created since this doc was last checked (see
`SKILL.md` for the seeding structure), search it first — it takes priority
over `CHANGELOG.md`/git log because it's purpose-built for this workflow.

---

## Illustrative categories (not existing files)

These are the categories worth searching for, based on issue types this
class of project commonly hits. Treat the "Key Symptoms" column as a search
prompt for `CHANGELOG.md`/`git log`, not a promise that a matching learning
file exists.

### Cache Strategy

| Symptom pattern | Search for |
|------------------|------------|
| High API calls, cache misses, rate limits | `cache`, `stale-while-revalidate`, loader `export const cache` |
| Edge cache not hit despite static content | cookies / `set-cookie` blocking edge cache |

### Loader / Rendering Optimization

| Symptom pattern | Search for |
|------------------|------------|
| 429 errors, high API volume, slow pages | overfetching, N+1, pagination |
| Deferred/lazy sections rendering unexpectedly | `foldThreshold`, async ⚡ toggle — see `CHANGELOG.md` "Unreleased" entry |

### Block Configuration

| Symptom pattern | Search for |
|------------------|------------|
| Missing sections, "not found" errors | `.deco/blocks/*.json` malformed or dangling reference — regenerate via `generate-blocks.ts` |
| Duplicate content, hidden loader errors | loader errors masked by duplicate sections |

### UI / Visual Bugs

| Symptom pattern | Search for |
|------------------|------------|
| Elements not clickable, invisible overlays | empty anchor tags |
| Mobile/desktop layout differences | breakpoint definitions |
| Safari-specific rendering glitches | Safari/WebKit-specific CSS |

### VTEX Integration

| Symptom pattern | Search for |
|------------------|------------|
| VTEX API errors, wrong store data | domain routing (myvtex vs vtexcommercestable) |

### Migration / Framework Upgrade

| Symptom pattern | Search for |
|------------------|------------|
| Import/type errors after a dependency bump | `git log` for `refactor(monorepo)` / `fix(*)` commits around the same time |

---

## Quick Search Commands

### Find a past fix by keyword

```bash
# Rate limiting issues
grep -ri "429\|rate limit\|too many" CHANGELOG.md
git log --oneline --grep="429\|rate limit" -i -30

# Cache issues
grep -ri "cache\|stale\|swr" CHANGELOG.md

# Performance issues
grep -ri "slow\|performance\|ttfb\|latency\|defer" CHANGELOG.md

# VTEX issues
grep -ri "vtex\|myvtex\|vtexcommerce" CHANGELOG.md
git log --oneline --grep="vtex" -i -30

# Visual/UI issues
git log --oneline --grep="css\|style\|layout\|ui" -i -30

# Block/config issues
git log --oneline --grep="block\|dangling\|deco/blocks" -i -30

# Migration/dependency issues
grep -ri "migrat\|breaking\|deprecat" CHANGELOG.md
```

### If `learnings/` exists (check first)

```bash
ls learnings/ 2>/dev/null && grep -ri "KEYWORD" learnings/
```

---

## Learning File Structure (for future entries)

If/when you write a new file into `learnings/`, use this structure — it
matches the template already used in `SKILL.md` Phase 5 and
`triage-workflow.md` Step 6:

```
# Title

## Category
[category-name]

## Problem
[Description]

## Symptoms
- Observable indicators

## Root Cause
[Explanation with code]

## Solution
[Fix with code examples]

## How to Debug
[Commands]

## Files Affected
[File patterns]

## Pattern Name
[Short name]

## Checklist Item
[One-line check]

## Impact
[Severity]
```

---

## Adding New Learnings

When documenting a new incident:

1. **Create `learnings/` if it doesn't exist**: `mkdir -p learnings`
2. **Choose a descriptive filename**: `[keyword]-[brief-description].md`
   - Example: `cors-headers-missing-api-routes.md`
3. **Pick a category** (or create a new one):
   - `cache-strategy` - Caching issues
   - `loader-optimization` - Data fetching / rendering issues
   - `block-config` - `.deco/blocks/*.json` configuration
   - `ui-bug` - Visual/layout issues
   - `vtex-integration` - VTEX-specific issues
   - `migration` - Version/migration issues
4. **Include code examples**: Both problem and solution code
5. **Document debug commands**: Make it reproducible
6. **Update this index**: Add a real entry once the file exists — don't
   pre-populate this document with filenames that don't exist yet
7. **Consider a `CHANGELOG.md` entry too** if the fix changes user-visible
   behavior — it's the one surface guaranteed to get read on every release

---

## Statistics

| Metric | Count |
|--------|-------|
| Total Learnings | 0 (folder does not exist yet) |
| Categories | 0 |

**Last verified**: 2026-07-07 — `learnings/` confirmed absent from repo
root and relative to this skill directory. Re-verify with `ls learnings/`
before trusting this file's "0" count, since it will go stale the moment
someone seeds the folder.
