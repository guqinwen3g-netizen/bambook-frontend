/**
 * 阶段 D / D6：实体级审计查询路由（非 admin）
 *
 *   GET /api/v1/audit/entity?targetType=Order&targetId=ORD_1
 *   GET /api/v1/audit/entity/export?targetType=Order&targetId=ORD_1   ← G4.3 变更史导出（CSV）
 *
 * 与 /api/admin/audit-logs（owner/admin 全局查询）的分工：
 *   - 本端点面向业务用户：强制 targetType+targetId（防全表扫描），
 *     按 targetType 映射模块读权限门禁（merchandiser 可读订单审计等），
 *     固定 limit 20 倒序返回。
 *   - admin 全局端点保持不变。
 *
 * 认证：JWT 或 API-Key（复用 createModuleAuthGuard，与 /api/v1/* 一致）；
 * 授权（2026-09-06 简化，Kevin 验收决策：实体审计对模块读权限可见）：
 *   单层 canReadEntityAudit 角色映射 —— 按 targetType 对齐模块读权限（既存 D6 语义）。
 *   2026-09-06 前曾有第一层 requirePermission('audit:read')，把业务用户全挡在实体审计外，
 *   与本端点「面向业务用户」的 D6 意图矛盾；全局审计（/api/admin/audit-logs）仍走 audit:read。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { buildAuditLogQuery, canReadEntityAudit } from './entityQuery';
import { buildEntityAuditCsv } from './entityCsv';

type AuditRouterOptions = {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
};

/** 实体审计固定返回条数（倒序取最近） */
const ENTITY_AUDIT_LIMIT = 20;
/** 导出分页：每页条数（与共享 `buildAuditLogQuery` 的 500 档一致 —— where/分页校验只此一份真源） */
const ENTITY_AUDIT_EXPORT_PAGE = 500;
/** 单次导出硬上限：到顶才写"已截断"那一行（§11 第 6 条要的是"**完整**变更史"） */
const ENTITY_AUDIT_EXPORT_MAX = 5000;

export function createAuditRouter(options: AuditRouterOptions) {
  const router = Router();
  const guard = createModuleAuthGuard({ requireAuth: options.requireAuth, apiKeys: options.apiKeys });

  /**
   * 两个端点共用的前置：强制两参（防全表扫描）+ 模块读权限门禁（fail closed；能读该实体的角色
   * 即可看它的变更历史，含创建人/时间）。失败时自己写响应并返回 null —— **收成一处**，
   * 免得"查询"与"导出"两条路各写一份门禁、日后漂开（导出漏门禁 = 越权下载审计）。
   *
   * 2026-09-06 Kevin 验收决策：不叠加 requirePermission('audit:read') 第一层 —— 它把业务用户
   * 全挡在实体审计外，与本端点「面向业务用户」的 D6 意图矛盾；全局审计搜索
   * （/api/admin/audit-logs）仍保持 audit:read 管理可见，不受影响。
   */
  const entityScope = (req: Request, res: Response, limit: number): { where: any; limit: number } | null => {
    const { targetType, targetId } = req.query as any;

    if (!targetType || typeof targetType !== 'string' || !targetId || typeof targetId !== 'string') {
      res.status(400).json({
        ok: false,
        error: 'TARGET_REQUIRED',
        message: 'targetType and targetId are both required.',
      });
      return null;
    }

    const actorRoles: string[] = (req as any).actor?.roles ?? [];
    if (!canReadEntityAudit(actorRoles, targetType)) {
      res.status(403).json({
        ok: false,
        error: 'FORBIDDEN',
        message: `Insufficient role to read audit history of ${targetType}.`,
      });
      return null;
    }

    const built = buildAuditLogQuery({ targetType, targetId, limit: String(limit) });
    if (!built.ok) {
      res.status(built.status).json({ ok: false, error: built.error, message: built.message });
      return null;
    }
    return { where: built.where, limit: built.limit };
  };

  router.get('/entity', guard, async (req: Request, res: Response) => {
    const scope = entityScope(req, res, ENTITY_AUDIT_LIMIT);
    if (!scope) return;

    const logs = await options.prisma.auditLog.findMany({
      where: scope.where,
      orderBy: { createdAt: 'desc' },
      take: scope.limit,
      include: { actor: { select: { id: true, displayName: true, email: true } } },
    });

    res.json({
      ok: true,
      logs: logs.map(l => ({
        id: l.id,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        operationType: l.operationType,
        fieldPath: l.fieldPath,
        beforeValue: l.beforeValue,
        afterValue: l.afterValue,
        detail: l.detail,
        createdAt: l.createdAt,
        actor: { id: l.actor.id, displayName: l.actor.displayName, email: l.actor.email },
      })),
    });
  });

  /**
   * G4.3：变更史导出（CSV）。与 `/entity` 同门禁、同 where 构造，只有两处不同：
   *   · 不取面板那 20 条，而是按 `ENTITY_AUDIT_EXPORT_PAGE`（500）**分页取到取满**，
   *     累计到硬上限 `ENTITY_AUDIT_EXPORT_MAX`（5000）才停 —— 到顶时 CSV 末尾**显式**加一行说明，
   *     不静默少给（v3.107 前是"只给一页 + 说明"，那对超 500 条的单据永远取不到更早的行）；
   *   · 响应是 `text/csv` 附件（文件名走 RFC 5987 `filename*`，中文名不乱码），不是 JSON。
   * 本端点**只读**：不写审计、不改任何行（导出行为本身是否要留痕属新口径，未自裁 —— 见 §12.05 D110）。
   */
  router.get('/entity/export', guard, async (req: Request, res: Response) => {
    const scope = entityScope(req, res, ENTITY_AUDIT_EXPORT_PAGE);
    if (!scope) return;

    const { targetType, targetId } = req.query as { targetType: string; targetId: string };

    // ★ v3.107（复核 #26）：改成**分页取满**，而不是"只取一页 + 说明被截断"。
    //   §11 第 6 条要的是"**完整**变更史"，一页 500 条今天就有单据撞上（走查库那单 FAB-UI-ONLY 就是）。
    //   只有到硬上限（5000）才写截断说明 ⇒ "完整"与"不许静默少给"两条同时成立。
    const rows: any[] = [];
    let truncated = false;
    for (let offset = 0; ; offset += ENTITY_AUDIT_EXPORT_PAGE) {
      const page = await options.prisma.auditLog.findMany({
        where: scope.where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: ENTITY_AUDIT_EXPORT_PAGE,
        include: { actor: { select: { id: true, displayName: true, email: true } } },
      });
      rows.push(...page);
      if (page.length < ENTITY_AUDIT_EXPORT_PAGE) break;            // 取完了
      if (rows.length > ENTITY_AUDIT_EXPORT_MAX) { truncated = true; break; }  // 到顶（多取一页只为判"还有")
    }
    if (rows.length > ENTITY_AUDIT_EXPORT_MAX) {
      rows.length = ENTITY_AUDIT_EXPORT_MAX;
      truncated = true;
    }
    const csv = buildEntityAuditCsv(rows, { truncated, maxRows: ENTITY_AUDIT_EXPORT_MAX });

    // 文件名：ASCII 兜底 + `filename*` 中文（两者都要 —— 老浏览器只认前者）
    const safe = (s: string) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    const cn = `变更史-${safe(targetType)}-${safe(targetId)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${cn.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(cn)}`,
    );
    res.send(csv);
  });

  return router;
}
