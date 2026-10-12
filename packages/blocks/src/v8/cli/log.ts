/** Where commands print. Tests pass a recorder; the bin passes the console. */
export interface Reporter {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Whether messages may carry ANSI colour (`--color`, or a terminal). Off when absent. */
  color?: boolean;
}

export const consoleReporter: Reporter = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** The same reporter, with colour turned on or off. */
export function withColor(reporter: Reporter, color: boolean): Reporter {
  return {
    info: (message) => reporter.info(message),
    warn: (message) => reporter.warn(message),
    error: (message) => reporter.error(message),
    color,
  };
}

export const silentReporter: Reporter = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
