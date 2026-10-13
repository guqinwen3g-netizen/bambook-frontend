import { describe, expect, it } from 'vitest';
import { createIdentityService } from '../identity';
import { createPolicyService } from '../policy';
import { AGENT_TOOL_ACTIONS } from '../toolAuthorization';
import { DEFAULT_AGENT_TOOLS } from '../defaults';
import { P0B_TOOL_DEFINITIONS } from '../toolRegistry';
import type { ActorContext, ToolAccessTarget } from '../types';

const registered = [...DEFAULT_AGENT_TOOLS, ...P0B_TOOL_DEFINITIONS];
function target(toolId: string, input: Record<string, unknown> = {}): ToolAccessTarget {
  const definition = registered.find(tool => tool.id === toolId);
  if (!definition) throw new Error(`Missing actual registered tool: ${toolId}`);
  return { toolId, scope: definition.scope, risk: definition.risk, input };
}
function actor(permissions: string[], roles: ActorContext['roles'] = ['manager']) {
  return createIdentityService().resolveActorContext({ userId: 'actor-action-boundary', roles, permissions, authorizationLoaded: true });
}
const policy = createPolicyService();

describe('Agent trusted action permissions (pure policy, not PG or HTTP evidence)', () => {
  it('declares every actual registered tool; completeness is a contract guard, not runtime proof', () => {
    expect([...new Set(registered.map(tool => tool.id))].filter(id => !AGENT_TOOL_ACTIONS[id])).toEqual([]);
    for (const id of new Set(registered.map(tool => tool.id))) expect(AGENT_TOOL_ACTIONS[id].source).toBeTruthy();
    for (const declaration of Object.values(AGENT_TOOL_ACTIONS).filter(action => action.sideEffects)) {
      expect(Boolean(declaration.allOf?.length || declaration.blockedReason || declaration.constraint === 'actor-memory-write')).toBe(true);
    }
  });

  it('orders:read permits actual read but does not authorize an actual order write, even for manager', async () => {
    const subject = await actor(['orders:read']);
    expect(policy.canUseTool(subject, target('orders.query')).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('orders.update_status'))).toMatchObject({ allowed: false, requiresApproval: false, reason: 'INSUFFICIENT_SCOPE: orders:write' });
  });

  it('marked empty permissions do not restore manager default write capability', async () => {
    const subject = await actor([]);
    expect(subject.permissionsAuthoritative).toBe(true);
    expect(policy.canUseTool(subject, target('orders.update_status')).allowed).toBe(false);
    expect(policy.canUseTool(subject, target('invoice.create')).allowed).toBe(false);
  });

  it('legacy unmarked missing/empty input retains the existing domain contract', async () => {
    for (const permissions of [undefined, []]) {
      const subject = await createIdentityService().resolveActorContext({ userId: 'legacy-manager', roles: ['manager'], permissions });
      expect(subject.permissionsAuthoritative).toBe(false);
      expect(policy.canUseTool(subject, target('orders.update_status')).allowed).toBe(true);
    }
  });

  it('effective grant can authorize a viewer while the original approval gate still applies', async () => {
    const subject = await actor(['orders:write'], ['viewer']);
    expect(policy.canUseTool(subject, { ...target('orders.update_status'), risk: 'high' })).toEqual({ allowed: true, requiresApproval: true, reason: 'APPROVAL_REQUIRED' });
  });

  it.each([
    ['invoice.create', ['invoices:read'], 'invoices:write'],
    ['payment_voucher.create', ['vouchers:read'], 'vouchers:write'],
    ['finance.apply_voucher_to_invoice', ['finance:read', 'invoices:write'], 'invoices:reconcile'],
    ['credit.thaw', ['credit:freeze:write'], 'credit:thaw:write'],
    ['qc.review_fabric_sample', ['qc:write', 'qc:garment_chain:write'], 'qc:fabric_chain:write'],
    ['order_changes.withdraw', ['orders:write'], 'order:change_request:create'],
    ['payment_requests.create', ['finance:read'], 'finance:payment_request:create'],
    ['internal_trade.confirm', ['orders:write'], 'order:internal_trade:write'],
    ['email.send', ['emails:read'], 'emails:write'],
    ['template.render', ['products:read'], 'tools:execute'],
  ] as const)('%s rejects neighboring domain/read capability', async (id, scopes, required) => {
    const denied = policy.canUseTool(await actor([...scopes]), target(id));
    expect(denied).toMatchObject({ allowed: false, requiresApproval: false });
    expect(denied.reason).toContain(required);
    expect(policy.canUseTool(await actor([required]), target(id)).allowed).toBe(true);
  });

  it('receipt allocates an existing voucher: actual reconciliation authority is sufficient, voucher-write alone is not', async () => {
    expect(policy.canUseTool(await actor(['vouchers:write']), target('payment.receive_and_reconcile')).allowed).toBe(false);
    expect(policy.canUseTool(await actor(['invoices:reconcile']), target('payment.receive_and_reconcile')).allowed).toBe(true);
  });

  it('invoice issue requires email-write only when the actual input requests an outbox draft', async () => {
    const subject = await actor(['invoices:write']);
    expect(policy.canUseTool(subject, target('invoice.issue')).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('invoice.issue', { email: { to: ['test@example.invalid'] } })).reason).toBe('INSUFFICIENT_SCOPE: emails:write');
    expect(policy.canUseTool(await actor(['invoices:write', 'emails:write']), target('invoice.issue', { email: { to: ['test@example.invalid'] } })).allowed).toBe(true);
  });

  it('undeclared actions fail closed regardless of a low-risk label or domain match', async () => {
    const subject = await actor(['orders:write']);
    expect(policy.canUseTool(subject, { toolId: 'orders.future_mutation', scope: 'orders', risk: 'low' })).toEqual({ allowed: false, requiresApproval: false, reason: 'TOOL_ACTION_UNDECLARED' });
  });

  it('owner and direct SuperAdmin technical shortcut share the central permission service', async () => {
    for (const role of ['owner', 'role-super-admin']) {
      const subject = { ...await actor([]), roles: [role] } as ActorContext;
      expect(policy.canUseTool(subject, target('order.confirm')).allowed).toBe(true);
      expect(policy.canUseTool(subject, target('payment_requests.query')).allowed).toBe(true);
      expect(policy.canUseTool(subject, { toolId: 'undeclared.write', scope: 'orders', risk: 'low' }).allowed).toBe(false);
    }
  });

  it('entity input chooses only real supported source scopes; invalid search types retain actual full search fallback', async () => {
    const subject = await actor(['products:read']);
    expect(policy.canUseTool(subject, target('entities.search', { entityTypes: ['product.asset'] })).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('entities.hydrate', { refs: [{ entityType: 'product.asset', id: 'asset-1' }] })).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('entities.hydrate', { refs: [{ entityType: 'relation.person', id: 'person-1' }] })).allowed).toBe(false);
    expect(policy.canUseTool(subject, target('entities.search', { entityTypes: ['NotAType'] })).allowed).toBe(false);
    expect(policy.canUseTool(subject, target('entities.search')).allowed).toBe(false);
  });

  it('explicit context expansion does not grant finance/production/pricing through base read', async () => {
    const orderReader = await actor(['orders:read']);
    expect(policy.canUseTool(orderReader, target('orders.expand', { include: ['summary'] })).allowed).toBe(true);
    expect(policy.canUseTool(orderReader, target('orders.expand', { include: ['invoices'] })).allowed).toBe(false);
    expect(policy.canUseTool(orderReader, target('orders.expand', { include: ['production'] })).allowed).toBe(false);
    const productReader = await actor(['products:read']);
    expect(policy.canUseTool(productReader, target('products.expand', { include: ['profile'] })).allowed).toBe(true);
    expect(policy.canUseTool(productReader, target('products.expand', { include: ['pricing'] })).allowed).toBe(false);
  });

  it('restored authenticated reads rely on runtime row guards; links require actual source type scope', async () => {
    const subject = await actor([]);
    expect(policy.canUseTool(subject, target('payment_requests.query')).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('exceptions.query')).allowed).toBe(true);
    expect(AGENT_TOOL_ACTIONS['exceptions.query'].sideEffects).toBe(false);
    expect(policy.canUseTool(subject, target('links.expand_neighbors', { type: 'order', id: 'order-1' })).reason).toBe('INSUFFICIENT_SCOPE: orders:read');
    expect(policy.canUseTool(await actor(['orders:read']), target('links.expand_neighbors', { type: 'order', id: 'order-1' })).allowed).toBe(true);
    expect(policy.canUseTool(await actor(['orders:read']), target('links.expand_neighbors', { type: 'Salary', id: 'salary-1' })).reason).toBe('ENTITY_TYPE_NOT_AUTHORIZED');
  });

  it('memory scope preserves personal ownership and existing shared contract, with runtime current-membership verification', async () => {
    const subject = await actor([]);
    expect(policy.canUseTool(subject, target('memory.write', { content: 'personal preference' })).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('memory.write', { scope: `personal:${subject.userId}` })).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('memory.write', { scope: 'personal:other-user' })).allowed).toBe(false);
    expect(policy.canUseTool(subject, target('memory.write', { scope: 'company' })).allowed).toBe(true);
    expect(policy.canUseTool(subject, target('memory.write', { scope: 'role:finance' })).allowed).toBe(false);
  });
});
