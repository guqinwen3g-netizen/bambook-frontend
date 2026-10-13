import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'audit-fabric-use') }));
vi.mock('../../relations/relationServiceV2', () => ({ createRelationServiceV2: () => ({
  buildScopeWhere: vi.fn(async () => ({})), buildWriteScopeWhere: vi.fn(async () => ({})),
}) }));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ hasBizReadAccess: vi.fn(async () => true) }) }));
vi.mock('../../devPanel/activeDb', () => ({ getActiveDb: () => 'panda_hub_dev' }));

import { writeRouteAuditLog } from '../../audit/routeAudit';
import {
  authorizeFabricUseInTx,
  checkAndRecordFabricUseInTx,
  createFabricUseAuthorizationCustomerConfirmationAdapter,
  createFabricUseAuthorizationRequestInTx,
  FABRIC_USE_ACTIONS,
  recordFabricUseAuthorizationUseInTx,
} from '../fabricUseAuthorizationService';

const OWNER = 'REL-CUSTOMER-A';
const GRANTEE = 'REL-CUSTOMER-B';
const ACTOR = { userId: 'user-sales', roles: [], permissions: ['products:read', 'products:write'], authorizationLoaded: true } as any;
const fingerprint = 'a'.repeat(64);

function makeTx(overrides: Record<string, any> = {}) {
  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []),
    productAsset: { findFirst: vi.fn(async () => ({ id: 'FAB-1', mainCategory: 'Fabric', status: 'Active' })) },
    fabricCustomerCode: { findMany: vi.fn(async () => [{ id: 'FCC-1', customerOrganizationId: OWNER }]) },
    relation: { findMany: vi.fn(async ({ where }: any) => (where.id.in as string[]).map(id => ({ id, name: id, category: 'customer', isOrganization: true, deletedAt: null }))) },
    fabricUseAuthorizationVersion: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    businessConfirmation: { findUnique: vi.fn(async () => null) },
    auditLog: { findUnique: vi.fn(async () => ({ id: 'audit', action: 'business_customer_confirmation_recorded', targetId: 'BCF-1', actorId: 'user-sales' })) },
    businessConfirmationEvidence: { findMany: vi.fn(async () => [{ evidence: { sourceFingerprint: 'b'.repeat(64), sourceSnapshot: { kind: 'screenshot' }, sourceType: 'screenshot', files: [{ purpose: 'screenshot' }] } }]) },
    fabricUseAuthorizationUse: { findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) },
  };
  return Object.assign(tx, overrides);
}

function activeVersion(overrides: Record<string, any> = {}) {
  return { id: 'FUA-V1', state: 'active', revision: 1, allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate],
    effectiveFrom: null, effectiveUntil: null, confirmationId: 'BCF-1', ...overrides };
}

describe('fabric-use authorization native gate and provenance', () => {
  beforeEach(() => vi.mocked(writeRouteAuditLog).mockClear());

  it('checks an exact customer grant at the business instant and preserves an explicit historical evaluation time', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('BAMBOOK_DEV_PANEL', '1'); vi.stubEnv('TZ', 'UTC');
    vi.stubEnv('DATABASE_URL', 'postgresql://clock-test:unused@127.0.0.1:1/panda_hub_dev');
    vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', '2026-10-08T00:18:00.000Z');
    vi.useFakeTimers(); vi.setSystemTime(new Date('2034-12-31T18:00:00.000Z'));
    try {
      const version = activeVersion({ effectiveFrom: BigInt(Date.parse('2026-10-01T00:00:00Z')),
        effectiveUntil: BigInt(Date.parse('2026-10-09T00:00:00Z')) });
      const tx = makeTx({
        fabricUseAuthorizationVersion: { findFirst: vi.fn(async () => version), findUnique: vi.fn(async () => version) },
        businessConfirmation: { findUnique: vi.fn(async () => ({ id: 'BCF-1', outcome: 'accepted', internalApprovalId: null,
          auditId: 'audit', recordedBy: 'user-sales' })) },
      });
      const command = { productAssetId: 'FAB-1', customerRelationId: GRANTEE, action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR };
      await expect(authorizeFabricUseInTx(tx, command)).resolves.toMatchObject({ basisKind: 'grant', authorizationVersionId: version.id });
      await expect(authorizeFabricUseInTx(tx, { ...command, now: Date.parse('2026-10-10T00:00:00Z') }))
        .rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED', statusCode: 409 });
      expect(version.effectiveUntil).toBe(BigInt(Date.parse('2026-10-09T00:00:00Z')));
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });

  it('keeps unrestricted fabrics and exact owner use on their own native basis', async () => {
    const unrestricted = makeTx({ fabricCustomerCode: { findMany: vi.fn(async () => []) } });
    await expect(authorizeFabricUseInTx(unrestricted, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).resolves.toMatchObject({ basisKind: 'unrestricted' });

    const owner = makeTx();
    await expect(authorizeFabricUseInTx(owner, { productAssetId: 'FAB-1', customerRelationId: OWNER,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).resolves.toMatchObject({ basisKind: 'owner', ownerRelationId: OWNER });
    expect(owner.fabricUseAuthorizationVersion.findFirst).not.toHaveBeenCalled();
  });

  it('requires the exact active customer version, exact action, valid customer IDs and proof', async () => {
    const accepted = { id: 'BCF-1', outcome: 'accepted', internalApprovalId: null, auditId: 'audit', recordedBy: 'user-sales' };
    const tx = makeTx({
      fabricUseAuthorizationVersion: { findFirst: vi.fn(async ({ where }: any) => where.granteeRelationId === GRANTEE ? activeVersion() : null), findUnique: vi.fn(async () => activeVersion()) },
      businessConfirmation: { findUnique: vi.fn(async () => accepted) },
    });
    await expect(authorizeFabricUseInTx(tx, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).resolves.toMatchObject({ basisKind: 'grant', authorizationVersionId: 'FUA-V1' });
    await expect(authorizeFabricUseInTx(tx, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.quotationCreate, actor: ACTOR })).rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED', statusCode: 409 });
    await expect(authorizeFabricUseInTx(tx, { productAssetId: 'FAB-1', customerRelationId: 'REL-CUSTOMER-C',
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED', statusCode: 409 });

    const internalOnly = makeTx({
      fabricUseAuthorizationVersion: { findFirst: vi.fn(async () => activeVersion()), findUnique: vi.fn(async () => activeVersion()) },
      businessConfirmation: { findUnique: vi.fn(async () => ({ ...accepted, internalApprovalId: 'APPROVAL-ONLY' })) },
    });
    await expect(authorizeFabricUseInTx(internalOnly, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED' });

    const noScreenshot = makeTx({
      fabricUseAuthorizationVersion: { findFirst: vi.fn(async () => activeVersion()), findUnique: vi.fn(async () => activeVersion()) },
      businessConfirmation: { findUnique: vi.fn(async () => accepted) },
      businessConfirmationEvidence: { findMany: vi.fn(async () => [{ evidence: { sourceFingerprint: 'b'.repeat(64), sourceSnapshot: {}, sourceType: 'screenshot', files: [] } }]) },
    });
    await expect(authorizeFabricUseInTx(noScreenshot, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED' });
  });

  it('does not use a missing, deleted or non-customer relation as a customer grant', async () => {
    for (const relation of [null, { id: GRANTEE, category: 'Supplier', isOrganization: true, deletedAt: null },
      { id: GRANTEE, category: 'customer', isOrganization: true, deletedAt: 12 }]) {
      const tx = makeTx({
        relation: { findMany: vi.fn(async ({ where }: any) => where.id.in.includes(OWNER)
          ? [{ id: OWNER, category: 'Customer', isOrganization: true, deletedAt: null }]
          : relation ? [relation] : []) },
        fabricUseAuthorizationVersion: { findFirst: vi.fn(async () => activeVersion()), findUnique: vi.fn(async () => activeVersion()) },
        businessConfirmation: { findUnique: vi.fn(async () => ({ id: 'BCF-1', outcome: 'accepted', internalApprovalId: null, auditId: 'audit', recordedBy: 'user-sales' })) },
      });
      await expect(authorizeFabricUseInTx(tx, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
        action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR })).rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED', statusCode: 409 });
    }
  });

  it('records customer grant provenance in the caller transaction and safely replays the same use fact', async () => {
    const tx = makeTx({
      fabricUseAuthorizationVersion: { findFirst: vi.fn(async () => activeVersion()), findUnique: vi.fn(async () => activeVersion()) },
      businessConfirmation: { findUnique: vi.fn(async () => ({ id: 'BCF-1', outcome: 'accepted', internalApprovalId: null, auditId: 'audit', recordedBy: 'user-sales' })) },
    });
    const first = await checkAndRecordFabricUseInTx(tx, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR, businessTargetType: 'OrderLine', businessTargetId: 'OL-1',
      businessVersionFingerprint: fingerprint });
    expect(first).toMatchObject({ basisKind: 'grant', authorizationVersionId: 'FUA-V1', usage: {
      productAssetId: 'FAB-1', granteeRelationId: GRANTEE, action: FABRIC_USE_ACTIONS.orderLineCreate, businessTargetId: 'OL-1' } });
    expect(tx.fabricUseAuthorizationUse.create).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditLog).toHaveBeenCalledTimes(1);

    const decision = await authorizeFabricUseInTx(tx, { productAssetId: 'FAB-1', customerRelationId: GRANTEE,
      action: FABRIC_USE_ACTIONS.orderLineCreate, actor: ACTOR });
    tx.fabricUseAuthorizationUse.findUnique.mockResolvedValueOnce({ id: 'FUAU-existing', useKey: 'existing' } as any);
    await expect(recordFabricUseAuthorizationUseInTx(tx, { decision, action: FABRIC_USE_ACTIONS.orderLineCreate,
      businessTargetType: 'OrderLine', businessTargetId: 'OL-1', businessVersionFingerprint: fingerprint, actorId: ACTOR.userId }))
      .resolves.toMatchObject({ id: 'FUAU-existing' });
    expect(tx.fabricUseAuthorizationUse.create).toHaveBeenCalledTimes(1);
  });

  it('only creates an immutable active version from accepted customer proof; a rejection creates none', async () => {
    const savedRequests: any[] = [];
    const createdVersions: any[] = [];
    const accepted: any = { id: 'BCF-accepted', outcome: 'accepted', internalApprovalId: null, auditId: 'audit-proof', recordedBy: ACTOR.userId };
    const tx: any = {
      $queryRawUnsafe: vi.fn(async () => []),
      productAsset: {
        findFirst: vi.fn(async () => ({ id: 'FAB-1', mainCategory: 'Fabric', status: 'Active' })),
        findUnique: vi.fn(async () => ({ id: 'FAB-1', sku: 'FAB-1', name: '羊毛斜纹', mainCategory: 'Fabric', status: 'Active',
          fabricProfile: { articleNo: 'ART-1', millQuality: 'MQ-1', millColorCode: 'Navy', construction: 'twill', weightValue: 250, weightUnit: 'gsm' } })),
      },
      fabricCustomerCode: { findMany: vi.fn(async () => [{ id: 'FCC-1', customerOrganizationId: OWNER, customerNameSnapshot: 'A 客户' }]) },
      relation: {
        findMany: vi.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id, name: id === OWNER ? 'A 客户' : 'B 客户',
          category: 'customer', isOrganization: true, deletedAt: null }))),
        findFirst: vi.fn(async ({ where }: any) => ({ id: where.id })),
      },
      fabricUseAuthorizationVersion: {
        findFirst: vi.fn(async ({ where }: any) => where.granteeRelationId === GRANTEE ? createdVersions[createdVersions.length - 1] ?? null : null), findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => { createdVersions.push(data); return data; }),
      },
      fabricUseAuthorizationRequest: {
        findUnique: vi.fn(async ({ where }: any) => where.id
          ? savedRequests.find(row => row.id === where.id) ?? null
          : savedRequests.find(row => row.recordedBy === where.recordedBy_requestKey.recordedBy
            && row.requestKey === where.recordedBy_requestKey.requestKey) ?? null),
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => { savedRequests.push(data); return data; }),
      },
      businessConfirmation: {
        findFirst: vi.fn(async () => null), findMany: vi.fn(async () => [accepted]),
        findUnique: vi.fn(async () => accepted),
      },
      auditLog: { findUnique: vi.fn(async () => ({ id: 'audit-proof', action: 'business_customer_confirmation_recorded', targetId: accepted.id, actorId: ACTOR.userId })) },
      businessConfirmationEvidence: { findMany: vi.fn(async () => [{ evidence: { sourceFingerprint: 'b'.repeat(64), sourceSnapshot: { source: 'screenshot' }, sourceType: 'screenshot', files: [{ purpose: 'screenshot' }] } }]) },
    };
    const created = await createFabricUseAuthorizationRequestInTx(tx, { productAssetId: 'FAB-1', granteeRelationId: GRANTEE,
      operation: 'grant', allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], requestKey: '00000000-0000-4000-8000-000000000001', actor: ACTOR });
    expect(created.request.id).toBeTruthy();
    accepted.finalContentFingerprint = created.request.finalContentFingerprint;
    accepted.scopeFingerprint = created.request.scopeFingerprint;
    const adapter = createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma: {} as any });
    const customerTarget = await adapter.inspect(tx, created.request.id, ACTOR, 'confirm');
    expect(customerTarget.internalApprovalId).toBeNull();

    await adapter.onRecordedInTx!(tx, { targetId: created.request.id, actor: ACTOR,
      command: { targetType: 'FabricUseAuthorizationRequest', targetId: created.request.id, finalContentFingerprint: created.request.finalContentFingerprint,
        internalApprovalId: null, scopeFingerprint: created.request.scopeFingerprint, scope: customerTarget.scope, outcome: 'accepted',
        customerName: '联系人', confirmedAt: new Date().toISOString(), channel: 'screenshot', idempotencyKey: '00000000-0000-4000-8000-000000000002' } as any,
      confirmation: accepted });
    expect(createdVersions).toHaveLength(1);
    expect(createdVersions[0]).toMatchObject({ state: 'active', allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], confirmationId: accepted.id });

    const historicalRead = await adapter.inspect(tx, created.request.id, ACTOR, 'read');
    expect(historicalRead.eligible).toBe(false);
    expect(historicalRead.finalContentFingerprint).toBe(created.request.finalContentFingerprint);
    expect(historicalRead.nativeStatus).toMatchObject({ current: true, state: 'active' });
    await expect(adapter.inspect(tx, created.request.id, ACTOR, 'confirm'))
      .rejects.toMatchObject({ code: 'VERSION_MISMATCH', statusCode: 409 });
    // Receipt replay must survive the version created by this very confirmation,
    // while retaining the original write permission and customer scope checks.
    await expect(adapter.inspectReplay!(tx, created.request.id, ACTOR))
      .resolves.toMatchObject({ eligible: false, nativeStatus: { current: true, state: 'active' } });
    await expect(adapter.inspectReplay!(tx, created.request.id,
      { ...ACTOR, permissions: ['products:read'] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    tx.relation.findFirst.mockResolvedValueOnce(null);
    await expect(adapter.inspectReplay!(tx, created.request.id, ACTOR))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(createdVersions).toHaveLength(1);
    const replayed = await createFabricUseAuthorizationRequestInTx(tx, { productAssetId: 'FAB-1', granteeRelationId: GRANTEE,
      operation: 'grant', allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], requestKey: '00000000-0000-4000-8000-000000000001', actor: ACTOR });
    expect(replayed.replayed).toBe(true);
    expect(tx.fabricUseAuthorizationRequest.create).toHaveBeenCalledTimes(1);

    const rejectedAdapter = createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma: {} as any });
    const rejectedCreated = await createFabricUseAuthorizationRequestInTx(tx, { productAssetId: 'FAB-1', granteeRelationId: 'REL-CUSTOMER-C',
      operation: 'grant', allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], requestKey: '00000000-0000-4000-8000-000000000003', actor: ACTOR });
    const rejectedTarget = await rejectedAdapter.inspect(tx, rejectedCreated.request.id, ACTOR, 'confirm');
    const rejected = await rejectedAdapter.onRecordedInTx!(tx, { targetId: rejectedCreated.request.id, actor: ACTOR,
      command: { targetType: 'FabricUseAuthorizationRequest', targetId: rejectedCreated.request.id,
        finalContentFingerprint: rejectedCreated.request.finalContentFingerprint, internalApprovalId: null,
        scopeFingerprint: rejectedCreated.request.scopeFingerprint, scope: rejectedTarget.scope, outcome: 'rejected',
        customerName: '联系人', confirmedAt: new Date().toISOString(), channel: 'screenshot', idempotencyKey: '00000000-0000-4000-8000-000000000004' } as any,
      confirmation: { ...accepted, id: 'BCF-rejected', outcome: 'rejected' } });
    expect(rejected.effect).toMatchObject({ status: 'not_applicable' });
    expect(createdVersions).toHaveLength(1);
  });

  it('discovers only bounded customer-linked targets from an exact product reference', async () => {
    const tx = makeTx({
      productAsset: { findFirst: vi.fn(), findMany: vi.fn(async () => [{ id: 'FAB-1' }]) },
      relation: {
        findMany: vi.fn(async () => [{ id: GRANTEE, name: 'B 客户', category: 'Customer', isOrganization: true, deletedAt: null }]),
        findFirst: vi.fn(async () => ({ id: GRANTEE })),
      },
      fabricUseAuthorizationRequest: { findMany: vi.fn(async () => [{ id: 'FUA-pending' }]) },
    });
    const adapter = createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma: {} as any });
    await expect(adapter.searchTargetIds!(tx, ACTOR, { sourceEmail: { relationId: GRANTEE }, businessReference: 'FAB-SKU-1' }))
      .resolves.toEqual(['FUA-pending']);
    expect(tx.productAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      mainCategory: 'Fabric', OR: [{ sku: 'FAB-SKU-1' }, { fabricProfile: { is: { articleNo: 'FAB-SKU-1' } } }],
    }), take: 3 }));
    expect(tx.fabricUseAuthorizationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      productAssetId: 'FAB-1', OR: [{ ownerRelationId: GRANTEE }, { granteeRelationId: GRANTEE }],
    }, take: 40 }));

    const noAnchor = makeTx({ fabricUseAuthorizationRequest: { findMany: vi.fn() } });
    await expect(adapter.searchTargetIds!(noAnchor, ACTOR, { sourceEmail: {} })).resolves.toEqual([]);
    expect(noAnchor.fabricUseAuthorizationRequest.findMany).not.toHaveBeenCalled();

    const exactApplication = makeTx({ fabricUseAuthorizationRequest: {
      findUnique: vi.fn(async ({ where }: any) => where.id === 'FUA__exact' ? { id: where.id, ownerRelationId: OWNER, granteeRelationId: GRANTEE } : null),
      findMany: vi.fn(),
    }, relation: {
      findMany: vi.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id, name: id, category: 'customer', isOrganization: true, deletedAt: null }))),
      findFirst: vi.fn(async ({ where }: any) => ({ id: where.id })),
    } });
    await expect(adapter.searchTargetIds!(exactApplication, ACTOR, { sourceEmail: { relationId: GRANTEE }, businessReference: 'FUA__exact' }))
      .resolves.toEqual(['FUA__exact']);
    await expect(adapter.searchTargetIds!(exactApplication, ACTOR, { sourceEmail: { relationId: GRANTEE }, businessReference: 'FUA__other' }))
      .resolves.toEqual([]);
    expect(exactApplication.fabricUseAuthorizationRequest.findMany).not.toHaveBeenCalled();
  });

  it('recommends the exclusive owner customer as the confirmation source without guessing an email', async () => {
    const relationFindMany = vi.fn(async ({ where }: any) => where.id.in.map((id: string) => ({
      id,
      name: id === OWNER ? 'A 客户' : 'B 客户',
      category: 'customer',
      isOrganization: true,
      deletedAt: null,
    })));
    const tx = makeTx({
      productAsset: {
        findFirst: vi.fn(async () => ({ id: 'FAB-1', mainCategory: 'Fabric', status: 'Active' })),
        findUnique: vi.fn(async () => ({ id: 'FAB-1', sku: 'FAB-1', name: '羊毛斜纹', mainCategory: 'Fabric', status: 'Active',
          fabricProfile: { articleNo: 'ART-1', millQuality: 'MQ-1', millColorCode: 'Navy', construction: 'twill', weightValue: 250, weightUnit: 'gsm' } })),
      },
      relation: {
        findMany: relationFindMany,
        findFirst: vi.fn(async ({ where }: any) => ({ id: where.id })),
      },
      fabricUseAuthorizationRequest: { findUnique: vi.fn(async () => ({
        id: 'FUA-owner-source', productAssetId: 'FAB-1', ownerRelationId: OWNER, granteeRelationId: GRANTEE,
        operation: 'grant', allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], effectiveFrom: null, effectiveUntil: null,
        expectedVersionId: null, finalContentFingerprint: fingerprint, scopeFingerprint: fingerprint,
      })) },
      businessConfirmation: { findMany: vi.fn(async () => []) },
    });
    const adapter = createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma: {} as any });

    const inspected = await adapter.inspect(tx, 'FUA-owner-source', ACTOR, 'read');

    expect(inspected.recommendation).toEqual({ relationId: OWNER });
    expect(inspected.recommendation).not.toHaveProperty('fromAddress');
    expect(relationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, name: true, category: true, isOrganization: true, deletedAt: true },
    }));
    expect(inspected.nativeStatus).toMatchObject({ ownerName: 'A 客户', granteeName: 'B 客户' });
  });
});
