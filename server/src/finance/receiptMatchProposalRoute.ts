import { Router, type Request, type Response } from 'express';
import type { TokenPayload } from '../auth/service';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import type { FinanceRouterOptions } from './route';
import { createReceiptMatchProposalService, RECEIPT_MATCH_SUGGEST_SCOPE, type ProposalDecision } from './receiptMatchProposalService';

/** Mount: /api/v1/finance/receipt-match-proposals. No generic approval labels. */
export function createReceiptMatchProposalRouter(options: FinanceRouterOptions): Router {
  const router = Router();
  const service = createReceiptMatchProposalService(options.prisma);
  router.use(createModuleAuthGuard(options));
  const write = requireJwtForWrite(options);
  const actor = (req: Request) => (req as Request & { actor: TokenPayload }).actor;
  const respondError = (res: Response, error: unknown) => {
    logger.error('[receipt-match-proposal] operation failed', { error: (error as Error).message });
    const safe = safeRouteError(error, { fallbackCode: 'RECEIPT_PROPOSAL_FAILED', fallbackMessage: '处理结果暂不可确认，请使用原请求重试并核对建议状态。' });
    return res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  };
  const bodyAllowed = (req: Request, res: Response, keys: string[]) => {
    if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).some(key => !keys.includes(key))) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: '请求包含无效字段，请核对原建议内容' } }); return false;
    }
    return true;
  };
  router.get('/', requirePermission('invoices:read'), async (req, res) => {
    try { res.json(await service.list(actor(req), Number(req.query.limit) || undefined)); }
    catch (error) { respondError(res, error); }
  });
  router.post('/', write, requirePermission(RECEIPT_MATCH_SUGGEST_SCOPE), async (req, res) => {
    if (!bodyAllowed(req, res, ['voucherId', 'invoiceId', 'amount', 'currency', 'note', 'requestId'])) return;
    try {
      const result = await service.submit(actor(req), req.body, req.ip);
      if (!result.replayed) options.onDataChange?.({ entity: 'finance.receipt-match-proposals', action: 'create', ids: [result.item.id] });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { respondError(res, error); }
  });
  const registerDecision = (path: string, status: ProposalDecision, permission: 'invoices:reconcile' | typeof RECEIPT_MATCH_SUGGEST_SCOPE) => {
    router.post(path, write, requirePermission(permission), async (req, res) => {
      if (!bodyAllowed(req, res, ['revision', 'requestId', 'note'])) return;
      try {
        const result = await service.decide(actor(req), req.params.id, status, req.body, req.ip);
        if (!result.replayed) {
          options.onDataChange?.({ entity: 'finance.receipt-match-proposals', action: 'update', ids: [result.item.id] });
          if (result.item.allocationId) options.onDataChange?.({ entity: 'finance.allocations', action: 'create', ids: [result.item.allocationId] });
        }
        res.json(result);
      } catch (error) { respondError(res, error); }
    });
  };
  registerDecision('/:id/confirm', 'Confirmed', 'invoices:reconcile');
  registerDecision('/:id/reject', 'Rejected', 'invoices:reconcile');
  registerDecision('/:id/withdraw', 'Withdrawn', RECEIPT_MATCH_SUGGEST_SCOPE);
  return router;
}
