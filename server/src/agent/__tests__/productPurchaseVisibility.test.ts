/** Real identity/policy/dispatch/storage output boundary; substitute persistence, no PG proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService } from '../identity';
import { executeAgentTool, executeTool } from '../toolRuntime';
import type { ActorContext } from '../types';

const raw = { id: 'purchase-agent-asset', sku: 'PURCHASE-AGENT', name: 'Purchase runtime fixture', mainCategory: 'Fabric', cost: 25.1234,
  garmentProfile: { targetCost: 'USD 25' }, trimmingProfile: { price: '2.5' }, fabricPrices: [
    { id: 'factory-now', priceType: 'factory', amount: 8.5 }, { id: 'factory-old', priceType: 'factory', amount: 8.1 },
    { id: 'customer-now', priceType: 'customer', amount: 20 }, { id: 'sample-now', priceType: 'sample', amount: 21 }, { id: 'cutting-now', priceType: 'cutting', amount: 22 },
  ] };
function storage() {
  return { userAccount: { findFirst: vi.fn(async () => ({ id: 'purchase-agent-actor', status: 'active' })) },
    productAsset: { findMany: vi.fn(async () => [raw]), count: vi.fn(async () => 1), create: vi.fn(), update: vi.fn() },
    agentTool: { upsert: vi.fn(async () => ({})) }, agentToolRun: { create: vi.fn(async ({ data }: any) => data) },
    approvalRequest: { create: vi.fn() }, $transaction: vi.fn() };
}
async function identity(permissions: string[], extra: Partial<Pick<ActorContext, 'roles' | 'permissionCeiling'>> = {}): Promise<ActorContext> {
  // A configured custom role is real identity even with no legacy role. The
  // production refreshToolActor attaches the trusted credential ceiling AFTER
  // resolving identity; it is not an ActorContextInput/body field.
  const resolved = await createIdentityService().resolveActorContext({ userId: 'purchase-agent-actor',
    roles: extra.roles ?? [], roleIds: ['purchase-fixture-configured-role'], permissions, authorizationLoaded: true });
  return extra.permissionCeiling ? { ...resolved, permissionCeiling: [...extra.permissionCeiling] } : resolved;
}
beforeEach(() => { vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', ''); vi.stubGlobal('fetch', vi.fn(() => { throw Error('No external transport permitted'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function prices(item: any) { return item.fabricPrices.filter((p: any) => p.priceType === 'factory').map((p: any) => p.amount); }

describe('actual Agent product purchase output obeys trusted scoped identity', () => {
  it.each([{ scopes: ['products:read'], extra: {}, visible: false }, { scopes: ['products:read', 'sensitive:cost'], extra: {}, visible: true },
    { scopes: ['products:read', 'sensitive:cost'], extra: { roles: ['owner'] as ActorContext['roles'], permissionCeiling: ['products:read'] }, visible: false }])('products.get $scopes / $extra masks all historical factory rows and actual cost without mutating DB facts', async ({ scopes, extra, visible }) => {
    const prisma = storage(); const subject = await identity(scopes, extra);
    expect(subject.permissionsAuthoritative).toBe(true);
    if (extra.permissionCeiling) expect(subject.permissionCeiling).toEqual(['products:read']);
    const output: any = await executeAgentTool({ prisma: prisma as any, actor: subject, toolId: 'products.get',
      toolInput: { id: raw.id, roles: ['owner'], permissions: ['sensitive:cost'], authorizationLoaded: true } });
    expect(output).toMatchObject({ ok: true, found: true, item: { id: raw.id, sku: raw.sku } });
    expect(output.item.cost).toBe(visible ? 25.1234 : null); expect(prices(output.item)).toEqual(visible ? [8.5, 8.1] : [null, null]);
    expect(output.item.fabricPrices.filter((p: any) => p.priceType !== 'factory').map((p: any) => p.amount)).toEqual([20, 21, 22]);
    expect(output.item.garmentProfile.targetCost).toBe('USD 25'); expect(output.item.trimmingProfile.price).toBe('2.5');
    expect(raw.cost).toBe(25.1234); expect(prices(raw)).toEqual([8.5, 8.1]);
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'success', actorId: 'purchase-agent-actor' }) });
    expect(prisma.productAsset.create).not.toHaveBeenCalled(); expect(prisma.productAsset.update).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('authoritative empty permissions cannot read a product through tool-domain fallback', async () => {
    const prisma = storage(); await expect(executeAgentTool({ prisma: prisma as any, actor: await identity([]), toolId: 'products.get', toolInput: { id: raw.id } }))
      .rejects.toThrow('TOOL_NOT_ALLOWED'); expect(prisma.productAsset.findMany).not.toHaveBeenCalled();
  });
  it('pricing expand needs actual pricing read grant before fetching; raw request fields cannot authorize it', async () => {
    const prisma = storage(); await expect(executeAgentTool({ prisma: prisma as any, actor: await identity(['products:read']), toolId: 'products.expand',
      toolInput: { id: raw.id, include: ['pricing'], permissions: ['sensitive:cost'], roles: ['owner'] } }))
      .rejects.toThrow('TOOL_NOT_ALLOWED: INSUFFICIENT_SCOPE: pricing:read'); expect(prisma.productAsset.findMany).not.toHaveBeenCalled();
  });
  it('ordinary pricing read can expand commercial prices while sensitive purchases remain masked', async () => {
    const output: any = await executeAgentTool({ prisma: storage() as any, actor: await identity(['products:read', 'pricing:read']), toolId: 'products.expand', toolInput: { id: raw.id, include: ['pricing'] } });
    expect(output).toMatchObject({ ok: true, found: true }); expect(output.pricing.map((p: any) => p.amount)).toEqual([null, null, 20, 21, 22]);
  });
  it('authorized pricing expand preserves purchase histories and commercial prices', async () => {
    const output: any = await executeAgentTool({ prisma: storage() as any, actor: await identity(['products:read', 'pricing:read', 'sensitive:cost']), toolId: 'products.expand', toolInput: { id: raw.id, include: ['pricing'] } });
    expect(output).toMatchObject({ ok: true, found: true, include: ['pricing'], product: { id: raw.id } });
    expect(output.pricing.map((p: any) => p.amount)).toEqual([8.5, 8.1, 20, 21, 22]);
  });
  it('untrusted low-level dispatch with no actor safely masks both full reads and expanded pricing (not an authorization/UAT claim)', async () => {
    const prisma = storage(); const get: any = await executeTool(prisma as any, { toolId: 'products.get', input: { id: raw.id, roles: ['owner'], permissions: ['sensitive:cost'] }, reason: 'untrusted output boundary probe' });
    expect(get.item.cost).toBeNull(); expect(prices(get.item)).toEqual([null, null]);
    const expand: any = await executeTool(prisma as any, { toolId: 'products.expand', input: { id: raw.id, include: ['pricing'] }, reason: 'untrusted expanded output probe' });
    expect(expand.pricing.map((p: any) => p.amount)).toEqual([null, null, 20, 21, 22]); expect(prices(raw)).toEqual([8.5, 8.1]);
  });
});
