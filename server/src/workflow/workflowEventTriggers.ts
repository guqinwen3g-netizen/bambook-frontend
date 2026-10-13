/** Persisted events may start generic review only. They never decide a step or
 * manufacture a native approval. Initialization is awaited before listening. */
import { PrismaClient } from '@prisma/client';
import { businessEventBus, BusinessEventType } from '../events/businessEventBus';
import { WorkflowEngine } from './workflowEngine';
import { WORKFLOW_SUPPORTED_EVENTS, currentWorkflowActor, workflowHash, workflowReject } from './workflowAccess';
import { logger } from '../lib/logger';

export const WORKFLOW_TRIGGER_GAPS = [{ definitionId: 'wf_def_invoice_issuance', eventType: 'ShipmentCompleted',
  reason: 'ShipmentCompleted carries Shipment identity; no durable native created-Invoice receipt is available to this workflow consumer.' }] as const;
const SUPPORTED_EVENTS: BusinessEventType[] = [...WORKFLOW_SUPPORTED_EVENTS];
let registered: { prisma: PrismaClient; unsubscribe: Array<() => void> } | undefined;
export async function registerWorkflowEventTriggers(prisma: PrismaClient): Promise<void> {
  const definitions = await prisma.workflowDefinition.findMany({ where: { isActive: true, triggerEvent: { not: null } } });
  for (const definition of definitions) {
    if (definition.entityType === 'Invoice' && definition.triggerEvent === 'ShipmentCompleted') {
      logger.warn('[WorkflowTrigger] native Invoice bridge unavailable; trigger disabled', { definitionId: definition.id, gap: WORKFLOW_TRIGGER_GAPS[0].reason });
    } else if (!SUPPORTED_EVENTS.includes(definition.triggerEvent as BusinessEventType)) {
      logger.warn('[WorkflowTrigger] unsupported trigger disabled', { definitionId: definition.id, eventType: definition.triggerEvent });
    }
  }
  if (registered?.prisma === prisma) return;
  registered?.unsubscribe.forEach(unsubscribe => unsubscribe());
  const engine = new WorkflowEngine(prisma), unsubscribe: Array<() => void> = [];
  for (const eventType of SUPPORTED_EVENTS) {
    unsubscribe.push(businessEventBus.subscribe(eventType, async event => {
      const defs = await prisma.workflowDefinition.findMany({ where: { isActive: true, triggerEvent: eventType } });
      if (!defs.length) return;
      const stored = await prisma.agentJob.findUnique({ where: { id: event.id } });
      if (!stored || stored.jobType !== `bev:${eventType}` || workflowHash(stored.payload) !== workflowHash(event)) workflowReject('CONFLICT', '工作流事件缺少准确的持久来源');
      const actor = await currentWorkflowActor(prisma, { userId: event.actorId, roles: [], permissions: [], departmentIds: [] });
      for (const def of defs) {
        if (event.sourceEntityType !== def.entityType || !event.sourceEntityId) workflowReject('INVALID_INPUT', '工作流事件与真实来源类型不一致', 400);
        await engine.createInstance({ definitionId: def.id, entityType: def.entityType, entityId: event.sourceEntityId,
          title: `${def.name}：${def.entityType} ${event.sourceEntityId}`, actor, clientRequestId: `event:${workflowHash({ eventId: event.id, definitionId: def.id })}`, initiatedById: actor.userId });
      }
      // Errors propagate to dispatch(): its durable event stays queued. No
      // catch-and-log success, permission fabrication, or Shipment→Invoice guess.
    }));
  }
  registered = { prisma, unsubscribe };
  logger.info('[WorkflowTrigger] registered', { definitionCount: definitions.length, triggerEvents: SUPPORTED_EVENTS, gaps: WORKFLOW_TRIGGER_GAPS });
}
