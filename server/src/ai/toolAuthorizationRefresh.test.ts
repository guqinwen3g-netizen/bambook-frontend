import { beforeEach, expect, it, vi } from 'vitest';
import { createPolicyService } from '../agent/policy';
const control = vi.hoisted(() => ({ options: null as any, skipApprovalCheck: true }));
vi.mock('../agent/agentLoop', () => ({ createAgentLoop: (options: any) => {
  control.options = options;
  return { run: async (input: any) => {
    await options.toolExecutor({ toolId: 'product_asset.create', input: { sku: 'V1' }, actor: input.actor,
      signal: input.signal, skipApprovalCheck: control.skipApprovalCheck });
    return { text: 'done' };
  } };
} }));
vi.mock('./llmProviders', () => ({ createLlmCompleter: () => ({}) }));
vi.mock('../agent/checkpoint', () => ({ PrismaCheckpointManager: class {}, createCheckpointConversationId: () => 'v1-refresh' }));
vi.mock('../agent/toolRuntime', () => ({ executeAgentTool: vi.fn(async ({ actor }: any) => {
  const policy = createPolicyService().canUseTool(actor, { toolId: 'product_asset.create', scope: 'products', risk: 'high' });
  if (!policy.allowed) throw Error(policy.reason);
  return { ok: true };
}) }));
import { executeAgentTool } from '../agent/toolRuntime';
import { createMacMiniChatRunner } from './runner';
function fixture(scopes: string[], active = true) {
  return { userAccount: { findFirst: vi.fn(async () => ({ id: 'staff', status: active ? 'active' : 'inactive', deletedAt: null,
    roles: [{ roleId: 'role-sales', role: { permissions: scopes.map(scope => ({ permission: { scope } })) } }], primaryDeptId: 'current-department' })) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) } } as any;
}
const request = () => ({ userId: 'staff', sessionId: 'session', roles: ['owner'], permissions: ['products:write'],
  authorizationLoaded: true as const, message: 'create', signal: new AbortController().signal, emit: vi.fn(), requestSource: 'user-session' as const });
beforeEach(() => { vi.clearAllMocks(); control.skipApprovalCheck = true; });
it('the actual runner refreshes a stale owner after approval before entering the write runtime', async () => {
  const db = fixture([]);
  await expect(createMacMiniChatRunner({ prisma: db, runSearch: task => task() })(request())).rejects.toThrow('INSUFFICIENT_SCOPE');
  const call = vi.mocked(executeAgentTool).mock.calls[0][0];
  expect(call.skipApprovalCheck).toBe(true);
  expect(call.actor.roles).not.toContain('owner'); expect(call.actor.permissionScopes).toEqual([]);
  expect(call.actor.permissionsAuthoritative).toBe(true); expect(db.userPermissionOverrides.findMany).toHaveBeenCalledOnce();
});
it('normal calls use current grants, and account deactivation prevents entering the tool runtime', async () => {
  control.skipApprovalCheck = false;
  await expect(createMacMiniChatRunner({ prisma: fixture(['products:write']), runSearch: task => task() })(request())).resolves.toMatchObject({ text: 'done' });
  expect(vi.mocked(executeAgentTool).mock.calls[0][0].actor.permissionScopes).toEqual(['products:write']);
  vi.mocked(executeAgentTool).mockClear();
  await expect(createMacMiniChatRunner({ prisma: fixture([], false), runSearch: task => task() })(request())).rejects.toThrow('ACCOUNT_INACTIVE');
  expect(executeAgentTool).not.toHaveBeenCalled();
});
