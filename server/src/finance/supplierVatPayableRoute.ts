import { Router, type Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { safeRouteError } from '../shared/routeError';
import { ciJson } from '../development/developmentCiSource';
import { getSupplierVatPayable, listSupplierVatPayableSources, previewSupplierVatPayable, registerSupplierVatPayable } from './supplierVatPayableService';

/** Mount at /supplier-vat-payables after the normal finance authentication
 * guard. Every operation additionally reloads actual grants and token ceiling. */
export function createSupplierVatPayableRouter({ prisma }: { prisma: PrismaClient }) {
  const router = Router();
  const reply = (run: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: import('express').Response) => {
    try {
      const value = await run(req);
      res.status(value && typeof value === 'object' && 'replayed' in value && value.replayed ? 200 : status).json(ciJson({ ok: true, ...value as object }));
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '应付登记结果暂不可确认，请保留原请求核对原票与原账。' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  };
  router.get('/:vatInvoiceId/sources', reply(req => listSupplierVatPayableSources(prisma, extractActorFromRequest(req), req.params.vatInvoiceId, req.query)));
  router.get('/:vatInvoiceId', reply(req => getSupplierVatPayable(prisma, extractActorFromRequest(req), req.params.vatInvoiceId)));
  router.post('/:vatInvoiceId/preview', reply(req => previewSupplierVatPayable(prisma, extractActorFromRequest(req), req.params.vatInvoiceId, req.body)));
  router.post('/:vatInvoiceId/register', reply(req => registerSupplierVatPayable(prisma, extractActorFromRequest(req), req.params.vatInvoiceId, req.body), 201));
  return router;
}
