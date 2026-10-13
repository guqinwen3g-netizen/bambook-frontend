import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createInventoryService } from '../inventory/inventoryService';
import { resolveReceiptWarehouse } from './receiptWarehouseAccess';
import { authorizeSupplierSources, lockSupplierContracts, type SupplierContractTx } from './supplierContractAccess';
import { beginSupplierCommand, persistSupplierCommand, replaySupplierCommand, supplierResponse, type SupplierCommand } from './supplierContractCommandReceipt';
import { authorizeSupplierContract, requireApprovedSupplierBasis, supplierEvidence } from './supplierCommitmentService';
import { readSupplierContract, latestSupplierRevision, supplierSnapshot, supplierAudit, type SupplierSnapshot } from './supplierContractStore';
import { normalizeSupplierLocation, supplierDate, supplierDecimal, supplierFail, supplierJson, supplierObject, supplierOptionalText, supplierText,
  type SupplierContractKind, type SupplierContractLine, type SupplierLocation } from './supplierContractPolicy';

type FulfillmentKind = 'purchase_delivery' | 'processing_input' | 'processing_return';
type FulfillmentLine = { kind: FulfillmentKind; lineId: string; quantity: string; unit: string; occurredAt: string; destination: SupplierLocation;
  processingContractId?: string; processingRevisionId?: string; processingLineId?: string; sourceFactId?: string; inventoryItemId?: string;
  evidence: string[]; notes?: string; materialCode?: string; description?: string; specification?: string };
type Basis = Awaited<ReturnType<typeof requireApprovedSupplierBasis>>;
type Fact = Prisma.SupplierFulfillmentFactUncheckedCreateInput;
function normalizeLines(kind: SupplierContractKind, value: unknown): FulfillmentLine[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) return supplierFail('LINES_REQUIRED', '请明确1至100条本次实际交接。');
  return value.map(raw => {
    const row = supplierObject(raw), type = row.kind;
    if (kind === 'purchase' ? type !== 'purchase_delivery' : type !== 'processing_input' && type !== 'processing_return')
      return supplierFail('FULFILLMENT_KIND_MISMATCH', '采购交付与加工接料/回交须归属准确合同类型。');
    const destination = normalizeSupplierLocation(row.destination);
    if (!destination) return supplierFail('DESTINATION_REQUIRED', '请明确本次实际接收对象与地点。');
    const line: FulfillmentLine = { kind: type as FulfillmentKind, lineId: supplierText(row.lineId, '准确已批合同条目', 150), quantity: supplierDecimal(row.quantity, '本次实际数量').toString(),
      unit: supplierText(row.unit, '本次明确单位', 20).toUpperCase(), occurredAt: supplierDate(row.occurredAt, '实际交接日期'), destination, evidence: supplierEvidence(row.evidence) };
    for (const key of ['processingContractId', 'processingRevisionId', 'processingLineId', 'sourceFactId', 'inventoryItemId', 'materialCode', 'description', 'specification', 'notes'] as const) {
      const text = supplierOptionalText(row[key], key, key === 'notes' ? 4000 : 1000); if (text !== undefined) line[key] = text;
    }
    return line;
  });
}
function exactLine(basis: Basis, id: string): SupplierContractLine {
  const line = basis.snapshot.lines.find(row => row.id === id);
  return line ?? supplierFail('LINE_SOURCE_MISMATCH', '本次行不属于准确已批合同版本。', 409);
}
async function validateActualDestination(tx: SupplierContractTx, destination: SupplierLocation) {
  if (destination.kind === 'warehouse') return resolveReceiptWarehouse(tx, destination.warehouseId);
  if (destination.kind === 'supplier') {
    const relation = await tx.relation.findFirst({ where: { id: destination.relationId, isOrganization: true, deletedAt: null } });
    if (!relation) return supplierFail('LOCATION_UNAVAILABLE', '实际交接对象已失效。', 409);
    return { id: relation.id, name: relation.name };
  }
  return { id: null, name: destination.name! };
}
function factData(receiptId: string, sequence: number, basis: Basis, source: SupplierContractLine, actual: FulfillmentLine, extra: Partial<Fact> = {}): Fact {
  return { id: `SFF_${randomUUID()}`, commandReceiptId: receiptId, lineSequence: sequence, kind: actual.kind, commitmentRevisionId: basis.revision.id,
    orderLineId: source.orderLineId, ...(basis.snapshot.contractKind === 'purchase' ? { purchaseLineId: source.id! } : { outsourcingLineId: source.id! }),
    occurredAt: actual.occurredAt, quantity: new Prisma.Decimal(actual.quantity), unit: actual.unit, materialCode: source.materialCode ?? null,
    specSnapshot: supplierJson({ description: source.description, specification: source.specification, materialCode: source.materialCode, sourceContractLineId: source.id, inputSource: source.inputSource }),
    fromKind: 'supplier', fromRelationId: basis.snapshot.supplierRelationId, toKind: actual.destination.kind,
    toRelationId: actual.destination.kind === 'supplier' ? actual.destination.relationId : null,
    toWarehouseId: actual.destination.kind === 'warehouse' ? actual.destination.warehouseId : null,
    partySnapshot: supplierJson({ supplier: basis.snapshot.supplierParty ?? { id: basis.snapshot.supplierRelationId }, destination: actual.destination }),
    evidence: supplierJson(actual.evidence), notes: actual.notes ?? null, recordedBy: basis.actor.userId, recordedAt: BigInt(Date.now()), ...extra };
}
/** Existing inventory primitives retain exact Decimal amounts and the outer
 * source/receipt transaction. A new physical lot never merges by material code. */
async function stockInbound(tx: SupplierContractTx, basis: Basis, source: SupplierContractLine, actual: FulfillmentLine, factId: string) {
  const warehouse = await resolveReceiptWarehouse(tx, actual.destination.warehouseId);
  const inventory = createInventoryService(tx as PrismaClient);
  const zero = await inventory.createInventoryItem({ warehouseId: warehouse.id, description: source.description, materialCode: source.materialCode,
    category: source.category, specification: source.specification, quantity: 0, unit: actual.unit, currency: basis.snapshot.currency, receiptDate: actual.occurredAt,
    notes: `实际供应商交接 ${factId}；质量结论另按专业 QC` }, basis.actor.userId, { tx });
  await tx.inventoryItem.update({ where: { id: zero.id }, data: { orderId: basis.snapshot.sourceProofs.find(proof => proof.orderLineId === source.orderLineId)!.orderId,
    unitCost: new Prisma.Decimal(source.unitPrice), updatedAt: BigInt(Date.now()) } });
  return inventory.createStockMovement({ itemId: zero.id, type: 'Inbound', quantity: 0, unit: actual.unit, movementDate: actual.occurredAt,
    referenceType: 'SupplierFulfillmentFact', referenceId: factId, reason: '供应商实际交付入库；未推定质量合格' }, basis.actor.userId, { tx, exactQuantity: new Prisma.Decimal(actual.quantity) });
}
async function sourceFactQuantity(tx: SupplierContractTx, id: string, quantity: string, unit: string, pending: Map<string, Prisma.Decimal>) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SupplierFulfillmentFact" WHERE "id" = ${id} FOR UPDATE`);
  const fact = await tx.supplierFulfillmentFact.findUnique({ where: { id } });
  if (!fact || fact.kind !== 'purchase_delivery' || fact.unit !== unit) return supplierFail('INPUT_SOURCE_MISMATCH', '原实际交付不存在，或明确单位不一致。', 409);
  const used = await tx.supplierFulfillmentFact.aggregate({ where: { sourceFactId: id, kind: 'processing_input' }, _sum: { quantity: true } });
  const reserved = (pending.get(id) ?? new Prisma.Decimal(0)).plus(quantity);
  if (new Prisma.Decimal(used._sum.quantity ?? 0).plus(reserved).gt(fact.quantity)) return supplierFail('INPUT_ALREADY_CONSUMED', '本次交接超过该实际来源尚未交接的数量，不能重复使用。', 409);
  pending.set(id, reserved);
  return fact;
}
export function createSupplierFulfillmentService(prisma: PrismaClient) {
  const transaction = <T>(work: (tx: SupplierContractTx) => Promise<T>) => prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  async function get(kind: SupplierContractKind, id: string, actor: TokenPayload) {
    return transaction(async tx => {
      const current = await authorizeSupplierContract(tx, kind, id, actor, { mode: 'read', businessGates: false });
      const approved = current.contract.approvedCommitmentRevisionId ? await tx.supplierCommitmentRevision.findUnique({ where: { id: current.contract.approvedCommitmentRevisionId } }) : null;
      const snapshot = approved ? supplierSnapshot(approved.snapshot, kind) : null;
      const facts = await tx.supplierFulfillmentFact.findMany({ where: kind === 'purchase' ? { purchaseLineId: { in: current.contract.lines.map(row => row.id) }, kind: 'purchase_delivery' }
        : { outsourcingLineId: { in: current.contract.lines.map(row => row.id) } }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] });
      const lines = (snapshot?.lines ?? []).map(line => {
        const own = facts.filter(fact => (kind === 'purchase' ? fact.purchaseLineId : fact.outsourcingLineId) === line.id);
        const actual = own.filter(fact => fact.kind === (kind === 'purchase' ? 'purchase_delivery' : 'processing_return') && fact.unit === line.unit)
          .reduce((sum, fact) => sum.plus(fact.quantity), new Prisma.Decimal(0));
        const inputUnits = [...new Set(own.filter(fact => fact.kind === 'processing_input').map(fact => fact.unit))];
        return { lineId: line.id, orderLineId: line.orderLineId, plannedQuantity: line.quantity, unit: line.unit,
          ...(kind === 'purchase' ? { deliveredQuantity: actual.toString() } : { returnedQuantity: actual.toString(), inputQuantities: inputUnits.map(unit => ({ unit,
            quantity: own.filter(fact => fact.kind === 'processing_input' && fact.unit === unit).reduce((sum, fact) => sum.plus(fact.quantity), new Prisma.Decimal(0)).toString() })) }),
          differenceFromPlan: actual.minus(line.quantity).toString(), varianceStatus: actual.eq(line.quantity) ? 'matches_plan' : 'pending', facts: own };
      });
      return supplierJson({ contractId: id, contractKind: kind, approvedRevisionId: approved?.id ?? null, lines, facts, historicalBasisUnknown: !snapshot });
    });
  }
  async function record(kind: SupplierContractKind, id: string, input: unknown, actor: TokenPayload) {
    const row = supplierObject(input), lines = normalizeLines(kind, row.lines), approvedRevisionId = supplierText(row.approvedRevisionId, '准确批准合同版本', 150);
    const command: SupplierCommand = { actor, requestKey: supplierText(row.requestKey, '原请求标识', 150), operation: 'record_fulfillment', kind, targetId: id, input: { approvedRevisionId, lines } };
    return transaction(async tx => {
      const started = await beginSupplierCommand(tx, command);
      const targets = [...new Map([{ kind, id }, ...lines.flatMap(line => line.processingContractId ? [{ kind: 'processing' as const, id: line.processingContractId }] : [])].map(target => [`${target.kind}:${target.id}`, target])).values()];
      const before = await Promise.all(targets.map(async target => {
        const contract = await readSupplierContract(tx, target.kind, target.id), latest = await latestSupplierRevision(tx, target.kind, target.id);
        return { ...target, contract, latest, snapshot: latest ? supplierSnapshot(latest.snapshot, target.kind) : null };
      }));
      const extraIds: string[] = [];
      for (const line of lines) if (line.sourceFactId) {
        const fact = await tx.supplierFulfillmentFact.findUnique({ where: { id: line.sourceFactId } });
        if (!fact) return supplierFail('INPUT_SOURCE_MISMATCH', '实际原料来源不存在。', 409);
        extraIds.push(fact.orderLineId);
      }
      const sourceIds = [...new Set([...before.flatMap(target => [...target.contract.lines.flatMap(line => line.orderLineId ? [line.orderLineId] : []), ...(target.snapshot?.lines.map(line => line.orderLineId) ?? [])]), ...extraIds])];
      await authorizeSupplierSources(tx, actor, sourceIds, { mode: 'write', lock: true, businessGates: false });
      await lockSupplierContracts(tx, targets);
      const current = await authorizeSupplierContract(tx, kind, id, actor, { mode: 'write', extraLineIds: sourceIds, businessGates: false });
      // A replay still needs all current sender/receiver source authority. Later
      // commercial revisions do not erase an already committed physical fact.
      const replay = await replaySupplierCommand(tx, command, started.fingerprint); if (replay) return replay;
      const basis = await requireApprovedSupplierBasis(tx, kind, id, current, approvedRevisionId, actor);
      const facts: Fact[] = [], pendingInput = new Map<string, Prisma.Decimal>();
      for (const [sequence, actual] of lines.entries()) {
        const source = exactLine(basis, actual.lineId);
        await validateActualDestination(tx, actual.destination);
        if (actual.kind !== 'processing_input' && actual.unit !== source.unit) return supplierFail('UNIT_MISMATCH', '实际交付/回交单位须与准确批准行一致，不隐式换算。', 409);
        const fact = factData(started.receiptId, sequence, basis, source, actual);
        if (actual.kind === 'purchase_delivery') {
          if (actual.destination.kind === 'supplier') {
            if (!actual.processingContractId || !actual.processingRevisionId || !actual.processingLineId) return supplierFail('PROCESSOR_REQUIRED', '原料直送加工方须明确准确已批加工合同、版本与行。');
            const receiver = await authorizeSupplierContract(tx, 'processing', actual.processingContractId, actor, { mode: 'write', businessGates: false });
            const receiverBasis = await requireApprovedSupplierBasis(tx, 'processing', actual.processingContractId, receiver, actual.processingRevisionId, actor);
            const receiverLine = exactLine(receiverBasis, actual.processingLineId), declared = receiverLine.inputSource;
            if (source.kind !== 'Material' || receiverBasis.snapshot.supplierRelationId !== actual.destination.relationId || receiverLine.orderLineId !== source.orderLineId
              || declared?.kind !== 'purchase_contract' || declared.contractId !== id || declared.lineId !== source.id)
              return supplierFail('PROCESSOR_MISMATCH', '直送对象、准确来源行或加工合同所声明的采购料源不一致。', 409);
            facts.push(fact, factData(started.receiptId, sequence, receiverBasis, receiverLine, { ...actual, kind: 'processing_input' }, {
              sourceFactId: fact.id, purchaseLineId: source.id!, materialCode: source.materialCode ?? null, specSnapshot: fact.specSnapshot,
              fromRelationId: basis.snapshot.supplierRelationId, partySnapshot: supplierJson({ from: basis.snapshot.supplierParty, to: receiverBasis.snapshot.supplierParty, destination: actual.destination }) }));
          } else {
            if (actual.processingContractId || actual.processingLineId || actual.processingRevisionId) return supplierFail('PROCESSOR_MISMATCH', '非直送交付不能附加加工接料结果。');
            if (actual.destination.kind === 'warehouse') {
              const movement = await stockInbound(tx, basis, source, actual, fact.id);
              const materialReceiptId = `MR_${randomUUID()}`;
              await tx.materialReceipt.create({ data: { id: materialReceiptId, receiptNumber: `MR-${materialReceiptId.slice(3)}`, purchaseOrderId: id,
                status: 'Pending', receivedDate: actual.occurredAt, receivedBy: basis.actor.userId, warehouseId: actual.destination.warehouseId!,
                totalReceived: new Prisma.Decimal(actual.quantity), totalAccepted: new Prisma.Decimal(0), totalRejected: new Prisma.Decimal(0),
                notes: `准确供应商实物交接 ${fact.id}；数量登记不代表专业质量合格`, createdAt: BigInt(Date.now()) } });
              fact.materialReceiptId = materialReceiptId; fact.sourceStockMovementId = movement.id;
            }
            facts.push(fact);
          }
        } else if (actual.kind === 'processing_input') {
          if (actual.destination.kind !== 'supplier' || actual.destination.relationId !== basis.snapshot.supplierRelationId)
            return supplierFail('PROCESSOR_MISMATCH', '加工接料实际接收对象须为本准确加工合同供应商。', 409);
          const declared = source.inputSource;
          if (!declared) return supplierFail('INPUT_SOURCE_REQUIRED', '准确加工行尚未明确料源，不能推定。', 409);
          if (declared.kind === 'warehouse') {
            if (actual.inventoryItemId !== declared.inventoryItemId) return supplierFail('INPUT_SOURCE_MISMATCH', '请使用已批加工行所声明的准确库内料源。', 409);
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem" WHERE "id" = ${declared.inventoryItemId} FOR UPDATE`);
            const item = await tx.inventoryItem.findFirst({ where: { id: declared.inventoryItemId, deletedAt: null } });
            const proof = basis.snapshot.sourceProofs.find(proof => proof.orderLineId === source.orderLineId)!;
            if (!item || item.orderId !== proof.orderId || item.ownership !== 'Owned' || item.ownerRelationId != null || item.unit !== actual.unit)
              return supplierFail('INPUT_SOURCE_MISMATCH', '实物料源归属、货权或明确单位已变化。', 409);
            const inventory = createInventoryService(tx as PrismaClient);
            const movement = await inventory.createStockMovement({ itemId: item.id, type: 'Outbound', quantity: 0, unit: actual.unit,
              movementDate: actual.occurredAt, referenceType: 'SupplierFulfillmentFact', referenceId: fact.id, reason: '实际原料交接加工方' }, basis.actor.userId, { tx, exactQuantity: new Prisma.Decimal(actual.quantity) });
            fact.sourceStockMovementId = movement.id; fact.fromKind = 'warehouse'; fact.fromRelationId = null; fact.fromWarehouseId = item.warehouseId;
            fact.materialCode = item.materialCode; fact.specSnapshot = supplierJson({ itemId: item.id, description: item.description, specification: item.specification, batchNumber: item.batchNumber });
          } else if (declared.kind === 'purchase_contract') {
            if (!actual.sourceFactId) return supplierFail('INPUT_SOURCE_REQUIRED', '采购料源加工接料须引用真实交付事实；直送请从采购交付入口原子登记。');
            const physical = await sourceFactQuantity(tx, actual.sourceFactId, actual.quantity, actual.unit, pendingInput);
            if (physical.purchaseLineId !== declared.lineId || physical.orderLineId !== source.orderLineId || physical.toKind !== 'supplier' || physical.toRelationId !== basis.snapshot.supplierRelationId)
              return supplierFail('INPUT_SOURCE_MISMATCH', '采购实物来源、准确条目或接料对象不一致；经仓库须使用实际库内料源。', 409);
            fact.sourceFactId = physical.id; fact.purchaseLineId = physical.purchaseLineId; fact.fromRelationId = physical.fromRelationId;
            fact.materialCode = physical.materialCode; fact.specSnapshot = physical.specSnapshot as Prisma.InputJsonValue;
          } else {
            if (!actual.evidence.length || !actual.description) return supplierFail('HANDOVER_EVIDENCE_REQUIRED', '客户供料须明确实际原料描述与交接证据。');
            fact.fromKind = 'customer'; fact.fromRelationId = declared.relationId; fact.materialCode = actual.materialCode ?? null;
            fact.specSnapshot = supplierJson({ description: actual.description, specification: actual.specification, materialCode: actual.materialCode });
          }
          facts.push(fact);
        } else {
          const anyInput = await tx.supplierFulfillmentFact.findFirst({ where: { outsourcingLineId: source.id!, kind: 'processing_input' } });
          if (!anyInput) return supplierFail('INPUT_FACT_REQUIRED', '请先登记本准确加工行实际接料，不能从计划数量推造回交来源。', 409);
          if (actual.destination.kind === 'warehouse') fact.sourceStockMovementId = (await stockInbound(tx, basis, source, actual, fact.id)).id;
          facts.push(fact);
        }
      }
      const result = supplierResponse({ contractId: id, contractKind: kind, approvedRevisionId, facts, qualityStatus: 'not_assessed', varianceStatus: 'pending' }, command, started.receiptId, id,
        { revisionId: approvedRevisionId, factIds: facts.map(fact => fact.id) });
      // The immutable receipt and all physical rows commit together. Its ID is
      // inserted first solely to satisfy the real FK, never as a partial ACK.
      await persistSupplierCommand(tx, command, started.fingerprint, result);
      for (const fact of facts) await tx.supplierFulfillmentFact.create({ data: fact });
      for (const actual of lines.filter(line => line.kind === 'purchase_delivery')) await tx.purchaseLine.update({ where: { id: actual.lineId }, data: { receivedQuantity: { increment: new Prisma.Decimal(actual.quantity) } } });
      await supplierAudit(tx, basis.actor.userId, 'record_supplier_actual_fulfillment', kind, id, null, { approvedRevisionId, factIds: facts.map(fact => fact.id), facts });
      return result;
    });
  }
  return { get, record };
}
