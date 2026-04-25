// Post-build smoke test. Validates the bundled `dist/app.js` can load both
// IDL v1 and v2 fixtures end-to-end — catches CJS/ESM interop drift, missing
// WASM assets, or esbuild-mangled module imports that unit tests (which run
// from source) would miss.
//
// Run via `npm run test:smoke` after `npm run build`.
//
// Exits non-zero on any failure so CI can gate on it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'app.js');

if (!existsSync(BUNDLE)) {
  console.error(`smoke: dist/app.js not found — run \`npm run build\` first.`);
  process.exit(1);
}

const ZERO_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

function runDiscover(idlPath, label) {
  const result = spawnSync(
    process.execPath,
    [BUNDLE, 'discover', ZERO_ID, '--idl', idlPath, '--json'],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  if (result.status !== 0) {
    console.error(`smoke[${label}] FAILED — exit ${result.status}`);
    if (result.stderr) console.error('stderr:', result.stderr.slice(0, 2000));
    if (result.stdout) console.error('stdout:', result.stdout.slice(0, 2000));
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    console.error(`smoke[${label}] FAILED — non-JSON output: ${result.stdout.slice(0, 500)}`);
    process.exit(1);
  }
  const services = parsed?.services;
  const serviceCount = services ? Object.keys(services).length : 0;
  if (serviceCount === 0) {
    console.error(`smoke[${label}] FAILED — no services listed`);
    process.exit(1);
  }
  console.log(
    `smoke[${label}] OK — version=${parsed.idlVersion} services=${Object.keys(services).join(',')}`,
  );
}

/**
 * Run the bundled CLI with a freshly-isolated VARA_WALLET_DIR so the IDL
 * cache subcommands (idl import/list/remove/clear) operate on an empty
 * sandbox per invocation. Returns parsed --json output or exits non-zero.
 */
function runCli(args, label, walletDir) {
  const result = spawnSync(process.execPath, [BUNDLE, ...args, '--json'], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, VARA_WALLET_DIR: walletDir },
  });
  if (result.status !== 0) {
    console.error(`smoke[${label}] FAILED — exit ${result.status}`);
    if (result.stderr) console.error('stderr:', result.stderr.slice(0, 2000));
    if (result.stdout) console.error('stdout:', result.stdout.slice(0, 2000));
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error(`smoke[${label}] FAILED — non-JSON output: ${result.stdout.slice(0, 500)}`);
    process.exit(1);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'vara-wallet-smoke-'));
try {
  // v1: extract the first bundled VFT IDL and write it to a temp file.
  const bundledSrc = readFileSync(
    join(REPO_ROOT, 'src', 'idl', 'bundled-idls.ts'),
    'utf-8',
  );
  const match = bundledSrc.match(/export const VFT_EXTENDED_IDL\s*=\s*`([\s\S]*?)`/);
  if (!match) {
    console.error('smoke: could not extract VFT_EXTENDED_IDL from bundled-idls.ts');
    process.exit(1);
  }
  const v1Path = join(tmp, 'vft-v1.idl');
  writeFileSync(v1Path, match[1]);
  runDiscover(v1Path, 'v1');

  // v2: use the test fixture shipped with the repo.
  const v2Path = join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'sample-v2.idl');
  if (!existsSync(v2Path)) {
    console.error(`smoke: v2 fixture missing at ${v2Path}`);
    process.exit(1);
  }
  runDiscover(v2Path, 'v2');

  // idl list / import / remove / clear — happy path against the bundled
  // CLI. Catches bundling regressions (esbuild tree-shaking idl-cache
  // exports, export renames) that unit tests run against source can't see.
  // Each call uses a private VARA_WALLET_DIR under tmp/ so the user's
  // real cache is untouched.
  const walletDir = join(tmp, 'wallet-home');
  const FAKE_CODE_ID = '0x' + 'ab'.repeat(32);

  const listEmpty = runCli(['idl', 'list'], 'idl-list-empty', walletDir);
  if (!Array.isArray(listEmpty) || listEmpty.length !== 0) {
    console.error(`smoke[idl-list-empty] FAILED — expected [], got ${JSON.stringify(listEmpty)}`);
    process.exit(1);
  }
  console.log('smoke[idl-list-empty] OK — empty cache returns []');

  const imported = runCli(
    ['idl', 'import', v2Path, '--code-id', FAKE_CODE_ID],
    'idl-import',
    walletDir,
  );
  if (imported?.source !== 'import' || !imported?.codeId) {
    console.error(`smoke[idl-import] FAILED — unexpected shape: ${JSON.stringify(imported)}`);
    process.exit(1);
  }
  console.log('smoke[idl-import] OK — imported v2 fixture');

  const listOne = runCli(['idl', 'list'], 'idl-list-one', walletDir);
  if (!Array.isArray(listOne) || listOne.length !== 1 || listOne[0].source !== 'import') {
    console.error(`smoke[idl-list-one] FAILED — expected 1 import entry, got ${JSON.stringify(listOne)}`);
    process.exit(1);
  }
  console.log('smoke[idl-list-one] OK — 1 entry visible after import');

  const removed = runCli(
    ['idl', 'remove', FAKE_CODE_ID],
    'idl-remove',
    walletDir,
  );
  if (removed?.removed !== true) {
    console.error(`smoke[idl-remove] FAILED — expected { removed: true }, got ${JSON.stringify(removed)}`);
    process.exit(1);
  }
  console.log('smoke[idl-remove] OK — entry removed');

  // Re-import to test clear --yes against a populated cache.
  runCli(['idl', 'import', v2Path, '--code-id', FAKE_CODE_ID], 'idl-reimport', walletDir);

  const preview = runCli(['idl', 'clear'], 'idl-clear-preview', walletDir);
  if (!Array.isArray(preview?.wouldRemove) || preview.wouldRemove.length !== 1) {
    console.error(`smoke[idl-clear-preview] FAILED — expected 1 entry in wouldRemove, got ${JSON.stringify(preview)}`);
    process.exit(1);
  }
  console.log('smoke[idl-clear-preview] OK — preview shows 1 entry');

  const cleared = runCli(['idl', 'clear', '--yes'], 'idl-clear-commit', walletDir);
  if (cleared?.removed !== 1) {
    console.error(`smoke[idl-clear-commit] FAILED — expected { removed: 1 }, got ${JSON.stringify(cleared)}`);
    process.exit(1);
  }
  console.log('smoke[idl-clear-commit] OK — entry cleared');

  const listFinal = runCli(['idl', 'list'], 'idl-list-final', walletDir);
  if (!Array.isArray(listFinal) || listFinal.length !== 0) {
    console.error(`smoke[idl-list-final] FAILED — expected [] after clear, got ${JSON.stringify(listFinal)}`);
    process.exit(1);
  }
  console.log('smoke[idl-list-final] OK — cache empty after clear');

  console.log('smoke: all checks passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
