import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ options: null as any }));
vi.mock('../agent/agentLoop', () => ({ createAgentLoop: (options: any) => {
  state.options = options;
  return { run: async (input: any) => {
    await options.toolExecutor({ toolId: 'products.count', input: { tag: 'original' }, actor: input.actor,
      signal: input.signal, skipApprovalCheck: true, approvalId: 'original-approval' });
    return { text: '结果待核对', stopReason: 'recovery_required', sources: [], thoughtProcess: 'blocked' };
  } };
} }));
vi.mock('./llmProviders', () => ({ createLlmCompleter: () => ({}) }));
vi.mock('../agent/toolRuntime', () => ({ executeAgentTool: vi.fn(async () => ({ ok: false, committed: false, error: 'FORBIDDEN' })) }));
import { executeAgentTool } from '../agent/toolRuntime';
import { createMacMiniChatRunner } from './runner';

it('the real runner adapter preserves original approval identity, actual actor, and interrupted result', async () => {
  const db = { userAccount: { findFirst: vi.fn(async () => ({ id: 'operator', status: 'active', deletedAt: null,
    roles: [{ roleId: 'sales', role: { permissions: [{ permission: { scope: 'products:read' } }] } }], primaryDeptId: 'company' })) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) } } as any;
  const result = await createMacMiniChatRunner({ prisma: db, runSearch: task => task() })({ userId: 'operator', sessionId: 'original-session',
    roles: ['owner'], permissions: ['products:read'], authorizationLoaded: true, message: 'original objective', signal: new AbortController().signal,
    emit: vi.fn(), requestSource: 'user-session' });
  expect(vi.mocked(executeAgentTool).mock.calls[0][0]).toMatchObject({ approvalId: 'original-approval', skipApprovalCheck: true,
    toolInput: { tag: 'original' }, sessionId: 'original-session', actor: { userId: 'operator', permissionScopes: ['products:read'], permissionsAuthoritative: true } });
  expect(result).toMatchObject({ stopReason: 'recovery_required', text: '结果待核对' });
});

it('actual resolver storage failure is not disguised as an unresolved approval', async () => {
  const error = new Error('storage unavailable');
  const db = { approvalRequest: { findUnique: vi.fn(async () => { throw error; }) }, userAccount: { findFirst: vi.fn(async () => ({ id: 'operator', status: 'active', deletedAt: null,
    roles: [{ roleId: 'sales', role: { permissions: [{ permission: { scope: 'products:read' } }] } }] })) }, userPermissionOverrides: { findMany: vi.fn(async () => []) } } as any;
  await createMacMiniChatRunner({ prisma: db, runSearch: task => task() })({ userId: 'operator', sessionId: 'original-session',
    roles: ['sales'], permissions: ['products:read'], authorizationLoaded: true, message: 'objective', signal: new AbortController().signal, emit: vi.fn(), requestSource: 'user-session' });
  await expect(state.options.approvalResolver('original-approval')).rejects.toBe(error);
  expect(db.approvalRequest.findUnique).toHaveBeenCalledWith({ where: { id: 'original-approval' } });
});
