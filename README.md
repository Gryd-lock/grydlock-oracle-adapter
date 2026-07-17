# grydlock-oracle-adapter 🔌

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue?logo=stellar)](https://stellar.org)
[![Soroban Smart Contracts](https://img.shields.io/badge/Smart%20Contracts-Soroban-purple)](https://soroban.stellar.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Status: In Development](https://img.shields.io/badge/status-in%20development-yellow)](#roadmap)

Read-client that fetches a 0–100 risk score for a Stellar address or asset from an on-chain risk oracle, and exposes it to the Gryd Lock extension behind a stable interface.

## Overview

`grydlock-oracle-adapter` is the closest thing Gryd Lock has to a backend — but it runs no server. It is a small, read-only client: given a destination, it calls a Soroban smart contract, reads a score, and returns it. Nothing more.

> **Status:** `StubOracle` is implemented and returns scores from the vendored `grydlock-testkit` fixtures. A live oracle connection is **not yet wired.**

### The Problem

Gryd Lock needs to warn users about risky Stellar addresses and assets before they sign a transaction, but it should not be in the business of computing that risk itself. Embedding scoring logic directly in the extension would mean:

- The extension would need direct chain access and scoring logic baked into its own codebase
- Swapping or upgrading the scoring engine would require an extension release
- There would be no way to develop or test the extension's warning flow without a live oracle

### What grydlock-oracle-adapter Does

At a high level, it does one thing, deliberately narrowly scoped:

- **🔎 Reads** — takes a destination (Stellar address or asset) and calls the on-chain risk oracle's `get_score()` function via Soroban
- **🔌 Adapts** — normalizes the oracle response behind a single, stable `RiskOracle` interface so the scoring backend can be swapped without touching the extension
- **📤 Exposes** — returns a plain 0–100 score to the Gryd Lock extension, with no chain-specific types leaking across the boundary

## Features

- **`RiskOracle` interface** — one method, `getScore(destination)`, that both implementations satisfy
- **`StubOracle`** — lookup-table score source backed by vendored `grydlock-testkit` fixtures, for local development and the `grydlock-testkit` evaluation; no network calls
- **`SorobanOracle`** _(planned)_ — calls `get_score()` on the live on-chain risk oracle contract and returns the result
- **Caching and fallback** _(planned)_ — a slow or unreachable oracle degrades gracefully instead of stalling the signing flow

<!-- TODO: expand this list as real implementation features land -->

## Architecture

```mermaid
graph TB
    subgraph Extension["Gryd Lock Extension"]
        UI[Signing Flow UI]
    end

    subgraph Adapter["grydlock-oracle-adapter"]
        IFACE[RiskOracle interface]
        STUB[StubOracle]
        SOROBAN[SorobanOracle - planned]
    end

    subgraph Chain["Stellar Network"]
        CONTRACT[On-chain Risk Oracle Contract]
    end

    UI -->|getScore destination| IFACE
    IFACE --> STUB
    IFACE -.->|not yet wired| SOROBAN
    SOROBAN -.->|get_score| CONTRACT
```

### Core Components

| Component              | Role                                                                      | Status              |
| ---------------------- | ------------------------------------------------------------------------- | ------------------- |
| `src/RiskOracle.ts`    | Defines the `getScore(destination)` contract                              | Implemented         |
| `src/StubOracle.ts`    | Lookup-table score source, backed by vendored `grydlock-testkit` fixtures | Implemented, tested |
| `src/SorobanOracle.ts` | Live client against the on-chain oracle contract                          | Not started         |

`src/fixtures/testkit/` is a vendored, point-in-time copy of `grydlock-testkit`'s
`destinations.json` and `scores.json` — not a live sync. If the testkit fixtures change, re-copy
them here to pick up the update.

## Interface (design)

The adapter exposes one job: turn a destination into a score.

```ts
// illustrative — not yet implemented
interface RiskOracle {
  // Returns a risk score 0–100 for a Stellar address or asset.
  getScore(destination: string): Promise<number>;
}
```

The extension depends on this shape and nothing beneath it. Two implementations are planned:

- **StubOracle** — returns a score from the vendored `grydlock-testkit` fixture lookup table (falling back to a default for unrecognized destinations). Used for development and for the `grydlock-testkit` evaluation. No network.
- **SorobanOracle** — calls `get_score()` on the live on-chain risk oracle contract and returns the result. Wired in a later phase.

## How the Extension Uses It

```ts
// illustrative
const oracle = new StubOracle(); // swap for SorobanOracle later
const score = await oracle.getScore(dest); // 0–100
showWarning(score); // extension maps score → tier
```

## Repository Structure

```
grydlock-oracle-adapter/
│
├── README.md                         ← This file
├── package.json                      ← Package manifest and npm scripts
├── tsconfig.json                     ← TypeScript compiler config (strict mode)
├── eslint.config.mjs                 ← ESLint flat config
├── .prettierrc.json                  ← Prettier config
├── vitest.config.ts                  ← Vitest config
├── commitlint.config.js              ← Conventional-commits lint rules
│
├── .husky/commit-msg                 ← Local commit-msg hook, runs commitlint
├── .github/workflows/ci.yml          ← CI: typecheck, lint, format check, test, build, commitlint
├── .github/workflows/cross-repo-sync.yml ← Weekly shared-contract drift check vs research/extension repos
│
├── scripts/
│   └── check-cross-repo-sync.mjs     ← Fetch + diff shared contracts from the other Gryd-lock repos
│
├── src/
│   ├── RiskOracle.ts                  ← Interface definition
│   ├── StubOracle.ts                  ← Lookup-table implementation, backed by fixtures/
│   ├── SorobanOracle.ts               ← Live oracle client (planned, not yet in src/)
│   ├── fixtures/testkit/              ← Vendored grydlock-testkit fixtures (destinations.json, scores.json)
│   └── index.ts                       ← Barrel export
│
└── tests/
    └── StubOracle.test.ts             ← getScore range + label-ordering tests against the fixtures
```

## Quick Start

```bash
npm install
npm run build      # compile src/ to dist/
npm test           # run the test suite
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run format     # prettier --write .
npm run sync:check # verify shared contracts against the other Gryd-lock repos
```

```ts
import { StubOracle } from './src';

const oracle = new StubOracle();
const score = await oracle.getScore('GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET'); // 95, labelled "malicious" in grydlock-testkit
```

## Tech Stack

- **TypeScript**
- **Soroban SDK** — reading the on-chain score
- **Stellar SDK (JS)** — address / asset handling
- **Stellar Testnet** — all development

## Testing

```bash
npm test
```

Covers:

- `StubOracle.getScore` returns a number within 0–100 for every destination in the vendored `grydlock-testkit` fixtures, and a default score for unrecognized destinations
- Fixture destinations labelled `malicious` score higher than those labelled `clean`

## Roadmap

- [x] Define the `RiskOracle` interface and ship `StubOracle`
- [x] Back `StubOracle` with vendored `grydlock-testkit` fixtures instead of a hardcoded table
- [ ] Wire `StubOracle` into the extension and confirm the query path end to end on testnet
- [ ] Implement `SorobanOracle` against a live oracle contract on testnet
- [ ] Add caching and a timeout / fallback so a slow or unreachable oracle degrades gracefully instead of stalling the signing flow

## Why This Matters for Gryd Lock

- **For the extension** — never talks to the chain directly; it just asks the adapter for a score
- **For the scoring backend** — pluggable; swap the oracle and nothing upstream changes
- **For development** — the signing-flow UI can be built and tested against `StubOracle` with no live backend at all

## Dependencies

- TypeScript ^6.0.3, Vitest ^4.1.10, ESLint ^10.6.0 + typescript-eslint ^8.63.0, Prettier ^3.9.4 — see `package.json` for the full, pinned list
- `soroban-client` / Soroban SDK — _planned, for `SorobanOracle`_
- Stellar SDK (JS) — _planned, for `SorobanOracle`_

## License

MIT

## Contributing

grydlock-oracle-adapter is being developed as an open-source contribution to the Stellar ecosystem. We are actively looking for collaborators with experience in:

- Stellar / Soroban smart contract development (Rust)
- TypeScript backend and browser-extension development
- On-chain data analysis and Stellar Horizon API integration
- Testing and evaluation methodology (`grydlock-testkit`)

Quick checklist for contributions:

- All tests pass: `npm test`
- Code follows project style guidelines: `npm run lint` and `npm run format:check`
- New features include tests
- Documentation is updated
- Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) style below

### Commit message convention

Commit messages are linted with [commitlint](https://commitlint.js.org/) using the
[`@commitlint/config-conventional`](https://github.com/conventional-changelog/commitlint/tree/master/%40commitlint/config-conventional)
preset, so that commit history stays parseable for automated semantic versioning. Every commit
message must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common `<type>` values:

| Type       | Use for                                                        |
| ---------- | -------------------------------------------------------------- |
| `feat`     | A new feature                                                  |
| `fix`      | A bug fix                                                      |
| `docs`     | Documentation-only changes                                     |
| `style`    | Formatting changes with no code meaning change (e.g. Prettier) |
| `refactor` | A code change that neither fixes a bug nor adds a feature      |
| `test`     | Adding or correcting tests                                     |
| `chore`    | Tooling, dependency, or build-process changes                  |

Examples:

```
feat: add SorobanOracle implementation
fix(RiskOracle): handle missing destination score
docs: update README license section to MIT
chore: add commitlint and husky commit-msg hook
```

This is enforced two ways:

- **Locally** — a husky `commit-msg` hook runs `commitlint` on every commit. Run `npm install`
  once after cloning so husky installs the hook (via the `prepare` script).
- **In CI** — the `commitlint` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
  lints every commit on a pull request, covering contributors who bypass the local hook (e.g.
  `git commit --no-verify`).

## Gryd Lock Organization

Gryd Lock is split across four repos in the `Gryd-lock` GitHub org:

| Repo                                                                    | Role                                                                                                                                                                       | Has code?                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`grydlock-research`](https://github.com/Gryd-lock/grydlock-research)   | Design study: threat model, system design, warning-tier thresholds, evaluation methodology. The reasoning the other three repos implement.                                 | No — design docs only                                                                                 |
| [`grydlock-extension`](https://github.com/Gryd-lock/grydlock-extension) | Browser extension. Intercepts a wallet's signing flow (Freighter first), decodes the pending transaction, asks the oracle adapter for a score, and shows a tiered warning. | Yes — early build: Freighter intercept, XDR decode, and warning popup implemented                     |
| **`grydlock-oracle-adapter`** _(this repo)_                             | Read-only client. Exposes `RiskOracle.getScore(destination)` to the extension; backed by `StubOracle` today, `SorobanOracle` later.                                        | Yes — `RiskOracle` + `StubOracle` implemented and tested                                              |
| [`grydlock-testkit`](https://github.com/Gryd-lock/grydlock-testkit)     | Testnet fixtures and stub scores used to evaluate the extension + adapter together.                                                                                        | Yes — labelled destinations, stub scores, and sample XDRs implemented, with a fixture validator in CI |

### How a signing flow moves through them

```mermaid
graph LR
    SIGN[Wallet signing flow] --> EXT[grydlock-extension\nintercept + decode]
    EXT -->|getScore destination| ADAPTER[grydlock-oracle-adapter\nRiskOracle]
    ADAPTER -->|StubOracle today| SCORE[0-100 score]
    ADAPTER -.->|SorobanOracle later| CHAIN[On-chain risk oracle]
    SCORE --> EXT
    EXT --> TIER[Warning tier]
    TIER --> USER{User decision}
```

`grydlock-testkit` supplies the fixture destinations and expected scores that `grydlock-extension`
and `grydlock-oracle-adapter` are evaluated against. `grydlock-research` is upstream of all
three — it defines the threat model and the warning-tier thresholds below.

### Shared contracts (must stay in sync across repos)

**1. `RiskOracle` interface** — defined here at `src/RiskOracle.ts`:

```ts
interface RiskOracle {
  getScore(destination: string): Promise<number>; // 0-100
}
```

`grydlock-extension` depends on this shape only — it does not know whether the score came from
`StubOracle` or a live oracle. If this signature changes, `grydlock-extension` needs a matching
update.

**2. Warning tiers** — defined in `grydlock-research`, consumed by `grydlock-extension` to decide
how loudly to warn:

| Score  | Tier     | Behaviour                       |
| ------ | -------- | ------------------------------- |
| 0–20   | Low      | Proceed                         |
| 21–50  | Elevated | Soft warning                    |
| 51–75  | High     | Strong warning, require confirm |
| 76–100 | Critical | Recommend abort                 |

### Verifying cross-repo sync (canonical method)

Don't verify the shared contracts above by reading READMEs across repos — that's exactly the
manual process that lets drift slip through. The canonical way to check sync is:

```bash
npm run sync:check
```

`scripts/check-cross-repo-sync.mjs` fetches the current state of the contracts from the other
public repos and diffs them against this repo:

- **Warning tiers** — parses the canonical table in `grydlock-research`'s README and compares
  it against both `grydlock-extension`'s implementation (`src/lib/tiers.ts`) and this repo's
  own README table
- **`RiskOracle.getScore`** — compares the signature in `src/RiskOracle.ts` against the
  stand-in the extension declares in `src/adapter/oracleAdapter.ts`

On drift it prints a PASS/FAIL report with the expected (canonical) vs actual values, writes
`drift-report.md`, and exits non-zero. CI runs it weekly (Mondays 06:00 UTC, plus on PRs that
touch a contract surface — see `.github/workflows/cross-repo-sync.yml`), since drift
originates in the other repos rather than in pushes here; a scheduled run that finds drift
automatically opens (or updates) a tracking issue labelled `cross-repo-drift`. A fetch or
parse failure exits with a distinct code (2) and is reported as "needs a human look", not as
confirmed drift.

### Conventions for AI Agents

- Treat this section as the source of truth for **cross-repo** context. Each repo's own README
  covers repo-local conventions.
- Before assuming a name/function/interface still exists in another repo, verify it there — this
  reflects each repo's state as of the last time it was checked, not a live feed. For the two
  shared contracts above, run `npm run sync:check` instead of eyeballing.
- If a change here affects `RiskOracle` or the warning-tier thresholds, call it out so the
  corresponding repo can be updated.

## Support

For issues and questions:

- GitHub Issues: https://github.com/Gryd-lock/grydlock-oracle-adapter/issues
- Stellar Discord: https://discord.gg/stellar

---

<div align="center">

**grydlock-oracle-adapter** — the one door Gryd Lock knocks on for a risk score.

_Part of the Gryd Lock project. Interface defined, live oracle not yet wired._

</div>
