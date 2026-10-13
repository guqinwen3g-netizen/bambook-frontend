import { Router, type Request, type Response, type RequestHandler } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { logger } from '../lib/logger';
import { createSupplierCommitmentService, authorizeSupplierContract } from './supplierCommitmentService';
import { createSupplierFulfillmentService } from './supplierFulfillmentService';
import { setSupplierApprovalAuthority, supplierAuthorityKey } from './supplierCommitmentAuthority';
import { freshSupplierActor, authorizeSupplierSources } from './supplierContractAccess';
import { readSupplierContractDocument, renderSupplierContractHtml } from './supplierContractDocument';
import { registerSupplierContractTradeDocument } from '../customs/supplierContractDocumentArchive';
import { supplierSnapshot } from './supplierContractStore';
import { SupplierContractError, supplierFail, supplierJson, supplierObject, supplierText, type SupplierContractKind } from './supplierContractPolicy';

export function createSupplierContractRouter(options: { prisma: PrismaClient; requireAuth: boolean; apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void }): Router {
  const router = Router(), service = createSupplierCommitmentService(options.prisma), fulfillment = createSupplierFulfillmentService(options.prisma);
  const write = requireJwtForWrite(options), writeScope = requirePermission('procurement:write'), readScope = requirePermission('procurement:read');
  const actorOf = (req: Request) => extractActorFromRequest(req) ?? supplierFail('UNAUTHORIZED', '请使用真实账号登录供应商工作区。', 401);
  const kindOf = (req: Request): SupplierContractKind => req.params.kind === 'purchase' || req.params.kind === 'processing' ? req.params.kind : supplierFail('INVALID_CONTRACT_KIND', '请选择采购或加工合同。');
  const familyOf = (req: Request): 'fabric' | 'garment' => req.params.family === 'fabric' || req.params.family === 'garment' ? req.params.family : supplierFail('INVALID_INPUT', '请选择准确业务域。');
  const run = (work: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { await work(req, res); } catch (error) {
      if (error instanceof SupplierContractError) { res.status(error.statusCode).json({ ok: false, error: error.message, code: error.code }); return; }
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code)) {
        res.status(409).json({ ok: false, error: '本次准确合同已被其他操作更新，请先按原请求标识核对结果。', code: 'CONCURRENT_UPDATE' }); return;
      }
      logger.error('[SupplierContractRoute] command failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ ok: false, error: '本次合同处理结果暂不可确认，请保留原请求标识核对。', code: 'SUPPLIER_COMMAND_UNAVAILABLE' });
    }
  };
  const changed = (kind: SupplierContractKind, id: string, action: string) => options.onDataChange?.({ entity: kind === 'purchase' ? 'PurchaseOrder' : 'OutsourcingOrder', action, ids: [id] });

  router.get('/sources', readScope, run(async (req, res) => {
    const actor = actorOf(req), search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const result = await options.prisma.$transaction(async tx => {
      const current = await freshSupplierActor(tx, actor, 'read'), scope = await freshOrderLineScope(tx, current);
      const orders = await tx.order.findMany({ where: { deletedAt: null, AND: [scope], ...(search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { poNumber: { contains: search, mode: 'insensitive' } }, { customer: { contains: search, mode: 'insensitive' } }] } : {}) },
        select: { id: true, code: true, poNumber: true, customer: true, businessLine: true, type: true, status: true }, orderBy: { createdAt: 'desc' }, take: 100 });
      const lines = await tx.orderLine.findMany({ where: { orderId: { in: orders.map(row => row.id) } }, orderBy: [{ orderId: 'asc' }, { lineNumber: 'asc' }] });
      return lines.map(line => ({ id: line.id, orderId: line.orderId, order: orders.find(order => order.id === line.orderId), lineNumber: line.lineNumber,
        description: line.description, materialCode: line.materialCode, quantity: line.quantity.toString(), unit: line.unit, fulfillmentMode: line.fulfillmentMode,
        cmtIncludedItems: line.cmtIncludedItems }));
    });
    res.json({ ok: true, items: supplierJson(result) });
  }));
  router.get('/approval-authority/:kind/:family', run(async (req, res) => {
    const kind = kindOf(req), family = familyOf(req), actor = actorOf(req);
    const item = await options.prisma.$transaction(async tx => {
      await freshSupplierActor(tx, actor, 'config');
      const key = supplierAuthorityKey(kind, family), row = await tx.systemConfig.findUnique({ where: { id: `global::${key}` } });
      let value: unknown = row?.value; if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
      return { key, version: row?.version ?? 0, userIds: Array.isArray(supplierObject(value).userIds) ? supplierObject(value).userIds : [] };
    });
    res.json({ ok: true, item });
  }));
  router.put('/approval-authority/:kind/:family', write, run(async (req, res) => {
    const row = supplierObject(req.body), result = await setSupplierApprovalAuthority({ prisma: options.prisma, actor: actorOf(req), kind: kindOf(req), family: familyOf(req),
      requestKey: supplierText(row.requestKey, '原请求标识', 150), userIds: row.userIds as string[], expectedConfigVersion: row.expectedConfigVersion as number, reason: supplierText(row.reason, '配置理由', 2000) });
    res.json(result);
  }));
  router.get('/:kind', readScope, run(async (req, res) => res.json({ ok: true, ...await service.list(kindOf(req), actorOf(req), { cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined }) })));
  router.post('/:kind', write, writeScope, run(async (req, res) => {
    const kind = kindOf(req), result = await service.create(kind, req.body, actorOf(req)); changed(kind, result.commandAck.contractId, 'create'); res.status(201).json(result);
  }));
  router.get('/:kind/:id', readScope, run(async (req, res) => res.json({ ok: true, item: await service.get(kindOf(req), req.params.id, actorOf(req)) })));
  router.get('/:kind/:id/fulfillments', readScope, run(async (req, res) => res.json({ ok: true, item: await fulfillment.get(kindOf(req), req.params.id, actorOf(req)) })));
  router.post('/:kind/:id/fulfillments', write, writeScope, run(async (req, res) => {
    const kind = kindOf(req), result = await fulfillment.record(kind, req.params.id, req.body, actorOf(req)); changed(kind, req.params.id, 'fulfillment'); res.json(result);
  }));
  router.get('/:kind/:id/revisions', readScope, run(async (req, res) => {
    const kind = kindOf(req), actor = actorOf(req);
    const items = await options.prisma.$transaction(async tx => {
      await authorizeSupplierContract(tx, kind, req.params.id, actor, { mode: 'read', businessGates: false });
      const rows = await tx.supplierCommitmentRevision.findMany({ where: kind === 'purchase' ? { purchaseOrderId: req.params.id } : { outsourcingOrderId: req.params.id }, orderBy: { revision: 'desc' } });
      const ids = rows.flatMap(row => { const snapshot = supplierSnapshot(row.snapshot, kind); return [...snapshot.lines.map(line => line.orderLineId), ...snapshot.sourceProofs.map(source => source.orderLineId)]; });
      if (ids.length) await authorizeSupplierSources(tx, actor, ids, { mode: 'read', businessGates: false });
      return supplierJson(rows);
    });
    res.json({ ok: true, items });
  }));
  router.get('/:kind/:id/commands/:requestKey', readScope, run(async (req, res) => {
    const kind = kindOf(req), actor = actorOf(req);
    const item = await options.prisma.$transaction(async tx => {
      await authorizeSupplierContract(tx, kind, req.params.id, actor, { mode: 'read', businessGates: false });
      const receipt = await tx.supplierContractCommandReceipt.findUnique({ where: { actorId_requestKey: { actorId: actor.userId, requestKey: req.params.requestKey } } });
      if (!receipt || receipt.contractKind !== kind || receipt.contractId !== req.params.id) return supplierFail('NOT_FOUND', '尚未查到该准确目标的原请求成功回执。', 404);
      const original = supplierObject(receipt.requestSnapshot), frozenIds: string[] = [];
      for (const revisionId of [supplierObject(supplierObject(receipt.resultSnapshot).commandAck).revisionId, original.approvedRevisionId]) if (typeof revisionId === 'string') {
        const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: revisionId } });
        if (revision) frozenIds.push(...supplierSnapshot(revision.snapshot, kind).lines.map(line => line.orderLineId));
      }
      if (frozenIds.length) await authorizeSupplierSources(tx, actor, frozenIds, { mode: 'read', businessGates: false });
      return receipt.resultSnapshot;
    });
    res.json(item);
  }));
  // Preview is for the current approved promise, with the same strong source
  // gate as generation. Archival document downloads stay in the shared center.
  router.get('/:kind/:id/preview.html', readScope, run(async (req, res) => {
    const document = await readSupplierContractDocument({ prisma: options.prisma, actor: actorOf(req), kind: kindOf(req), id: req.params.id,
      ...(typeof req.query.revisionId === 'string' ? { revisionId: req.query.revisionId } : {}), forNewPromise: true });
    res.type('html').send(renderSupplierContractHtml(document));
  }));
  router.post('/:kind/:id/generate-document', write, writeScope, run(async (req, res) => {
    const row = supplierObject(req.body), kind = kindOf(req);
    const result = await registerSupplierContractTradeDocument(options.prisma, { actor: actorOf(req), kind, contractId: req.params.id,
      revisionId: supplierText(row.approvedRevisionId, '准确已批版本', 150), requestKey: supplierText(row.requestKey, '原请求标识', 150) });
    changed(kind, req.params.id, 'generate-document'); res.json(result);
  }));
  const mutations = { draft: service.saveDraft, amendments: service.amend, 'merge-demands': service.merge,
    submit: service.submit, 'record-offline-send': service.recordOfflineSend, 'supplier-feedback': service.recordSupplierFeedback };
  for (const [path, mutate] of Object.entries(mutations)) {
    const method = path === 'draft' ? 'put' : 'post';
    router[method](`/:kind/:id/${path}`, write, writeScope, run(async (req, res) => { const kind = kindOf(req), result = await mutate(kind, req.params.id, req.body, actorOf(req)); changed(kind, req.params.id, path); res.json(result); }));
  }
  return router;
}
