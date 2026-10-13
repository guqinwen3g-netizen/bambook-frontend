import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from './errorCodes';
import { exactJsonValue } from '../lib/exactJsonValue';
import type { BusinessWorkspaceScope, BusinessWorkspaceContext, BusinessWorkspaceContinueCommand,
  BusinessWorkspaceNode, BusinessWorkspaceCommandAck, BusinessWorkspaceContinueResult } from './businessWorkspaceContract';

const ACTION = 'continue_business_workspace', SOURCE = 'route:business-workspace:continue';
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw businessError('INVALID_INPUT', '请提交准确业务工作区。');
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.length || value.length > 160 || value !== value.trim() || /[\u0000-\u001f]/.test(value))
    throw businessError('INVALID_INPUT', `${label}必须是准确记录编号。`);
  return value;
};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const workspaceDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(exactJsonValue(value)))).digest('hex');
export const workspaceTargetId = (scope: BusinessWorkspaceScope) => `BW_${workspaceDigest(scope)}`;

export function parseWorkspaceScope(value: unknown): BusinessWorkspaceScope {
  const input = record(value), kind = input.kind;
  const fields: Record<string, string[]> = { development_case: ['caseId'], development_version: ['caseId', 'sampleVersionId'],
    order_main: ['orderId'], order_line: ['orderId', 'orderLineId'], production_branch: ['orderId', 'orderLineId', 'productionBatchId', 'productionBatchRevision'] };
  if (typeof kind !== 'string' || !fields[kind] || Object.keys(input).sort().join(',') !== ['kind', ...fields[kind]].sort().join(','))
    throw businessError('INVALID_INPUT', '工作区必须绑定准确开发案、版本、订单行或生产分支。');
  for (const field of fields[kind]) {
    if (field === 'productionBatchRevision') {
      if (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1) throw businessError('INVALID_INPUT', '生产分支修订号无效。');
    } else text(input[field], field);
  }
  return input as BusinessWorkspaceScope;
}
export function parseWorkspaceContinueCommand(value: unknown): BusinessWorkspaceContinueCommand {
  const input = record(value);
  if (Object.keys(input).sort().join(',') !== 'expectedContextFingerprint,requestKey,scope,targetNodeId'
    || typeof input.expectedContextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedContextFingerprint))
    throw businessError('INVALID_INPUT', '请读取当前准确工作区后明确继续。');
  return { scope: parseWorkspaceScope(input.scope), targetNodeId: text(input.targetNodeId, '目标步骤'),
    expectedContextFingerprint: input.expectedContextFingerprint, requestKey: text(input.requestKey, '原请求键') };
}

export type WorkspaceNodeFact = Omit<BusinessWorkspaceNode, 'status' | 'canOpen' | 'canContinue'> & {
  eligible: boolean; unknown?: boolean; initial?: boolean;
};
/** Eligible future content stays closed until a human continuation. Actual
 * history remains readable even if its current gate has subsequently failed. */
export function assembleBusinessWorkspace(input: {
  scope: BusinessWorkspaceScope; identity: unknown; overview: Record<string, unknown>;
  facts: WorkspaceNodeFact[]; activatedNodeIds: string[]; canWrite: boolean; childSummaries: Array<Record<string, unknown>>;
}): BusinessWorkspaceContext {
  const activated = new Set(input.activatedNodeIds), currentNodeIds: string[] = [];
  const nodes = input.facts.map(fact => {
    const active = activated.has(fact.id) || !!fact.initial;
    if (active && !fact.hasHistory) currentNodeIds.push(fact.id);
    const canOpen = active || fact.hasHistory;
    const status: BusinessWorkspaceNode['status'] = fact.unknown ? 'unknown' : !fact.eligible && canOpen ? 'blocked'
      : active && !fact.hasHistory ? 'current' : fact.hasHistory ? 'recorded' : 'locked';
    return { id: fact.id, label: fact.label, precedingIds: fact.precedingIds, status, hasHistory: fact.hasHistory,
      canOpen, canContinue: input.canWrite && fact.eligible && !active && !fact.hasHistory, blockedReasons: fact.blockedReasons, evidenceRefs: fact.evidenceRefs };
  });
  const base = { schemaVersion: 1 as const, scope: input.scope, scopeFingerprint: workspaceDigest(input.identity), overview: input.overview,
    currentNodeIds, nodes, childSummaries: input.childSummaries };
  return { ...base, contextFingerprint: workspaceDigest(base) };
}

function readStoredAck(row: any, command?: BusinessWorkspaceContinueCommand): BusinessWorkspaceCommandAck {
  const saved = row?.detail?.after, ack = saved?.commandAck;
  if (!row || row.action !== ACTION || row.targetType !== 'BusinessWorkspace' || row.detail?.source !== SOURCE
    || !saved?.command || saved.commandFingerprint !== workspaceDigest(saved.command)
    || row.targetId !== workspaceTargetId(saved.command.scope) || !ack || ack.schemaVersion !== 1 || ack.auditId !== row.id
    || ack.actorId !== row.actorId || ack.requestKey !== saved.command.requestKey || ack.targetNodeId !== saved.command.targetNodeId
    || !/^[a-f0-9]{64}$/.test(ack.contextFingerprint ?? '') || !/^[a-f0-9]{64}$/.test(ack.scopeFingerprint ?? '')
    || ack.commandFingerprint !== saved.commandFingerprint || workspaceDigest(ack.scope) !== workspaceDigest(saved.command.scope)
    || command && saved.commandFingerprint !== workspaceDigest(command)) throw businessError('CONFLICT', '原继续请求的参数或回执不一致，请核对原记录。');
  return ack;
}
export async function readWorkspaceActivations(db: any, scope: BusinessWorkspaceScope, scopeFingerprint: string): Promise<string[]> {
  const rows = await db.auditLog.findMany({ where: { action: ACTION, targetType: 'BusinessWorkspace', targetId: workspaceTargetId(scope) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return [...new Set(rows.map((row: any) => readStoredAck(row)).filter((ack: BusinessWorkspaceCommandAck) => ack.scopeFingerprint === scopeFingerprint).map((ack: BusinessWorkspaceCommandAck) => ack.targetNodeId))] as string[];
}

export type WorkspaceAdapter = {
  authorize(db: any, scope: BusinessWorkspaceScope, mode: 'read' | 'write'): Promise<TokenPayload>;
  lock(db: any, scope: BusinessWorkspaceScope): Promise<void>;
  context(db: any, scope: BusinessWorkspaceScope, actor: TokenPayload): Promise<BusinessWorkspaceContext>;
};
export async function continueBusinessWorkspace(params: { prisma: any; prior: TokenPayload | null | undefined; input: unknown; adapter: WorkspaceAdapter; ip?: string | null }): Promise<BusinessWorkspaceContinueResult> {
  const command = parseWorkspaceContinueCommand(params.input), actorId = params.prior?.userId;
  if (!actorId) throw businessError('UNAUTHORIZED', '明确继续需要当前登录账号。');
  const commandFingerprint = workspaceDigest(command), auditId = `BWACK_${workspaceDigest([actorId, command.requestKey])}`;
  return params.prisma.$transaction(async (tx: any) => {
    await params.adapter.authorize(tx, command.scope, 'read');
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`business-workspace-request:${actorId}:${command.requestKey}`},0))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`business-workspace-scope:${workspaceTargetId(command.scope)}`},0))::text`);
    await params.adapter.lock(tx, command.scope);
    // A receipt is a current authorized read of the original action, not a new
    // consumption grant. Re-read context instead of replaying stale capability.
    const freshRead = await params.adapter.authorize(tx, command.scope, 'read');
    const existing = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (existing) return { context: await params.adapter.context(tx, command.scope, freshRead), commandAck: readStoredAck(existing, command), replayed: true };
    const actor = await params.adapter.authorize(tx, command.scope, 'write');
    const before = await params.adapter.context(tx, command.scope, actor);
    const node = before.nodes.find(node => node.id === command.targetNodeId);
    if (before.contextFingerprint !== command.expectedContextFingerprint || !node?.canContinue)
      throw businessError('CONFLICT', '当前来源或步骤条件已变化，请核对当前准确工作区。');
    const commandAck: BusinessWorkspaceCommandAck = { schemaVersion: 1, requestKey: command.requestKey, scope: command.scope, targetNodeId: command.targetNodeId,
      auditId, contextFingerprint: before.contextFingerprint, scopeFingerprint: before.scopeFingerprint, actorId: actor.userId, commandFingerprint };
    await tx.auditLog.create({ data: { id: auditId, actorId: actor.userId, action: ACTION, targetType: 'BusinessWorkspace', targetId: workspaceTargetId(command.scope),
      detail: exactJsonValue({ source: SOURCE, after: { command, commandFingerprint, commandAck } }), ip: params.ip ?? null } });
    return { context: await params.adapter.context(tx, command.scope, actor), commandAck, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
