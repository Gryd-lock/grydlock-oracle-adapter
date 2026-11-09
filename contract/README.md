# grydlock-risk-oracle (reference Soroban contract)

A minimal, admin-curated 0–100 risk-score registry. It is the contract `SorobanOracle` +
`StellarRpcTransport` read on testnet. It is intentionally small: one admin sets scores by hand,
with no aggregation, staking, or dispute process. **Do not treat it as a production scoring
system.** The open issues track what that would need.

## Testnet deployment

|             |                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Contract ID | `CA42XDMAPI3QXA4XP6HEBPWD3IHZQ3YJB4MABSURASGGOVYU5QCWSC2M`                                                         |
| Network     | Stellar testnet (`Test SDF Network ; September 2015`)                                                              |
| RPC         | `https://soroban-testnet.stellar.org`                                                                              |
| Seed data   | [grydlock-testkit `scores.json`](https://github.com/Gryd-lock/grydlock-testkit/blob/main/scores.json) (12 entries) |

Full record, including the wasm hash, admin address, and every seeded score:
[`deployments/testnet.json`](deployments/testnet.json).

## Interface (version 1)

```rust
enum Target { Address(Address), Asset(String /* code */, Address /* issuer */), Pool(BytesN<32>) }
enum Score  { Scored(u32), Pending, Unscored }
struct LedgerStamp { sequence: u32, timestamp: u64 /* unix seconds */ }

fn get_score(target: Target) -> (Score, LedgerStamp, u32 /* interface_version */);   // read-only
fn set_score(target: Target, score: u32);    // admin; score <= 100, else error #1
fn set_pending(target: Target);              // admin
fn clear_score(target: Target);              // admin; target then reads Unscored
fn admin() -> Address;
fn set_admin(new_admin: Address);            // current admin
fn interface_version() -> u32;
```

- **`LedgerStamp`** is the ledger the outcome was _written_ at. For an `Unscored` target, which
  has no stored entry, it is the current ledger. The adapter uses it for ADR 0001's finality and
  staleness checks.
- **Targets** mirror the adapter's `ValidatedDestination`. `G` accounts and `C` contracts use
  `Address`, and muxed `M` accounts are scored under their base `G` account. SEP-11 assets use
  `Asset(code, issuer)` (an empty code or one over 12 characters is error #2), and liquidity pools
  use their 32-byte pool id.
- **Events.** `set_score`, `set_pending` and `clear_score` publish
  `score_updated { #[topic] target, score, sequence }`. `set_admin` publishes
  `admin_changed { previous, new_admin }`.
- **TTL.** Every write extends the instance and the written entry to the network's maximum TTL,
  so a seeded deployment stays readable without a restore.

## Develop

```sh
rustup target add wasm32v1-none
cargo test                     # unit tests (auth, range checks, events, absence semantics)
stellar contract build         # -> target/wasm32v1-none/release/grydlock_risk_oracle.wasm
```

## Deploy and seed

From the repo root:

```sh
node scripts/deploy-testnet-contract.mjs                    # build, upload, deploy, seed
node scripts/deploy-testnet-contract.mjs --contract-id C…   # re-seed an existing deployment
```

The script uses (and if needed creates and friendbot-funds) the Stellar CLI identity
`grydlock-testnet-admin`. That identity becomes the contract admin. Only someone who holds its
secret key can update scores, so to hand over control run `set_admin`.
