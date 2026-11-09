/* global console, process, fetch */
/**
 * Builds the reference risk-oracle contract (contract/), deploys it to
 * Stellar testnet with the Stellar CLI, and seeds it from grydlock-testkit's
 * scores.json. Writes the result to contract/deployments/testnet.json.
 *
 * Usage:
 *   node scripts/deploy-testnet-contract.mjs                  # build, deploy, seed
 *   node scripts/deploy-testnet-contract.mjs --contract-id C… # seed an existing deployment
 *   node scripts/deploy-testnet-contract.mjs --scores ./scores.json
 *
 * Options:
 *   --source <name>      Stellar CLI identity used as deployer and admin
 *                        (default: grydlock-testnet-admin). It is generated and
 *                        funded with friendbot if it does not exist yet.
 *   --contract-id <C…>   Skip build and deploy; only seed this contract.
 *   --scores <path|url>  Score source (default: grydlock-testkit main scores.json).
 *
 * Requires `stellar` (Stellar CLI >= 23) and a Rust toolchain with the
 * wasm32v1-none target on PATH.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DIR = join(ROOT, 'contract');
const WASM = join(CONTRACT_DIR, 'target', 'wasm32v1-none', 'release', 'grydlock_risk_oracle.wasm');
const DEPLOYMENT_FILE = join(CONTRACT_DIR, 'deployments', 'testnet.json');
const DEFAULT_SCORES =
  'https://raw.githubusercontent.com/Gryd-lock/grydlock-testkit/main/scores.json';
const NETWORK = 'testnet';

function parseArgs(argv) {
  const args = { source: 'grydlock-testnet-admin', contractId: undefined, scores: DEFAULT_SCORES };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--source') args.source = value;
    else if (flag === '--contract-id') args.contractId = value;
    else if (flag === '--scores') args.scores = value;
    else throw new Error(`Unknown argument: ${flag}`);
    i++;
  }
  return args;
}

function stellar(args, { quiet = false } = {}) {
  if (!quiet) console.log(`$ stellar ${args.join(' ')}`);
  return execFileSync('stellar', args, {
    cwd: CONTRACT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function ensureIdentity(name) {
  try {
    return stellar(['keys', 'address', name], { quiet: true });
  } catch {
    console.log(`Identity "${name}" not found; generating and funding it with friendbot.`);
    stellar(['keys', 'generate', name, '--network', NETWORK, '--fund']);
    return stellar(['keys', 'address', name], { quiet: true });
  }
}

async function loadScores(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`GET ${source} -> HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

/**
 * Maps a testkit destination key to the contract's `Target` enum, in the
 * Stellar CLI's JSON argument form. Mirrors `encodeTarget` in
 * src/StellarRpcTransport.ts.
 */
function toTargetArg(destination) {
  const asset = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(destination);
  if (asset) return { Asset: [asset[1], asset[2]] };
  if (/^[GC][A-Z2-7]{55}$/.test(destination)) return { Address: destination };
  throw new Error(
    `Cannot seed "${destination}": only G/C addresses and CODE:ISSUER assets are supported by this script.`,
  );
}

function validateScores(scores) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw new Error('scores.json must be an object of destination -> score');
  }
  for (const [key, score] of Object.entries(scores)) {
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error(`score for "${key}" must be an integer 0-100, got ${score}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const admin = ensureIdentity(args.source);
  console.log(`Admin / deployer: ${admin}`);

  let contractId = args.contractId;
  let wasmHash;
  if (!contractId) {
    stellar(['contract', 'build']);
    wasmHash = stellar([
      'contract',
      'upload',
      '--wasm',
      WASM,
      '--source-account',
      args.source,
      '--network',
      NETWORK,
    ]);
    contractId = stellar([
      'contract',
      'deploy',
      '--wasm-hash',
      wasmHash,
      '--source-account',
      args.source,
      '--network',
      NETWORK,
      '--',
      '--admin',
      admin,
    ]);
    console.log(`Deployed ${contractId} (wasm ${wasmHash})`);
  }

  const scores = await loadScores(args.scores);
  validateScores(scores);
  const seeded = {};
  for (const [destination, score] of Object.entries(scores)) {
    stellar([
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source-account',
      args.source,
      '--network',
      NETWORK,
      '--',
      'set_score',
      '--target',
      JSON.stringify(toTargetArg(destination)),
      '--score',
      String(score),
    ]);
    seeded[destination] = score;
  }

  let previous = {};
  try {
    previous = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8'));
  } catch {
    // first deployment
  }
  const record = {
    network: NETWORK,
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    contractId,
    wasmHash: wasmHash ?? (previous.contractId === contractId ? previous.wasmHash : undefined),
    admin,
    interfaceVersion: 1,
    scoresSource: args.scores,
    seededAt: new Date().toISOString(),
    seeded,
  };
  mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `Seeded ${Object.keys(seeded).length} scores. Wrote ${DEPLOYMENT_FILE.replace(`${ROOT}/`, '')}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
