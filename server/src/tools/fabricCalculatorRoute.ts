/**
 * 面料计算器 API — POST /api/v1/tools/fabric-calculator/calculate（REQ2-22，DR-062）
 *
 * 六类计算 kind 判别单端点（weight-convert / yarn-convert / theoretical-weight /
 * width-usage / roll-length / container-loading）；纯函数零写路径，登录即可用。
 * 设计真源：docs/design/04-模块设计/09-业务工具/BusinessTools-业务工具/面料计算器.md
 */
import { Router, Request, Response } from 'express';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { calculateFabric, FabricCalcValidationError } from './fabricCalculatorService';

export interface FabricCalculatorRouterOptions {
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createFabricCalculatorRouter(options: FabricCalculatorRouterOptions): Router {
  const router = Router();
  const guard = createModuleAuthGuard({ requireAuth: options.requireAuth, apiKeys: options.apiKeys });
  router.use(guard);

  router.post('/calculate', (req: Request, res: Response) => {
    try {
      const { kind, ...input } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof kind !== 'string' || kind.length === 0) {
        res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'body.kind 必填' } });
        return;
      }
      const output = calculateFabric(kind, input);
      res.json({ kind, ...output });
    } catch (err: any) {
      if (err instanceof FabricCalcValidationError || err?.code === 'VALIDATION_FAILED') {
        res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: err.message } });
        return;
      }
      res.status(500).json({ error: { code: 'CALCULATION_FAILED', message: err?.message ?? 'internal error' } });
    }
  });

  return router;
}
