import { describe, expect, it } from 'vitest';
import { noopLogger, LogFields } from '../src/Logger';
import { RISK_DECISION_SCHEMA_VERSION, RiskDecision } from '../src/RiskDecision';
import {
  createRiskDecisionProvenanceEvent,
  emitRiskDecisionProvenance,
  pseudonymizeDestination,
  riskDecisionLogLevel,
} from '../src/RiskDecisionProvenance';

const RAW_DESTINATION = 'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET';
const RPC_URL_FRAGMENT = 'https://internal-rpc.example.com/soroban/secret-path';
const ISSUER_KEY_FRAGMENT = 'GISSUERSECRETLOOKINGVALUE1234567890ABCDEFGH';

function verifiedDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return {
    outcome: 'verified',
    schemaVersion: RISK_DECISION_SCHEMA_VERSION,
    destination: RAW_DESTINATION,
    source: 'soroban-v2',
    observedAt: 1_000,
    score: 42,
    ...overrides,
  } as RiskDecision;
}

describe('pseudonymizeDestination', () => {
  it('is deterministic for the same destination + salt', () => {
    expect(pseudonymizeDestination(RAW_DESTINATION, 'salt-a')).toBe(
      pseudonymizeDestination(RAW_DESTINATION, 'salt-a'),
    );
  });

  it('differs across salts for the same destination', () => {
    expect(pseudonymizeDestination(RAW_DESTINATION, 'salt-a')).not.toBe(
      pseudonymizeDestination(RAW_DESTINATION, 'salt-b'),
    );
  });

  it('differs across destinations for the same salt', () => {
    expect(pseudonymizeDestination(RAW_DESTINATION, 'salt-a')).not.toBe(
      pseudonymizeDestination('GDIFFERENTDESTINATIONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'salt-a'),
    );
  });

  it('never contains the raw destination substring', () => {
    const ref = pseudonymizeDestination(RAW_DESTINATION, 'salt-a');
    expect(ref).not.toContain(RAW_DESTINATION);
    expect(ref.startsWith('dref_')).toBe(true);
  });
});

describe('createRiskDecisionProvenanceEvent — default (no redaction options) contains no raw destination/URL/secret', () => {
  it('omits the raw destination field entirely by default', () => {
    const event = createRiskDecisionProvenanceEvent(verifiedDecision(), {
      correlationId: 'req-1',
      latencyMs: 12,
      now: () => 2_000,
    });

    expect(event.destination).toBeUndefined();
    expect(event.destinationRef).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(RAW_DESTINATION);
  });

  it('omits raw error detail by default even when a raw error was supplied', () => {
    const rawError = new Error(
      `Upstream RPC call to ${RPC_URL_FRAGMENT} failed for issuer ${ISSUER_KEY_FRAGMENT}`,
    );

    const event = createRiskDecisionProvenanceEvent(
      verifiedDecision({
        outcome: 'unavailable',
        reason: 'transport-error',
      } as Partial<RiskDecision>),
      { correlationId: 'req-1', latencyMs: 5, now: () => 2_000, rawError },
    );

    expect(event.rawErrorDetail).toBeUndefined();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(RPC_URL_FRAGMENT);
    expect(serialized).not.toContain(ISSUER_KEY_FRAGMENT);
  });

  it('never uses the destination as the correlationId', () => {
    const event = createRiskDecisionProvenanceEvent(verifiedDecision(), {
      correlationId: 'req-independent-of-destination',
      latencyMs: 1,
    });
    expect(event.correlationId).not.toBe(RAW_DESTINATION);
    expect(event.correlationId).toBe('req-independent-of-destination');
  });

  it('snapshot: the default event shape for a verified decision', () => {
    const event = createRiskDecisionProvenanceEvent(verifiedDecision(), {
      correlationId: 'req-1',
      latencyMs: 12,
      now: () => 2_000,
    });

    expect(event).toEqual({
      event: 'risk_decision_provenance',
      schemaVersion: 1,
      correlationId: 'req-1',
      outcome: 'verified',
      source: 'soroban-v2',
      observedAt: 1_000,
      timestamp: 2_000,
      latencyMs: 12,
      score: 42,
      reason: undefined,
      policyRuleId: undefined,
    });
  });
});

describe('createRiskDecisionProvenanceEvent — explicit opt-ins', () => {
  it('includes the pseudonymized destination reference only when opted in with a salt', () => {
    const event = createRiskDecisionProvenanceEvent(
      verifiedDecision(),
      { correlationId: 'req-1', latencyMs: 1 },
      { includePseudonymizedDestination: true, destinationSalt: 'my-salt' },
    );

    expect(event.destinationRef).toBe(pseudonymizeDestination(RAW_DESTINATION, 'my-salt'));
    expect(event.destination).toBeUndefined();
  });

  it('throws if includePseudonymizedDestination is set without a salt', () => {
    expect(() =>
      createRiskDecisionProvenanceEvent(
        verifiedDecision(),
        { correlationId: 'req-1', latencyMs: 1 },
        { includePseudonymizedDestination: true },
      ),
    ).toThrow();
  });

  it('includes the raw destination only when explicitly opted in', () => {
    const event = createRiskDecisionProvenanceEvent(
      verifiedDecision(),
      { correlationId: 'req-1', latencyMs: 1 },
      { includeRawDestination: true },
    );
    expect(event.destination).toBe(RAW_DESTINATION);
  });

  it('includes a capped raw error rendering only when explicitly opted in', () => {
    const rawError = new Error(`failed at ${RPC_URL_FRAGMENT}`);
    const event = createRiskDecisionProvenanceEvent(
      verifiedDecision({
        outcome: 'unavailable',
        reason: 'transport-error',
      } as Partial<RiskDecision>),
      { correlationId: 'req-1', latencyMs: 1, rawError },
      { includeRawError: true },
    );
    expect(event.rawErrorDetail).toContain(RPC_URL_FRAGMENT);
  });

  it('caps an overly long raw error rendering', () => {
    const rawError = new Error('x'.repeat(1000));
    const event = createRiskDecisionProvenanceEvent(
      verifiedDecision({
        outcome: 'unavailable',
        reason: 'transport-error',
      } as Partial<RiskDecision>),
      { correlationId: 'req-1', latencyMs: 1, rawError },
      { includeRawError: true },
    );
    expect(event.rawErrorDetail!.length).toBeLessThan(1000);
  });
});

describe('riskDecisionLogLevel / emitRiskDecisionProvenance', () => {
  it('maps unavailable/incompatible to error', () => {
    expect(riskDecisionLogLevel('unavailable')).toBe('error');
    expect(riskDecisionLogLevel('incompatible')).toBe('error');
  });

  it('maps degraded/policy-blocked to warn', () => {
    expect(riskDecisionLogLevel('degraded')).toBe('warn');
    expect(riskDecisionLogLevel('policy-blocked')).toBe('warn');
  });

  it('maps verified/unscored to info', () => {
    expect(riskDecisionLogLevel('verified')).toBe('info');
    expect(riskDecisionLogLevel('unscored')).toBe('info');
  });

  it('emits through the injected logger at the mapped level', () => {
    const seen: Array<{ level: string; message: string; fields?: LogFields }> = [];
    const logger = {
      debug: (message: string, fields?: LogFields) =>
        seen.push({ level: 'debug', message, fields }),
      info: (message: string, fields?: LogFields) => seen.push({ level: 'info', message, fields }),
      warn: (message: string, fields?: LogFields) => seen.push({ level: 'warn', message, fields }),
      error: (message: string, fields?: LogFields) =>
        seen.push({ level: 'error', message, fields }),
    };

    const event = createRiskDecisionProvenanceEvent(
      verifiedDecision({ outcome: 'incompatible' } as Partial<RiskDecision>),
      { correlationId: 'req-1', latencyMs: 1 },
    );
    emitRiskDecisionProvenance(logger, event);

    expect(seen).toHaveLength(1);
    expect(seen[0].level).toBe('error');
    expect(seen[0].message).toBe('risk_decision_provenance');
  });

  it('never throws when using the noop logger', () => {
    const event = createRiskDecisionProvenanceEvent(verifiedDecision(), {
      correlationId: 'req-1',
      latencyMs: 1,
    });
    expect(() => emitRiskDecisionProvenance(noopLogger, event)).not.toThrow();
  });
});
