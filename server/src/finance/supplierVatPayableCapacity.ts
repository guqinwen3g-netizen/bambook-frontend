import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { supplierObject } from '../procurement/supplierContractPolicy';
import { SUPPLIER_VAT_PAYABLE_ACTION, readSupplierVatPayableSource, supplierVatAuthorizationOrderIds,
  supplierVatLineIdentity, type SupplierVatAmountBasis } from './supplierVatPayableSource';

export type SupplierVatRegistration = { amountBasis: SupplierVatAmountBasis; contractAmount: string; orderIds: string[] };

/** Capacity belongs to the stable contract line, across approved amendments.
 * Count only actual original AP receipts, never VAT amounts or header totals. */
export function createSupplierVatRegistrationReader(tx: Prisma.TransactionClient) {
  let audits: ReturnType<Prisma.TransactionClient['auditLog']['findMany']> | undefined;
  const verified = new Map<string, Promise<Awaited<ReturnType<typeof readSupplierVatPayableSource>>>>();
  return async (needed: ReadonlySet<string>) => {
    const result = new Map<string, SupplierVatRegistration[]>();
    if (!needed.size) return result;
    audits ??= tx.auditLog.findMany({ where: { action: SUPPLIER_VAT_PAYABLE_ACTION, targetType: 'Invoice' } });
    const seen = new Set<string>();
    for (const audit of await audits) {
      const old = supplierObject(supplierObject(audit.detail).snapshot);
      if (!Array.isArray(old.sources) || !old.sources.some(value => {
        const line = supplierObject(value); return needed.has(`${line.contractKind}:${line.contractId}:${line.lineId}`);
      })) continue;
      const vatId = supplierObject(old.vatOriginal).id;
      if (typeof vatId !== 'string') throw businessError('CONFLICT', '原应付容量依据缺失，请核对原账。');
      let evidence = verified.get(vatId);
      if (!evidence) { evidence = readSupplierVatPayableSource(tx, vatId); verified.set(vatId, evidence); }
      const original = await evidence;
      if (original.auditId !== audit.id || seen.has(vatId)) throw businessError('CONFLICT', '原应付容量回执重复或与准确原账不一致。');
      seen.add(vatId);
      const orderIds = supplierVatAuthorizationOrderIds(original.snapshot);
      for (const line of original.snapshot.sources) {
        const id = supplierVatLineIdentity(line);
        if (!needed.has(id)) continue;
        result.set(id, [...(result.get(id) ?? []), { amountBasis: original.snapshot.amountBasis, contractAmount: line.contractAmount, orderIds }]);
      }
    }
    return result;
  };
}

/** Separate calls deliberately re-read current original receipts. Candidate
 * enumeration can cache one view, then uses a new reader before returning. */
export async function readSupplierVatRegistrations(tx: Prisma.TransactionClient, needed: ReadonlySet<string>) {
  return createSupplierVatRegistrationReader(tx)(needed);
}
