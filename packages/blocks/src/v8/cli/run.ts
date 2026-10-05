/**
 * The `deco` command line: `deco <schema|content|check|serve> [flags]`
 * (spec: cli). Parses flags, runs one command and returns its exit code.
 */
import { check } from "./check/index.ts";
import { content, writeContent } from "./content.ts";
import { consoleReporter, type Reporter } from "./log.ts";
import { CliError, decoPaths, findDecoRoot } from "./root.ts";
import { reportSchema, schema, writeSchema } from "./schema/index.ts";
import { serve, startServer } from "./serve/server.ts";
import { watchFiles, watchTree } from "./watch.ts";

type FlagKind = "string" | "boolean";

const COMMANDS: Record<string, { usage: string; flags: Record<string, FlagKind> }> = {
  schema: {
    usage: "deco schema  [--root <dir>] [--watch]",
    flags: { root: "string", watch: "boolean" },
  },
  content: {
    usage: "deco content [--root <dir>] [--watch]",
    flags: { root: "string", watch: "boolean" },
  },
  check: { usage: "deco check   [--root <dir>]", flags: { root: "string" } },
  serve: {
    usage:
      "deco serve   [--root <dir>] [--port <n>] [--host <addr>] [--preview <host:port|url>] [--assets <dir>] [--read-only]",
    flags: {
      root: "string",
      port: "string",
      host: "string",
      preview: "string",
      assets: "string",
      "read-only": "boolean",
    },
  },
};

export const USAGE = `Usage: deco <command> [flags]

Commands:
  schema    turn the types in .deco/index.ts into .deco/schema.gen.json
  content   turn .deco/blocks into the content module, .deco/blocks.gen.ts
  check     check that every saved block fits the schema (writes nothing)
  serve     serve .deco to the site editor on this machine

${Object.values(COMMANDS)
  .map((c) => `  ${c.usage}`)
  .join("\n")}

Every command finds .deco/ by walking up from the current folder, or takes --root.`;

export type ParsedFlags = Record<string, string | boolean | string[]>;

export function parseFlags(command: string, args: string[]): ParsedFlags {
  const spec = COMMANDS[command].flags;
  const flags: ParsedFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--"))
      throw new CliError(`unexpected argument "${arg}"\n${COMMANDS[command].usage}`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) throw new CliError(`unknown flag --${name}\n${COMMANDS[command].usage}`);
    if (kind === "boolean") {
      if (eq !== -1) throw new CliError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = args[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw new CliError(`--${name} needs a value`);
      i++;
    }
    flags[name] = value;
  }
  return flags;
}

export interface RunOptions {
  cwd?: string;
  reporter?: Reporter;
  /** Resolves when a `--watch` or `serve` run should stop (tests); defaults to SIGINT/SIGTERM. */
  until?: Promise<void>;
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

/**
 * What `deco publish` prints. It isn't one of the four commands and isn't in
 * the usage: publishing is committing (/next/design-decisions).
 */
const PUBLISH_SIGNPOST = `There is no publish command: Git is the source of truth for content, so publishing is committing.
Commit the changes in .deco/blocks (and push them). A deploy ships the commit; with the hosted
Deco CMS, a commit becomes a release without a deploy.`;

/** Run one `deco` invocation; returns the exit code. */
export async function runCli(argv: string[], options: RunOptions = {}): Promise<number> {
  const reporter = options.reporter ?? consoleReporter;
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    reporter.info(USAGE);
    return command ? 0 : 1;
  }
  if (command === "publish") {
    // Not a command: a signpost for agents that look for one (design-decisions).
    reporter.error(PUBLISH_SIGNPOST);
    return 1;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    reporter.error(`unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  try {
    const flags = parseFlags(command, rest);
    const root = flags.root as string | undefined;
    const base = { root, cwd: options.cwd, reporter };
    switch (command) {
      case "schema": {
        if (!flags.watch) return await schema(base);
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
        return 0;
      }
      case "content": {
        if (!flags.watch) return await content(base);
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
        return 0;
      }
      case "check":
        return check(base);
      case "serve": {
        const port = flags.port === undefined ? undefined : Number(flags.port);
        if (port !== undefined && !Number.isInteger(port))
          throw new CliError(`--port must be a number, got ${flags.port}`);
        const serveOptions = {
          ...base,
          port,
          host: flags.host as string | undefined,
          preview: flags.preview as string | undefined,
          assets: flags.assets as string | undefined,
          readOnly: Boolean(flags["read-only"]),
        };
        if (!options.until) return await serve(serveOptions);
        const running = await startServer(serveOptions);
        await options.until;
        await running.close();
        return 0;
      }
    }
    return 1;
  } catch (error) {
    if (error instanceof CliError) {
      reporter.error(error.message);
      return 1;
    }
    throw error;
  }
}
