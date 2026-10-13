import { randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { lockSupplierCommand, freshSupplierActor, type SupplierAccessMode, type SupplierContractTx } from './supplierContractAccess';
import { supplierFail, supplierFingerprint, supplierJson, supplierObject, supplierText, type SupplierContractKind } from './supplierContractPolicy';

export type SupplierCommandAck = { schemaVersion: 1; requestKey: string; operation: string; contractKind: SupplierContractKind;
  contractId: string; receiptId: string; revisionId?: string; approvalId?: string; factIds?: string[]; documentId?: string };
export type SupplierCommandResponse = { ok: true; item: unknown; commandAck: SupplierCommandAck };
export type SupplierCommand = { actor: TokenPayload; requestKey: string; operation: string; kind: SupplierContractKind; targetId: string | null; input: unknown; mode?: SupplierAccessMode };
export async function beginSupplierCommand(tx: SupplierContractTx, command: SupplierCommand) {
  supplierText(command.requestKey, '原请求标识', 150);
  const actor = await freshSupplierActor(tx, command.actor, command.mode ?? 'write');
  await lockSupplierCommand(tx, actor.userId, command.requestKey);
  // Caller checks exact current source authority before exposing a stored result.
  return { actor, receiptId: `SCR_${randomUUID()}`, fingerprint: supplierFingerprint({ actorId: actor.userId, operation: command.operation,
    contractKind: command.kind, targetId: command.targetId, input: command.input }) };
}
export async function replaySupplierCommand(tx: SupplierContractTx, command: SupplierCommand, fingerprint: string): Promise<SupplierCommandResponse | null> {
  const receipt = await tx.supplierContractCommandReceipt.findUnique({ where: { actorId_requestKey: { actorId: command.actor.userId, requestKey: command.requestKey } } });
  if (!receipt) return null;
  if (receipt.inputFingerprint !== fingerprint || receipt.operation !== command.operation || receipt.contractKind !== command.kind
    || command.targetId !== null && receipt.contractId !== command.targetId) return supplierFail('REQUEST_KEY_CONFLICT', '原请求标识已用于不同目标或参数，请核对原请求。', 409);
  const value = supplierObject(receipt.resultSnapshot), ack = supplierObject(value.commandAck);
  if (value.ok !== true || ack.requestKey !== receipt.requestKey || ack.contractId !== receipt.contractId || ack.receiptId !== receipt.id)
    return supplierFail('RECEIPT_UNAVAILABLE', '原提交回执无法准确核实，请联系管理员。', 503);
  return value as unknown as SupplierCommandResponse;
}
export async function persistSupplierCommand(tx: SupplierContractTx, command: SupplierCommand, fingerprint: string, result: SupplierCommandResponse): Promise<SupplierCommandResponse> {
  await tx.supplierContractCommandReceipt.create({ data: { id: result.commandAck.receiptId, actorId: command.actor.userId, requestKey: command.requestKey,
    operation: command.operation, contractKind: command.kind, contractId: result.commandAck.contractId, inputFingerprint: fingerprint,
    requestSnapshot: supplierJson(command.input), resultSnapshot: supplierJson(result), createdAt: BigInt(Date.now()) } });
  return result;
}
export const supplierResponse = (item: unknown, command: SupplierCommand, receiptId: string, contractId: string, extra: Partial<SupplierCommandAck> = {}): SupplierCommandResponse => ({ ok: true,
  item: supplierJson(item), commandAck: { schemaVersion: 1, requestKey: command.requestKey, operation: command.operation, contractKind: command.kind, contractId, receiptId, ...extra } });
