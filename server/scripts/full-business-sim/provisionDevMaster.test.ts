import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { planScenarioMasterData, type ScenarioMasterData } from './masterData';
import { buildDevMasterProvisionPlan, createDevMasterPrivateDirectory, readCommittedDevMaster, writeDevMasterCastBeforeCommit,
  type DevMasterCommittedReceipt } from './provisionDevMaster';

const clock = vi.hoisted(() => ({ mode: 'fixed', nowIso: '2026-10-08T00:18:00.000Z', timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' }));
vi.mock('../../src/shared/businessClock', async () => ({ ...await vi.importActual('../../src/shared/businessClock'), getBusinessClock: () => clock }));
const input = { namespace: 'rebuild-controlled', requestKey: 'stable-original-rebuild', planSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64) };
const password = 'Scenario-' + 'c'.repeat(48);
let privateDirectory: string;
beforeEach(() => { privateDirectory = createDevMasterPrivateDirectory(); clock.mode = 'fixed'; });
afterEach(() => { fs.rmSync(privateDirectory, { recursive: true, force: true }); vi.restoreAllMocks(); });
function appliedCast(): ScenarioMasterData {
  const master = planScenarioMasterData({ namespace: input.namespace, nowMs: Date.parse(clock.nowIso) }); master.mode = 'apply';
  for (const actor of Object.values(master.cast)) actor.password = password;
  return master;
}
async function fixture() {
  const master = appliedCast(), privateCast = writeDevMasterCastBeforeCommit({ ...input, privateDirectory, master });
  const receipt: DevMasterCommittedReceipt = { protocolVersion: 1, phase: 'master_provisioned', ...input, credentialsSha256: privateCast.sha256, transactionId: 'exact-original-transaction' };
  const audit = { id: 'original-audit', actorId: 'system', action: 'dev_scenario_master_provisioned', targetType: 'ScenarioDevRebuild', targetId: input.requestKey,
    detail: { source: 'script:dev-scenario-rebuild', after: receipt }, createdAt: new Date() };
  const passwordHash = await bcrypt.hash(password, 4);
  const users = Object.values(master.cast).map(actor => ({ id: actor.id, email: actor.email, primaryDeptId: actor.departmentId, status: 'active', deletedAt: null, passwordHash,
    metadata: { simulation: true, simulationNamespace: input.namespace, scenarioActor: actor.key },
    roles: [{ roleId: actor.roleId, departmentId: actor.departmentId }] }));
  const audits = [audit];
  const tx = { $executeRaw: vi.fn(async () => 0), $queryRaw: vi.fn(async () => [{ name: 'panda_hub_dev', port: 5432, address: '127.0.0.1', readOnly: 'on' }]),
    auditLog: { findMany: vi.fn(async () => audits) }, userAccount: { findMany: vi.fn(async () => users) } };
  const transaction = vi.fn(async (run: (value: Prisma.TransactionClient) => Promise<unknown>) => run(tx as unknown as Prisma.TransactionClient));
  return { prisma: { $transaction: transaction } as unknown as PrismaClient, tx, transaction, master, receipt, audit, audits, users, privateCast,
    params: { ...input, privateDirectory, expectedPort: 5432 } };
}

describe('Controlled dev master plan and original transaction readback', () => {
  it('plans all master records without passwords, DB construction, reset or a completion claim', () => {
    const plan = buildDevMasterProvisionPlan(input);
    expect(plan).toMatchObject({ mode: 'plan', executable: false, currentDevRebuilt: false, businessDriverComplete: false, preserveTables: ['_prisma_migrations'] });
    expect(Object.values(plan.master.cast)).toHaveLength(21);
    expect(Object.values(plan.master.cast).every(actor => actor.password === null)).toBe(true);
    expect(plan.master.catalog.customers).toHaveLength(35); expect(plan.master.catalog.suppliers).toHaveLength(35);
  });
  it('stores the already-produced original cast durably in 0700/0600 and never overwrites it', () => {
    const master = appliedCast(), saved = writeDevMasterCastBeforeCommit({ ...input, privateDirectory, master });
    expect(fs.statSync(privateDirectory).mode & 0o777).toBe(0o700); expect(fs.statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(saved.path, 'utf8'))).toMatchObject({ phase: 'prepared_before_commit', requestKey: input.requestKey, planSha256: input.planSha256, master: { mode: 'apply' } });
    const originalBytes = fs.readFileSync(saved.path);
    expect(() => writeDevMasterCastBeforeCommit({ ...input, privateDirectory, master: { ...master, namespace: 'another-namespace' } })).toThrow(/CAST|NAMESPACE/);
    expect(() => writeDevMasterCastBeforeCommit({ ...input, privateDirectory, master })).toThrow(/EXISTS/);
    expect(fs.readFileSync(saved.path)).toEqual(originalBytes);
  });
  it('recovers the exact committed receipt and original usable credentials with current account/role readback only', async () => {
    const f = await fixture(), bytes = fs.readFileSync(f.privateCast.path);
    const result = await readCommittedDevMaster(f.prisma, f.params);
    expect(result).toMatchObject({ phase: 'master_provisioned', replayed: true, canReseed: false, businessDriverComplete: false,
      receipt: f.receipt, auditId: f.audit.id, master: f.master });
    expect(fs.readFileSync(f.privateCast.path)).toEqual(bytes);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1); // SET TRANSACTION READ ONLY, never a data write.
    expect(f.tx.userAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: Object.values(f.master.cast).map(actor => actor.id) } } }));
  });
  it('does not infer reset failure or generate another seed when the commit acknowledgement is unknown', async () => {
    const f = await fixture(); f.audits.splice(0);
    expect(await readCommittedDevMaster(f.prisma, f.params)).toMatchObject({ phase: 'unknown', canReseed: false, businessDriverComplete: false, reason: 'ORIGINAL_TRANSACTION_RECEIPT_MISSING' });
    expect(f.tx.userAccount.findMany).not.toHaveBeenCalled(); expect(fs.existsSync(f.privateCast.path)).toBe(true);
  });
  it.each(['duplicate_receipt', 'wrong_plan', 'wrong_cast_hash', 'changed_password', 'revoked_user', 'role_changed', 'wrong_database', 'wall_clock'] as const)('rejects %s without reseeding or rotating credentials', async problem => {
    const f = await fixture(), original = fs.readFileSync(f.privateCast.path);
    if (problem === 'duplicate_receipt') f.audits.push({ ...f.audit, id: 'duplicate' });
    if (problem === 'wrong_plan') f.receipt.planSha256 = 'c'.repeat(64);
    if (problem === 'wrong_cast_hash') f.receipt.credentialsSha256 = 'd'.repeat(64);
    if (problem === 'changed_password') f.users[0].passwordHash = await bcrypt.hash('changed-password', 4);
    if (problem === 'revoked_user') f.users[0].status = 'disabled';
    if (problem === 'role_changed') f.users[0].roles = [];
    if (problem === 'wrong_database') f.tx.$queryRaw.mockResolvedValue([{ name: 'panda_hub_local', port: 5432, address: '127.0.0.1', readOnly: 'on' }]);
    if (problem === 'wall_clock') clock.mode = 'wall';
    await expect(readCommittedDevMaster(f.prisma, f.params)).rejects.toThrow(/DEV_MASTER/);
    expect(fs.readFileSync(f.privateCast.path)).toEqual(original);
  });
  it('rejects unsafe or symlinked credential directories/files and unreadably permissive bytes', async () => {
    const f = await fixture(), original = fs.readFileSync(f.privateCast.path), symlink = path.join(os.tmpdir(), `bambook-dev-scenario-rebuild-link-${process.pid}`);
    fs.symlinkSync(privateDirectory, symlink);
    try { await expect(readCommittedDevMaster(f.prisma, { ...f.params, privateDirectory: symlink })).rejects.toThrow(/PATH/); }
    finally { fs.unlinkSync(symlink); }
    fs.chmodSync(f.privateCast.path, 0o644);
    await expect(readCommittedDevMaster(f.prisma, f.params)).rejects.toThrow(/PATH/);
    fs.chmodSync(f.privateCast.path, 0o600); fs.unlinkSync(f.privateCast.path);
    const outside = path.join(privateDirectory, 'outside-copy.json'); fs.writeFileSync(outside, original, { mode: 0o600 }); fs.symlinkSync(outside, f.privateCast.path);
    await expect(readCommittedDevMaster(f.prisma, f.params)).rejects.toThrow(/PATH/);
  });
});
