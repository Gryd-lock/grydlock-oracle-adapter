/**
 * Request/response types for the Soroban risk-oracle protocol, plus a
 * hand-rolled runtime validator (`decodeSorobanRawResponse`) for the
 * response half. See docs/adr/0001-soroban-oracle-protocol.md for the
 * design rationale.
 *
 * `SorobanRpcTransport.invokeGetScore` (src/SorobanOracle.ts) hands back
 * `unknown` — a real transport decodes XDR into *some* JS value, but that
 * value must never be trusted structurally before use, exactly like the
 * vendored JSON fixtures in src/fixtures/testkit/. `decodeSorobanRawResponse`
 * is this protocol's equivalent of that directory's
 * `validateScoresFixture`/`validateDestinationsFixture`: it walks the value
 * by hand (no schema-validation library exists in this repo, and this
 * module doesn't add one) and throws {@link SorobanResponseSchemaError} the
 * moment anything doesn't match.
 */

import type { ValidatedDestination } from '../../DestinationValidator';
import { PROTOCOL_DESCRIPTOR, type InterfaceVersionRange } from './protocol';

export type { InterfaceVersionRange, ProtocolDescriptor } from './protocol';
export {
  PROTOCOL_DESCRIPTOR,
  validateProtocolDescriptor,
  ProtocolDescriptorError,
} from './protocol';

/** The single contract entry point `SorobanOracle` calls — see the ADR. */
export const SOROBAN_GET_SCORE_METHOD = PROTOCOL_DESCRIPTOR.contractMethod;

/**
 * This build's default supported interface version range, taken from the
 * checked-in protocol descriptor. `SorobanOracleConfig.supportedInterfaceVersionRange`
 * is still a required, explicit field on every `SorobanOracle` instance
 * (see that config's doc comment) — this constant is a starting point for
 * callers, not an implicit default baked into the oracle itself.
 */
export const SOROBAN_ORACLE_INTERFACE_VERSION_RANGE: InterfaceVersionRange =
  PROTOCOL_DESCRIPTOR.supportedInterfaceVersionRange;

/**
 * A request `SorobanOracle` hands to a `SorobanRpcTransport`. Destination
 * encoding reuses `ValidatedDestination` (src/DestinationValidator.ts)
 * rather than re-deriving address parsing — see the ADR's "Destination
 * encoding" section.
 */
export interface SorobanScoreRequest {
  /** Always `SOROBAN_GET_SCORE_METHOD`; carried on the request so a transport doesn't need a second import to know what it's calling. */
  readonly method: typeof SOROBAN_GET_SCORE_METHOD;
  /** The destination being scored, already validated and canonicalized. */
  readonly destination: ValidatedDestination;
  /**
   * The newest interface version this caller understands, sent as a hint —
   * see the ADR's "Contract method and interface version" section for why
   * this isn't a true negotiation handshake. The authoritative check is
   * always against `SorobanRawResponse.interfaceVersion`, not this value.
   */
  readonly interfaceVersion: number;
}

/** Ledger checkpoint metadata a response reports its score against. */
export interface SorobanRawLedgerCheckpoint {
  /** The ledger sequence the score was computed against. */
  readonly sequence: number;
  /** That ledger's close time, in epoch milliseconds. */
  readonly closeTimeUnixMs: number;
  /** The RPC node's most recently observed ledger sequence at response time. */
  readonly latestSeenSequence: number;
}

/**
 * The three ways a `get_score` call can resolve — see the ADR's "Absence
 * semantics" section for what distinguishes `unscored` from `pending`.
 */
export type SorobanRawOutcome =
  | { readonly variant: 'scored'; readonly score: number }
  | { readonly variant: 'unscored' }
  | { readonly variant: 'pending' };

/**
 * The full decoded-but-not-yet-trusted response shape a `SorobanRpcTransport`
 * is expected to produce. `SorobanOracle` validates every field against this
 * shape via {@link decodeSorobanRawResponse} before using any of it.
 */
export interface SorobanRawResponse {
  /** Interface version the contract reports for this response. */
  readonly interfaceVersion: number;
  /** Network passphrase the contract believes it's running on. */
  readonly networkPassphrase: string;
  /** Contract id that produced this response. */
  readonly contractId: string;
  /** Ledger checkpoint the response is anchored to. */
  readonly ledger: SorobanRawLedgerCheckpoint;
  /** The outcome — a score, or one of the two absence variants. */
  readonly outcome: SorobanRawOutcome;
}

/**
 * Thrown by {@link decodeSorobanRawResponse} when a transport's raw value
 * doesn't match {@link SorobanRawResponse}. `SorobanOracle` catches this and
 * re-throws it as `MalformedOracleResponseError` (src/OracleError.ts) with
 * this error attached as `context.cause`, so callers see the stable,
 * catchable oracle error taxonomy rather than this schema-internal type.
 */
export class SorobanResponseSchemaError extends Error {
  constructor(detail: string) {
    super(`Malformed Soroban oracle response: ${detail}`);
    this.name = 'SorobanResponseSchemaError';
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `${typeof value} (${JSON.stringify(value)})`;
}

function decodeLedgerCheckpoint(value: unknown): SorobanRawLedgerCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SorobanResponseSchemaError(`"ledger" must be an object, got ${describe(value)}`);
  }
  const l = value as Record<string, unknown>;

  if (!Number.isInteger(l.sequence) || (l.sequence as number) < 0) {
    throw new SorobanResponseSchemaError(
      `"ledger.sequence" must be a non-negative integer, got ${describe(l.sequence)}`,
    );
  }
  if (typeof l.closeTimeUnixMs !== 'number' || !Number.isFinite(l.closeTimeUnixMs)) {
    throw new SorobanResponseSchemaError(
      `"ledger.closeTimeUnixMs" must be a finite number, got ${describe(l.closeTimeUnixMs)}`,
    );
  }
  if (!Number.isInteger(l.latestSeenSequence) || (l.latestSeenSequence as number) < 0) {
    throw new SorobanResponseSchemaError(
      `"ledger.latestSeenSequence" must be a non-negative integer, got ${describe(l.latestSeenSequence)}`,
    );
  }

  return {
    sequence: l.sequence as number,
    closeTimeUnixMs: l.closeTimeUnixMs,
    latestSeenSequence: l.latestSeenSequence as number,
  };
}

const ABSENCE_VARIANTS = new Set(PROTOCOL_DESCRIPTOR.absenceVariants);

function decodeOutcome(value: unknown): SorobanRawOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SorobanResponseSchemaError(`"outcome" must be an object, got ${describe(value)}`);
  }
  const o = value as Record<string, unknown>;

  if (o.variant === 'scored') {
    const { score } = o;
    if (
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < PROTOCOL_DESCRIPTOR.scoreRange.min ||
      score > PROTOCOL_DESCRIPTOR.scoreRange.max
    ) {
      throw new SorobanResponseSchemaError(
        `"outcome.score" must be an integer within ${PROTOCOL_DESCRIPTOR.scoreRange.min}-${PROTOCOL_DESCRIPTOR.scoreRange.max}, got ${describe(score)}`,
      );
    }
    return { variant: 'scored', score };
  }

  if (typeof o.variant === 'string' && ABSENCE_VARIANTS.has(o.variant)) {
    return { variant: o.variant as 'unscored' | 'pending' };
  }

  throw new SorobanResponseSchemaError(
    `"outcome.variant" must be "scored" or one of [${PROTOCOL_DESCRIPTOR.absenceVariants.join(', ')}], got ${describe(o.variant)}`,
  );
}

/**
 * Validates and decodes a transport's raw response value against
 * {@link SorobanRawResponse}. Throws {@link SorobanResponseSchemaError}
 * describing exactly which field failed and why.
 */
export function decodeSorobanRawResponse(value: unknown): SorobanRawResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SorobanResponseSchemaError(`expected an object, got ${describe(value)}`);
  }
  const r = value as Record<string, unknown>;

  if (!Number.isInteger(r.interfaceVersion) || (r.interfaceVersion as number) < 1) {
    throw new SorobanResponseSchemaError(
      `"interfaceVersion" must be a positive integer, got ${describe(r.interfaceVersion)}`,
    );
  }
  if (typeof r.networkPassphrase !== 'string' || r.networkPassphrase.length === 0) {
    throw new SorobanResponseSchemaError(
      `"networkPassphrase" must be a non-empty string, got ${describe(r.networkPassphrase)}`,
    );
  }
  if (typeof r.contractId !== 'string' || r.contractId.length === 0) {
    throw new SorobanResponseSchemaError(
      `"contractId" must be a non-empty string, got ${describe(r.contractId)}`,
    );
  }

  const ledger = decodeLedgerCheckpoint(r.ledger);
  const outcome = decodeOutcome(r.outcome);

  return {
    interfaceVersion: r.interfaceVersion as number,
    networkPassphrase: r.networkPassphrase,
    contractId: r.contractId,
    ledger,
    outcome,
  };
}

/** @returns Whether `version` falls within `range`, inclusive. */
export function isInterfaceVersionSupported(
  version: number,
  range: InterfaceVersionRange,
): boolean {
  return version >= range.min && version <= range.max;
}
