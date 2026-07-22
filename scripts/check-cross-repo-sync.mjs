/* global console, process, fetch, URL */
/**
 * Cross-repo compatibility verification (issue #45).
 *
 * The README's "Shared contracts" section names two things that must stay in
 * sync across the Gryd-lock repos:
 *
 *   1. The RiskOracle interface — defined here (src/RiskOracle.ts), consumed
 *      by grydlock-extension (src/adapter/oracleAdapter.ts declares a
 *      stand-in with the same signature until it imports the real package).
 *   2. The warning-tier thresholds — defined in grydlock-research's README
 *      (canonical), implemented in grydlock-extension (src/lib/tiers.ts),
 *      and documented in this repo's README.
 *
 * This script fetches the current state of those contracts from the other
 * public repos (raw.githubusercontent.com, no auth required), parses each
 * side, and reports drift. Exit codes:
 *
 *   0 — everything in sync
 *   1 — drift detected (report printed and written to drift-report.md)
 *   2 — a source could not be fetched or parsed (infrastructure problem or
 *       a contract moved/changed shape so much the parser needs updating —
 *       NOT confirmed drift, but needs a human look either way)
 *
 * Run manually with `npm run sync:check`; CI runs it weekly (see
 * .github/workflows/cross-repo-sync.yml) because drift originates in the
 * other repos, not in pushes to this one.
 */
import { readFile, writeFile } from 'node:fs/promises';

const RAW_BASE = 'https://raw.githubusercontent.com/Gryd-lock';

const SOURCES = {
  researchReadme: `${RAW_BASE}/grydlock-research/main/README.md`,
  extensionTiers: `${RAW_BASE}/grydlock-extension/main/src/lib/tiers.ts`,
  extensionAdapter: `${RAW_BASE}/grydlock-extension/main/src/adapter/oracleAdapter.ts`,
};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * Parses a markdown warning-tier table ("| 0–20 | Low | ... |") into
 * [{ min, max, tier }] with lowercase tier names. Accepts en-dash or hyphen
 * ranges and ignores header/separator rows.
 */
function parseTierTable(markdown, label) {
  const tiers = [];
  for (const line of markdown.split('\n')) {
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 2) continue;
    const range = cells[0].match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (!range) continue;
    tiers.push({
      min: Number(range[1]),
      max: Number(range[2]),
      tier: cells[1].toLowerCase(),
    });
  }
  if (tiers.length === 0) {
    throw new Error(`no warning-tier table found in ${label}`);
  }
  return tiers;
}

/**
 * Parses grydlock-extension's src/lib/tiers.ts. The TIERS array lists
 * `max: <n>` and `tier: '<name>'` in matching order, so the two match lists
 * are zipped by index; band minimums are derived from the previous band's
 * max (first band starts at 0).
 */
function parseExtensionTiers(source) {
  const maxes = [...source.matchAll(/max:\s*(\d+)/g)].map((m) => Number(m[1]));
  const names = [...source.matchAll(/tier:\s*'([a-z]+)'/g)].map((m) => m[1]);
  if (maxes.length === 0 || maxes.length !== names.length) {
    throw new Error(
      `could not pair max/tier entries in extension tiers.ts ` +
        `(${maxes.length} maxes, ${names.length} names)`,
    );
  }
  return maxes.map((max, i) => ({
    min: i === 0 ? 0 : maxes[i - 1] + 1,
    max,
    tier: names[i],
  }));
}

/**
 * Extracts a normalized `getScore` signature ("(destination: string) =>
 * Promise<number>") from TypeScript source, whether declared as an interface
 * method or an exported function.
 */
function parseGetScoreSignature(source, label) {
  const match = source.match(/getScore\s*\(([^)]*)\)\s*:\s*(Promise<[^>]+>)/);
  if (!match) {
    throw new Error(`no getScore signature found in ${label}`);
  }
  const params = match[1].replace(/\s+/g, ' ').trim();
  return `(${params}) => ${match[2].replace(/\s+/g, '')}`;
}

function formatTiers(tiers) {
  return tiers.map((t) => `${t.min}-${t.max}:${t.tier}`).join('  ');
}

function compareTiers(canonical, other) {
  if (canonical.length !== other.length) return false;
  return canonical.every(
    (t, i) => t.min === other[i].min && t.max === other[i].max && t.tier === other[i].tier,
  );
}

const report = [];
const drift = [];

function record(name, inSync, expected, actual) {
  const line = inSync
    ? `PASS  ${name}`
    : `FAIL  ${name}\n      expected (canonical): ${expected}\n      actual:               ${actual}`;
  report.push(line);
  if (!inSync) drift.push(name);
}

try {
  const [researchReadme, extensionTiersSrc, extensionAdapterSrc, localInterface, localReadme] =
    await Promise.all([
      fetchText(SOURCES.researchReadme),
      fetchText(SOURCES.extensionTiers),
      fetchText(SOURCES.extensionAdapter),
      readFile(new URL('../src/RiskOracle.ts', import.meta.url), 'utf8'),
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
    ]);

  // Contract 1: warning tiers. grydlock-research is canonical.
  const canonicalTiers = parseTierTable(researchReadme, 'grydlock-research README');
  const extensionTiers = parseExtensionTiers(extensionTiersSrc);
  const localReadmeTiers = parseTierTable(localReadme, 'local README');

  record(
    'warning tiers: grydlock-extension src/lib/tiers.ts vs grydlock-research',
    compareTiers(canonicalTiers, extensionTiers),
    formatTiers(canonicalTiers),
    formatTiers(extensionTiers),
  );
  record(
    'warning tiers: this repo README vs grydlock-research',
    compareTiers(canonicalTiers, localReadmeTiers),
    formatTiers(canonicalTiers),
    formatTiers(localReadmeTiers),
  );

  // Contract 2: RiskOracle.getScore. This repo is canonical; the extension's
  // adapter stand-in must expect the same signature.
  const localSignature = parseGetScoreSignature(localInterface, 'src/RiskOracle.ts');
  const extensionSignature = parseGetScoreSignature(
    extensionAdapterSrc,
    'grydlock-extension src/adapter/oracleAdapter.ts',
  );
  record(
    'RiskOracle.getScore: grydlock-extension adapter stand-in vs src/RiskOracle.ts',
    localSignature === extensionSignature,
    localSignature,
    extensionSignature,
  );
} catch (err) {
  console.error(`sync check could not run: ${err.message}`);
  console.error(
    'This is a fetch/parse failure, not confirmed drift — if the other repo ' +
      'restructured its files, update the paths/parsers in scripts/check-cross-repo-sync.mjs.',
  );
  process.exit(2);
}

const summary = report.join('\n');
console.log(summary);

if (drift.length > 0) {
  const body =
    `Cross-repo contract drift detected by scripts/check-cross-repo-sync.mjs:\n\n` +
    '```\n' +
    summary +
    '\n```\n\n' +
    `Canonical sources: warning tiers — grydlock-research README; ` +
    `RiskOracle interface — this repo's src/RiskOracle.ts.\n`;
  await writeFile(new URL('../drift-report.md', import.meta.url), body);
  console.error(`\n${drift.length} contract(s) out of sync. Report written to drift-report.md.`);
  process.exit(1);
}

console.log('\nAll cross-repo contracts in sync.');
