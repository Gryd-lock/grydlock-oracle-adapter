# grydlock-oracle-adapter 🔌

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue?logo=stellar)](https://stellar.org)
[![Soroban Smart Contracts](https://img.shields.io/badge/Smart%20Contracts-Soroban-purple)](https://soroban.stellar.org)
[![License: TBD](https://img.shields.io/badge/License-TBD-lightgrey.svg)](#license)
[![Status: In Development](https://img.shields.io/badge/status-in%20development-yellow)](#roadmap)
[![CI](https://github.com/Gryd-lock/grydlock-oracle-adapter/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)

Read-client that fetches a 0–100 risk score for a Stellar address or asset from an on-chain risk oracle, and exposes it to the Gryd Lock extension behind a stable interface.

## Overview

`grydlock-oracle-adapter` is the closest thing Gryd Lock has to a backend — but it runs no server. It is a small, read-only client: given a destination, it calls a Soroban smart contract, reads a score, and returns it. Nothing more.

> **Status:** `RiskOracle` interface and `StubOracle` are implemented and tested. A live oracle connection (`SorobanOracle`) is **not yet wired.**

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
- **`StubOracle`** _(implemented)_ — hardcoded lookup-table score source for local development and the `grydlock-testkit` evaluation; no network calls
- **`SorobanOracle`** _(planned)_ — calls `get_score()` on the live on-chain risk oracle contract and returns the result
- **Caching and fallback** _(planned)_ — a slow or unreachable oracle degrades gracefully instead of stalling the signing flow

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

| Component               | Role                                              | Status                       |
| ------------------------ | -------------------------------------------------- | ----------------------------- |
| `src/RiskOracle.ts`      | Defines the `getScore(destination)` contract       | Implemented                   |
| `src/StubOracle.ts`      | Hardcoded lookup-table score source for local dev  | Implemented, tested           |
| `src/SorobanOracle.ts`   | Live client against the on-chain oracle contract   | Not started                   |

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

- **StubOracle** — returns a fixed or lookup-table score. Used for development and for the `grydlock-testkit` evaluation. No network.
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
│
├── .github/workflows/ci.yml          ← CI: typecheck, lint, format check, test, build
│
├── src/
│   ├── RiskOracle.ts                  ← Interface definition
│   ├── StubOracle.ts                  ← Hardcoded lookup-table implementation
│   └── index.ts                       ← Barrel export
│
└── tests/
    └── StubOracle.test.ts             ← getScore range test
```

`SorobanOracle` is not yet in `src/` — see [Roadmap](#roadmap).

## Quick Start

```bash
npm install
npm run build      # compile src/ to dist/
npm test           # run the test suite
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run format     # prettier --write .
```

```ts
import { StubOracle } from './src';

const oracle = new StubOracle();
const score = await oracle.getScore('GAKNOWNWASHTRADERWALLETEXAMPLE'); // 95
```

## Tech Stack

- **TypeScript** (strict mode)
- **Vitest** — test runner
- **ESLint** + **typescript-eslint** — linting
- **Prettier** — formatting
- **Soroban SDK** _(planned)_ — reading the on-chain score
- **Stellar SDK (JS)** _(planned)_ — address / asset handling
- **Stellar Testnet** _(planned)_ — all development

## Testing

<!-- TODO: fill in once a test runner and real tests exist -->

No tests exist yet. Test tooling and coverage will be documented here once `StubOracle` lands.

## Roadmap

- [ ] Define the `RiskOracle` interface and ship `StubOracle` _(in progress)_
- [ ] Wire `StubOracle` into the extension and confirm the query path end to end on testnet
- [ ] Implement `SorobanOracle` against a live oracle contract on testnet
- [ ] Add caching and a timeout / fallback so a slow or unreachable oracle degrades gracefully instead of stalling the signing flow

## Why This Matters for Gryd Lock

- **For the extension** — never talks to the chain directly; it just asks the adapter for a score
- **For the scoring backend** — pluggable; swap the oracle and nothing upstream changes
- **For development** — the signing-flow UI can be built and tested against `StubOracle` with no live backend at all

## Dependencies

<!-- TODO: pin real versions once package.json exists -->

- TypeScript
- `soroban-client` / Soroban SDK
- Stellar SDK (JS)

## License

<!-- TODO: pick and add a LICENSE file -->

TBD

## Contributing

<!-- TODO: flesh out once the project has real contribution surface area -->

Gryd Lock Oracle Adapter is part of the Gryd Lock project. Contribution guidelines will be added once the initial `StubOracle` implementation lands.

## Gryd Lock Organization

<!-- TODO: confirm repo names/roles once the org structure is finalized -->

| Repo                                        | Role                                                                                                                       | Primary language |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **`grydlock-extension`** _(TBD)_            | The browser extension that surfaces risk warnings in the signing flow                                                      | TypeScript       |
| **`grydlock-oracle-adapter`** _(this repo)_ | Read-only client that fetches a 0–100 risk score from the on-chain oracle and exposes it behind the `RiskOracle` interface | TypeScript       |
| **`grydlock-testkit`** _(TBD)_              | Evaluation harness that exercises the extension against `StubOracle`                                                       | TypeScript       |
| Risk oracle contract _(TBD)_                | On-chain Soroban contract that computes and serves risk scores via `get_score()`                                           | Rust (Soroban)   |

## Support

<!-- TODO: add real issue tracker / community links -->

For issues and questions:

- GitHub Issues: Create an issue in this repo
- Stellar Discord: https://discord.gg/stellar

---

<div align="center">

**grydlock-oracle-adapter** — the one door Gryd Lock knocks on for a risk score.

_Part of the Gryd Lock project. Interface defined, live oracle not yet wired._

</div>
