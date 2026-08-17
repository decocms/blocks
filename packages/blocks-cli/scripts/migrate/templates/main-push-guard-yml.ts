/**
 * Scaffolds `.github/workflows/main-push-guard.yml` — a branch-protection
 * surrogate. It does NOT block the push (real branch protection would, before
 * the fact); it fails visibly in the Actions history when a commit reaches main
 * without going through a PR (the "never commit straight to main" convention).
 *
 * Heuristic: GET /repos/{owner}/{repo}/commits/{sha}/pulls returns the PRs
 * associated with a commit (including the merge/squash/rebase GitHub records on
 * main when a PR merges). Empty list = the commit did not come from a PR.
 *
 * Fully generic — no per-site parameters.
 */
export function generateMainPushGuardYml(): string {
  return `name: main-push-guard

# Branch-protection surrogate: detects a commit that reaches main WITHOUT a PR.
# Does not block the push — only fails visibly in the Actions history when the
# "never commit straight to main" convention is broken.

on:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: read

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - name: Check that the commit on main came from a merged PR
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          SHA: \${{ github.sha }}
        run: |
          count="\$(gh api "repos/\${REPO}/commits/\${SHA}/pulls" --jq 'length')"
          if [ "\$count" -eq 0 ]; then
            echo "::error::commit \${SHA} reached main with no associated PR (direct push). Convention: one issue = one PR, never commit straight to main."
            exit 1
          fi
          echo "OK: commit \${SHA} associated with \${count} PR(s)."
`;
}
