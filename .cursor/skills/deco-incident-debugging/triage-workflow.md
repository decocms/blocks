# Triage Workflow - Fast Incident Response

This workflow is optimized for **SPEED**. Follow these steps in order. Stop as soon as you identify the issue.

## Step 0: Get Context (30 seconds)

**Gather from the engineer:**

```
INCIDENT BRIEF:
- Site: [site name]
- Error/Behavior: [exact message or description]
- Started: [when - sudden or gradual]
- Scope: [all users? specific pages? specific browsers?]
- Recent changes: [deployments, config, third-party]
```

## Step 1: Symptom Keyword Search (60 seconds)

**`learnings/` does not exist in this repo yet** — there's no seeded
knowledge base. Search `learnings/` opportunistically (it may exist by the
time you read this, if someone seeded it per `SKILL.md`), but always fall
back to `CHANGELOG.md` and `git log`, which document real past fixes:

| Symptom Type | Keywords to Search | Command |
|--------------|-------------------|---------|
| Rate limits | 429, rate limit, too many requests | `grep -ri "429\|rate limit" learnings/ CHANGELOG.md 2>/dev/null` |
| Slow pages | slow, cache, ttfb, performance, defer | `grep -ri "slow\|cache\|ttfb\|defer" learnings/ CHANGELOG.md 2>/dev/null` |
| Missing content | blank, missing, not found, null | `grep -ri "missing\|not found\|blank" learnings/ CHANGELOG.md 2>/dev/null` |
| Errors | error, exception, failed | `grep -ri "error\|failed\|exception" learnings/ CHANGELOG.md 2>/dev/null` |
| VTEX | vtex, cart, checkout, product | `grep -ri "vtex" learnings/ CHANGELOG.md 2>/dev/null` |
| Visual | css, style, invisible, layout | `grep -ri "css\|style\|invisible" learnings/ CHANGELOG.md 2>/dev/null` |
| Safari | safari, webkit, ios | `grep -ri "safari\|webkit" learnings/ CHANGELOG.md 2>/dev/null` |
| Images | image, flash, loading, lcp | `grep -ri "image\|flash\|lcp" learnings/ CHANGELOG.md 2>/dev/null` |
| Lazy | lazy, defer, render | `grep -ri "lazy\|defer\|render" learnings/ CHANGELOG.md 2>/dev/null` |

If `CHANGELOG.md` doesn't turn up anything, widen to commit history:

```bash
git log --oneline --grep="SYMPTOM_KEYWORD" -i -30
git log --oneline -20 -- <affected-path>
```

**If match found**: Read the learning file / CHANGELOG entry / commit and
jump to Step 4.

## Step 2: Category-Based Search (60 seconds)

**If keyword search didn't find an exact match, and `learnings/` exists and
has content, browse it by category:**

```bash
# List all learnings (skip if the folder doesn't exist)
ls learnings/ 2>/dev/null

# Read category headers
head -20 learnings/*.md 2>/dev/null | grep -A 2 "## Category"
```

| Category | When to Check |
|----------|---------------|
| `cache-strategy` | Slow pages, high API calls, rate limits |
| `loader-optimization` | Performance, N+1 queries, overfetching |
| `block-config` | Missing sections, "not found" errors |
| `rich-text` | Content display issues, broken links |
| `ui-bug` | Visual problems, click issues |
| `responsive` | Mobile/desktop differences |
| `safari-bug` | Safari-only issues |
| `vtex-routing` | VTEX API errors, wrong responses |
| `migration` | Post-migration issues |

If `learnings/` is empty or missing, skip straight to Step 3.

## Step 3: Quick Diagnostics (2 minutes)

**If no learning match, run quick diagnostics:**

### 3a. Error-Based Issues

```bash
# Check error logs (last 1 hour)
SEARCH_LOGS({ 
  query: "level:error site:SITENAME", 
  limit: 50,
  startTime: "-1h",
  endTime: "now"
})

# Group by error type
GET_LOG_DETAILS({ 
  query: "level:error site:SITENAME",
  groupBy: ["body"]
})
```

**Look for**:
- Error message patterns
- Stack traces pointing to specific files
- Frequency of errors

### 3b. Performance Issues

```bash
# CDN metrics
MONITOR_SUMMARY({ 
  sitename: "SITE", 
  hostname: "HOST", 
  startDate: "TODAY", 
  endDate: "TODAY",
  granularity: "hourly"
})

# Top error paths
MONITOR_TOP_PATHS({
  ...baseParams,
  filters: [{ type: "status_code", operator: "contains", value: "5" }]
})

# Cache effectiveness
MONITOR_CACHE_STATUS({ ...baseParams })
```

**Look for**:
- Cache hit rate < 50% (should be >80%)
- 5xx error spike
- 429 rate limiting
- Specific paths with high errors

### 3c. Code Issues

```bash
# Type errors (fast check; per-package tsc --noEmit, see README.md/CLAUDE.md)
bun run typecheck 2>&1 | head -50

# .deco/blocks/*.json sanity check — no schema validator exists anymore
# (deco.cx/validate has no current equivalent); this fails loudly on
# malformed JSON in .deco/blocks/:
npx tsx node_modules/@decocms/cli/scripts/generate-blocks.ts 2>&1 | grep -iE "error|fail"

# Recent changes
git log --oneline -10
```

**Look for**:
- New TypeScript errors after deployment
- Malformed `.deco/blocks/*.json` (generator throws, or blocks silently drop)
- Recent commits touching affected areas

## Step 4: Apply Known Fix (if learning/CHANGELOG/commit matched)

**Read the full source:**

```bash
cat learnings/[MATCHED_FILE].md 2>/dev/null   # if learnings/ exists
# otherwise re-read the matched CHANGELOG.md section, or:
git show <matched-commit-sha>
```

**Verify match:**
- [ ] Symptoms in the learning/entry/commit match current symptoms
- [ ] Root cause explanation makes sense for this case
- [ ] Solution is applicable to this site

**Apply solution:**
1. Follow the code examples in the learning/commit
2. Test the fix locally if possible
3. Deploy with confidence

## Step 5: Unknown Issue - Deep Dive

**If nothing matched, gather comprehensive data:**

### 5a. Full Error Context

```bash
# Extended error search
SEARCH_LOGS({ 
  query: "level:error site:SITENAME path:AFFECTED_PATH", 
  limit: 100
})

# Error timeline
QUERY_CHART_DATA({
  series: [{
    dataSource: "events",
    aggFn: "count",
    where: "level:error site:SITENAME",
    groupBy: ["body"]
  }],
  granularity: "5 minute",
  startTime: "-6h"
})
```

### 5b. Code Investigation

```bash
# Find the affected file
grep -r "ERROR_KEYWORD" sections/ loaders/ actions/

# Read the file
cat [AFFECTED_FILE]

# Check git blame
git blame [AFFECTED_FILE] | head -50

# Check recent changes to file
git log -5 --oneline -- [AFFECTED_FILE]
```

### 5c. Runtime Investigation

```bash
# Check server timing
curl -sI "https://SITE.com/affected-page?__d" | grep server-timing

# Check response headers
curl -sI "https://SITE.com/affected-page" | grep -i "cache\|set-cookie\|x-"

# Check for specific loader
curl -s "https://SITE.com/live/invoke/site/loaders/[LOADER]" | jq '.'
```

## Step 6: Document Novel Issue

**If this is a new pattern, create a learning.** `learnings/` doesn't exist
in this repo yet — create the folder (and a category subfolder, see
`SKILL.md`) the first time you write one:

```bash
# Create new learning file (creates learnings/ if it doesn't exist yet)
mkdir -p learnings
touch learnings/[descriptive-name].md
```

If the issue is a user-visible behavior change, also consider adding an
entry to `CHANGELOG.md` — that's the one incident-learnings surface that's
guaranteed to be read.

**Template:**

```markdown
# [Title - Descriptive Problem Name]

## Category
[category-name]

## Problem
[Clear description of what went wrong]

## Symptoms
- [Observable indicator 1]
- [Observable indicator 2]
- [Error message if applicable]

## Root Cause
[Explanation with code examples showing the problem]

\`\`\`typescript
// PROBLEM CODE
\`\`\`

## Solution
[How to fix with code examples]

\`\`\`typescript
// FIXED CODE
\`\`\`

## How to Debug
\`\`\`bash
# Commands to diagnose this issue
\`\`\`

## Files Affected
- [File pattern 1]
- [File pattern 2]

## Pattern Name
[Short memorable name]

## Checklist Item
[One-line check for future audits]

## Impact
[What happens if unfixed - severity and scope]
```

## Decision Tree

```
START: What is the primary symptom?
│
├─► Rate Limit / 429
│   └─► Check: learnings/ (if seeded), CHANGELOG.md, git log for cache/loader fixes
│       ├─► Match? Apply fix
│       └─► No match? Check for missing cache exports, N+1 queries
│
├─► Slow Page / High Latency
│   └─► Check: learnings/ (if seeded), CHANGELOG.md (async ⚡/foldThreshold entry), git log
│       ├─► Match? Apply fix
│       └─► No match? Run MONITOR_CACHE_STATUS, check for uncached loaders
│
├─► Missing Content / Blank Areas
│   └─► Check: learnings/ (if seeded), git log for .deco/blocks/ or section fixes
│       ├─► Match? Apply fix
│       └─► No match? Regenerate .deco/blocks/ (generate-blocks.ts), check browser console
│
├─► Visual / UI Bug
│   └─► Check: learnings/ (if seeded), git log for the affected component
│       ├─► Match? Apply fix
│       └─► No match? Inspect DOM, check CSS loading order
│
├─► VTEX Error
│   └─► Check: learnings/ (if seeded), CHANGELOG.md, git log for VTEX fixes
│       ├─► Match? Apply fix
│       └─► No match? Check VTEX status, verify credentials
│
└─► Unknown Error
    └─► Run full diagnostics (Step 3a-3c)
        └─► Create new learning when resolved (see Step 6)
```

## Speed Tips

1. **Parallel searches**: Run multiple grep commands at once, across `learnings/` (if it exists), `CHANGELOG.md`, and `git log`
2. **Use exact error text**: Copy-paste errors for precise matching
3. **Check recent deploys first**: Most incidents follow deployments
4. **Trust matched sources**: If symptoms match a learning, CHANGELOG entry, or past commit, the fix likely works
5. **Don't over-investigate**: If you find a match, apply it and verify

## Common Pitfalls

- **Over-diagnosing**: Stop investigating once you find the cause
- **Ignoring learnings**: Always check learnings before deep diving
- **Missing scope**: Verify if issue is widespread or isolated
- **Forgetting to document**: Novel issues must become learnings
