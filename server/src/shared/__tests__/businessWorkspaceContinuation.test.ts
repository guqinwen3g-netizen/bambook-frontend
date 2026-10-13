import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import type { BusinessWorkspaceScope } from '../businessWorkspaceContract';
import { assembleBusinessWorkspace, continueBusinessWorkspace, parseWorkspaceContinueCommand, readWorkspaceActivations, workspaceDigest,
  type WorkspaceAdapter } from '../businessWorkspaceContinuation';
import { businessError } from '../errorCodes';

const scope: BusinessWorkspaceScope = { kind: 'development_version', caseId: 'C', sampleVersionId: 'V.1' };
const actor = { userId: 'sales', roles: ['sales'], permissions: ['products:read', 'products:write'] } as TokenPayload;
function memory() {
  const rows = new Map<string, any>(), order: string[] = [];
  let gate = true, readAllowed = true, writeAllowed = true;
  const db = { $queryRaw: vi.fn(async (sql: { values: unknown[] }) => { order.push(String(sql.values[0])); return []; }),
    auditLog: { findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => [...rows.values()].filter(row => row.targetId === where.targetId)),
      create: vi.fn(async ({ data }: any) => { rows.set(data.id, data); return data; }) } };
  const adapter: WorkspaceAdapter = {
    authorize: vi.fn(async (_db, _scope, mode) => { order.push(`authorize:${mode}`); if (mode === 'read' && !readAllowed) throw businessError('NOT_FOUND', '来源已不可见'); if (mode === 'write' && !writeAllowed) throw businessError('FORBIDDEN', '写授权已撤销'); return actor; }),
    lock: vi.fn(async () => { order.push('parent-lock'); }),
    async context(db, selected) {
      return assembleBusinessWorkspace({ scope: selected, identity: selected, overview: { id: 'C' }, childSummaries: [], canWrite: writeAllowed,
        activatedNodeIds: await readWorkspaceActivations(db, selected, workspaceDigest(selected)), facts: [
          { id: 'tasks', label: '任务', precedingIds: [], initial: true, hasHistory: false, eligible: true, blockedReasons: [], evidenceRefs: [] },
          { id: 'archive', label: '产品留档', precedingIds: ['qc'], hasHistory: false, eligible: gate, blockedReasons: gate ? [] : [{ code: 'QC_PASS_REQUIRED', message: '本版 QC 已失效' }], evidenceRefs: [] },
        ] });
    },
  };
  return { db, rows, order, adapter, prisma: { $transaction: async (work: (db: any) => unknown) => work(db) },
    setGate: (value: boolean) => { gate = value; }, revokeRead: () => { readAllowed = false; }, revokeWrite: () => { writeAllowed = false; } };
}
describe('explicit workspace continuation is an audited intent, never a domain completion', () => {
  it('keeps an eligible future node closed until explicit continuation and records only its exact ACK', async () => {
    const f = memory(), before = await f.adapter.context(f.db, scope, actor);
    expect(before.nodes.find(node => node.id === 'archive')).toMatchObject({ canOpen: false, canContinue: true, status: 'locked' });
    expect(f.db.auditLog.create).not.toHaveBeenCalled();
    const command = { scope, targetNodeId: 'archive', expectedContextFingerprint: before.contextFingerprint, requestKey: 'original-key' };
    const result = await continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: command, adapter: f.adapter });
    expect(result.commandAck).toMatchObject({ scope, targetNodeId: 'archive', requestKey: 'original-key', actorId: actor.userId, commandFingerprint: workspaceDigest(command) });
    expect(result.context.nodes.find(node => node.id === 'archive')).toMatchObject({ canOpen: true, canContinue: false });
    expect(f.rows.size).toBe(1);
    expect(f.order.slice(0, 6)).toEqual(['authorize:read', 'business-workspace-request:sales:original-key', expect.stringContaining('business-workspace-scope:'), 'parent-lock', 'authorize:read', 'authorize:write']);
  });
  it('replays the old ACK with current read authority and current blocked capabilities after write revocation or a later QC failure', async () => {
    const f = memory(), before = await f.adapter.context(f.db, scope, actor);
    const command = { scope, targetNodeId: 'archive', expectedContextFingerprint: before.contextFingerprint, requestKey: 'same-key' };
    const original = await continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: command, adapter: f.adapter });
    f.setGate(false); f.revokeWrite();
    const replayed = await continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: command, adapter: f.adapter });
    expect(replayed.commandAck).toEqual(original.commandAck); expect(replayed.replayed).toBe(true);
    expect(replayed.context.nodes.find(node => node.id === 'archive')).toMatchObject({ status: 'blocked', canContinue: false });
    expect(f.rows.size).toBe(1);
    await expect(continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: { ...command, targetNodeId: 'qc' }, adapter: f.adapter })).rejects.toMatchObject({ code: 'CONFLICT' });
    f.revokeRead();
    await expect(continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: command, adapter: f.adapter })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rechecks current read scope after locking and rejects stale or invented input without audit writes', async () => {
    const f = memory(), before = await f.adapter.context(f.db, scope, actor);
    const command = { scope, targetNodeId: 'archive', expectedContextFingerprint: before.contextFingerprint, requestKey: 'fresh-key' };
    await expect(continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: { ...command, expectedContextFingerprint: 'a'.repeat(64) }, adapter: f.adapter })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(() => parseWorkspaceContinueCommand({ ...command, actorId: 'other' })).toThrow();
    f.adapter.lock = async () => { f.revokeRead(); };
    await expect(continueBusinessWorkspace({ prisma: f.prisma, prior: actor, input: command, adapter: f.adapter })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it('retains real history when a current gate fails without opening any unrecorded future node', () => {
    const value = assembleBusinessWorkspace({ scope, identity: scope, overview: {}, canWrite: true, activatedNodeIds: [], childSummaries: [], facts: [
      { id: 'qc', label: 'QC', precedingIds: [], eligible: false, hasHistory: true, blockedReasons: [], evidenceRefs: [{ kind: 'QC', id: 'old-report' }] },
      { id: 'order', label: '订单', precedingIds: ['qc'], eligible: false, hasHistory: false, unknown: true, blockedReasons: [], evidenceRefs: [] },
    ] });
    expect(value.nodes[0]).toMatchObject({ canOpen: true, status: 'blocked' });
    expect(value.nodes[1]).toMatchObject({ canOpen: false, canContinue: false, status: 'unknown' });
  });
});
