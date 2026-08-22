/* global console */
/**
 * Dual-module build (issue #96).
 *
 * Bundles `src/index.ts` into a single-file ESM output and a single-file
 * CommonJS output with esbuild, then runs `tsc --emitDeclarationOnly` for
 * the `.d.ts` files.
 *
 * Bundling to one file per format, rather than emitting one compiled file
 * per source module (plain `tsc`), sidesteps a real interop problem: this
 * package's relative imports (`from './RiskOracle'`) have no file
 * extension, which is fine for `tsc`'s own module resolution but is not
 * valid under Node's ESM loader, which requires extensions on relative
 * specifiers. Bundling inlines every relative import, so the emitted ESM
 * file never needs Node to resolve one. `"sideEffects": false` in
 * package.json still lets a downstream bundler tree-shake unused named
 * exports out of the single bundled file — bundling to one file does not by
 * itself defeat tree-shaking; see scripts/bundle-size.mjs, which verifies
 * this for the "StubOracle only" import pattern.
 *
 * Type declarations are emitted separately, per source module, by `tsc`
 * (not esbuild, which does not generate types). Declaration files are
 * resolved by the TypeScript compiler/language server using tsconfig's own
 * module resolution, not Node's runtime ESM loader, so their
 * extension-less relative imports are not subject to the same restriction
 * and do not need bundling.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  // A real runtime dependency, but not currently imported by any src/
  // module (see README's Dependencies section) — kept external as the
  // conventional default for a library's own dependencies regardless.
  external: ['@stellar/stellar-sdk'],
  logLevel: 'info',
};

// The two builds share no state (different outfiles, same config), so run
// them concurrently rather than serializing on each other.
await Promise.all([
  build({ ...shared, format: 'esm', outfile: 'dist/esm/index.js' }),
  build({ ...shared, format: 'cjs', outfile: 'dist/cjs/index.js' }),
]);

// The root package.json has no top-level "type", so without these, Node
// can't tell dist/esm/index.js's format from package.json alone — it falls
// back to sniffing the file's contents at runtime (a real, measurable
// startup cost) and prints a MODULE_TYPELESS_PACKAGE_JSON warning. Each
// dist/ subfolder gets its own package.json declaring its actual format,
// the standard fix for a dual CJS/ESM package.
mkdirSync('dist/esm', { recursive: true });
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

// esbuild does not emit type declarations; tsc does, from the same source,
// mirroring src/'s module structure under dist/types/. Passed as a single
// command string (not a separate args array) so shell:true doesn't trip
// Node's DEP0190 warning about unescaped shell arguments.
execFileSync('npx tsc -p tsconfig.types.json', { stdio: 'inherit', shell: true });

console.log('\nBuild complete: dist/esm, dist/cjs, dist/types');
