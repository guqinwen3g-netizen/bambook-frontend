import { businessNowDate } from '../../shared/businessClock';
/**
 * D6 财务深化 — 调度任务：远期结汇合约到期预警
 *
 * 为什么需要（零基础障碍清单 D6「远期结汇缺合约模型」）：合约层缺的后果里，
 * **"到期日没人管"是其中一半** —— 远期结汇合约到期必须交割，逾期会有展期成本/罚息。
 * 本任务把"快到期 / 已逾期"变成**可被看见的预警**（与信用证三期预警同口径：**预警不改业务状态**）。
 *
 * 每日 10:00 后执行一次（日去重）。扫描未终态（非 Settled / Cancelled）且未软删的远期合约：
 *
 *   到期日在未来且 ≤ 7 天 → warning（临近，需安排交割或与银行谈展期）
 *   到期日已过            → critical（已逾期，面临展期成本/罚息）
 *
 * dedupKey：`forward_fx_maturity:${id}:${maturityDate}:${tier}`
 * 幂等语义由 `RiskAlert.dedupKey @unique` 承担；到期日变更或级别跃迁产生新键，
 * 形成升级轨迹；同一到期日同一级别日级不重复。
 *
 * ⓘ 口径复用真源 `finance/forwardFxService.daysToMaturityOf`（**不在本文件另写一套日期差**）——
 *   日期非法返回 null ⇒ **跳过**（不显示成"今天到期"：0 与 null 是两回事）。
 */
import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';
import { daysToMaturityOf, forwardFxRemainingOf, FORWARD_FX_STATUS_LABELS } from '../../finance/forwardFxService';

/** 临近窗口：到期日距今日 ≤ 7 天升 warning（与信用证三期预警同口径） */
const APPROACHING_DAYS = 7;
/** 远期合约终态（不参与到期预警） */
const TERMINAL_STATUSES = ['Settled', 'Cancelled'];

/**
 * 扫描入口（watchdog 与测试直驱共用）：返回本次新产生的预警数。
 */
export async function scanForwardFxMaturity(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<{ alerted: number; scanned: number }> {
  const db = prisma as any;
  const risk = createRiskService(prisma);

  const contracts: any[] = await db.forwardFxContract.findMany({
    where: { deletedAt: null, status: { notIn: TERMINAL_STATUSES } },
    select: {
      id: true, contractNumber: true, bankName: true, currency: true,
      foreignAmount: true, settledForeignAmount: true, status: true, maturityDate: true,
    },
  });

  let alerted = 0;
  for (const c of contracts) {
    // 真源口径：日期非法 → null ⇒ 跳过（**不**当成"今天到期"）
    const diffDays = daysToMaturityOf(c.maturityDate, localYmd(today));
    if (diffDays === null) continue;

    let tier: AlertLevel;
    let timing: string;
    if (diffDays < 0) {
      tier = 'critical';
      timing = `已逾期 ${-diffDays} 天`;
    } else if (diffDays <= APPROACHING_DAYS) {
      tier = 'warning';
      timing = diffDays === 0 ? '今日到期' : `仅剩 ${diffDays} 天`;
    } else {
      continue; // 窗口外
    }

    const remaining = forwardFxRemainingOf(c.foreignAmount, c.settledForeignAmount);
    const settled = Number(c.settledForeignAmount ?? 0);
    const statusLabel = FORWARD_FX_STATUS_LABELS[c.status] ?? c.status;
    const bank = c.bankName ? `${c.bankName} ` : '';

    const { created } = await risk.raiseAlert({
      type: 'forward_fx_maturity',
      level: tier,
      title: `远期结汇合约 ${c.contractNumber} ${timing}`,
      content: `合约 ${c.contractNumber}（${bank}${c.currency}，当前 ${statusLabel}）到期（交割）日为 ${c.maturityDate}，${timing}。`
        + `已交割 ${settled}、剩余未交割 ${remaining} ${c.currency}。`
        + `请及时安排交割，或提前与银行沟通展期，避免逾期产生展期成本/罚息。`,
      relatedType: 'ForwardFxContract',
      relatedId: c.id,
      dedupKey: `forward_fx_maturity:${c.id}:${c.maturityDate}:${tier}`,
    });
    if (created) alerted += 1;
  }

  if (alerted > 0) {
    logger.info('[ForwardFxMaturityWatchdog] scan', { alerted, scanned: contracts.length });
  }
  return { alerted, scanned: contracts.length };
}

/** 本地日期（业务日期口径：不用 toISOString —— 那是 UTC，本仓有棘轮守卫禁它） */
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createForwardFxMaturityWatchdogTask(): ScheduledTask {
  return {
    id: 'forward_fx_maturity_watchdog',
    shouldRun: (now: Date) => {
      // 每日 10:00 后执行一次
      const dayKey = dayKeyOf(now);
      if (now.getHours() >= 10 && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanForwardFxMaturity(prisma);
      } catch (e: any) {
        logger.error('[ForwardFxMaturityWatchdog] failed', { error: e?.message });
      }
    },
  };
}
