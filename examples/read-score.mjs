/* global console, process */
/**
 * Reads one live risk score from the reference contract on Stellar testnet.
 *
 *   npm run build
 *   node examples/read-score.mjs [destination]
 *
 * The destination defaults to a seeded testkit account (score 92). Try an
 * address that isn't seeded to see `UNRECOGNIZED_DESTINATION` instead of a
 * made-up 0.
 */
import { createSorobanOracle, GRYDLOCK_TESTNET, OracleError } from 'grydlock-oracle-adapter';

const destination = process.argv[2] ?? 'GD7XPB2A7CG5Z4ICV24B3LXCRHAEJRFEK4OEW3ZIOQAPJOHAXBB7QHGE';

// The public testnet RPC can take several seconds to answer, so allow 20 s.
const oracle = createSorobanOracle({
  ...GRYDLOCK_TESTNET,
  environment: 'development',
  requestBudgetMs: 20_000,
});

try {
  const r = await oracle.getScoreDetailed(destination);
  console.log(
    `score ${r.score} (${r.cacheStatus}), contract ${r.contractId}, ledger ${r.ledgerSequence}`,
  );
} catch (error) {
  if (!(error instanceof OracleError)) throw error;
  console.log(`no score: ${error.code}`);
  process.exitCode = 1;
}
