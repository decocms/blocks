---
name: deco-incident-debugging
description: Fast incident response skill for Deco engineering team. Rapidly identifies known issues from past learnings, proposes solutions, and guides debugging for new incidents. Optimized for speed - get to root cause in minutes, not hours.
---

# Deco Incident Debugging

**PRIORITY: SPEED** - This skill is designed for real-time incident response. Every second counts. Execute the triage workflow immediately and propose solutions as fast as possible.

## When to Use This Skill

- **Production incident** in progress
- Site is down, slow, or showing errors
- Customer escalation requiring immediate response
- On-call engineer needs AI assistance during war room
- Post-incident to document root cause and learnings

## Quick Start - 60 Second Triage

```
1. GET SYMPTOMS         → What error/behavior is the user seeing?
2. MATCH LEARNINGS      → Search learnings/ for similar patterns
3. PROPOSE SOLUTIONS    → If match found, apply known fix
4. DEEP DIVE            → If no match, run diagnostic workflow
5. DOCUMENT             → Capture new learning if novel issue
```

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | This overview and quick reference |
| `triage-workflow.md` | Step-by-step fast triage process (interactive) |
| `headless-mode.md` | Autonomous investigation without human interaction |
| `learnings-index.md` | Categorized index of all past learnings |

## Operating Modes

### Interactive Mode (default)
Use when working alongside an engineer during an incident. The agent asks clarifying questions and collaborates on diagnosis.

### Headless Mode
Use when triggered automatically by incident management systems (PagerDuty, Opsgenie, etc.). The agent receives minimal context and autonomously:
1. Extracts keywords from alert message
2. Searches learnings for matching patterns
3. Collects live data (logs, metrics)
4. Correlates findings to known issues
5. Outputs structured diagnosis with proposed fix

See `headless-mode.md` for full autonomous workflow, input/output formats, and integration examples.

## Learnings Database

**Status: `learnings/` does not exist yet in this repo.** There is no seeded
knowledge base to search — do not `grep learnings/` and treat a silent/empty
result as "no known issue." Until the folder is created and seeded, use these
two real sources instead:

- **`CHANGELOG.md`** (repo root) — the human-curated ledger of behavior
  changes, several of which are incident-driven fixes. Example: the
  "Unreleased — Admin async (⚡) toggle is the source of truth for deferral"
  entry documents a real regression (issue #266, sections silently rendering
  client-side) and its fix/migration path.
- **`git log`** — search commit history for prior fixes to the same area,
  e.g. `git log --oneline --grep="fix" -i -- <path>` or
  `git log --oneline -- <affected-file>`. Example: commit `a3f9b9c
  test(cms): add regression test for the layout-cache index-corruption race`
  is a real past incident with a regression test you can read for the
  root-cause pattern.

```bash
# Search past incident-driven changes
grep -ri "SYMPTOM_KEYWORD" CHANGELOG.md
git log --oneline --grep="fix\|regression\|incident" -i -20
git log --oneline -20 -- <affected-file-or-dir>
```

### If you want to seed `learnings/` for future incidents

The workflow below (Phase 5, "Document New Learning") still assumes a place
to write novel findings. If none exists, create it with this structure before
relying on it:

```
learnings/
  cache-strategy/
  loader-optimization/
  block-config/
  ui-bug/
  vtex-integration/
  migration/
  <filename>.md   # [keyword]-[brief-description].md, using the template
                   # in Phase 5 / triage-workflow.md Step 6
```

Seed it opportunistically — turn each future Phase 5 write-up into a real
file instead of a one-off chat response, and it will compound. Until then,
treat every category table below as illustrative of the *kind* of pattern to
look for, not as a literal file that exists.

## Incident Response Workflow

### Phase 1: Rapid Assessment (< 2 minutes)

**Ask the engineer these questions:**

1. **What is the error message or behavior?**
   - Copy exact error text if available
   - Describe what user sees

2. **When did it start?**
   - Sudden vs gradual
   - After deployment?
   - Traffic spike?

3. **What is the scope?**
   - All users or specific segment?
   - All pages or specific routes?
   - One site or multiple?

4. **What changed recently?**
   - Code deployments
   - Config changes
   - Third-party updates

### Phase 2: Pattern Matching (< 3 minutes)

**Search for known patterns.** If `learnings/` has been seeded (see above),
search it first; either way, fall back to `CHANGELOG.md` and `git log`:

```bash
# If learnings/ exists and has content:
grep -ri "SYMPTOM_KEYWORD" learnings/ 2>/dev/null

# Always available — search real past fixes:
grep -ri "SYMPTOM_KEYWORD" CHANGELOG.md
git log --oneline --grep="SYMPTOM_KEYWORD" -i -20

# Examples:
grep -ri "429" CHANGELOG.md           # Rate limiting
grep -ri "cache" CHANGELOG.md         # Cache issues
grep -ri "slow" CHANGELOG.md          # Performance
grep -ri "not found" CHANGELOG.md     # Missing resources
grep -ri "cookie" CHANGELOG.md        # Cookie/session issues
grep -ri "vtex" CHANGELOG.md          # VTEX integration
grep -ri "lazy" CHANGELOG.md          # Lazy loading / deferral issues
```

### Phase 3: Known Issue? Apply Fix Immediately

If symptom matches a learning (or a past CHANGELOG/git entry):

1. **Read the full learning file / CHANGELOG entry / commit**
2. **Verify root cause matches** the current symptoms
3. **Apply the documented solution**
4. **Verify the fix works**

### Phase 4: Unknown Issue? Deep Diagnostic

If no learning matches, run full diagnostics:

```bash
# Check error logs (HyperDX)
SEARCH_LOGS({ query: "level:error site:SITENAME", limit: 50 })

# Check CDN metrics (if slow)
MONITOR_SUMMARY({ sitename: "SITE", hostname: "HOSTNAME" })
MONITOR_TOP_PATHS({ ... })
MONITOR_STATUS_CODES({ ... })

# Check for TypeScript errors (per-package; see README.md/CLAUDE.md)
bun run typecheck

# Check for recent changes
git log --oneline -20
git diff HEAD~5

# .deco/blocks/*.json is still a real convention in this codebase (synced to
# KV via sync-blocks-to-kv.ts / generate-blocks.ts). There is no
# `deco.cx/validate`-style schema validator anymore. The closest check is
# running the blocks generator, which fails loudly on malformed JSON:
npx tsx node_modules/@decocms/cli/scripts/generate-blocks.ts
```

### Phase 5: Document New Learning

If this is a novel issue, create a new learning:

```markdown
# [Title]

## Category
[category-name]

## Problem
[What went wrong]

## Symptoms
- [Observable indicator 1]
- [Observable indicator 2]

## Root Cause
[Why it happened with code examples]

## Solution
[How to fix with code examples]

## How to Debug
[Commands and techniques]

## Files Affected
[List of file patterns]

## Pattern Name
[Short memorable name]

## Checklist Item
[One-line check for future audits]

## Impact
[What happens if unfixed]
```

## Common Incident Patterns

### Rate Limiting (429 Errors)

**Symptoms**: "Too Many Requests" errors, spiky error rates

**Quick Check**:
```bash
grep -ri "rate limit\|429\|overfetch" learnings/ CHANGELOG.md 2>/dev/null
```

**Where to look** (until `learnings/` is seeded, no filenames are guaranteed
to exist — search `CHANGELOG.md` / `git log` for prior cache- or
loader-related fixes instead):
- Loaders missing `export const cache` causing repeated upstream calls
- N+1 / overfetching patterns in loaders

**Immediate Actions**:
1. Check if loaders have `export const cache`
2. Check for N+1 query patterns
3. Add stale-while-revalidate caching

### Slow Page Load

**Symptoms**: High TTFB, slow LCP, user complaints about speed

**Quick Check**:
```bash
grep -ri "slow\|cache\|lazy\|performance" learnings/ CHANGELOG.md 2>/dev/null
```

**Where to look**: the "Unreleased — Admin async (⚡) toggle" entry in
`CHANGELOG.md` documents a real deferral/rendering behavior change relevant
to slow-page investigations (position-based auto-deferral, `foldThreshold`).
Also check cache hit rates and lazy-section cache headers directly.

**Immediate Actions**:
1. Check cache hit rates with CDN metrics
2. Verify lazy sections have proper cache headers (see the async ⚡ /
   `foldThreshold` behavior in `CHANGELOG.md`)
3. Check for sync loaders blocking render

### Missing Content / Blank Sections

**Symptoms**: Sections not rendering, blank areas on page

**Quick Check**:
```bash
grep -ri "dangling\|missing\|not found\|blank" learnings/ CHANGELOG.md 2>/dev/null
```

**Where to look**: block config pointing at a deleted component, or a loader
error masked by duplicate sections. Search `git log` for past fixes touching
`.deco/blocks/` or the affected section.

**Immediate Actions**:
1. Sanity-check `.deco/blocks/*.json` by regenerating:
   `npx tsx node_modules/@decocms/cli/scripts/generate-blocks.ts`
   (fails loudly on malformed JSON; there is no full schema validator)
2. Check browser console for loader errors
3. Verify component files exist

### VTEX Integration Issues

**Symptoms**: Products not loading, cart errors, checkout problems

**Quick Check**:
```bash
grep -ri "vtex" learnings/ CHANGELOG.md 2>/dev/null
```

**Where to look**: wrong VTEX domain (myvtex vs vtexcommercestable), or
cookies blocking edge caching. Search `git log` / `CHANGELOG.md` for past
VTEX-related fixes.

**Immediate Actions**:
1. Check VTEX domain configuration
2. Verify API credentials
3. Check for VTEX service status

### Visual Bugs / UI Issues

**Symptoms**: Broken layouts, invisible elements, style issues

**Quick Check**:
```bash
grep -ri "invisible\|css\|style\|responsive\|safari" learnings/ CHANGELOG.md 2>/dev/null
```

**Where to look**: empty links covering clickable content, mobile/desktop
breakpoint inconsistencies, Safari-specific image flashing, or missing
styles on lazy-loaded sections. Search `git log` for past fixes to the
affected component.

**Immediate Actions**:
1. Check browser dev tools for overlapping elements
2. Inspect CSS loading order
3. Test on affected browser/device

## Debugging Commands Reference

### Error Investigation

```bash
# Search error logs
SEARCH_LOGS({ query: "level:error site:SITENAME", limit: 50 })

# Group errors by message
GET_LOG_DETAILS({ 
  query: "level:error site:SITENAME",
  groupBy: ["body", "service"]
})

# Timeline of errors
QUERY_CHART_DATA({
  series: [{ dataSource: "events", aggFn: "count", where: "level:error" }],
  granularity: "1 hour"
})
```

### Performance Investigation

```bash
# CDN summary
MONITOR_SUMMARY({ sitename: "SITE", hostname: "HOST", startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" })

# Top paths by requests
MONITOR_TOP_PATHS({ ... })

# Cache effectiveness
MONITOR_CACHE_STATUS({ ... })

# Error rates
MONITOR_STATUS_CODES({ ... })
```

### Code Investigation

```bash
# Type errors (per-package tsc --noEmit; see README.md/CLAUDE.md)
bun run typecheck

# .deco/blocks/*.json sanity check — there is no schema validator anymore
# (deco.cx/validate has no current equivalent); this fails on malformed JSON:
npx tsx node_modules/@decocms/cli/scripts/generate-blocks.ts

# Find missing cache
grep -L "export const cache" loaders/**/*.ts

# Recent changes
git log --oneline -20
git diff HEAD~5

# Find files with errors
bun run typecheck 2>&1 | grep "error TS" | sed 's/:.*//g' | sort | uniq -c | sort -rn
```

## Escalation Criteria

### Escalate Immediately If:

- Site completely down (no pages loading)
- Checkout broken (revenue impact)
- Data breach suspected
- Issue affecting multiple customers
- Fix requires platform changes (not site code)

### Can Handle with This Skill:

- Single site performance issues
- Configuration problems
- Code bugs in site repository
- Cache/loader issues
- Visual/UI bugs

## Post-Incident Checklist

After resolving the incident:

- [ ] Document root cause in `learnings/` if novel (create the folder with
      the structure above if it doesn't exist yet) — and/or add a
      `CHANGELOG.md` entry if it's a user-visible behavior change
- [ ] Create PR with fix
- [ ] Update affected checklists if pattern is common
- [ ] Share learning with team
- [ ] Consider if monitoring should be added

## Related Skills

- `deco-full-analysis` - For comprehensive site audits (non-urgent)
- `deco-performance-audit` - For deep performance analysis
- `deco-typescript-fixes` - For systematic type error fixes
