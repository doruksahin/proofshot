import { defineConfig } from 'tsup';
import * as fs from 'fs';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

export default defineConfig([
  {
    entry: { 'bin/proofshot': 'bin/proofshot.ts' },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    sourcemap: true,
    clean: true,
    shims: true,
    define: {
      __PROOFSHOT_VERSION__: JSON.stringify(packageJson.version),
    },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: { 'src/index': 'src/index.ts' },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    splitting: true,
    sourcemap: true,
    dts: true,
    shims: true,
    define: {
      __PROOFSHOT_VERSION__: JSON.stringify(packageJson.version),
    },
  },
  {
    entry: { 'src/browser/cdp-daemon': 'src/browser/cdp-daemon.ts' },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    sourcemap: true,
    shims: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
