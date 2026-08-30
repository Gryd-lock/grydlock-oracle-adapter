/**
 * Versioned descriptor of the Soroban risk-oracle protocol `SorobanOracle`
 * targets. See docs/adr/0001-soroban-oracle-protocol.md for the full design
 * rationale — this file is the checked-in, runtime-validated data behind
 * that document's "Decision" section, not a restatement of it.
 *
 * Unlike src/fixtures/testkit/ (a vendored, third-party copy of
 * grydlock-testkit's fixtures, streamed and validated incrementally because
 * it's large and externally sourced — see that directory's schema.ts), this
 * descriptor is small and authored in this repo, so it's a plain TS constant
 * validated once, eagerly, at module load via {@link validateProtocolDescriptor}
 * rather than an incrementally-parsed JSON file.
 *
 * IMPORTANT: nothing here is sourced from a deployed, externally-controlled
 * contract — see the ADR's "Contract interface stability" section. This is
 * this adapter's own target interface, expected to be revised (with
 * `schemaVersion` bumped) once a real contract exists.
 */

/** An inclusive `[min, max]` range of supported interface versions. */
export interface InterfaceVersionRange {
  /** Oldest interface version this build understands. */
  readonly min: number;
  /** Newest interface version this build understands. */
  readonly max: number;
}

/** Shape of the protocol descriptor, before/after validation. */
export interface ProtocolDescriptor {
  /** Bumped whenever this adapter's targeted contract interface changes. */
  readonly schemaVersion: number;
  /** The single contract entry point this adapter calls. */
  readonly contractMethod: string;
  /** Interface version range this build of the descriptor understands. */
  readonly supportedInterfaceVersionRange: InterfaceVersionRange;
  /** The distinct "no numeric score" outcome variants a response may report — see the ADR's "Absence semantics". */
  readonly absenceVariants: readonly string[];
  /** Inclusive range a `scored` outcome's `score` must fall within. */
  readonly scoreRange: {
    /** Lowest valid score, inclusive. */
    readonly min: number;
    /** Highest valid score, inclusive. */
    readonly max: number;
  };
  /** Human-readable summary of why this descriptor is provisional. */
  readonly description: string;
}

const RAW_PROTOCOL_DESCRIPTOR: ProtocolDescriptor = {
  schemaVersion: 1,
  contractMethod: 'get_score',
  supportedInterfaceVersionRange: { min: 1, max: 1 },
  absenceVariants: ['unscored', 'pending'],
  scoreRange: { min: 0, max: 100 },
  description:
    'Adapter-targeted Soroban risk-oracle contract interface. No externally-authoritative ' +
    'contract deployment exists yet (see docs/adr/0001-soroban-oracle-protocol.md) — this ' +
    'descriptor is what SorobanOracle validates every transport response against, and is ' +
    'expected to gain schemaVersions as a real contract interface is ratified.',
};

/** Thrown when {@link RAW_PROTOCOL_DESCRIPTOR} itself fails shape validation. */
export class ProtocolDescriptorError extends Error {
  constructor(detail: string) {
    super(`Invalid Soroban protocol descriptor: ${detail}`);
    this.name = 'ProtocolDescriptorError';
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `${typeof value} (${JSON.stringify(value)})`;
}

/**
 * Validates the shape of a {@link ProtocolDescriptor}. Exported (rather than
 * only run privately at module load) so a test can exercise it directly
 * against a deliberately-broken value.
 */
export function validateProtocolDescriptor(data: unknown): ProtocolDescriptor {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ProtocolDescriptorError(`expected an object, got ${describe(data)}`);
  }
  const d = data as Record<string, unknown>;

  if (!Number.isInteger(d.schemaVersion) || (d.schemaVersion as number) < 1) {
    throw new ProtocolDescriptorError(
      `"schemaVersion" must be a positive integer, got ${describe(d.schemaVersion)}`,
    );
  }
  if (typeof d.contractMethod !== 'string' || d.contractMethod.length === 0) {
    throw new ProtocolDescriptorError(
      `"contractMethod" must be a non-empty string, got ${describe(d.contractMethod)}`,
    );
  }

  const range = d.supportedInterfaceVersionRange as Partial<InterfaceVersionRange> | undefined;
  if (
    typeof range !== 'object' ||
    range === null ||
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    (range.min as number) < 1 ||
    (range.max as number) < (range.min as number)
  ) {
    throw new ProtocolDescriptorError(
      `"supportedInterfaceVersionRange" must be { min, max } positive integers with min <= max, got ${describe(d.supportedInterfaceVersionRange)}`,
    );
  }

  if (
    !Array.isArray(d.absenceVariants) ||
    d.absenceVariants.length === 0 ||
    !d.absenceVariants.every((v) => typeof v === 'string' && v.length > 0)
  ) {
    throw new ProtocolDescriptorError(
      `"absenceVariants" must be a non-empty array of non-empty strings, got ${describe(d.absenceVariants)}`,
    );
  }

  const scoreRange = d.scoreRange as Partial<{ min: number; max: number }> | undefined;
  if (
    typeof scoreRange !== 'object' ||
    scoreRange === null ||
    typeof scoreRange.min !== 'number' ||
    typeof scoreRange.max !== 'number' ||
    scoreRange.min < 0 ||
    scoreRange.max < scoreRange.min
  ) {
    throw new ProtocolDescriptorError(
      `"scoreRange" must be { min, max } numbers with 0 <= min <= max, got ${describe(d.scoreRange)}`,
    );
  }

  if (typeof d.description !== 'string' || d.description.length === 0) {
    throw new ProtocolDescriptorError(
      `"description" must be a non-empty string, got ${describe(d.description)}`,
    );
  }

  return data as ProtocolDescriptor;
}

/** Validated once, at module load — see this file's doc comment. */
export const PROTOCOL_DESCRIPTOR: ProtocolDescriptor =
  validateProtocolDescriptor(RAW_PROTOCOL_DESCRIPTOR);
