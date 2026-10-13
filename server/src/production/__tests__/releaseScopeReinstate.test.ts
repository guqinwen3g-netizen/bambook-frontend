import { describe, expect, it, vi } from 'vitest';
import { createReleaseRequest } from '../releaseService';

/**
 * P2-1 回归（业务定案 2026-09-13「返修完可重新发起放行」）：
 * 此前 `invalidated` 是**无出口的死状态** —— 样品一返修，该行订单永久放不了行（业务死路）。
 *
 * 定案行为：
 *   - 因「返修/证据失效」置 invalidated（末条事件 kind='invalidated'）→ 允许重新发起，
 *     范围复位为 no_release（signReleaseRequest 会拒绝 revoked/invalidated，必须先放开状态），
 *     并追加 'resumed' 事件留痕；真正的放行门禁仍在 eligibility 侧（含 P0-6 分层兜底）。
 *   - 因「拆批退出」置 invalidated（末条事件 kind='superseded'，已由子批次承接）
 *     → **仍拒绝**，否则会与子批次范围重复放行（同一批货放行两次）。
 *   - revoked 语义不变：仍拒绝。
 */

function makePrisma(scope: any, events: any[] = []) {
  const state: any = {
    scope: { deletedAt: null, scopeRevision: 1, currentReleaseId: 'REL-OLD', ...scope },
    events: [...events],
    requests: [] as any[],
    updates: [] as any[],
  };

  const prisma: any = {
    releaseScope: {
      findMany: async () => [state.scope],
      findFirst: async ({ where }: any) =>
        state.scope.id === where?.id && (state.scope.deletedAt ?? null) === (where?.deletedAt ?? null)
          ? state.scope
          : null,
      update: async ({ where, data }: any) => {
        if (where.id !== state.scope.id) throw new Error('NOT_FOUND');
        Object.assign(state.scope, data);
        state.updates.push(data);
        return state.scope;
      },
    },
    releaseEvent: {
      // 关键：必须尊重 orderBy.sequence desc（取**末条**事件判定失效原因）
      findFirst: async ({ where, orderBy }: any) => {
        const rows = state.events.filter((e: any) => e.scopeId === where?.scopeId);
        if (orderBy?.sequence === 'desc') return [...rows].sort((a, b) => b.sequence - a.sequence)[0] ?? null;
        return rows[0] ?? null;
      },
      create: async ({ data }: any) => { state.events.push(data); return data; },
    },
    releaseRequest: {
      create: async ({ data }: any) => { state.requests.push(data); return data; },
    },
    sample: { findFirst: async () => null },
    orderLine: { findMany: async () => [{ id: state.scope.orderLineId, orderId: state.scope.orderId }], findUnique: async () => ({ id: state.scope.orderLineId, orderId: state.scope.orderId }) },
    // Explicit legacy release evidence storage seam, not fabricated PG facts.
    ppSampleRelease: { findMany: async () => state.scope.currentReleaseId ? [{ id: state.scope.currentReleaseId, scopeId: state.scope.id, scopeRevision: state.scope.scopeRevision, sampleId: null }] : [] },
    $queryRaw: async () => [{ id: 'explicit-storage-row-lock' }],
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  return { prisma, state };
}

const baseScope = (over: any = {}) => ({
  id: 'RS-1', orderId: 'ORD-1', orderLineId: 'OL-1',
  state: 'invalidated', scopeRevision: 1, currentReleaseId: null, ...over,
});

describe('createReleaseRequest · P2-1 invalidated 可重新发起', () => {
  it('返修失效（末条事件 invalidated）→ 允许重新发起：范围复位 no_release + 追加 resumed 事件留痕', async () => {
    const { prisma, state } = makePrisma(
      baseScope({ currentReleaseId: 'REL-OLD' }),
      [
        { id: 'E1', scopeId: 'RS-1', sequence: 1, kind: 'granted' },
        { id: 'E2', scopeId: 'RS-1', sequence: 2, kind: 'invalidated', reason: '样品返修' },
      ],
    );

    const r = await createReleaseRequest({
      prisma, scopeId: 'RS-1', input: {}, actorId: 'u_merch',
    } as any);

    expect(r.ok).toBe(true);
    // 范围从死状态放开，且不再指向旧放行记录
    expect(state.scope.state).toBe('no_release');
    expect(state.scope.currentReleaseId).toBeNull();
    // 留痕：追加 resumed 事件
    const resumed = state.events.find((e: any) => e.kind === 'resumed');
    expect(resumed).toBeTruthy();
    expect(resumed.reason).toContain('重新发起放行');
    // 新请求已建，等待领导签字
    expect(state.requests.length).toBe(1);
    expect(state.requests[0].state).toBe('pending');
  });

  it('拆批退出（末条事件 superseded）→ 仍拒绝 SCOPE_SUPERSEDED，范围不被改动', async () => {
    const { prisma, state } = makePrisma(
      baseScope(),
      [
        { id: 'E1', scopeId: 'RS-1', sequence: 1, kind: 'granted' },
        { id: 'E2', scopeId: 'RS-1', sequence: 2, kind: 'invalidated' },
        { id: 'E3', scopeId: 'RS-1', sequence: 3, kind: 'superseded', reason: '拆批：整行范围退出' },
      ],
    );

    const r = await createReleaseRequest({
      prisma, scopeId: 'RS-1', input: {}, actorId: 'u_merch',
    } as any);

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('SCOPE_SUPERSEDED');
    expect(state.scope.state).toBe('invalidated'); // 未复位
    expect(state.requests.length).toBe(0);
    expect(state.events.some((e: any) => e.kind === 'resumed')).toBe(false);
  });

  it('revoked 语义不变 → 仍拒绝 SCOPE_NOT_ACTIVE', async () => {
    const { prisma, state } = makePrisma(baseScope({ state: 'revoked' }));
    const r = await createReleaseRequest({
      prisma, scopeId: 'RS-1', input: {}, actorId: 'u_merch',
    } as any);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('SCOPE_NOT_ACTIVE');
    expect(state.requests.length).toBe(0);
  });

  it('范围不存在 → 404 SCOPE_NOT_FOUND', async () => {
    const { prisma } = makePrisma(baseScope());
    const r = await createReleaseRequest({
      prisma, scopeId: 'NOPE', input: {}, actorId: 'u_merch',
    } as any);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('SCOPE_NOT_FOUND');
  });
});
