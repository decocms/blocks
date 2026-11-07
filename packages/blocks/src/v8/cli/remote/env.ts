/**
 * Where the remote commands go and who they go as (spec: cli › The deco CLI):
 * `DECO_STUDIO_URL` (default `https://studio.decocms.com`), the bearer token
 * from `DECO_TOKEN` or else from Studio's CLI (`npx decocms auth token
 * --target=<url>`), and the public CDN. The blocks CLI has no login of its
 * own: the session is Studio CLI's.
 */
import { execFile } from "node:child_process";
import { CliError, EXIT } from "../root.ts";

export const DEFAULT_STUDIO_URL = "https://studio.decocms.com";
export const DEFAULT_DELIVERY_URL = "https://delivery.decocms.com";

export type Env = Record<string, string | undefined>;

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The Studio API base, `DECO_STUDIO_URL` with no trailing `/`. */
export function studioUrl(env: Env): string {
  const value = env.DECO_STUDIO_URL?.trim();
  return withoutTrailingSlash(value ? value : DEFAULT_STUDIO_URL);
}

/**
 * The public CDN base. `DECO_DELIVERY_URL` is for tests only (it may carry a
 * key prefix path); it isn't documented.
 */
export function deliveryUrl(env: Env): string {
  const value = env.DECO_DELIVERY_URL?.trim();
  return withoutTrailingSlash(value ? value : DEFAULT_DELIVERY_URL);
}

/** What `deco login` prints, and what a missing session tells you to run. */
export function loginCommand(env: Env): string {
  return `npx decocms auth login --target=${studioUrl(env)}`;
}

/**
 * Runs a command and resolves with its stdout; rejects when it can't start or
 * exits non-zero. Tests replace it.
 */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    const command = commandFor(file, args);
    execFile(
      command.file,
      command.args,
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        shell: command.shell,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/**
 * How to start `file` on this platform. On Windows `npx` is `npx.cmd`, a
 * batch file, which only runs through a shell: there each argument is quoted
 * (MSVC rules), so a `--target` URL reaches it whole.
 */
export function commandFor(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (platform !== "win32") return { file, args, shell: false };
  return { file: file === "npx" ? "npx.cmd" : file, args: args.map(quoteWindowsArg), shell: true };
}

function quoteWindowsArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * The bearer token: `DECO_TOKEN` when set, else the trimmed stdout of
 * `npx decocms auth token --target=<DECO_STUDIO_URL>`, which refreshes and
 * saves the Studio CLI session. No token is exit 3.
 */
export async function resolveToken(env: Env, run: CommandRunner = runCommand): Promise<string> {
  const fromEnv = env.DECO_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const target = studioUrl(env);
  let out: string;
  try {
    out = await run("npx", ["decocms", "auth", "token", `--target=${target}`]);
  } catch {
    throw notLoggedIn(env);
  }
  const token = out.trim();
  if (!token) throw notLoggedIn(env);
  return token;
}

function notLoggedIn(env: Env): CliError {
  return new CliError(`not logged in to ${studioUrl(env)}; run: ${loginCommand(env)}`, {
    exitCode: EXIT.auth,
    code: "not_logged_in",
  });
}
