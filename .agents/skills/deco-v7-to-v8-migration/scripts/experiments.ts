/**
 * A/B tests and dates. v7 ran tests on its random matcher and date windows on
 * its date matcher; the next major keeps both in content: tests in the saved
 * block `experiments` (type `split-traffic`) read by the `experiment` rule,
 * date windows in the saved block `campaigns` (type `calendar`) read by the
 * `campaign` rule, which names one. The script moves neither: it
 * reports each kind once, for whoever moves them by hand, and says who hands
 * the visitor to the client when the site has tests.
 */
import { siteFramework } from "./framework";
import type { Report } from "./report";
import { forEachBlock, readContent } from "./walk";

/** v7's random matcher, under each name v7 saved it with. */
const RANDOM_MATCHERS = new Set([
  "website/matchers/random.ts",
  "website/matchers/random",
  "$live/matchers/MatchRandom.ts",
]);

/** A date rule: v7's names (renamed to `date` by the content step) and v8's prerelease one. */
const DATE_RULES = new Set(["date", "website/matchers/date.ts", "$live/matchers/MatchDate.ts"]);

export const RUN_AN_AB_TEST = "/next/matchers-and-variants#run-an-a-b-test";
export const SCHEDULE_A_CAMPAIGN = "/next/matchers-and-variants#schedule-a-campaign";

const quoted = (names: Iterable<string>) =>
  [...names]
    .sort()
    .map((n) => `"${n}"`)
    .join(", ");

/**
 * Reports v7's random matchers and every date rule (v7's, or the prerelease
 * `date`, which no longer exists): one "Left to do" line each, pointing at
 * the docs. Changes no file.
 */
export function reportTestsAndDates(root: string, report: Report): void {
  const { blocks, files } = readContent(root);
  const tests = new Set<string>();
  const dates = new Set<string>();
  for (const [entry, block] of Object.entries(blocks)) {
    if (RANDOM_MATCHERS.has(block.__resolveType as string)) {
      tests.add(entry);
      continue;
    }
    forEachBlock(block, (node) => {
      if (RANDOM_MATCHERS.has(node.__resolveType)) tests.add(entry);
      else if (DATE_RULES.has(node.__resolveType)) dates.add(entry);
    });
  }
  if (tests.size > 0) {
    report.manual.push({
      step: "content",
      subject: "A/B tests",
      message: `v7's random matchers (in ${quoted([...tests].map((n) => files[n] ?? n))}) weren't moved: put each test in the saved block experiments (type split-traffic) under its saved-block name, so visitors keep their groups and results carry over, and point its rules at { "__resolveType": "experiment", "name": … } (Run an A/B test, ${RUN_AN_AB_TEST})`,
    });
    reportAssignment(root, report);
  }
  if (dates.size > 0) {
    report.manual.push({
      step: "content",
      subject: "date rules",
      message: `date rules (in ${quoted([...dates].map((n) => files[n] ?? n))}) weren't moved, and deco check rejects them until they are: put each window in the saved block campaigns (type calendar), each start and end a date and time with the store's offset (like 2026-11-27T00:00-03:00: v7 read a date-time without one in the server's time zone, and deco check rejects it), and write each rule as { "__resolveType": "campaign", "name": … } naming its campaign (a prerelease { "__resolveType": "date", "campaign": … } becomes that rule with the same name) (Schedule a campaign, ${SCHEDULE_A_CAMPAIGN})`,
    });
  }
}

/** Who hands the visitor to the client, by binding: without one every test is off. */
function reportAssignment(root: string, report: Report): void {
  const framework = siteFramework(root);
  if (framework === "tanstack") return; // createDecoWorker reads the visitor on every page request.
  report.manual.push({
    step: "content",
    subject: "experiments",
    message:
      framework === "nextjs"
        ? "decide the tests in proxy.ts: draftProxy from @decocms/nextjs/proxy does it, or decideVisitor, decideAssignments, visitorRequestHeaders, assignmentsRequestHeaders and applyVisitor next to the draft calls; the catch-all page's bindDraft and contentClient(cms) then build cms.client({ version, experiments, campaigns }) from what the proxy decided"
        : "hand the visitor to the client per request: const { visitor, cookie } = readVisitor(request) from @decocms/blocks/experiments, cms.client({ visitor, ...(await cms.readVersion(request)) }), and the cookie on the response when it isn't null and the request isn't a preview (/next/built-in-blocks#split-traffic); until then every test is off",
  });
}
