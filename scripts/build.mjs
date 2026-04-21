import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/app.ts'],
  outfile: 'dist/app.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,
  sourcemap: 'linked',
  legalComments: 'linked',
  external: ['better-sqlite3', 'smoldot'],
  define: {
    'process.env.VARA_WALLET_VERSION': JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});
