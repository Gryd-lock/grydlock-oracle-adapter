# Contributing

Thanks for contributing to the Grydlock Oracle Adapter!

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
