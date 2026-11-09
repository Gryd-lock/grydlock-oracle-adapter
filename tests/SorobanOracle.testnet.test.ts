import { describe, expect, it } from 'vitest';
import {
  ContractIncompatibilityError,
  GRYDLOCK_TESTNET,
  OracleTimeoutError,
  UnrecognizedDestinationError,
  WrongNetworkError,
  createSorobanOracle,
} from '../src';
import deployment from '../contract/deployments/testnet.json';

/**
 * Live check against the reference contract deployed on Stellar testnet
 * (contract/deployments/testnet.json). It makes real Soroban RPC calls, so
 * it is skipped unless you opt in:
 *
 *   GRYDLOCK_LIVE_TESTNET=1 npx vitest run tests/SorobanOracle.testnet.test.ts
 *
 * Setting GRYDLOCK_TESTNET_CONTRACT_ID also opts in, and points the suite at
 * that contract instead. It must be seeded from the same scores.json. CI runs
 * this nightly (.github/workflows/testnet-nightly.yml) instead of on every PR,
 * so a testnet outage can't block merges.
 */
const overrideContractId = process.env.GRYDLOCK_TESTNET_CONTRACT_ID;
const enabled = process.env.GRYDLOCK_LIVE_TESTNET === '1' || Boolean(overrideContractId);
const contractId = overrideContractId ?? deployment.contractId;
const target = { ...GRYDLOCK_TESTNET, contractId };
const seeded = deployment.seeded as Record<string, number>;

/** A valid account the seed data never mentions. */
const UNSEEDED_ACCOUNT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const LIVE_TIMEOUT_MS = 30_000;

describe.skipIf(!enabled)('SorobanOracle (live testnet)', () => {
  const oracle = createSorobanOracle({ ...target, environment: 'test', requestBudgetMs: 20_000 });

  it(
    'reads a seeded account score with full provenance',
    async () => {
      const [destination, expected] = Object.entries(seeded).find(([key]) => key.startsWith('G'))!;
      const result = await oracle.getScoreDetailed(destination);

      expect(result.score).toBe(expected);
      expect(result.source).toBe('SorobanOracle');
      expect(result.contractId).toBe(contractId);
      expect(result.networkPassphrase).toBe(GRYDLOCK_TESTNET.networkPassphrase);
      expect(result.interfaceVersion).toBe(1);
      expect(result.ledgerSequence).toBeGreaterThan(0);
      expect(result.observedConfirmations).toBeGreaterThanOrEqual(1);
      expect(result.ledgerCloseTimeUnixMs).toBeLessThanOrEqual(Date.now());
      // Seeded once, so it goes stale after DEFAULT_SOROBAN_FINALITY_POLICY's 7 days.
      expect(['live', 'cache-stale']).toContain(result.cacheStatus);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'reads a seeded SEP-11 asset score',
    async () => {
      const asset = Object.keys(seeded).find((key) => key.includes(':'));
      expect(asset).toBeDefined();
      expect(await oracle.getScore(asset!)).toBe(seeded[asset!]);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'reports an unseeded destination as unrecognized, not as a number',
    async () => {
      await expect(oracle.getScore(UNSEEDED_ACCOUNT)).rejects.toBeInstanceOf(
        UnrecognizedDestinationError,
      );
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'refuses to read when configured for a different network',
    async () => {
      const mainnet = createSorobanOracle({
        ...target,
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        environment: 'test',
      });
      await expect(mainnet.getScore(UNSEEDED_ACCOUNT)).rejects.toBeInstanceOf(WrongNetworkError);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'reports a contract id with no deployed instance as CONTRACT_NOT_FOUND',
    async () => {
      const missing = createSorobanOracle({
        ...target,
        contractId: 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L',
        environment: 'test',
      });
      const error = await missing.getScore(UNSEEDED_ACCOUNT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ContractIncompatibilityError);
      expect((error as ContractIncompatibilityError).code).toBe('CONTRACT_NOT_FOUND');
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'surfaces an exhausted budget as OracleTimeoutError',
    async () => {
      const impatient = createSorobanOracle({ ...target, environment: 'test', requestBudgetMs: 1 });
      await expect(impatient.getScore(UNSEEDED_ACCOUNT)).rejects.toBeInstanceOf(OracleTimeoutError);
    },
    LIVE_TIMEOUT_MS,
  );
});
