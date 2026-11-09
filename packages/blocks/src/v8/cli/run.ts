/**
 * The `deco` command line (spec: cli). Parses flags, runs one command and
 * returns its exit code (spec: cli › Exit codes): 0 ok, 1 check failed (or
 * any other failure), 2 conflict, 3 auth, 4 network, 5 busy (run again), 64
 * usage. Every command takes `--json`: stdout then carries exactly one JSON
 * object, and what a person reads goes to stderr.
 */
import path from "node:path";
import { readSchemaFile, reportCheck } from "./check/index.ts";
import { content, readSavedBlocks, savedBlocksFromMap, writeContent } from "./content.ts";
import { consoleReporter, type Reporter, withColor } from "./log.ts";
import {
  diff,
  drafts,
  login,
  type Outcome,
  publish,
  pull,
  push,
  type RemoteContext,
  releases,
  remoteBlocks,
  schemaPush,
} from "./remote/commands.ts";
import type { CommandRunner, Env } from "./remote/env.ts";
import type { Fetch } from "./remote/http.ts";
import { checkDraftName, findSite, requireDraftName } from "./remote/local.ts";
import { CliError, decoPaths, EXIT, findDecoRoot, packageVersion, usageError } from "./root.ts";
import { reportSchema, schema, writeSchema } from "./schema/index.ts";
import { installSkills } from "./skills.ts";
import { watchFiles, watchTree } from "./watch.ts";

type FlagKind = "string" | "boolean";

interface CommandSpec {
  usage: string;
  flags: Record<string, FlagKind>;
  /** How many positional arguments it takes, at most. */
  positionals?: number;
}

const DRAFT = { draft: "string" } as const;

const COMMANDS: Record<string, CommandSpec> = {
  login: { usage: "deco login", flags: {} },
  pull: {
    usage: "deco pull     [--draft=<name>] [--force]",
    flags: { ...DRAFT, force: "boolean" },
  },
  diff: { usage: "deco diff     [--draft=<name>]", flags: { ...DRAFT } },
  push: {
    usage: "deco push     --draft=<name> [--ours | --theirs] [--prune]",
    flags: { ...DRAFT, ours: "boolean", theirs: "boolean", prune: "boolean" },
  },
  publish: {
    usage: "deco publish  --draft=<name> [--message=<text>]",
    flags: { ...DRAFT, message: "string" },
  },
  drafts: {
    usage: "deco drafts   list | new <name> | discard <name> | url <name>",
    flags: {},
    positionals: 2,
  },
  releases: { usage: "deco releases [--cursor=<cursor>]", flags: { cursor: "string" } },
  check: {
    usage: "deco check    [--draft=<name> | --revision=<id>]",
    flags: { ...DRAFT, revision: "string" },
  },
  content: {
    usage: "deco content  [--watch]",
    flags: { watch: "boolean" },
  },
  schema: {
    usage: "deco schema   [--watch | --check]\n  deco schema push",
    flags: { watch: "boolean", check: "boolean" },
    positionals: 1,
  },
  skills: {
    usage: "deco skills install [--dir=<path>]",
    flags: { dir: "string" },
    positionals: 1,
  },
};

/** Flags every command takes. */
const COMMON_FLAGS: Record<string, FlagKind> = { root: "string", json: "boolean" };

export const USAGE = `Usage: deco <command> [flags]

Commands:
  login     print how to log in (the session is Studio CLI's: npx decocms auth login)
  pull      write production, or a draft, into .deco/blocks
  diff      show what .deco/blocks changes against what was pulled, or against a draft
  push      save the blocks changed since the pull into a draft as one change (deletes with
            --prune); prints its preview link
  publish   make a draft live (prints its changes first)
  drafts    list, create, discard a draft, or print its preview link
  releases  list the published revisions, newest first, 50 a page
  check     check that the content fits the schema (production; or a draft, or a revision;
            with no DECO_SITE set anywhere, the saved blocks in .deco/blocks)
  content   turn .deco/blocks into the content module, .deco/blocks.gen.ts (content without
            a site: createCMS({ blocks, content }))
  schema    turn the types in .deco/index.ts into .deco/schema.gen.json
            (--check: write nothing, fail when the file is out of date; for CI)
            schema push: upload it so Studio can draw forms (CI, on production deploys)
  skills    skills install: copy the agent skills of this @decocms/blocks into the site,
            one folder per skill in .claude/skills (or --dir, relative to the folder that
            contains .deco/); replaces those folders, leaves other skills alone; offline

${Object.values(COMMANDS)
  .map((c) => `  ${c.usage}`)
  .join("\n")}

Every command finds .deco/ by walking up from the current folder, or takes --root.
Every command takes --json (one JSON object on stdout) and --color or --no-color.
Site: DECO_SITE, from the environment, else .env, .dev.vars, then vars.DECO_SITE in
wrangler.jsonc, wrangler.json or wrangler.toml (in the folder that contains .deco/).
Studio: DECO_STUDIO_URL (default https://studio.decocms.com); token: DECO_TOKEN, else
npx decocms auth token. Exit codes: 0 ok, 1 failed, 2 conflict, 3 auth, 4 network,
5 busy (run again), 64 usage.`;

export type ParsedFlags = Record<string, string | boolean | string[]>;

export function parseFlags(command: string, args: string[]): ParsedFlags {
  const command_ = COMMANDS[command]!;
  const spec = { ...COMMON_FLAGS, ...command_.flags };
  const flags: ParsedFlags = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      if (positionals.length >= (command_.positionals ?? 0))
        throw usageError(`unexpected argument "${arg}"\n${command_.usage}`);
      positionals.push(arg);
      continue;
    }
    // Every command's: `color` is true, false or absent; the last one given wins.
    if (arg === "--color" || arg === "--no-color") {
      flags.color = arg === "--color";
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (name === "color" || name === "no-color") throw usageError(`--${name} takes no value`);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) throw usageError(`unknown flag --${name}\n${command_.usage}`);
    if (kind === "boolean") {
      if (eq !== -1) throw usageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = args[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw usageError(`--${name} needs a value`);
      i++;
    }
    flags[name] = value;
  }
  if (positionals.length > 0) flags._ = positionals;
  return flags;
}

export interface RunOptions {
  cwd?: string;
  /** Defaults to the console, coloured when stdout and stderr are both terminals. */
  reporter?: Reporter;
  /** Resolves when a `--watch` run should stop (tests); defaults to SIGINT/SIGTERM. */
  until?: Promise<void>;
  /** The environment (`DECO_STUDIO_URL`, `DECO_TOKEN`); defaults to the process's. */
  env?: Env;
  /** Defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Runs `npx decocms auth token` (tests replace it). */
  runCommand?: CommandRunner;
  /** Where `--json` writes its object; defaults to stdout. */
  stdout?: (text: string) => void;
  /** The skills `deco skills install` copies; defaults to the package's `skills/` (tests replace it). */
  skillsDir?: string;
}

function stopSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function watchLoop(
  dir: string,
  filter: (rel: string) => boolean,
  rerun: () => Promise<void> | void,
  until: Promise<void>,
  reporter: Reporter,
) {
  let running = Promise.resolve();
  const watcher = watchTree(dir, filter, () => {
    running = running.then(async () => {
      try {
        await rerun();
      } catch (error) {
        reporter.error((error as Error).message);
      }
    });
  });
  reporter.info("watching for changes (ctrl-c to stop)");
  await until;
  watcher.close();
  await running;
}

/** Everything a person reads goes to stderr, so `--json`'s stdout is one object. */
const stderrReporter: Reporter = {
  info: (message) => console.error(message),
  warn: (message) => console.error(message),
  error: (message) => console.error(message),
};

function stringFlag(flags: ParsedFlags, name: string): string | null {
  const value = flags[name];
  return typeof value === "string" ? value : null;
}

/** Run one `deco` invocation; returns the exit code. */
export async function runCli(argv: string[], options: RunOptions = {}): Promise<number> {
  let reporter = options.reporter ?? consoleReporter;
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    reporter.info(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  const json = rest.includes("--json");
  if (json && !options.reporter) reporter = stderrReporter;
  let outcome: Outcome;
  try {
    if (!Object.hasOwn(COMMANDS, command))
      throw usageError(`unknown command "${command}"\n\n${USAGE}`);
    const flags = parseFlags(command, rest);
    const color =
      typeof flags.color === "boolean"
        ? flags.color
        : options.reporter
          ? Boolean(options.reporter.color)
          : !json && Boolean(process.stdout.isTTY && process.stderr.isTTY);
    reporter = withColor(reporter, color);
    const env = options.env ?? process.env;
    outcome = await runCommand(command, flags, { ...options, env, reporter });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    reporter.error(error.message);
    if (json) {
      stdout(
        JSON.stringify({
          ok: false,
          exitCode: error.exitCode,
          error: { code: error.code, message: error.message },
          ...error.details,
        }),
      );
    }
    return error.exitCode;
  }
  if (json) {
    stdout(
      JSON.stringify(
        outcome.exitCode === EXIT.ok
          ? { ok: true, ...outcome.result }
          : { ok: false, exitCode: outcome.exitCode, ...outcome.result },
      ),
    );
  }
  return outcome.exitCode;
}

/**
 * The root of a remote command. With no `.deco/` at all a remote command has
 * no folder to work in nor to read `DECO_SITE` from, a usage error (64), as a
 * missing `DECO_SITE` is (contract §7.4); local commands keep exit 1. The
 * message stays the documented one (cli-09).
 */
function remoteRoot(options: { root?: string; cwd?: string }): string {
  try {
    return findDecoRoot(options);
  } catch (error) {
    if (error instanceof CliError && error.exitCode !== EXIT.usage) {
      throw usageError(error.message);
    }
    throw error;
  }
}

async function runCommand(
  command: string,
  flags: ParsedFlags,
  options: RunOptions & { env: Env; reporter: Reporter },
): Promise<Outcome> {
  const { reporter } = options;
  const positionals = (flags._ as string[] | undefined) ?? [];
  const root = flags.root as string | undefined;
  const base = { root, cwd: options.cwd, reporter };
  const remote = (): RemoteContext => ({
    paths: decoPaths(remoteRoot(base)),
    reporter,
    env: options.env,
    fetch: options.fetch ?? fetch,
    runCommand: options.runCommand,
  });
  const legacy = (exitCode: number, result: Record<string, unknown> = {}): Outcome =>
    exitCode === EXIT.ok
      ? { exitCode, result }
      : {
          exitCode,
          result: { error: { code: "failed", message: `deco ${command} failed` }, ...result },
        };
  switch (command) {
    case "login":
      return login({ env: options.env, reporter });
    case "pull": {
      const draft = stringFlag(flags, "draft");
      return pull(remote(), {
        draft: draft === null ? null : checkDraftName(draft),
        force: flags.force === true,
      });
    }
    case "diff": {
      const draft = stringFlag(flags, "draft");
      return diff(remote(), { draft: draft === null ? null : checkDraftName(draft) });
    }
    case "push": {
      const draft = requireDraftName(flags.draft, "push");
      if (flags.ours && flags.theirs) throw usageError("--ours and --theirs can't be combined");
      return push(remote(), {
        draft,
        side: flags.ours ? "ours" : flags.theirs ? "theirs" : null,
        prune: flags.prune === true,
      });
    }
    case "publish":
      return publish(remote(), {
        draft: requireDraftName(flags.draft, "publish"),
        message: stringFlag(flags, "message") ?? undefined,
      });
    case "drafts": {
      const name = positionals[1] ?? null;
      return drafts(remote(), {
        action: positionals[0],
        name: name === null ? null : checkDraftName(name),
      });
    }
    case "releases":
      return releases(remote(), { cursor: stringFlag(flags, "cursor") ?? undefined });
    case "check": {
      const draft = stringFlag(flags, "draft");
      const revision = stringFlag(flags, "revision");
      if (draft !== null && revision !== null)
        throw usageError("--draft and --revision can't be combined");
      // No flag: production (latest.json, then each block by hash, from the
      // CDN), always, even when .deco/blocks exists. No .deco/ at all stays
      // exit 1 for check, as before.
      const paths = decoPaths(findDecoRoot(base));
      if (draft === null && revision === null && findSite(paths, options.env) === null) {
        // No Studio site: the content is the git-backed .deco/blocks (a site
        // on createCMS({ blocks, content }), a v7 site being migrated), checked
        // as deco check always did.
        const meta = readSchemaFile(paths.schema);
        return checkOutcome(reportCheck(meta, readSavedBlocks(paths.blocks), reporter));
      }
      const ctx = remote();
      const meta = readSchemaFile(ctx.paths.schema);
      const source = await remoteBlocks(ctx, {
        draft: draft === null ? null : checkDraftName(draft),
        revision,
      });
      reporter.info(`checking ${source.label}`);
      return checkOutcome(reportCheck(meta, savedBlocksFromMap(source.blocks), reporter));
    }
    case "content": {
      if (!flags.watch) return legacy(await content(base));
      const paths = decoPaths(findDecoRoot(base));
      const once = async () => {
        const result = await writeContent(paths);
        if (result.changed) reporter.info(`wrote .deco/blocks.gen.ts (${result.count} blocks)`);
      };
      await content({ ...base, watching: true });
      await watchLoop(
        paths.blocks,
        (rel) => rel.endsWith(".json"),
        once,
        options.until ?? stopSignal(),
        reporter,
      );
      return { exitCode: EXIT.ok, result: {} };
    }
    case "schema": {
      if (positionals.length > 0) {
        if (positionals[0] !== "push")
          throw usageError(`unexpected argument "${positionals[0]}"\n${COMMANDS.schema!.usage}`);
        if (flags.watch || flags.check)
          throw usageError("deco schema push takes no --watch or --check");
        return schemaPush(remote());
      }
      if (flags.watch && flags.check) {
        throw usageError(`--watch and --check can't be combined\n${COMMANDS.schema!.usage}`);
      }
      if (!flags.watch) return legacy(await schema({ ...base, check: flags.check === true }));
      const paths = decoPaths(findDecoRoot(base));
      // Monorepo packages the block map imports live outside the root:
      // watch the files the last run read there, too.
      const external = watchFiles(() => void once());
      let running = Promise.resolve();
      const run = async () => {
        const result = await writeSchema(paths);
        external.update(result.externalSources);
        reportSchema(result, reporter);
      };
      const once = () => {
        running = running.then(run).catch((error) => reporter.error((error as Error).message));
        return running;
      };
      await run();
      // Regenerate when any source file changes; the schema only depends on code.
      await watchLoop(
        paths.root,
        (rel) =>
          /\.(ts|tsx|mts|cts)$/.test(rel) &&
          !rel
            .split("/")
            .some((s) => s === "node_modules" || s.startsWith(".git") || s === "dist") &&
          !rel.endsWith(".gen.ts"),
        once,
        options.until ?? stopSignal(),
        reporter,
      );
      external.close();
      await running;
      return { exitCode: EXIT.ok, result: {} };
    }
    case "skills": {
      if (positionals[0] !== "install") {
        throw usageError(
          positionals.length === 0
            ? `deco skills needs a subcommand\n${COMMANDS.skills!.usage}`
            : `unexpected argument "${positionals[0]}"\n${COMMANDS.skills!.usage}`,
        );
      }
      const dir = stringFlag(flags, "dir") ?? undefined;
      const paths = decoPaths(findDecoRoot(base));
      const installed = installSkills({ root: paths.root, dir, from: options.skillsDir });
      const shown = path.relative(paths.root, installed.dir) || ".";
      const where = shown.startsWith("..") || path.isAbsolute(shown) ? installed.dir : shown;
      for (const name of installed.skills) reporter.info(`installed ${path.join(where, name)}/`);
      reporter.info(
        `${installed.skills.length} skill(s) from @decocms/blocks ${packageVersion()} in ${where}`,
      );
      return {
        exitCode: EXIT.ok,
        result: { dir: installed.dir, version: packageVersion(), skills: installed.skills },
      };
    }
  }
  throw usageError(`unknown command "${command}"`);
}

function checkOutcome(report: ReturnType<typeof reportCheck>): Outcome {
  const result = {
    blocks: report.count,
    errors: report.errors,
    warnings: report.warnings,
    problems: report.problems,
  };
  if (report.exitCode === EXIT.ok) return { exitCode: EXIT.ok, result };
  return {
    exitCode: report.exitCode,
    result: {
      error: { code: "check_failed", message: `${report.errors} errors` },
      ...result,
    },
  };
}
