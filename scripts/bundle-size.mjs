/* global console, process */
/**
 * Bundle-size and tree-shaking check (issue #39).
 *
 * Bundles the package as an ESM consumer would (esbuild, minified) for a set
 * of representative import patterns, then enforces:
 *
 *  1. A minified-size budget per pattern — CI fails on regression past it.
 *  2. A module allowlist per pattern — CI fails if an import pattern pulls
 *     source modules it should not need (i.e. tree-shaking stopped working,
 *     or the barrel grew a side-effectful import). This is what guarantees
 *     that importing only StubOracle never drags in SorobanOracle,
 *     aggregation, or other future code.
 *
 * Bundling happens from the TypeScript source, which is how the extension's
 * bundler will consume the package once #37's ESM output lands; the entry
 * point can be switched to the built ESM output at that point.
 *
 * Budgets are deliberate: if a legitimate feature pushes a pattern past its
 * budget, raise the budget here in the same PR and say so in the PR
 * description.
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const KB = 1024;

const CHECKS = [
  {
    name: 'StubOracle only',
    entry: `export { StubOracle } from './src/index.ts';`,
    budgetBytes: 5 * KB,
    // Everything this import pattern is allowed to bundle. Any other module
    // contributing bytes to the output fails the check.
    allowedInputs: [
      'src/index.ts',
      'src/StubOracle.ts',
      'src/RiskOracle.ts',
      'src/fixtures/testkit/scores.json',
    ],
  },
  {
    name: 'full barrel',
    entry: `export * from './src/index.ts';`,
    budgetBytes: 10 * KB,
    allowedInputs: null, // the whole package — no allowlist to enforce
  },
];

async function measure(check) {
  const result = await build({
    stdin: {
      contents: check.entry,
      resolveDir: process.cwd(),
      sourcefile: 'entry.ts',
      loader: 'ts',
    },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    metafile: true,
    outfile: 'bundle.js',
    logLevel: 'silent',
  });

  const output = result.outputFiles[0];
  const [outputMeta] = Object.values(result.metafile.outputs);
  const bundledInputs = Object.entries(outputMeta.inputs)
    .filter(([, meta]) => meta.bytesInOutput > 0)
    .map(([path]) => path)
    .filter((path) => path !== 'entry.ts');

  return {
    minifiedBytes: output.contents.byteLength,
    gzipBytes: gzipSync(output.contents, { level: 9 }).byteLength,
    bundledInputs,
  };
}

function formatBytes(bytes) {
  return `${(bytes / KB).toFixed(2)} KB`;
}

let failed = false;

for (const check of CHECKS) {
  const { minifiedBytes, gzipBytes, bundledInputs } = await measure(check);
  const overBudget = minifiedBytes > check.budgetBytes;
  const disallowed = check.allowedInputs
    ? bundledInputs.filter((path) => !check.allowedInputs.includes(path))
    : [];

  console.log(`\n${overBudget || disallowed.length ? '✖' : '✔'} ${check.name}`);
  console.log(
    `  minified: ${formatBytes(minifiedBytes)} (budget ${formatBytes(check.budgetBytes)})` +
      ` | gzip: ${formatBytes(gzipBytes)}`,
  );
  console.log(`  bundled modules: ${bundledInputs.join(', ')}`);

  if (overBudget) {
    failed = true;
    console.error(
      `  FAIL: minified size ${formatBytes(minifiedBytes)} exceeds the ` +
        `${formatBytes(check.budgetBytes)} budget. If this growth is intentional, ` +
        `raise the budget in scripts/bundle-size.mjs in the same PR.`,
    );
  }
  if (disallowed.length) {
    failed = true;
    console.error(
      `  FAIL: import pattern pulled in module(s) it should not need: ` +
        `${disallowed.join(', ')}. Tree-shaking is not excluding them — check for ` +
        `side-effectful imports in the barrel or in the modules above.`,
    );
  }
}

console.log('');
process.exit(failed ? 1 : 0);
