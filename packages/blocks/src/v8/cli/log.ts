/** Where commands print. Tests pass a recorder; the bin passes the console. */
export interface Reporter {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleReporter: Reporter = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export const silentReporter: Reporter = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
