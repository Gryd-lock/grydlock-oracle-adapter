import { mulberry32 } from './rng';
import { generateScheduleSpec, ScheduleSpec, GenerateOptions } from './schedule';
import { buildHarness, SutKind } from './harness';
import { runSchedule } from './runner';
import { ALL_INVARIANTS, InvariantViolation } from './invariants';
import { CircuitBreakerConfig } from '../../src/CircuitBreakerOracle';

export interface FuzzConfig {
  seed: number;
  iterations: number;
  sutKind: SutKind;
  destinations?: string[];
  minCallers?: number;
  maxCallers?: number;
  depth?: number;
  drainProbability?: number;
  warmupFailures?: number;
  cbConfig?: Partial<CircuitBreakerConfig>;
}

export interface FuzzFailure {
  iteration: number;
  spec: ScheduleSpec;
  violations: InvariantViolation[];
}

export interface FuzzReport {
  iterations: number;
  failures: FuzzFailure[];
}

function genOptsFrom(config: FuzzConfig, rng: ReturnType<typeof mulberry32>): GenerateOptions {
  return {
    rng,
    minCallers: config.minCallers ?? 2,
    maxCallers: config.maxCallers ?? 6,
    destinations: config.destinations ?? ['A', 'B', 'C'],
    depth: config.depth ?? 2,
    drainProbability: config.drainProbability ?? 0.3,
    warmupFailures: config.warmupFailures ?? 0,
  };
}

/**
 * Runs `config.iterations` independently-generated, randomized schedules
 * against a fresh SUT each time, checking every invariant in
 * `ALL_INVARIANTS` after each one. Deterministic given `config.seed`: see
 * FUZZER_DESIGN.md for the iteration-budget justification and the
 * probabilistic bug-finding argument this loop is built to support.
 */
export async function runFuzzer(
  config: FuzzConfig,
  buildSut: (
    kind: SutKind,
    cbConfig?: Partial<CircuitBreakerConfig>,
  ) => ReturnType<typeof buildHarness> = buildHarness,
): Promise<FuzzReport> {
  const rng = mulberry32(config.seed);
  const genOpts = genOptsFrom(config, rng);
  const failures: FuzzFailure[] = [];

  for (let i = 0; i < config.iterations; i++) {
    const spec = generateScheduleSpec(genOpts);
    const harness = buildSut(config.sutKind, config.cbConfig);
    const trace = await runSchedule(harness, spec);
    const violations = ALL_INVARIANTS.flatMap((check) => check(harness, trace));
    if (violations.length > 0) {
      failures.push({ iteration: i, spec, violations });
    }
  }

  return { iterations: config.iterations, failures };
}

/** Runs a single, already-generated spec against a fresh SUT and returns any violations. Used by the shrinker. */
export async function reproduceSpec(
  spec: ScheduleSpec,
  sutKind: SutKind,
  cbConfig: Partial<CircuitBreakerConfig> | undefined,
  buildSut: (
    kind: SutKind,
    cbConfig?: Partial<CircuitBreakerConfig>,
  ) => ReturnType<typeof buildHarness> = buildHarness,
): Promise<InvariantViolation[]> {
  const harness = buildSut(sutKind, cbConfig);
  const trace = await runSchedule(harness, spec);
  return ALL_INVARIANTS.flatMap((check) => check(harness, trace));
}
