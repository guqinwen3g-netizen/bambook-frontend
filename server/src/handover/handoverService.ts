/**
 * handoverService.ts — REQ2-13 业务员离职一键交接（DR-056）
 *
 * 设计真源：docs/design/04-模块设计/02-客户与开拓/业务员离职一键交接.md
 *
 * DR-056 四决策：
 *   ① 移交面 = 五类归属字段 + 无锚订单兜底；有锚订单/邮件/报价经 T-38 客户锚自动继承（不改字段）
 *   ② 预览→执行两段式；单事务原子执行 + HandoverRecord append-only 留痕
 *   ③ 可选同事务停用账号；停用即时失效由 accountStatusGuard 组合根守卫承接（事务提交后失效缓存）
 *   ④ 防批量导出在 relations export.csv 受控通道（data:export:full），本服务不含
 */
import { PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { invalidateAccountStatusCache } from '../auth/accountStatusGuard';
import { logger } from '../lib/logger';

export type HandoverResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): HandoverResult<never> =>
  ({ ok: false, error: { code, message, status } });

function generateHandoverId(): string {
  return `HO__${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** 五类资产计数（预览与执行共用同一统计口径） */
async function countAssets(db: any, fromUserId: string) {
  const [relationsOwned, relationsCoFollowed, opportunities, followUpRecords, unanchoredOrders] = await Promise.all([
    db.relation.count({ where: { ownerId: fromUserId } }),
    db.relation.count({ where: { salesRepIds: { has: fromUserId }, NOT: { ownerId: fromUserId } } }),
    db.opportunity.count({ where: { salesRepId: fromUserId } }),
    db.followUpRecord.count({ where: { salesRepId: fromUserId } }),
    db.order.count({ where: { ownerId: fromUserId, customerRelationId: null } }),
  ]);
  return { relationsOwned, relationsCoFollowed, opportunities, followUpRecords, unanchoredOrders };
}

export function createHandoverService(prisma: PrismaClient) {
  const db = prisma as any;

  /**
   * 预览（只读零写路径）：离职者资产计数 + 警示。
   * toUserId 可选——给则追加接收人侧校验警示，供 UI 选人后即时反馈。
   */
  async function preview(input: { fromUserId?: string; toUserId?: string }): Promise<HandoverResult<any>> {
    try {
      const fromUserId = String(input.fromUserId ?? '').trim();
      if (!fromUserId) return fail('VALIDATION_FAILED', 'fromUserId 必填');
      const toUserId = String(input.toUserId ?? '').trim() || undefined;

      const from = await db.userAccount.findUnique({
        where: { id: fromUserId },
        select: { id: true, displayName: true, email: true, status: true, deletedAt: true },
      });
      if (!from) return fail('NOT_FOUND', `离职者 ${fromUserId} 不存在`, 404);

      const counts = await countAssets(db, fromUserId);
      const warnings: string[] = [];
      if (from.status === 'disabled') warnings.push('离职者账号已停用（支持补办资产交接）');
      if (from.deletedAt != null) warnings.push('离职者账号已软删（支持补办资产交接）');

      const headedDepts = await db.department.findMany({ where: { headId: fromUserId }, select: { name: true } });
      if (headedDepts.length > 0) {
        warnings.push(`离职者任部门主管（${headedDepts.map((d: any) => d.name).join('、')}）：交接不改写组织架构，需人工调整主管`);
      }

      if (toUserId) {
        if (toUserId === fromUserId) {
          warnings.push('接收人不能是离职者本人');
        } else {
          const to = await db.userAccount.findUnique({
            where: { id: toUserId },
            select: { id: true, displayName: true, status: true, deletedAt: true },
          });
          if (!to) warnings.push('接收人不存在');
          else if (to.status !== 'active' || to.deletedAt != null) warnings.push('接收人账号非 active 状态，无法接收交接');
        }
      }

      return { ok: true, data: { fromUser: from, counts, warnings } };
    } catch (e: any) {
      logger.error('[handover] preview failed', { error: e?.message });
      return fail('INTERNAL_ERROR', e?.message || '预览失败', 500);
    }
  }

  /**
   * 执行交接：单事务原子完成五类移交 + 可选停用 + 交接单 + 双审计。
   * 任何一步失败整体回滚——不允许半移交状态。
   */
  async function execute(
    input: { fromUserId?: string; toUserId?: string; disableAccount?: boolean; note?: string },
    actorId: string,
    ip?: string | null,
  ): Promise<HandoverResult<any>> {
    try {
      const fromUserId = String(input.fromUserId ?? '').trim();
      const toUserId = String(input.toUserId ?? '').trim();
      if (!fromUserId || !toUserId) return fail('VALIDATION_FAILED', 'fromUserId 与 toUserId 必填');
      if (fromUserId === toUserId) return fail('SAME_USER', '接收人不能是离职者本人');
      const note = input.note != null ? String(input.note).slice(0, 500) : null;
      const disableAccount = input.disableAccount !== false; // 默认停用

      const from = await db.userAccount.findUnique({ where: { id: fromUserId } });
      if (!from) return fail('NOT_FOUND', `离职者 ${fromUserId} 不存在`, 404);
      const to = await db.userAccount.findUnique({ where: { id: toUserId } });
      if (!to) return fail('NOT_FOUND', `接收人 ${toUserId} 不存在`, 404);
      if (to.status !== 'active' || to.deletedAt != null) {
        return fail('INACTIVE_SUCCESSOR', '接收人账号非 active 状态，无法接收交接');
      }

      const handoverId = generateHandoverId();
      const counts = await countAssets(db, fromUserId);

      const result = await prisma.$transaction(async (tx: any) => {
        // ── ① 档主移交：ownerId → 接收人；salesRepIds 剔除离职者、补入接收人 ──
        const ownedRelations = await tx.relation.findMany({
          where: { ownerId: fromUserId },
          select: { id: true, salesRepIds: true },
        });
        for (const rel of ownedRelations) {
          const reps = new Set<string>(rel.salesRepIds || []);
          reps.delete(fromUserId);
          reps.add(toUserId);
          await tx.relation.update({
            where: { id: rel.id },
            data: { ownerId: toUserId, salesRepIds: [...reps] },
          });
        }

        // ── ② 协同跟进移交：档主不变，salesRepIds 剔除离职者、补入接收人 ──
        // （① 后原档主客户已不含离职者，此处自然只剩「他人档主 + 离职者协同」）
        const coFollowedRelations = await tx.relation.findMany({
          where: { salesRepIds: { has: fromUserId }, NOT: { ownerId: fromUserId } },
          select: { id: true, salesRepIds: true },
        });
        for (const rel of coFollowedRelations) {
          const reps = new Set<string>(rel.salesRepIds || []);
          reps.delete(fromUserId);
          reps.add(toUserId);
          await tx.relation.update({
            where: { id: rel.id },
            data: { salesRepIds: [...reps] },
          });
        }

        // ── ③ 商机管线移交（含冗余姓名快照同步） ──
        const opportunities = await tx.opportunity.updateMany({
          where: { salesRepId: fromUserId },
          data: { salesRepId: toUserId, salesRepName: to.displayName },
        });

        // ── ④ 跟进记录移交（内容不变，责任人口径移交；原始归属经交接单留痕可溯） ──
        const followUpRecords = await tx.followUpRecord.updateMany({
          where: { salesRepId: fromUserId },
          data: { salesRepId: toUserId, salesRepName: to.displayName },
        });

        // ── ⑤ 无锚遗留订单兜底：有客户锚订单经 T-38 自动继承，不动 ──
        const unanchoredOrders = await tx.order.updateMany({
          where: { ownerId: fromUserId, customerRelationId: null },
          data: { ownerId: toUserId },
        });

        const executedCounts = {
          relationsOwned: ownedRelations.length,
          relationsCoFollowed: coFollowedRelations.length,
          opportunities: opportunities.count,
          followUpRecords: followUpRecords.count,
          unanchoredOrders: unanchoredOrders.count,
        };

        // ── ⑥ 可选停用（与既有 admin disable-account 同语义不双轨；metadata 联链交接单） ──
        let disabledNow = false;
        if (disableAccount && from.status !== 'disabled') {
          await tx.userAccount.update({
            where: { id: fromUserId },
            data: {
              status: 'disabled',
              metadata: {
                ...((from.metadata as any) || {}),
                disabledAt: new Date().toISOString(),
                disabledBy: actorId || 'system',
                handoverId,
              },
            },
          });
          disabledNow = true;
        }
        const accountDisabled = disableAccount || from.status === 'disabled';

        // ── ⑦ 交接单（append-only 留痕） ──
        await tx.handoverRecord.create({
          data: {
            id: handoverId,
            fromUserId,
            toUserId,
            operatedBy: actorId || 'system',
            fromUserName: from.displayName,
            toUserName: to.displayName,
            disableAccount,
            note,
            detail: { ...executedCounts, previewCounts: counts },
          },
        });

        // ── ⑧ 双审计（事务内，失败即回滚——不伪成功） ──
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'system',
          source: 'handover',
          operation: 'handover_execute',
          targetType: 'HandoverRecord',
          targetId: handoverId,
          after: { fromUserId, toUserId, counts: executedCounts, disableAccount, note },
          ip: ip ?? null,
          operationType: 'update',
          fieldPath: 'ownership',
          transactionId: handoverId,
        });
        if (disabledNow) {
          await writeRouteAuditLog({
            prisma: tx,
            actorId: actorId || 'system',
            source: 'handover',
            operation: 'disable_account',
            targetType: 'UserAccount',
            targetId: fromUserId,
            after: { status: 'disabled', handoverId },
            ip: ip ?? null,
            operationType: 'update',
            fieldPath: 'status',
            transactionId: handoverId,
          });
        }

        return { handoverId, counts: executedCounts, accountDisabled };
      }, { timeout: 30_000 });

      // 事务提交后即时失效状态缓存（DR-056-③：立即失去访问）
      invalidateAccountStatusCache(fromUserId);
      return { ok: true, data: result };
    } catch (e: any) {
      logger.error('[handover] execute failed', { error: e?.message });
      return fail('INTERNAL_ERROR', e?.message || '交接执行失败', 500);
    }
  }

  /** 交接单历史（倒序，管理员审计视角） */
  async function listRecords(limit = 20): Promise<HandoverResult<any>> {
    try {
      const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const records = await db.handoverRecord.findMany({
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
      });
      return { ok: true, data: { records } };
    } catch (e: any) {
      logger.error('[handover] listRecords failed', { error: e?.message });
      return fail('INTERNAL_ERROR', e?.message || '交接记录查询失败', 500);
    }
  }

  return { preview, execute, listRecords };
}
