// Opt-in acceptance cases must not change the normal backend suite denominator.
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';
import fs from 'node:fs';
import path from 'node:path';
const acceptanceSandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX;
if (acceptanceSandbox && fs.lstatSync(acceptanceSandbox).isSymbolicLink()) {
  throw Error('Acceptance sandbox must be a real private directory');
}
const acceptanceCacheDir = acceptanceSandbox
  ? path.join(fs.realpathSync(acceptanceSandbox), 'vitest-cache') : undefined;
const acceptanceCacheStat = acceptanceCacheDir
  ? fs.lstatSync(acceptanceCacheDir, { throwIfNoEntry: false }) : undefined;
if (acceptanceCacheStat && (acceptanceCacheStat.isSymbolicLink() || !acceptanceCacheStat.isDirectory())) {
  throw Error('Acceptance cache must be a private directory');
}
export default mergeConfig(base, defineConfig({
  cacheDir: acceptanceCacheDir,
  test: { include: ['src/**/*.test.ts', 'ops-panel/src/**/*.test.ts', 'acceptance-tests/**/*.test.ts'] },
}));
