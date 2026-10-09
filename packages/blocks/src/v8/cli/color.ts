/**
 * ANSI colour for the `deco` CLI's output. Off unless the run asked for it:
 * `--color`, or a terminal on both stdout and stderr (see `runCli`). When off,
 * every function returns its text unchanged, so piped output stays plain.
 */
export interface Paint {
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const sgr = (open: number, close: number) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;

const ON: Paint = {
  green: sgr(32, 39),
  red: sgr(31, 39),
  yellow: sgr(33, 39),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
};

const plain = (text: string) => text;
const OFF: Paint = { green: plain, red: plain, yellow: plain, dim: plain, bold: plain };

export function paint(color: boolean | undefined): Paint {
  return color ? ON : OFF;
}
