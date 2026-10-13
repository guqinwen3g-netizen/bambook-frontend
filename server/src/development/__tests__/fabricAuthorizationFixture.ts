/** Storage-only identity seam. This does not create production grants or prove PG business approval. */
import { vi } from 'vitest';
export function fabricAuthorizationFixture(actorId = 'u_owner') {
  const user = { id: actorId, displayName: 'Synthetic current operator', status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ departmentId: null, role: { id: 'role-super-admin', permissions: [{ permission: { scope: 'products:write' } }, { permission: { scope: 'products:read' } }] } }] };
  return {
    userAccount: { findFirst: vi.fn(async () => user), findUnique: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    relation: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, ownerId: actorId, salesRepIds: [], deletedAt: null })) },
  };
}
/** Recorded legacy approval storage substitute, not native approval execution evidence. */
export const legacyApprovedFabricBatch = (patch: any = {}) => ({ id: 'APPROVED-BATCH', developmentCaseId: 'DC__1', sampleType: 'lab-dip',
  status: 'approved', round: 1, customerStatus: 'approved', approvedBy: 'u_owner', approvedAt: 1n, convertedProductAssetId: 'P1', deletedAt: null, ...patch });
