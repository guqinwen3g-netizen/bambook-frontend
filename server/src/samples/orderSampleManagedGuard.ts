import { DevelopmentDomainError } from '../development/developmentOperationalGuard';

/** Caller holds the actual Sample row lock and has reloaded the row. Reads the
 * binding without taking a late Source lock: native append locks Source only.
 * A missing delegate/table propagates; old storage cannot imply no binding. */
export async function assertGenericSampleMutationAllowed(tx: any, sample: { id: string; sourceOrderId?: string | null }, operation: string): Promise<void> {
  const source = await tx.orderSampleSource.findUnique({ where: { sampleId: sample.id }, select: { id: true, sampleId: true } });
  if (source) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', `此样品已绑定订单业务来源，${operation}须从该样品的业务流程操作，不能通过通用编辑改变原记录。`);
}

/** Native order production samples must acquire their exact Line/Batch source
 * and initial event atomically. Case-only producers remain intact; a Case origin does not prove an order line. */
export function assertGenericOrderSampleCreationAllowed(input: { type?: unknown; sourceOrderId?: unknown; sourceCaseId?: unknown; origin?: unknown; sealOrigin?: unknown }): void {
  const production = ['pp', 'top', 'ship', 'head', 'pioneer'].includes(String(input.type));
  if (production && typeof input.sourceOrderId === 'string' && input.sourceOrderId.trim())
    throw new DevelopmentDomainError('INVALID_INPUT', '订单生产样品须选择实际订单行、批次及工厂，通过准确来源登记。');
}
