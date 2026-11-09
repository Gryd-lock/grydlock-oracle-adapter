# Errors

Every failure is a subclass of `OracleError` with a stable `code`. Match on `instanceof` or
`code`, never on the message. No failure path returns a number.

| Error                              | `code`                          | Meaning                                                        |
| ---------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `OracleUnavailableError`           | `ORACLE_UNAVAILABLE`            | RPC unreachable, HTTP/JSON-RPC error, or score entry archived  |
| `OracleTimeoutError`               | `ORACLE_TIMEOUT`                | The request budget ran out                                     |
| `OracleCancelledError`             | `ORACLE_CANCELLED`              | The caller's `AbortSignal` fired                               |
| `InvalidDestinationError`          | `INVALID_DESTINATION`           | Malformed address or asset; thrown before any network call     |
| `UnrecognizedDestinationError`     | `UNRECOGNIZED_DESTINATION`      | Valid destination, but the oracle has no score (`Unscored`)    |
| `ScoreNotYetComputedError`         | `SCORE_NOT_YET_COMPUTED`        | Tracked but not yet scored (`Pending`)                         |
| `ContractIncompatibilityError`     | `CONTRACT_INCOMPATIBILITY`      | Contract has no `get_score`, or rejected the argument shape    |
| `ContractIncompatibilityError`     | `CONTRACT_NOT_FOUND`            | No contract instance at the configured id on this network      |
| `UnsupportedInterfaceVersionError` | `UNSUPPORTED_INTERFACE_VERSION` | Contract's interface version is outside the supported range    |
| `WrongNetworkError`                | `WRONG_NETWORK`                 | RPC node or response is on a different network than configured |
| `WrongContractError`               | `WRONG_CONTRACT`                | Response came from a different contract id                     |
| `MalformedOracleResponseError`     | `MALFORMED_ORACLE_RESPONSE`     | Return value doesn't match the protocol schema                 |
| `InsufficientFinalityError`        | `INSUFFICIENT_FINALITY`         | Result has fewer confirmations than `finalityPolicy` requires  |
| `QuorumNotMetError`                | `QUORUM_NOT_MET`                | (experimental aggregator) Too few sources answered             |
| `RiskDecisionValidationError`      | `RISK_DECISION_INVALID`         | (experimental `RiskDecision`) Decision failed validation       |
| `CacheControlUnsupportedError`     | `CACHE_CONTROL_UNSUPPORTED`     | (experimental `RequestContext`) Cache directive not supported  |

`UnsupportedInterfaceVersionError` is also an `instanceof ContractIncompatibilityError`.

The `SorobanOracle`-specific errors are explained in
[ADR 0001](adr/0001-soroban-oracle-protocol.md). Definitions are in
[`src/OracleError.ts`](../src/OracleError.ts).
