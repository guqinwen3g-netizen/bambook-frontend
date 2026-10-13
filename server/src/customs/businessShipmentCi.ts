
/** Business CI producer. Financial Invoice is never a content source. */
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { currentDocumentActor, documentSourceFingerprint, documentSourceJson, lockShipmentDocumentSourcesInTx,
  shipmentDocumentSourceInTx, type ShipmentDocumentSource } from '../shipping/shipmentDocumentSource';
import { generateTradeDocumentNumber } from './tradeDocumentLifecycleService';
import { isLcInstrument } from './lcGate';
import { currentExporterProfileSnapshot } from '../templates/docTemplates/financeInvoice';
import { todayLocalKey } from '../shared/localDate';
import { normalizeFabricSupplyTerms } from '../orders/fabricCommissionPolicy';


const refuse = (message: string): never => { throw businessError('CONFLICT', message); };
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface BusinessCiSelection { lineIds: string[] }
export interface BusinessCiCommand extends BusinessCiSelection { requestKey: string; expectedSourceFingerprint: string }
export function validateBusinessCiSelection(input: any, command = false): BusinessCiCommand {
  const allowed = command ? ['lineIds', 'requestKey', 'expectedSourceFingerprint'] : ['lineIds'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))
    || !Array.isArray(input.lineIds) || !input.lineIds.length || input.lineIds.some((id: any) => !text(id) || id !== id.trim())
    || new Set(input.lineIds).size !== input.lineIds.length) throw businessError('INVALID_INPUT', '请选择准确装运行，不得提交金额、身份或其他来源字段。');
  if (command && (!text(input.requestKey) || input.requestKey.length > 128 || !/^[a-f0-9]{64}$/.test(input.expectedSourceFingerprint)))
    throw businessError('INVALID_INPUT', '需要原请求编号和当前来源指纹。');
  return { lineIds: [...input.lineIds].sort(), requestKey: input.requestKey, expectedSourceFingerprint: input.expectedSourceFingerprint };
}

/** Only existing confirmed order facts are accepted; absent identities never guessed. */
export function buildBusinessShipmentCiSnapshot(source: ShipmentDocumentSource, selection: BusinessCiSelection, credits: any[]) {
  if (source.kind === 'claim' || !source.cartonCoverageComplete) refuse('本票须有完整实际装箱来源；售后补发不能借普通销售 CI。');
  const lines = selection.lineIds.map(id => source.lines.find(line => line.id === id));
  if (lines.some(line => !line?.orderLineId || !line.orderId || !line.originalOrderLine || line.quantity == null || line.unitPrice == null || !line.unit)) refuse('所选装运行缺少准确订单行、实装数量、单位或确认单价。');
  const orderIds = [...new Set<string>(lines.map(line => line.orderId))].sort();
  const orders = orderIds.map(id => source.orders.find(order => order.id === id));
  if (orders.some(order => !order || !['Confirmed', 'Production', 'Shipping', 'Delivered'].includes(order.status))) refuse('CI 只接受当前已确认的来源订单。');
  const first = orders[0], contract = text(first.finalContractNumber) || text(first.salesContractNumber);
  if (!contract || !text(first.currency) || !first.customerRelationId || !text(first.billToName) || !text(first.shipToName)
    || !text(first.paymentInstrument) || !text(first.paymentTerms) || !text(first.deliveryTerms)) refuse('原订单缺少合同、币种、客户、交易双方或付款/贸易条款，不能猜测 CI 内容。');
  const lc = (order: any) => {
    if (!isLcInstrument(order.paymentInstrument)) return null;
    const found = credits.filter(row => row.orderId === order.id && !['Cancelled', 'Expired'].includes(row.status));
    if (found.length !== 1 || !text(found[0].lcNumber) || !['Issued', 'Presented', 'Accepted', 'Discrepant'].includes(found[0].status)) refuse('信用证来源不唯一、缺失或状态不可证，不能确定商业单据包。');
    return found[0];
  };
  const firstLc = lc(first);
  for (const order of orders) {
    const currentLc = lc(order);
    if ((text(order.finalContractNumber) || text(order.salesContractNumber)) !== contract || order.currency !== first.currency
      || order.customerRelationId !== first.customerRelationId || order.billToName !== first.billToName || order.billToRelationId !== first.billToRelationId
      || order.billToAddress !== first.billToAddress || order.shipToName !== first.shipToName || order.shipToAddress1 !== first.shipToAddress1
      || order.shipToAddress2 !== first.shipToAddress2 || order.shipToCountry !== first.shipToCountry || order.businessLine !== first.businessLine
      || order.paymentTerms !== first.paymentTerms || order.deliveryTerms !== first.deliveryTerms || order.paymentInstrument !== first.paymentInstrument
      || currentLc?.lcNumber !== firstLc?.lcNumber) refuse('所选行不属于同一客户、收货方、品类及合同/信用证包，请分别制单。');
  }
  const rows = lines.map(line => {
    const quantity = new Prisma.Decimal(line.quantity), price = new Prisma.Decimal(line.unitPrice);
    if (!quantity.isFinite() || !price.isFinite() || quantity.lte(0) || price.lt(0)) refuse('实际数量或原订单单价无效。');
    const allocation = source.allocations.filter(row => row.orderLineId === line.orderLineId && row.status !== 'Cancelled');
    if (!allocation.length || allocation.some(row => row.actualQty == null)) refuse('本票实际装运分配尚未确认，不能按预计数量制作 CI。');
    const actual = allocation.reduce((sum, row) => sum.plus(row.actualQty), new Prisma.Decimal(0));
    const shipped = source.lines.filter(row => row.orderLineId === line.orderLineId).reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    if (!actual.equals(shipped)) refuse('本票装运行与实际分配未完整一致。');
    return { shipmentLineId: line.id, itemNo: line.originalOrderLine.itemNo ?? null, orderId: line.orderId, orderLineId: line.orderLineId, productionBatchIds: line.productionBatchIds,
      description: line.originalOrderLine.description, materialCode: line.originalOrderLine.materialCode, specification: line.originalOrderLine.specSnapshot,
      ...normalizeFabricSupplyTerms(line.originalOrderLine),
      quantity: quantity.toString(), unit: line.unit, unitPrice: price.toString(), amount: quantity.mul(price).toDecimalPlaces(4).toString() };
  });
  const packageLines = source.lines.filter(line => {
    const order = source.orders.find(row => row.id === line.orderId);
    return order && (text(order.finalContractNumber) || text(order.salesContractNumber)) === contract && lc(order)?.lcNumber === firstLc?.lcNumber;
  });
  const responsibility = (line: typeof lines[number]) => normalizeFabricSupplyTerms(line.originalOrderLine).fabricSupplyMode === 'commission' ? 'commission' : 'goods';
  const kinds = new Set(packageLines.map(responsibility));
  // Actual LC requirements retain the complete contract/LC package. We have
  // no authority to infer that an LC permits splitting its commercial CI.
  const split = kinds.size > 1 && !firstLc;
  if (split && new Set(lines.map(responsibility)).size !== 1) refuse('本票有不同货款责任，请分别选择完整普通货款或佣金贸易子包；不能混成我方货款应收。');
  const required = split ? packageLines.filter(line => responsibility(line) === responsibility(lines[0])) : packageLines;
  if (required.length !== lines.length || required.some(line => !selection.lineIds.includes(line.id))) refuse('请选择本票该合同/信用证及商业责任包的全部装运行，不能重复或遗漏包内行。');
  const packageKey = digest(split ? [contract, null, responsibility(lines[0])] : [contract, firstLc?.lcNumber ?? null]);
  return documentSourceJson({ protocolVersion: 1, sourceKind: 'shipment', shipmentId: source.shipment.id, packageKey,
    sourceFingerprint: documentSourceFingerprint({ source, selection: { lineIds: [...selection.lineIds].sort() }, credits }), orderIds, lines: rows,
    totalAmount: rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)).toString(), currency: first.currency,
    customerRelationId: first.customerRelationId, contractNumber: contract, letterOfCredit: firstLc,
    parties: { billTo: { name: first.billToName, relationId: first.billToRelationId, address: first.billToAddress },
      shipTo: { name: first.shipToName, address1: first.shipToAddress1, address2: first.shipToAddress2, country: first.shipToCountry } },
    paymentInstrument: first.paymentInstrument, paymentTerms: first.paymentTerms, deliveryTerms: first.deliveryTerms,
    confirmedOrderSnapshot: orders });
}

async function sourceInTx(tx: any, shipmentId: string, selection: BusinessCiSelection, actor: TokenPayload, lock = false) {
  const options = { trustedActor: actor, extraScopes: ['customs:write' as const] };
  const source = lock ? (await lockShipmentDocumentSourcesInTx(tx, [shipmentId], options))[0]
    : await shipmentDocumentSourceInTx(tx, shipmentId, options);
  const orderIds = source.orderIds;
  const credits = await tx.letterOfCredit.findMany({ where: { orderId: { in: orderIds } }, orderBy: { id: 'asc' } });
  if (lock && credits.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "LetterOfCredit" WHERE "id" IN (${Prisma.join(credits.map((row: any) => row.id))}) ORDER BY "id" FOR UPDATE`);
  const currentCredits = lock ? await tx.letterOfCredit.findMany({ where: { orderId: { in: orderIds } }, orderBy: { id: 'asc' } }) : credits;
  return buildBusinessShipmentCiSnapshot(source, selection, currentCredits);
}
export async function readBusinessShipmentCiSource(db: PrismaClient, shipmentId: string, input: unknown, actor: TokenPayload) {
  const selection = validateBusinessCiSelection(input);
  return db.$transaction(tx => sourceInTx(tx, shipmentId, selection, actor));
}
export async function writeBusinessShipmentCi(db: PrismaClient, shipmentId: string, input: unknown, actor: TokenPayload,
  operation: 'draft' | 'revise' | 'issue', documentId?: string) {
  const command = validateBusinessCiSelection(input, true);
  return db.$transaction(async (tx: any) => {
    const fresh = await currentDocumentActor(tx, actor, ['customs:write', 'shipments:read', 'orders:read']);
    const snapshot = await sourceInTx(tx, shipmentId, command, fresh, true);
    const requestHash = digest([shipmentId, operation, documentId ?? null, command]);
    const auditId = 'BCI_REQUEST_' + digest([fresh.userId, operation, command.requestKey]);
    const prior = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (prior) {
      if (prior.detail?.requestHash !== requestHash) refuse('原请求编号已用于其他 CI 内容。');
      const item = await tx.tradeDocument.findUnique({ where: { id: prior.targetId } });
      if (!item || item.deletedAt != null || item.shipmentId !== shipmentId || item.sourceInvoiceId != null || !item.sourceRef?.startsWith('business-ci:v1:shipment:')) refuse('原请求单据已失效，不能补造。');
      return { item: documentSourceJson(item), versionId: prior.detail.versionId, replayed: true };
    }
    if (snapshot.sourceFingerprint !== command.expectedSourceFingerprint) refuse('原订单、信用证或实际装运资料已变化，请重新核对。');
    const sourceRef = `business-ci:v1:shipment:${shipmentId}:${snapshot.packageKey}`;
    const ts = BigInt(Date.now());
    let item: any, version: any;
    if (operation === 'draft') {
      const active = await tx.tradeDocument.findFirst({ where: { sourceRef, deletedAt: null, status: { not: 'Cancelled' } } });
      if (active) refuse('该实际出运包已有 CI，请回原单据处理。');
      const number = await generateTradeDocumentNumber(tx, 'CommercialInvoice');
      const draftSnapshot = { ...snapshot, exporterSnapshot: await currentExporterProfileSnapshot(tx as PrismaClient) };
      item = await tx.tradeDocument.create({ data: { id: 'TD_BCI_' + digest(auditId).slice(0, 32), type: 'CommercialInvoice', domain: 'customs', status: 'Draft',
        documentNumber: number, sourceRef, sourceInvoiceId: null, shipmentId, relationId: snapshot.customerRelationId,
        totalAmount: new Prisma.Decimal(snapshot.totalAmount), currency: snapshot.currency, createdAt: ts, updatedAt: ts } });
      version = await tx.documentVersion.create({ data: { id: 'DV_' + digest(auditId), documentId: item.id, version: 1,
        content: { commercialInvoiceSnapshot: draftSnapshot }, changedBy: fresh.userId, changeReason: '从实际出运创建业务 CI', createdAt: ts } });
    } else {
      if (!documentId) refuse('请选择准确业务 CI。');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${documentId} FOR UPDATE`);
      item = await tx.tradeDocument.findUnique({ where: { id: documentId } });
      if (!item || item.deletedAt != null || item.status !== 'Draft' || item.type !== 'CommercialInvoice' || item.domain !== 'customs'
        || item.sourceInvoiceId != null || item.sourceRef !== sourceRef || item.shipmentId !== shipmentId) refuse('仅当前准确的新业务 CI 草稿可签发。');
      version = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { version: 'desc' } });
      const saved = version?.content?.commercialInvoiceSnapshot;
      if (!saved || saved.protocolVersion !== 1 || saved.shipmentId !== shipmentId || saved.issuedAt) refuse('仅未签发的业务 CI 草稿可修改或签发。');
      const withoutDraftOnly = (value: any) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== 'exporterSnapshot'));
      if (operation === 'issue' && documentSourceFingerprint(withoutDraftOnly(saved)) !== documentSourceFingerprint(snapshot))
        refuse('草稿来源或内容已变化，不能签发旧版本；请先刷新并修订草稿。');
      if (operation === 'revise') {
        const revisedSnapshot = { ...snapshot, exporterSnapshot: await currentExporterProfileSnapshot(tx as PrismaClient) };
        version = await tx.documentVersion.create({ data: { id: 'DV_' + digest(auditId), documentId: item.id, version: version.version + 1,
          content: { commercialInvoiceSnapshot: revisedSnapshot }, changedBy: fresh.userId, changeReason: '按最新出运资料修订业务 CI 草稿', createdAt: ts } });
        item = await tx.tradeDocument.update({ where: { id: item.id }, data: { relationId: snapshot.customerRelationId,
          totalAmount: new Prisma.Decimal(snapshot.totalAmount), currency: snapshot.currency, updatedAt: ts } });
      } else {
      const duplicates = await tx.tradeDocument.count({ where: { documentNumber: item.documentNumber, id: { not: item.id } } });
      // Invoice is consulted solely for numbering collision, never contents.
      const financialNumber = await tx.invoice.findFirst({ where: { invoiceNumber: item.documentNumber }, select: { id: true } });
      if (duplicates || financialNumber) refuse('CI 号码已被其他单据或财务票占用。');
      const issueDate = todayLocalKey();
      version = await tx.documentVersion.create({ data: { id: 'DV_' + digest(auditId), documentId: item.id, version: version.version + 1,
        content: { commercialInvoiceSnapshot: { ...snapshot, exporterSnapshot: saved.exporterSnapshot,
          issueDate, issuedAt: ts.toString(), issuedBy: fresh.userId } },
        changedBy: fresh.userId, changeReason: '签发业务 CI 并冻结来源内容', createdAt: ts } });
      item = await tx.tradeDocument.update({ where: { id: item.id }, data: { status: 'Issued', issueDate, issuedBy: fresh.userId, updatedAt: ts } });
      }
    }
    await tx.auditLog.create({ data: { id: auditId, actorId: fresh.userId, action: `BUSINESS_CI_${operation.toUpperCase()}`, targetType: 'TradeDocument', targetId: item.id,
      detail: { requestHash, requestKey: command.requestKey, versionId: version.id, sourceFingerprint: snapshot.sourceFingerprint }, createdAt: new Date(Number(ts)) } });
    const after = await sourceInTx(tx, shipmentId, command, actor);
    if (after.sourceFingerprint !== snapshot.sourceFingerprint) refuse('写入期间来源变化，本次改动未确认。');
    return { item: documentSourceJson(item), versionId: version.id, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
