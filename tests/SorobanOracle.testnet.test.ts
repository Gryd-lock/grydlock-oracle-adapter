import { describe, it } from 'vitest';

/**
 * Gated live-testnet check for `SorobanOracle`.
 *
 * This is intentionally NOT exercised by this PR or by CI: it needs a real
 * deployed Soroban risk-oracle contract on testnet matching the protocol in
 * docs/adr/0001-soroban-oracle-protocol.md, and — since this PR ships only
 * the `SorobanRpcTransport` interface, not a real network implementation of
 * it (see that ADR's "Scope of this increment") — a `'live'` transport to
 * drive it with. Neither exists in this environment yet; wiring both up is
 * tracked by the epic's dependent issues (#1, #2, #3, #4, #15, #22, #66,
 * #90, #92), not by this increment.
 *
 * Once both exist, set `GRYDLOCK_TESTNET_CONTRACT_ID` to the deployed
 * contract's id to un-skip this suite locally. Until then it no-ops.
 */
const testnetContractId = process.env.GRYDLOCK_TESTNET_CONTRACT_ID;

describe.skipIf(!testnetContractId)('SorobanOracle (live testnet)', () => {
  it('reads a real score from the deployed contract', () => {
    // Intentionally unimplemented: exercising this requires both a real
    // SorobanRpcTransport (@stellar/stellar-sdk-backed) and a deployed
    // contract to point it at, neither of which exist in this repo yet.
    // This test exists as the wiring point for whoever lands that work —
    // see the file doc comment above.
    throw new Error(
      'GRYDLOCK_TESTNET_CONTRACT_ID is set, but this suite has no live SorobanRpcTransport ' +
        "implementation to run it against yet — see this file's doc comment.",
    );
  });
});
