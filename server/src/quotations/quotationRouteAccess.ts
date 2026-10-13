import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { createTeamShareService } from '../teams/teamShareService';
import { conversionAuthorityRead, currentConversionActor, assertConversionCustomerWrite } from '../development/developmentConversionAuthority';
import { currentOrderConversionReader, assertOrderConversionCustomerRead } from '../orders/orderConversionReadAuthority';
import { businessError } from '../shared/errorCodes';
import { buildQuotationListScopeWhere } from './quotationService';

/** Authenticate with the verified credential, then use current stored grants. */
export function currentQuotationRouteActor(db: PrismaClient, prior: TokenPayload, write: boolean) {
  return write ? currentConversionActor(db, prior.userId, prior, 'quotations:write')
    : currentOrderConversionReader(db, prior, 'quotation');
}

/** Same customer/legacy-owner boundary as the quotation list, using fresh grants.
 * A current business leader also retains the matrix's real team follow-up scope. */
export async function quotationRouteReadScope(db: PrismaClient, actor: TokenPayload | null) {
  if (!actor) return {};
  return conversionAuthorityRead(db, async strict => {
    const existing = await buildQuotationListScopeWhere(strict, actor);
    if (!Object.keys(existing).length) return existing;
    const ids = new Set(await createTeamShareService(strict).resolveVisibleRelationIds(actor, { fresh: true }));
    const resolver = await createPermissionService({ prisma: strict }).getDataScopeResolver(actor, 'relations');
    const kind = resolveWriteKind(resolver.rule);
    if (kind === 'team' || kind === 'department') {
      const userIds = resolver.allowedUserIds ?? [], departmentIds = resolver.allowedDepartmentIds ?? [];
      const branches: any[] = [];
      if (userIds.length) branches.push({ ownerId: { in: userIds } }, { salesRepIds: { hasSome: userIds } });
      if (departmentIds.length) branches.push({ departmentId: { in: departmentIds } });
      if (branches.length) {
        const customers = await strict.relation.findMany({ where: { deletedAt: null, OR: branches }, select: { id: true } });
        customers.forEach((customer: any) => ids.add(customer.id));
      }
    }
    const customers = ids.size ? await strict.relation.findMany({ where: { deletedAt: null, id: { in: [...ids] } }, select: { id: true } }) : [];
    return { OR: [{ customerRelationId: { in: customers.map((customer: any) => customer.id) } },
      { AND: [{ customerRelationId: null }, { ownerId: actor.userId }] }] };
  });
}

export async function assertQuotationRouteRead(db: PrismaClient, actor: TokenPayload, id: string) {
  return conversionAuthorityRead(db, async strict => {
    const scope = await quotationRouteReadScope(strict, actor);
    const quotation = await strict.quotation.findFirst({ where: { AND: [scope, { id, deletedAt: null }] } });
    if (!quotation) throw businessError('NOT_FOUND', '报价单不存在或不在当前可见范围。');
    if (quotation.customerRelationId) await assertOrderConversionCustomerRead(strict, actor, quotation.customerRelationId, quotation.ownerId ?? null);
    return quotation;
  });
}

export async function assertQuotationRouteWrite(db: PrismaClient, actor: TokenPayload, id: string) {
  return conversionAuthorityRead(db, async strict => {
    const quotation = await strict.quotation.findFirst({ where: { id, deletedAt: null } });
    if (!quotation) throw businessError('NOT_FOUND', '报价单不存在或不在当前可操作范围。');
    await assertConversionCustomerWrite(strict, actor, quotation.customerRelationId, quotation.ownerId ?? null);
    return quotation;
  });
}

export async function assertQuotationRouteCustomer(db: PrismaClient, actor: TokenPayload, customerId: unknown, ownerId: string) {
  if (customerId == null) return;
  if (typeof customerId !== 'string' || !customerId || customerId !== customerId.trim())
    throw businessError('INVALID_INPUT', '客户标识无效，请选择真实客户档案。');
  await assertConversionCustomerWrite(db, actor, customerId, ownerId);
}

/** Scope the existing read service at its query boundary, without changing its DTO. */
export function quotationScopedReadClient(db: PrismaClient, scope: Record<string, unknown>): PrismaClient {
  return new Proxy(Object.create(null), { get(_target, key) {
    if (key === 'quotation') return new Proxy(Object.create(null), { get(_delegate, method) {
      const fn = Reflect.get(db.quotation, method, db.quotation);
      if (method === 'findMany') return (args: any) => db.quotation.findMany({ ...args, where: { AND: [args.where ?? {}, scope] } });
      return typeof fn === 'function' ? fn.bind(db.quotation) : fn;
    } });
    const value = Reflect.get(db, key, db);
    return typeof value === 'function' ? value.bind(db) : value;
  } }) as PrismaClient;
}
