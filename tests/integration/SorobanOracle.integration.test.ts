import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanOracle, SOROBAN_SOURCE } from '../../src/SorobanOracle';
import { scores } from '../../src/fixtures/testkit';
import {
  ContractIncompatibilityError,
  InvalidDestinationError,
  OracleTimeoutError,
  OracleUnavailableError,
  UnrecognizedDestinationError,
} from '../../src/OracleError';
import { createRiskOracleFixture } from './riskOracleFixture';
import { SorobanRpcServerHandle, startSorobanRpcServer } from './sorobanRpcHarness';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function pickKnownDestination(): { destination: string; score: number } {
  const destination = Object.keys(scores)[0];
  if (destination === undefined) {
    throw new Error('the vendored testkit score fixture is empty');
  }
  return { destination, score: scores[destination] as number };
}

function makeUnknownDestination(): string {
  for (;;) {
    const candidate = Keypair.random().publicKey();
    if (!(candidate in scores)) return candidate;
  }
}

describe('SorobanOracle integration harness', () => {
  let server: SorobanRpcServerHandle;
  let oracle: SorobanOracle;
  let known: { destination: string; score: number };

  beforeAll(async () => {
    known = pickKnownDestination();
    server = await startSorobanRpcServer(createRiskOracleFixture(scores));
    oracle = new SorobanOracle({ rpcUrl: server.url, contractId: CONTRACT_ID });
  });

  afterAll(async () => {
    await server.close();
  });

  it('returns the fixture score for a known destination', async () => {
    const score = await oracle.getScore(known.destination);
    expect(score).toBe(known.score);
  });

  it('exercises the local RPC boundary for every fixture destination', async () => {
    for (const destination of Object.keys(scores)) {
      await expect(oracle.getScore(destination)).resolves.toBe(scores[destination]);
    }
  });

  it('returns live provenance metadata for a known destination', async () => {
    const before = Date.now();
    const result = await oracle.getScoreDetailed(known.destination);
    expect(result.score).toBe(known.score);
    expect(result.source).toBe(SOROBAN_SOURCE);
    expect(result.cacheStatus).toBe('live');
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('throws InvalidDestinationError for a malformed destination', async () => {
    await expect(oracle.getScore('not-a-destination')).rejects.toBeInstanceOf(
      InvalidDestinationError,
    );
  });

  it('throws InvalidDestinationError for a near-miss forged address', async () => {
    const tampered = known.destination.slice(0, -1) + 'O';
    await expect(oracle.getScore(tampered)).rejects.toBeInstanceOf(InvalidDestinationError);
  });

  it('throws UnrecognizedDestinationError for a valid but unknown destination', async () => {
    const unknown = makeUnknownDestination();
    await expect(oracle.getScore(unknown)).rejects.toBeInstanceOf(UnrecognizedDestinationError);
  });

  it('throws UnrecognizedDestinationError when the contract reverts', async () => {
    server.behavior.revertDestinations = new Set([known.destination]);
    try {
      await expect(oracle.getScore(known.destination)).rejects.toBeInstanceOf(
        UnrecognizedDestinationError,
      );
    } finally {
      server.behavior.revertDestinations = undefined;
    }
  });

  it('throws ContractIncompatibilityError for a malformed return value', async () => {
    server.behavior.malformedDestinations = new Set([known.destination]);
    try {
      await expect(oracle.getScore(known.destination)).rejects.toBeInstanceOf(
        ContractIncompatibilityError,
      );
    } finally {
      server.behavior.malformedDestinations = undefined;
    }
  });

  it('throws OracleUnavailableError when the RPC endpoint is unreachable', async () => {
    const dead = await startSorobanRpcServer(createRiskOracleFixture(scores));
    const url = dead.url;
    await dead.close();

    const orphan = new SorobanOracle({ rpcUrl: url, contractId: CONTRACT_ID });
    await expect(orphan.getScore(known.destination)).rejects.toBeInstanceOf(OracleUnavailableError);
  });

  it('throws OracleUnavailableError when the RPC responds with a 5xx', async () => {
    server.behavior.httpStatus = 500;
    try {
      await expect(oracle.getScore(known.destination)).rejects.toBeInstanceOf(
        OracleUnavailableError,
      );
    } finally {
      server.behavior.httpStatus = undefined;
    }
  });

  it('throws OracleTimeoutError when the RPC is too slow', async () => {
    server.behavior.delayMs = 300;
    const slow = new SorobanOracle({
      rpcUrl: server.url,
      contractId: CONTRACT_ID,
      timeoutMs: 50,
    });
    try {
      await expect(slow.getScore(known.destination)).rejects.toBeInstanceOf(OracleTimeoutError);
    } finally {
      server.behavior.delayMs = undefined;
    }
  });
});
