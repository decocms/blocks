/**
 * `deco schema --check` in the site's CI: the step fails a pull request whose
 * `.deco/schema.gen.json` differs from what `deco schema` writes (Studio reads
 * that file for the editor forms, so a stale one shows stale forms). It runs
 * right after the install step, before a build's `prebuild` regenerates the
 * file. Workflows are line-edited (no YAML rewrite), so comments and layout
 * stay as they were.
 */
import fs from "node:fs";
import path from "node:path";
import type { Report } from "./report";

const CHECK = "deco schema --check";
const INSTALL =
  /^(?:(?:bun|pnpm|yarn)\s+install|npm\s+(?:ci|install|i)|yarn(?:\s+--\S+)*\s*$)(?:\s|$)/;
const STEP_NAME = "Check that .deco/schema.gen.json is up to date";

/** The folder with the site's git repository: the root itself, or the nearest parent with `.git`. */
function repoRoot(root: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return root;
  }
}

/** How the site runs a dependency's bin, from its lockfile. */
function runner(root: string, repo: string): string {
  const has = (name: string) =>
    fs.existsSync(path.join(root, name)) || fs.existsSync(path.join(repo, name));
  if (has("bun.lock") || has("bun.lockb")) return "bunx";
  if (has("pnpm-lock.yaml")) return "pnpm exec";
  if (has("yarn.lock")) return "yarn";
  return "npx";
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The `run:` command of the step on or under `line`, when it's a one-line command. */
function runCommand(line: string): string | undefined {
  const m = /^\s*(?:-\s+)?run:\s*(.+?)\s*$/.exec(line);
  return m && !/^[|>]/.test(m[1]) ? m[1].replace(/^["']|["']$/g, "") : undefined;
}

interface Insert {
  /** Line index the new step goes before. */
  at: number;
  text: string[];
}

/**
 * Where the check goes in one workflow: after the first install step, with
 * that step's indentation and working directory. Undefined when the workflow
 * has no one-line install step.
 */
function planInsert(
  lines: string[],
  command: string,
  workingDirectory: string,
): Insert | undefined {
  for (let i = 0; i < lines.length; i++) {
    const run = runCommand(lines[i]);
    if (!run || !INSTALL.test(run) || /\s(?:-g|--global)\b/.test(run)) continue;
    // The step's own `- ` line: this one, or the closest above with less indentation.
    let start = i;
    while (start >= 0 && !/^\s*-\s/.test(lines[start])) start--;
    if (start < 0) continue;
    const dash = indentOf(lines[start]);
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() !== "" && !line.trimStart().startsWith("#") && indentOf(line) <= dash) break;
      end++;
    }
    while (end > start + 1 && lines[end - 1].trim() === "") end--;
    const body = " ".repeat(dash + 2);
    const dir = lines
      .slice(start, end)
      .map((l) => /^\s*(?:-\s+)?working-directory:\s*(.+?)\s*$/.exec(l)?.[1])
      .find(Boolean);
    const text = [`${" ".repeat(dash)}- name: ${STEP_NAME}`];
    if (dir) text.push(`${body}working-directory: ${dir}`);
    // A job's `defaults.run.working-directory` already applies to the new step.
    else if (workingDirectory && !lines.some((l) => /^\s*working-directory:/.test(l)))
      text.push(`${body}working-directory: ${workingDirectory}`);
    text.push(`${body}run: ${command}`);
    return { at: end, text };
  }
  return undefined;
}

/** Add `deco schema --check` to the site's CI workflows (the pull-request ones when there are any). */
export function addSchemaCheck(root: string, report: Report): void {
  const repo = repoRoot(root);
  const dir = path.join(repo, ".github", "workflows");
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()
        .map((f) => path.join(dir, f))
    : [];
  const workflows = files
    .map((file) => ({ file, text: fs.readFileSync(file, "utf8") }))
    // v7's content regeneration jobs are deleted by hand (reference/manual-steps.md).
    .filter(({ text }) => !/generate:blocks|regen-blocks/.test(text));
  const rel = (file: string) => path.relative(repo, file).split(path.sep).join("/");
  const command = `${runner(root, repo)} ${CHECK}`;
  const manual = (message: string) =>
    report.manual.push({ step: "scripts", subject: "CI", message });

  const already = workflows.filter(({ text }) => text.includes(CHECK));
  if (already.length > 0) {
    report.done.push({
      step: "scripts",
      subject: "CI",
      message: `${already.map((w) => rel(w.file)).join(", ")} already run${already.length === 1 ? "s" : ""} ${CHECK}`,
    });
    return;
  }
  const onPullRequests = workflows.filter(({ text }) => /\bpull_request(?:_target)?\b/.test(text));
  const targets = onPullRequests.length > 0 ? onPullRequests : workflows;
  const siteDir = path.relative(repo, root).split(path.sep).join("/");
  const added: string[] = [];
  for (const { file, text } of targets) {
    const lines = text.split("\n");
    const insert = planInsert(lines, command, siteDir);
    if (!insert) continue;
    lines.splice(insert.at, 0, ...insert.text);
    fs.writeFileSync(file, lines.join("\n"));
    added.push(rel(file));
  }
  if (added.length > 0) {
    report.done.push({
      step: "scripts",
      subject: "CI",
      message: `${added.join(", ")}: \`${command}\` after the install step, so a pull request whose .deco/schema.gen.json differs from what deco schema writes fails (commit the regenerated file to fix it)`,
    });
    return;
  }
  manual(
    targets.length === 0
      ? `no CI workflow found in ${rel(dir)}: run \`${command}\` in the site's CI after installing dependencies, so a stale .deco/schema.gen.json fails the pull request`
      : `no one-line install step in ${targets.map((w) => rel(w.file)).join(", ")}: add \`${command}\` after the dependencies are installed, so a stale .deco/schema.gen.json fails the pull request`,
  );
}
