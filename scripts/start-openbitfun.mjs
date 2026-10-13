import path from 'node:path';
import { OpenBitFunRuntime, runGuarded } from './openbitfun-runtime.mjs';
const root = path.resolve(import.meta.dirname, '..');
if (process.argv[2] === '--guard') {
  const [command, ...args] = process.argv.slice(3);
  if (!command) throw new Error('Guarded command is required');
  try {
    const result = await runGuarded(command, args, { stdio: 'inherit', maxRssMiB: 3072, timeoutMs: 180000 });
    process.exitCode = result.code === 0 ? 0 : 130;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  const runtime = new OpenBitFunRuntime({
    bundleRoot: path.join(root, 'tmp/openbitfun-runtime'), workspace: path.join(root, 'tmp/openbitfun-workspace'),
    webDevRoot: process.argv.includes('--dev') ? path.join(root, 'tmp/upstream/OpenBitFun/src/web-ui') : undefined,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { runtime.stop(); });
  const status = await runtime.start();
  console.log(JSON.stringify(status));
  if (status.state !== 'ready') process.exitCode = 1;
}
