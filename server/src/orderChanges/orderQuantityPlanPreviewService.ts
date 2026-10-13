import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { canonicalQuantityPlan, lockAndValidateQuantityPlan } from './orderLineQuantityPlan';
import { checkOrderMoqFacts, freezeQuantityMoqSnapshot } from './quantityPlanMoqGate';
import { businessError } from '../shared/errorCodes';

/**
 * Read-only actual-line quantity/MOQ preview. It deliberately creates no snapshot,
 * approval, audit, or business row. The later request command repeats every check.
 */
export function createOrderQuantityPlanPreviewService(prisma: PrismaClient) {
  return {
    async preview(actor: TokenPayload, input: unknown) {
      const plan = canonicalQuantityPlan(input);
      return prisma.$transaction(async (tx) => {
        const validated = await lockAndValidateQuantityPlan(
          tx,
          plan.orderId,
          plan,
          actor,
          'order:change_request:create',
        );

        // Historical positive overrides lack an immutable actor/value/scope proof.
        // The current user cannot retroactively authorize them.
        if (validated.actual.some((line: any) => typeof line.moqOverride === 'number' && line.moqOverride > 0)) {
          throw businessError('CONFLICT', 'MOQ 行级原授权证据尚未核实，请先核对');
        }

        // For a legacy order without a verified MOQ snapshot, use the locked current
        // configuration for this advisory result. Do not persist the proposed freeze.
        const frozen = await freezeQuantityMoqSnapshot(tx, validated.order);
        const effectiveOrder = frozen
          ? { ...validated.order, moqSnapshot: frozen.snapshot }
          : validated.order;
        const proposedById = new Map(validated.plan.lines.map((line: any) => [line.lineId, line]));
        const proposedRows = validated.actual.map((line: any) => ({
          ...line,
          quantity: proposedById.get(line.id)!.afterQuantity,
        })).sort((a: any, b: any) => a.lineNumber - b.lineNumber || a.id.localeCompare(b.id));

        const verdict = await checkOrderMoqFacts(tx, effectiveOrder, proposedRows, actor.userId);
        const lines = verdict.lines.map((line: any, index: number) => ({
          ...line,
          lineId: proposedRows[line.lineIndex ?? index]?.id ?? null,
        }));
        if (lines.length !== proposedRows.length || lines.some((line: any) => !line.lineId)) {
          throw businessError('CONFLICT', 'MOQ 逐行回读不完整，请刷新订单后重试');
        }
        return {
          orderId: plan.orderId,
          expectedUpdatedAt: plan.expectedUpdatedAt,
          lineQuantityPlan: validated.plan,
          moq: { ...verdict, lines },
          advisory: true as const,
        };
      });
    },
  };
}
