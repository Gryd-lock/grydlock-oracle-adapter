# Development

## Checks

| Command                                 | What it does                                                           |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `npm test`                              | Vitest unit, fuzz, concurrency and type tests (live tests skipped)     |
| `npm run test:live`                     | Live suite against the testnet contract (network required)             |
| `npm run typecheck`                     | `tsc` on `src/` and the type tests                                     |
| `npm run lint`                          | ESLint                                                                 |
| `npm run format:check`                  | Prettier (CI auto-formats if this fails)                               |
| `npm run build`                         | ESM + CJS bundles and `.d.ts` into `dist/`                             |
| `npm run test:smoke`                    | Imports the built package via ESM, CJS and a browser bundler           |
| `npm run size`                          | Bundle-size budgets and tree-shaking allowlist                         |
| `npm run docs:check`                    | Fails if any exported symbol lacks a doc comment                       |
| `npm run docs`                          | Generates the TypeDoc API reference into `docs/api/` (gitignored)      |
| `npm run sbom`, `npm run license-check` | Supply-chain gates (see [CONTRIBUTING.md](../CONTRIBUTING.md))         |
| `npm run sync:fixtures`                 | Refresh the vendored grydlock-testkit fixtures                         |
| `npm run sync:check`                    | Diff shared contracts against grydlock-extension and grydlock-research |

`test:live` sets an environment variable inline, so it needs a POSIX shell. On Windows, set
`GRYDLOCK_LIVE_TESTNET=1` yourself and run `npx vitest run tests/SorobanOracle.testnet.test.ts`.

## Contract

```sh
cd contract
cargo test                       # unit tests
stellar contract build           # wasm (soroban-sdk 29 requires the Stellar CLI to build)
node ../scripts/deploy-testnet-contract.mjs   # build, deploy and seed on testnet
```

See [`contract/README.md`](../contract/README.md).

## CI workflows

| Workflow              | Trigger                       | Runs                                                          |
| --------------------- | ----------------------------- | ------------------------------------------------------------- |
| `ci.yml`              | pull requests                 | checks above on Node 20/22/24, commitlint, supply-chain gates |
| `contract.yml`        | changes under `contract/`     | `cargo fmt`, `clippy -D warnings`, `cargo test`, wasm build   |
| `testnet-nightly.yml` | daily                         | live testnet suite; opens an issue on failure                 |
| `cross-repo-sync.yml` | weekly + contract-surface PRs | `sync:check`; opens a `cross-repo-drift` issue on drift       |
| `sync-fixtures.yml`   | weekly                        | refreshes testkit fixtures                                    |
| `release.yml`         | push to `main`                | semantic-release                                              |
| `docs.yml`            | push to `main`, releases      | builds the API reference for GitHub Pages                     |
| `mutation.yml`        | nightly                       | Stryker mutation testing                                      |

Known broken:

- **`docs.yml`**: GitHub Pages isn't enabled for the repo, so the deploy step fails and the
  API reference isn't published. Run `npm run docs` locally instead.
- **`mutation.yml`**: it calls `npm run test:mutation`, which doesn't exist. Adding
  `stryker run` isn't enough on its own, because Stryker's vitest runner uses worker threads,
  which reject the `--expose-gc` flag `vitest.config.ts` passes.

## Commits and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). A husky
`commit-msg` hook checks them locally (installed by `npm install`), and the `commitlint` CI job
checks them again on pull requests.

`release.yml` runs [semantic-release](https://semantic-release.gitbook.io/) on every push to
`main`. `fix:` gives a patch release, `feat:` a minor one, and a `BREAKING CHANGE:` footer a
major one. Each release produces a git tag, a `CHANGELOG.md` entry and a GitHub Release. The
package is `private` and not published to npm. Consumers install it from a commit tarball.

## Cross-repo contracts

Two things must stay in sync across the org:

1. The `RiskOracle` signature (`src/RiskOracle.ts`), which grydlock-extension consumes.
2. The warning tiers, defined in grydlock-research and implemented in grydlock-extension. They
   are mirrored in the README's "How it fits in the project" section.

`npm run sync:check` compares both against the other repos. Exit code 1 means drift was found,
and 2 means a source couldn't be fetched. The script parses the tier table out of `README.md`,
so keep that table's format when you edit the README.
