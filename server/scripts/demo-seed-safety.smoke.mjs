/**
 * Smoke test: DEMO seed safety contract.
 * Verifies the route-backed safety guarantees without touching any real DB or API.
 *
 * Run from apps/Bambook/server:
 *   node scripts/demo-seed-safety.smoke.mjs
 */
import { execFileSync } from 'child_process';
import path from 'path';

const SCRIPT = path.resolve('scripts/seed-demo-data.ts');
let passed = 0, failed = 0;

function run(args, expectNonZero = false) {
  try {
    const out = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function assert(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    failed++;
  }
}

console.log('=== DEMO seed safety contract smoke ===\n');

// Test 1: --dry-run does not connect to DB (exit 0, output mentions "No database connection")
console.log('[1] --dry-run does not connect to DB');
const dry = run(['--dry-run']);
assert('exit code 0', dry.code === 0, `(got ${dry.code})`);
assert('mentions no DB connection', /No database connection/i.test(dry.stdout), `stdout: ${dry.stdout.slice(0,120)}`);

// Test 2: --apply WITHOUT --unsafe-direct-prisma is rejected (exit 2)
console.log('\n[2] --apply without unsafe flag is rejected');
const applyUnsafe = run(['--apply']);
assert('exit code 2', applyUnsafe.code === 2, `(got ${applyUnsafe.code})`);
assert('error mentions --unsafe-direct-prisma', /unsafe-direct-prisma/i.test(applyUnsafe.stderr), `stderr: ${applyUnsafe.stderr.slice(0,160)}`);

// Test 3: --rollback WITHOUT --unsafe-direct-prisma is rejected (exit 2)
console.log('\n[3] --rollback without unsafe flag is rejected');
const rollbackUnsafe = run(['--rollback']);
assert('exit code 2', rollbackUnsafe.code === 2, `(got ${rollbackUnsafe.code})`);
assert('error mentions --unsafe-direct-prisma', /unsafe-direct-prisma/i.test(rollbackUnsafe.stderr), `stderr: ${rollbackUnsafe.stderr.slice(0,160)}`);

// Test 4: no args / conflicting args prints usage (exit 1)
console.log('\n[4] no args prints usage');
const noArgs = run([]);
assert('exit code 1', noArgs.code === 1, `(got ${noArgs.code})`);
assert('usage mentions --api-apply', /api-apply/i.test(noArgs.stderr), `stderr: ${noArgs.stderr.slice(0,160)}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
