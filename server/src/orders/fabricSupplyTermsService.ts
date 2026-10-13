import type { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { createRelationServiceV2 } from '../relations/relationServiceV2';
import { businessError } from '../shared/errorCodes';
import { fabricCommissionFinancialLine, normalizeFabricSupplyTerms, type FabricFinancialLine } from './fabricCommissionPolicy';

/** Choosing a party on one's own order does not change the supplier master or
 * grant access to the supplier's other orders. The caller owns the parent lock
 * and has already reloaded the actual order writer and credential ceiling. */
export async function assertFabricSupplyTermsParty(tx: Prisma.TransactionClient, actor: TokenPayload, line: FabricFinancialLine,
  family: string, submitting = false) {
  const terms = normalizeFabricSupplyTerms(line);
  if (family !== 'fabric') {
    if (terms.fabricSupplyMode !== null) throw businessError('INVALID_INPUT', '面料供给方式和佣金只适用于面料条目。');
    return terms;
  }
  if (terms.fabricSupplyMode !== 'commission') return terms;
  if (!hasScope({ ...actor, roles: [] }, 'suppliers:read')) throw businessError('FORBIDDEN', '当前账号不能核对真实佣金付款供应商。');
  const party = await createRelationServiceV2(tx as PrismaClient).getRelation(actor, terms.fabricCommissionSupplierId!);
  if (!party.ok || !party.data || party.data.category !== 'Supplier' || party.data.isOrganization !== true)
    throw businessError('NOT_FOUND', '佣金付款供应商不存在或不在当前可见范围。');
  if (submitting) {
    const basis = fabricCommissionFinancialLine(line);
    if (basis.unitPrice == null || basis.unitPrice === '0' || !basis.unit)
      throw businessError('INVALID_INPUT', '提交佣金订单须明确货物单价、数量单位和佣金约定。');
  }
  return terms;
}
