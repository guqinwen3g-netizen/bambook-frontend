/**
 * 自动化规则 API 路由
 *
 * GET    /api/v1/automation/rules        — 列出所有规则及启用状态
 * PATCH  /api/v1/automation/rules/:id     — 更新规则启用状态（body: { enabled: boolean }）
 */

import { Router, Request, Response } from 'express';
import { listAutomationRules, setRuleEnabled } from './automationConfig';
import { actorIdFromRequest, writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { requirePermission } from '../auth/permissionGuard';

export function createAutomationRouter(prisma: any): Router {
  const router = Router();

  // GET /api/v1/automation/rules — 列出所有自动化规则
  router.get('/rules', (_req: Request, res: Response) => {
    try {
      const rules = listAutomationRules();
      res.json({ rules });
    } catch (e: any) {
      logger.error('[AutomationRoute] GET rules failed', { error: e?.message });
      res.status(500).json({ error: 'failed to list automation rules' });
    }
  });

  // PATCH /api/v1/automation/rules/:id — 更新规则启用状态（W7 设置域裁决：owner/admin 守卫）
  router.patch('/rules/:id', requirePermission('settings:automation:write'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }

      const updated = setRuleEnabled(id, enabled);
      if (!updated) {
        return res.status(404).json({ error: `automation rule '${id}' not found` });
      }

      // 审计日志
      const actorId = actorIdFromRequest(req);
      await writeRouteAuditLog({
        prisma,
        actorId,
        source: 'api:automation',
        operation: 'update_automation_rule',
        targetType: 'AutomationRule',
        targetId: id,
        after: { enabled },
        operationType: 'update',
        fieldPath: 'enabled',
        afterValue: enabled,
      }).catch(e => logger.error('[AutomationRoute] audit log failed', { error: e?.message }));

      res.json({ rule: updated });
    } catch (e: any) {
      logger.error('[AutomationRoute] PATCH rule failed', { error: e?.message });
      res.status(500).json({ error: 'failed to update automation rule' });
    }
  });

  return router;
}
