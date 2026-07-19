export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export const NoopLogger: Logger = {
  debug: () => {
    // no-op
  },
  info: () => {
    // no-op
  },
  warn: () => {
    // no-op
  },
  error: () => {
    // no-op
  },
};

