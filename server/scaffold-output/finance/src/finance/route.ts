/**
 * 财务管理 API — /api/v1/finance
 *
 * 由 scaffold-module.ts 生成于 2026-06-15T00:39:31.882Z.
 * 生成器只搭骨架，业务校验/字段白名单/审计需要人工补全。
 *
 * 契约钩子（来自 docs/MODULE_CONTRACT.md）：
 *   - L2.2 输入校验：在每个 mutation 入口加 zod / 手写白名单
 *   - L3.1 EntityLink 同步：mutation 必须调用 syncFinanceReferences
 *   - L4 审批：高风险 mutation 默认走 manifest.safety.approval=required
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
// TODO[L3]: import { syncFinanceReferences } from '../entities/sync';

export interface FinanceRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

type FinanceCreateInput = {
  // TODO[L1]: 根据 prisma.Invoice 字段补齐
  voucherNo: string;
  type: string;
  amount: number;
  currency: string;
};

export function createFinanceRouter(options: FinanceRouterOptions): Router {
  const { prisma, onDataChange } = options;
  const router = Router();

  // GET /api/v1/finance — list / search
  router.get('/', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const items = await prisma.invoice.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      });
      res.json({ items, total: items.length });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
    }
  });

  // GET /api/v1/finance/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const item = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '发票/收付款凭证不存在' } });
      res.json(item);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'GET_FAILED', message: err.message } });
    }
  });

  // POST /api/v1/finance — create (high risk, approval upstream)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const input = req.body as FinanceCreateInput;
      // TODO[L2.2]: 字段白名单 + 必填校验
      const created = await prisma.invoice.create({ data: input as any });
      // TODO[L3.1]: await syncFinanceReferences(prisma, created.id, { source: 'route:create' });
      onDataChange?.({ entity: 'finance', action: 'create', ids: [created.id] });
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'CREATE_FAILED', message: err.message } });
    }
  });

  // PATCH /api/v1/finance/:id
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const updated = await prisma.invoice.update({ where: { id: req.params.id }, data: req.body });
      // TODO[L3.1]: await syncFinanceReferences(prisma, updated.id, { source: 'route:update' });
      onDataChange?.({ entity: 'finance', action: 'update', ids: [updated.id] });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'UPDATE_FAILED', message: err.message } });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 收付款凭证（PaymentVoucher） — /api/v1/finance/vouchers
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/vouchers — list / search
  router.get('/vouchers', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const items = await (prisma as any).paymentVoucher.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      });
      res.json({ items, total: items.length });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
    }
  });

  // GET /api/v1/finance/vouchers/:id
  router.get('/vouchers/:id', async (req: Request, res: Response) => {
    try {
      const item = await (prisma as any).paymentVoucher.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '收付款凭证不存在' } });
      res.json(item);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'GET_FAILED', message: err.message } });
    }
  });

  // POST /api/v1/finance/vouchers — create (high risk, approval upstream)
  router.post('/vouchers', async (req: Request, res: Response) => {
    try {
      // TODO[L2.2]: 字段白名单 + 必填校验
      const created = await (prisma as any).paymentVoucher.create({ data: req.body });
      // TODO[L3.1]: await syncVoucherReferences(prisma, created.id, { source: 'route:create' });
      onDataChange?.({ entity: 'finance.vouchers', action: 'create', ids: [created.id] });
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'CREATE_FAILED', message: err.message } });
    }
  });

  // PATCH /api/v1/finance/vouchers/:id
  router.patch('/vouchers/:id', async (req: Request, res: Response) => {
    try {
      const updated = await (prisma as any).paymentVoucher.update({ where: { id: req.params.id }, data: req.body });
      // TODO[L3.1]: await syncVoucherReferences(prisma, updated.id, { source: 'route:update' });
      onDataChange?.({ entity: 'finance.vouchers', action: 'update', ids: [updated.id] });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'UPDATE_FAILED', message: err.message } });
    }
  });

  return router;
}
