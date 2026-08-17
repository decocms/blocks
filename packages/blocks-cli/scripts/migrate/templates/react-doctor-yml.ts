/**
 * Scaffolds `.github/workflows/react-doctor.yml` — flags React
 * security/perf/correctness/a11y/bundle-size/architecture issues on PRs.
 *
 * Advisory by construction (the action's default: comments, never fails the
 * build). Separate workflow from ci.yml on purpose — zero coupling with the
 * blocking gates. `fetch-depth: 0` gives the merge-base so it reports only what
 * the PR introduces.
 *
 * Fully generic — no per-site parameters. Docs: https://www.react.doctor/ci
 */
export function generateReactDoctorYml(): string {
  return `name: React Doctor

# Flags React security/perf/correctness/a11y/bundle-size/architecture issues.
# Advisory by construction (comments, never fails the check). To make it a hard
# gate, add \`with: { blocking: error }\` to the action step below.

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write

concurrency:
  group: react-doctor-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  react-doctor:
    runs-on: ubuntu-latest
    steps:
      # fetch-depth: 0 gives the merge-base so it reports only PR-introduced findings.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: millionco/react-doctor@v2
`;
}
