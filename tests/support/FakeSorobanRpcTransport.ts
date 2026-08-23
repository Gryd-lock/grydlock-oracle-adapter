import type { SorobanRpcTransport } from '../../src/SorobanOracle';
import type { SorobanScoreRequest, SorobanRawResponse } from '../../src/fixtures/soroban';

/**
 * Deterministic in-memory `SorobanRpcTransport` fake for tests. Not a
 * network implementation of any kind — see
 * docs/adr/0001-soroban-oracle-protocol.md's "Scope of this increment" for
 * why this package doesn't ship a `'live'` transport. Responses are
 * pre-registered per canonical destination via `setResponse`/`setError`, so
 * a test controls exactly what `SorobanOracle` sees without any real RPC
 * call.
 */
export class FakeSorobanRpcTransport implements SorobanRpcTransport {
  readonly transportKind: 'live' | 'fixture';

  private readonly responses = new Map<string, unknown>();
  private readonly errors = new Map<string, unknown>();
  private readonly calls: SorobanScoreRequest[] = [];
  private delayMs = 0;
  private abortedCount = 0;

  /**
   * @param transportKind Defaults to `'fixture'`, matching what this class
   * actually is. Tests that need to exercise `SorobanOracle`'s
   * production-vs-fixture-transport refusal from the "this would be a live
   * transport" side pass `'live'` here rather than mutating a readonly
   * field.
   */
  constructor(transportKind: 'live' | 'fixture' = 'fixture') {
    this.transportKind = transportKind;
  }

  /** Registers the raw (pre-decode) value returned for `canonicalDestination`. */
  setResponse(canonicalDestination: string, value: unknown): void {
    this.responses.set(canonicalDestination, value);
    this.errors.delete(canonicalDestination);
  }

  /** Registers an error `invokeGetScore` throws for `canonicalDestination`, simulating a provider failure. */
  setError(canonicalDestination: string, error: unknown): void {
    this.errors.set(canonicalDestination, error);
    this.responses.delete(canonicalDestination);
  }

  /** Makes every subsequent `invokeGetScore` call wait `ms` before resolving/rejecting, so a test can cancel mid-flight. */
  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /** Every request this transport has received, in order — for assertions on what `SorobanOracle` sent. */
  get invocations(): readonly SorobanScoreRequest[] {
    return this.calls;
  }

  /** How many in-flight calls were actually aborted via their `AbortSignal` — proof cancellation released the transport, not just the caller's wait. */
  get abortedInvocationCount(): number {
    return this.abortedCount;
  }

  async invokeGetScore(
    request: SorobanScoreRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    this.calls.push(request);
    const key = request.destination.canonical;

    if (this.delayMs > 0) {
      await this.delay(this.delayMs, options.signal);
    }

    if (this.errors.has(key)) {
      throw this.errors.get(key);
    }
    if (!this.responses.has(key)) {
      throw new Error(`FakeSorobanRpcTransport: no response configured for "${key}"`);
    }
    return this.responses.get(key);
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.abortedCount += 1;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

/**
 * Default field values for {@link makeRawScoredResponse}/{@link makeRawAbsenceResponse} —
 * override per test. `ledgerCloseTimeUnixMs` defaults to "now" (computed
 * fresh per call, not a fixed constant) so a test that doesn't care about
 * staleness gets a "live" result by default; tests exercising the finality
 * policy's staleness path override it explicitly.
 */
function defaults(): {
  interfaceVersion: number;
  networkPassphrase: string;
  contractId: string;
  ledgerSequence: number;
  ledgerCloseTimeUnixMs: number;
  latestSeenSequence: number;
} {
  return {
    interfaceVersion: 1,
    networkPassphrase: 'Test SDF Network ; September 2015',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    ledgerSequence: 1_000_000,
    ledgerCloseTimeUnixMs: Date.now(),
    latestSeenSequence: 1_000_005,
  };
}

/** Builds a well-formed `SorobanRawResponse`-shaped value (deep-overridable) for a `'scored'` outcome. */
export function makeRawScoredResponse(
  score: number,
  overrides: {
    interfaceVersion?: number;
    networkPassphrase?: string;
    contractId?: string;
    ledgerSequence?: number;
    ledgerCloseTimeUnixMs?: number;
    latestSeenSequence?: number;
  } = {},
): SorobanRawResponse {
  const merged = { ...defaults(), ...overrides };
  return {
    interfaceVersion: merged.interfaceVersion,
    networkPassphrase: merged.networkPassphrase,
    contractId: merged.contractId,
    ledger: {
      sequence: merged.ledgerSequence,
      closeTimeUnixMs: merged.ledgerCloseTimeUnixMs,
      latestSeenSequence: merged.latestSeenSequence,
    },
    outcome: { variant: 'scored', score },
  };
}

/** Builds a well-formed `SorobanRawResponse`-shaped value for an absence (`'unscored'`/`'pending'`) outcome. */
export function makeRawAbsenceResponse(
  variant: 'unscored' | 'pending',
  overrides: {
    interfaceVersion?: number;
    networkPassphrase?: string;
    contractId?: string;
    ledgerSequence?: number;
    ledgerCloseTimeUnixMs?: number;
    latestSeenSequence?: number;
  } = {},
): SorobanRawResponse {
  const merged = { ...defaults(), ...overrides };
  return {
    interfaceVersion: merged.interfaceVersion,
    networkPassphrase: merged.networkPassphrase,
    contractId: merged.contractId,
    ledger: {
      sequence: merged.ledgerSequence,
      closeTimeUnixMs: merged.ledgerCloseTimeUnixMs,
      latestSeenSequence: merged.latestSeenSequence,
    },
    outcome: { variant },
  };
}
