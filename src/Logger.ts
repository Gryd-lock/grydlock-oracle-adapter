/**
 * Structured fields attached to a log entry.
 */
export type LogFields = Record<string, unknown>;

/**
 * Minimal structured logger accepted by oracle implementations and wrappers.
 *
 * The library never logs on its own: consumers inject a Logger (e.g. one
 * that forwards to the extension's logging) to opt in. When none is
 * supplied, implementations fall back to {@link noopLogger}, so logging is
 * entirely opt-in and nothing in this package writes to the console.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Default Logger that discards everything.
 */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
