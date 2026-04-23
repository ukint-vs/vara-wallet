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

  console.log('smoke: all checks passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
