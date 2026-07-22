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
  /** Logs a diagnostic message, most verbose level. */
  debug(message: string, fields?: LogFields): void;
  /** Logs an informational message. */
  info(message: string, fields?: LogFields): void;
  /** Logs a warning about a recoverable or unexpected condition. */
  warn(message: string, fields?: LogFields): void;
  /** Logs an error. */
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
