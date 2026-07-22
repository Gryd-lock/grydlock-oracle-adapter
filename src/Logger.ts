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
  /** Low-level diagnostic detail, e.g. cache/coalescing internals. */
  debug(message: string, fields?: LogFields): void;
  /** Normal operational events, e.g. a resolved score's provenance. */
  info(message: string, fields?: LogFields): void;
  /** Recoverable problems, e.g. a fallback tier being used. */
  warn(message: string, fields?: LogFields): void;
  /** Failures, e.g. a score request that ultimately failed. */
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
