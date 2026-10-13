// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const helper = path.resolve('scripts/openbitfun-dev.sh');
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture(exits = false) {
  root = await mkdtemp(path.join(os.tmpdir(), 'bambook-agent-dev-'));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/start-openbitfun.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FIXTURE_ROOT + '/started', String(process.pid));
process.on('SIGTERM', () => { writeFileSync(process.env.FIXTURE_ROOT + '/stopped', 'yes'); process.exit(0); });
${exits ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}
`);
  return { ...process.env, FIXTURE_ROOT: root, HELPER: helper };
}
const waitForStart = 'for i in {1..100}; do [ -f "$FIXTURE_ROOT/started" ] && break; sleep 0.02; done; test -f "$FIXTURE_ROOT/started"';

describe('OpenBitFun browser development startup', () => {
  it('is part of npm run dev without an implicit heavyweight build', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const stack = await readFile('scripts/dev-stack.sh', 'utf8');
    const leaf = await readFile(helper, 'utf8');
    expect(pkg.scripts.dev).toBe('npm run dev:stack');
    expect(pkg.scripts['dev:stack']).toBe('bash scripts/dev-stack.sh');
    expect(stack).toContain('source "$ROOT/scripts/openbitfun-dev.sh"');
    expect(stack).toContain('start_openbitfun_dev "$ROOT"');
    expect(stack).toContain("trap 'stop_openbitfun_dev' EXIT");
    expect(leaf).toContain('--max-old-space-size=128');
    expect(leaf).toContain('"$root/scripts/start-openbitfun.mjs" --dev');
    expect(leaf).not.toContain('openbitfun:prepare');
  });
  it('keeps the host watcher out of Agent checkouts, runtime artifacts and evidence', async () => {
    const config = await readFile('vite.config.ts', 'utf8');
    const watcher = config.slice(config.indexOf('watch: {'), config.indexOf('preview: {'));
    for (const pattern of ['**/out/**', '**/tmp/**', '**/artifacts/**', '**/docs/acceptance/evidence/**', '**/docs/design-system/evidence/**', '**/design-frontend/**']) {
      expect(watcher).toContain(pattern);
    }
    expect(watcher).not.toContain('**/components/**');
    expect(watcher).not.toContain('**/styles/**');
  });
  it('starts once and shuts down its owned runtime when the dev shell exits', async () => {
    const env = await fixture();
    await exec('bash', ['-c', `
source "$HELPER"
trap 'stop_openbitfun_dev' EXIT
start_openbitfun_dev "$FIXTURE_ROOT"
${waitForStart}
first="$OPENBITFUN_DEV_PID"
start_openbitfun_dev "$FIXTURE_ROOT"
test "$first" = "$OPENBITFUN_DEV_PID" || exit 1
`], { env, timeout: 6000, windowsHide: true });
    expect(await readFile(path.join(root!, 'stopped'), 'utf8')).toBe('yes');
    const pid = Number(await readFile(path.join(root!, 'started'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 8000);
  it('does not signal a completed child or an unrelated PID during cleanup', async () => {
    const env = await fixture(true);
    await exec('bash', ['-c', `
source "$HELPER"
start_openbitfun_dev "$FIXTURE_ROOT"
${waitForStart}
wait "$OPENBITFUN_DEV_PID"
kill() { echo unexpected > "$FIXTURE_ROOT/unexpected-signal"; }
stop_openbitfun_dev
stop_openbitfun_dev
test ! -f "$FIXTURE_ROOT/unexpected-signal"
`], { env, timeout: 6000, windowsHide: true });
  }, 8000);
});
