# Restart runbook: `createProductionOracleStack`

Operational reference for the restart-safe lifecycle stack from #112. See
`LIFECYCLE_ADR.md` for the design rationale; this document is the "what do I
actually do" companion.

## Wiring it up

```ts
import {
  createProductionOracleStack,
  createChromeStorageLocalStore,
} from 'grydlock-oracle-adapter';

const store = createChromeStorageLocalStore('grydlock'); // null outside a chrome.storage.local-shaped host

const stack = createProductionOracleStack({
  inner: myRawOracle,
  namespace: {
    network: STELLAR_NETWORK_PASSPHRASE,
    contract: RISK_ORACLE_CONTRACT_ID,
    evidenceSchemaVersion: '1',
    policyVersion: '1', // bump this whenever ttl/staleness/eviction policy changes
  },
  cache: { ttlMs: 30_000, staleMs: 60_000, maxEvidenceAgeMs: 5 * 60_000 },
  rateLimit: { budget: 100, windowMs: 60_000, contextId: STABLE_CONTEXT_ID },
  circuitBreaker: { failureThreshold: 5, cooldownWindow: 30_000 },
  refreshLease: {}, // enables cross-context lease coordination
  store: store ?? undefined,
});

await stack.lifecycle.init();
// serve traffic via stack.oracle
```

`STABLE_CONTEXT_ID` matters: it's what lets the rate limiter recognize "this
is the same context resuming" across a restart. Generate it once (e.g. on
first install) and persist it yourself — a fresh random id every restart
means the rate limiter can never find its own prior bucket state, which is
still correct (a genuinely new identity should start with an empty budget)
but not restart-_continuous_.

## Shutdown / suspend

Call `stack.dispose()` (equivalently `stack.lifecycle.dispose()`) from
`chrome.runtime.onSuspend` and from any other shutdown path your host
exposes. It is idempotent and safe to call from more than one such path.
After disposal, `stack.oracle.getScore(...)` throws rather than silently
continuing to serve or admit traffic.

## Operational scenarios

| Scenario                                                                           | What happens                                                                                                                                     | Action needed                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| MV3 worker suspended, no in-flight lease                                           | Nothing to do — no timers, no open work                                                                                                          | None                                                         |
| MV3 worker suspended while holding a refresh lease (Web Locks)                     | Platform releases the lock immediately                                                                                                           | None                                                         |
| MV3 worker suspended while holding a refresh lease (gossip fallback, no Web Locks) | Peers recover the lease after `refreshLease.leaseMs` (default: `cache.ttlMs + cache.staleMs`)                                                    | None — bounded automatically                                 |
| Cold start, `store` configured                                                     | `withCache` hydrates matching-namespace, non-expired evidence on first `getScore`; rate limiter restores its own bucket if `contextId` is stable | None                                                         |
| Network switch / contract upgrade                                                  | Construct a **new** stack with a new `namespace`                                                                                                 | Bump `namespace.network`/`namespace.contract`                |
| Cache/eviction policy change                                                       | Old records must not be reinterpreted under the new policy                                                                                       | Bump `namespace.policyVersion`                               |
| `store` write failures (quota, serialization)                                      | Logged via the configured `logger`; in-memory state stays authoritative for the current process                                                  | Monitor `logger` output; not restart-safe until quota clears |
| Corrupt persisted record found on hydration                                        | Quarantined (deleted from `store`), treated as absent                                                                                            | None — self-healing                                          |
| `chrome.storage.local` unavailable (content-script-only context)                   | `createChromeStorageLocalStore` returns `null`; pass `store: undefined`                                                                          | Stack runs in-memory-only, non-restart-safe mode             |

## Fault-injection checklist (for anyone extending this stack)

- Kill the lease owner mid-refresh (no `release()` call) → confirm recovery
  within `leaseMs` (`tests/lifecycle/RefreshLeaseCoordinator.test.ts`).
- Corrupt a persisted cache/rate-limit record directly in the store → confirm
  it's quarantined, not loaded (`tests/withCache.lifecycle.test.ts`).
- Restart with a mismatched `namespace` → confirm old evidence is
  unservable, not silently reinterpreted.
- Flood gossip with oversized/malformed/clock-skewed/forged-identity
  messages → confirm bounded memory and no acceptance
  (`tests/withRateLimit.lifecycle.test.ts`,
  `tests/lifecycle/RefreshLeaseCoordinator.test.ts`).
- Double-dispose the stack from two shutdown paths → confirm no
  double-close/double-teardown errors.
