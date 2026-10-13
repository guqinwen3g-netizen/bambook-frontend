import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { businessError } from '../shared/errorCodes';

type CaseAnchor = { id: string; linkedOrderId?: string | null };
export type DevelopmentOrderAssociation = {
  caseId: string; state: 'ready' | 'restricted';
  items: Array<{ id: string; poNumber: string | null; status: string; source: 'case-source' | 'legacy-link' }>;
};
const stable = (value: any): string => Array.isArray(value) ? '[' + value.map(stable).sort().join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);
async function currentAccess(prisma: PrismaClient, signed: TokenPayload | null | undefined) {
  // Module-allowed anonymous development reads reveal no order association.
  if (!signed?.userId) return { readable: false, scope: {}, fingerprint: 'no-bound-order-identity' };
  let user: Awaited<ReturnType<typeof loadUserWithRoles>>;
  try {
    user = await loadUserWithRoles(prisma, signed.userId);
  } catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验关联订单权限，请稍后重试。'); }
  if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
  let actor: TokenPayload;
  try { actor = await buildLoadedAuthTokenPayload(prisma, user); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验关联订单权限，请稍后重试。'); }
  if (signed.permissionCeiling !== undefined) actor.permissionCeiling = [...signed.permissionCeiling];
  const readable = hasScope({ ...actor, roles: [] }, 'orders:read');
  let scope: Record<string, unknown> = {};
  if (readable) {
    try { scope = await freshOrderLineScope(prisma, actor); }
    catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验关联订单范围，请稍后重试。'); }
  }
  return { readable, scope, fingerprint: stable({ actor, scope, readable }) };
}
/** A page-wide read of actual canonical sources plus explicit legacy pointers.
 * These pointers stay historical snapshots; no writes or first-order projection. */
export async function readDevelopmentOrderAssociations(prisma: PrismaClient, cases: CaseAnchor[], signed: TokenPayload | null | undefined): Promise<Map<string, DevelopmentOrderAssociation>> {
  if (!cases.length) return new Map();
  const ids = cases.map(c => c.id), legacyIds = [...new Set(cases.map(c => c.linkedOrderId).filter((id): id is string => Boolean(id)))];
  const access = await currentAccess(prisma, signed);
  const read = async (scope: Record<string, unknown>) => {
    try { return await prisma.order.findMany({ where: { AND: [{ deletedAt: null }, { OR: [{ sourceCaseId: { in: ids } }, ...(legacyIds.length ? [{ id: { in: legacyIds } }] : [])] }, scope] }, select: { id: true, sourceCaseId: true, poNumber: true, status: true }, orderBy: { id: 'asc' } }); }
    catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法读取关联大货订单，请稍后重试。'); }
  };
  const rows = access.readable ? await read(access.scope) : [];
  const current = await currentAccess(prisma, signed);
  if (access.fingerprint !== current.fingerprint) throw businessError('FORBIDDEN', '读取期间关联订单权限或范围发生变化，请重新核对。');
  let currentCases: CaseAnchor[];
  try { currentCases = await prisma.developmentCase.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, linkedOrderId: true } }); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验开发案关联来源，请稍后重试。'); }
  if (stable(currentCases) !== stable(cases.map(c => ({ id: c.id, linkedOrderId: c.linkedOrderId ?? null })))) throw businessError('SOURCE_CHANGED', '开发案关联来源已变化，请刷新后重新核对。');
  const latest = current.readable ? await read(current.scope) : [];
  if (stable(rows) !== stable(latest)) throw businessError('SOURCE_CHANGED', '关联订单来源或归属已变化，请刷新后重新核对。');
  const final = await currentAccess(prisma, signed);
  if (current.fingerprint !== final.fingerprint) throw businessError('FORBIDDEN', '读取期间关联订单权限或范围发生变化，请重新核对。');
  return new Map(cases.map(c => [c.id, { caseId: c.id, state: access.readable ? 'ready' : 'restricted', items: rows.filter(r => r.sourceCaseId === c.id || r.id === c.linkedOrderId).map(r => ({ id: r.id, poNumber: r.poNumber, status: r.status, source: r.sourceCaseId === c.id ? 'case-source' : 'legacy-link' })) }]));
}
