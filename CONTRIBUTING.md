# Contributing

Thanks for contributing to grydlock-oracle-adapter.

## Pick an issue

- Browse [open issues](https://github.com/Gryd-lock/grydlock-oracle-adapter/issues). Labels
  give the size (`difficulty: S` / `M` / `L` / `XL`) and the area (`area: contract`,
  `area: resilience`, and so on). `good first issue` marks a good starting point.
- Comment on the issue before you start, so two people don't build the same thing.
- Every issue has acceptance criteria. A PR is done when it meets all of them.

## Set up

```sh
git clone https://github.com/Gryd-lock/grydlock-oracle-adapter.git
cd grydlock-oracle-adapter
npm ci          # also installs the commit-msg hook
```

Contract work also needs Rust with the `wasm32v1-none` target and the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli). See
[`contract/README.md`](contract/README.md).

## Before you open a PR

Run what CI runs:

```sh
npm run typecheck && npm run lint && npm test && npm run size && npm run build && npm run test:smoke && npm run docs:check
```

- For changes to `src/StellarRpcTransport.ts` or `src/SorobanOracle.ts`, also run
  `npm run test:live` against testnet.
- For changes under `contract/`, run `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
  in `contract/`.
- Every exported symbol needs a doc comment, or `docs:check` fails.
- A new export goes in the experimental section of `src/index.ts` unless a maintainer
  agrees it is stable.

## Open the PR

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:` or `chore:`. A breaking change needs a `!` or a `BREAKING CHANGE:`
  footer. Releases are cut automatically from these messages
  (see [docs/development.md](docs/development.md)).
- Link the issue (`Closes #123`), say what you tested, and call out any bundle-size budget
  change.
- Keep PRs small. One issue per PR is ideal.

## Supply-chain gates

Every PR runs a `supply-chain` CI job that enforces three things:

1. **SBOM generation** — a CycloneDX 1.6 SBOM is generated to `sbom/bom.json`
   and uploaded as a build artifact. Re-run locally with `npm run sbom`.
2. **Vulnerability audit** — `npm audit --audit-level=high` fails the build on
   any `high` or `critical` advisory in the dependency tree.
3. **License policy** — `npm run license-check` enforces an allowlist
   (MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0,
   Python-2.0, WTFPL, CC-BY-4.0) and a denylist (AGPL-3.0, GPL-3.0, LGPL-3.0,
   GPL-2.0, LGPL-2.1, CC-BY-NC-4.0).

### Handling a flagged dependency

If CI fails the supply-chain job, do **not** silence the gate. Instead:

- **Vulnerability:** bump the affected package to a patched version
  (`npm update <pkg>` or pin a safe range), then re-run `npm audit --audit-level=high`
  locally until it is clean. If no fix exists upstream, note it in the PR and
  ping a maintainer — do not merge with a known high/critical advisory.
- **License:** if a transitive dep uses a denylisted license (e.g. GPL/AGPL),
  find an equivalent MIT/Apache-licensed alternative, or discuss with maintainers.
  Adding it to the allowlist requires explicit maintainer approval in the PR.
- **SBOM:** if `npm run sbom` fails, ensure `@cyclonedx/cyclonedx-npm` is
  installed (`npm ci` should pull it from devDependencies).

The root project package is exempt from the license check (governed by this
repo's own `LICENSE` file).
