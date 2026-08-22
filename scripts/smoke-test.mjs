/* global console, process */
/**
 * Package entry-point smoke tests (issue #96).
 *
 * Verifies the *built* `dist/` output, not the TypeScript source, is
 * actually consumable the way a real downstream project would consume it:
 *
 *  1. Node ESM `import` of the package by name (exercises the `import`
 *     condition of package.json's `exports` map).
 *  2. Node CommonJS `require` of the package by name (exercises the
 *     `require` condition).
 *  3. A browser-oriented bundler (esbuild, platform "browser") resolving
 *     and bundling the ESM output without error.
 *
 * Run after `npm run build`; requires `dist/` to exist.
 *
 * (1) and (2) resolve the package by its own name rather than a relative
 * `dist/...` path — Node supports a package importing itself by name
 * ("self-reference") once its package.json declares both `name` and
 * `exports`, which this one does, so no `npm link`/install step is needed
 * to exercise the real `exports` map resolution.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';

const PKG_NAME = 'grydlock-oracle-adapter';

// Every export the barrel is expected to carry through to the built output;
// kept in sync with src/index.ts by hand, since a build-time diff against
// the source barrel would need TypeScript's own type information to do
// properly, which esbuild's bundling here does not have. Type-only exports
// (every plain `interface`/`type`, e.g. AllDetailed) are deliberately
// excluded: they compile away entirely and never exist on the built
// module's runtime export object, so an `in` check on one would always
// fail here regardless of whether the source-level re-export is correct.
// `CircuitBreakerState` is the one enum in the barrel and *is* included:
// unlike interfaces/types, a TypeScript enum compiles to a real runtime
// object.
const EXPECTED_EXPORTS = [
  'StubOracle',
  'validateDestination',
  'encodeAssetCode',
  'assetCodeType',
  'decodeStrKey',
  'encodeStrKey',
  'isValidStrKey',
  'decodeBase32',
  'encodeBase32',
  'crc16XModem',
  'StrKeyError',
  'STRKEY_BASE32_ALPHABET',
  'noopLogger',
  'ProvenanceOracle',
  'toBatchOracle',
  'OracleError',
  'OracleUnavailableError',
  'OracleTimeoutError',
  'InvalidDestinationError',
  'UnrecognizedDestinationError',
  'ContractIncompatibilityError',
  'QuorumNotMetError',
  'CoalescingOracle',
  'DefaultOracle',
  'CircuitBreakerOracle',
  'CircuitBreakerState',
  'defaultIsInfrastructureError',
  'FallbackOracle',
  'typedFallbackOracle',
  'RiskOracleAggregator',
  'weightedMedian',
  'honestOrderBounds',
  'computeDisagreement',
  'compose',
  'withCache',
  'withTimeout',
  'withProvenance',
  'withRateLimit',
  'OracleRateLimitError',
  'joinBucketMaps',
];

function assertExports(label, moduleExports) {
  const missing = EXPECTED_EXPORTS.filter((name) => !(name in moduleExports));
  if (missing.length > 0) {
    throw new Error(`${label}: missing expected export(s): ${missing.join(', ')}`);
  }
  console.log(`  ok: all ${EXPECTED_EXPORTS.length} expected exports present`);
}

async function functionalSmokeCheck(label, moduleExports) {
  const { StubOracle, DefaultOracle, CoalescingOracle, compose, withProvenance } = moduleExports;
  const oracle = compose(withProvenance())(new CoalescingOracle(new StubOracle()));
  const result = await oracle.getScoreDetailed(
    'GAJLLIIPHII6OCG4KQJIGPCHVN6DNCRBXHX6DEUTPE7MQ6OONAYBRLET',
  );
  if (typeof result.score !== 'number') {
    throw new Error(`${label}: composed oracle call did not return a numeric score`);
  }
  const fallback = new DefaultOracle(7);
  if ((await fallback.getScore('anything')) !== 7) {
    throw new Error(`${label}: DefaultOracle did not return its configured score`);
  }
  console.log(`  ok: composed oracle round-trip returned score=${result.score}`);
}

async function checkEsmImport() {
  console.log('\n[1/3] Node ESM import (self-referenced by package name)');
  const moduleExports = await import(PKG_NAME);
  assertExports('ESM', moduleExports);
  await functionalSmokeCheck('ESM', moduleExports);
}

async function checkCjsRequire() {
  console.log('\n[2/3] Node CommonJS require (self-referenced by package name)');
  const require = createRequire(import.meta.url);
  const moduleExports = require(PKG_NAME);
  assertExports('CJS', moduleExports);
  await functionalSmokeCheck('CJS', moduleExports);
}

async function checkBundlerConsumption() {
  console.log('\n[3/3] Browser-bundler consumption (esbuild, platform "browser")');
  const result = await build({
    stdin: {
      contents: `import { StubOracle, CircuitBreakerOracle } from './dist/esm/index.js';\nconsole.log(StubOracle, CircuitBreakerOracle);`,
      resolveDir: process.cwd(),
      sourcefile: 'smoke-entry.js',
      loader: 'js',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  if (!result.outputFiles?.[0]?.contents?.length) {
    throw new Error('bundler smoke check: esbuild produced no output');
  }
  console.log(`  ok: bundled ${result.outputFiles[0].contents.byteLength} bytes without error`);
}

async function main() {
  if (!existsSync('dist/esm/index.js') || !existsSync('dist/cjs/index.js')) {
    console.error('dist/ not found or incomplete — run `npm run build` before `npm run test:smoke`.');
    process.exit(1);
  }

  await checkEsmImport();
  await checkCjsRequire();
  await checkBundlerConsumption();

  console.log('\nAll package entry-point smoke checks passed.');
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err);
  process.exit(1);
});
