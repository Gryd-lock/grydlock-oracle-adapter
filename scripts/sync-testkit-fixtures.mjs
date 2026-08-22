/* global console, process, fetch */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const RAW_BASE = 'https://raw.githubusercontent.com/Gryd-lock/grydlock-testkit/main';
const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'fixtures',
  'testkit',
);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return { text, data: JSON.parse(text) };
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${url}: ${err.message}`, { cause: err });
  }
}

function validateDestinations(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('destinations.json must be an object');
  }
  if (!Array.isArray(data.destinations)) {
    throw new Error('destinations.json must have a "destinations" array');
  }
  for (let i = 0; i < data.destinations.length; i++) {
    const entry = data.destinations[i];
    for (const field of ['id', 'type', 'label', 'notes']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`destinations[${i}].${field} must be a non-empty string`);
      }
    }
  }
}

function validateScores(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('scores.json must be an object');
  }
  for (const [key, score] of Object.entries(data)) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`score for "${key}" must be a finite number between 0 and 100, got ${score}`);
    }
  }
}

function readLocalJson(filename) {
  try {
    const raw = readFileSync(join(FIXTURES_DIR, filename), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null; // File might not exist or be invalid, assume null
  }
}

function generateDriftReport(oldDest, newDest, oldScores, newScores) {
  const report = [];

  // Destinations drift
  const oldDestIds = new Set((oldDest?.destinations || []).map((d) => d.id));
  const newDestIds = new Set((newDest?.destinations || []).map((d) => d.id));
  const addedDest = [...newDestIds].filter((id) => !oldDestIds.has(id));
  const removedDest = [...oldDestIds].filter((id) => !newDestIds.has(id));

  if (addedDest.length > 0) report.push(`- Added ${addedDest.length} destinations.`);
  if (removedDest.length > 0) report.push(`- Removed ${removedDest.length} destinations.`);

  // Scores drift
  const oldScoreKeys = oldScores ? Object.keys(oldScores) : [];
  const newScoreKeys = newScores ? Object.keys(newScores) : [];
  let changedScores = 0;

  const allScoreKeys = new Set([...oldScoreKeys, ...newScoreKeys]);
  for (const key of allScoreKeys) {
    if (oldScores?.[key] !== newScores?.[key]) {
      changedScores++;
    }
  }

  if (changedScores > 0) report.push(`- ${changedScores} scores changed/added/removed.`);

  return report;
}

async function main() {
  console.log('Fetching upstream fixtures from grydlock-testkit...');
  const destReq = await fetchJson(`${RAW_BASE}/destinations.json`);
  const scoreReq = await fetchJson(`${RAW_BASE}/scores.json`);

  console.log('Validating schemas...');
  validateDestinations(destReq.data);
  validateScores(scoreReq.data);

  console.log('Generating drift report...');
  const localDest = readLocalJson('destinations.json');
  const localScores = readLocalJson('scores.json');

  const drift = generateDriftReport(localDest, destReq.data, localScores, scoreReq.data);

  if (drift.length === 0 && localDest && localScores) {
    console.log('No changes detected in upstream fixtures. Everything is up to date.');
    process.exit(0);
  }

  console.log('\n--- Drift Report ---');
  drift.forEach((line) => console.log(line));
  console.log('--------------------\n');

  // Write drift report to file so GitHub action can use it in PR body
  writeFileSync('drift-report.md', drift.join('\n'), 'utf8');

  console.log('Writing new fixtures to src/fixtures/testkit/ ...');
  writeFileSync(join(FIXTURES_DIR, 'destinations.json'), destReq.text, 'utf8');
  writeFileSync(join(FIXTURES_DIR, 'scores.json'), scoreReq.text, 'utf8');

  console.log('Regenerating .text.ts companion modules...');
  execSync('npm run generate:fixtures', { stdio: 'inherit' });

  console.log('Done!');
}

main().catch((err) => {
  console.error(`Sync failed: ${err.message}`);
  process.exit(1);
});
