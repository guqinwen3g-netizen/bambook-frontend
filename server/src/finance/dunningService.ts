
/**
 * dunningService.ts — REQ2-08 催款函套件（账龄明细注入的中英双语函 + 记录留痕）
 *
 * 设计真源：docs/design/04-模块设计/05-财务与结算/催款函套件.md
 * P0-2 扩展：催款函分级（stage 参数四档语气模板：提醒/催款/严催/法务准备）+
 *           催款记录登记 stage 快照（记录发生时的分级，历史不失真）。
 *
 * DR-050 三决策：
 *   ① 函生成即时组装（不落模板表）——账龄明细是逐发票动态行，模板变量表达不了表格；
 *      EmailTemplate 单发票轻提醒模板保留，两档并存
 *   ② 催款记录独立建模（快照留痕）——还款后历史不失真；发送走既有 Outbox，本域只登记事实
 *   ③ 一键发起挂账龄行（选中即上下文：客户×币种）
 *
 * 口径：与账龄报表同源（净额口径 DR-044——open = amount − Σ InvoiceAllocation；
 *      逾期判定 dueDate < asOf；五桶分段同 bucketOf）。
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { resolveEffectiveStage, scopeKeyOf, stageOfBuckets } from './dunningStageService';
import { sumAppliedAmountByInvoice } from '../shared/invoiceAppliedSum';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────

export const DUNNING_CHANNELS = ['email', 'phone', 'visit', 'other'] as const;
export const DUNNING_RESULTS = ['sent', 'promised', 'paid', 'disputed', 'no_response'] as const;

export const CHANNEL_LABELS: Record<string, string> = {
  email: '邮件', phone: '电话', visit: '拜访', other: '其他',
};
export const RESULT_LABELS: Record<string, string> = {
  sent: '已送达', promised: '承诺付款', paid: '已付款', disputed: '有争议', no_response: '未回应',
};

// ── P0-2 分级函语气模板（共享账龄明细注入，四档 subject/收尾差异）──
const LETTER_STAGES = ['reminder', 'firm', 'urgent', 'legal'] as const;
type LetterStage = (typeof LETTER_STAGES)[number];

const STAGE_TONES: Record<LetterStage, {
  zhSubject: string; zhClosing: string[]; enSubject: string; enClosing: string[];
}> = {
  reminder: {
    zhSubject: '【付款提醒】',
    zhClosing: ['烦请贵司核对以上明细并尽快安排付款。如已付款或对金额有疑问，请及时与我们联系核对。', '顺祝商祺！'],
    enSubject: 'Payment Reminder',
    enClosing: ['We would appreciate your prompt arrangement of the outstanding payment. If payment has already been made or you have any questions, please contact us for reconciliation.', 'Best regards,'],
  },
  firm: {
    zhSubject: '【催款通知】',
    zhClosing: ['请贵司于收到本函后 7 个工作日内安排付款；如已付款，烦请提供付款水单以便我司核销入账。', '顺祝商祺！'],
    enSubject: 'Payment Demand Notice',
    enClosing: ['Please arrange payment within 7 working days of receipt of this notice. If payment has already been made, kindly provide the remittance advice for our reconciliation.', 'Best regards,'],
  },
  urgent: {
    zhSubject: '【严催函】',
    zhClosing: ['该账款已严重逾期。请贵司于收到本函后 5 个工作日内付清全部欠款；逾期未付，我司将暂停新订单的生产与发运安排，并保留按合同约定主张逾期损失的权利。', '顺祝商祺！'],
    enSubject: 'Urgent Payment Demand',
    enClosing: ['The above balance is now seriously overdue. Please settle it in full within 5 working days of receipt of this letter. Otherwise, we will suspend production and shipment of new orders, and reserve the right to claim overdue losses as stipulated in the contract.', 'Best regards,'],
  },
  legal: {
    zhSubject: '【最后通知 · 法务准备】',
    zhClosing: ['该账款已逾期超过 90 天。请贵司于收到本函后 3 个工作日内付清全部欠款；否则我司将把本案移交外部律师采取法律行动（由此产生的诉讼费、律师费等费用将由贵司承担），并终止一切商业合作。', '顺祝商祺！'],
    enSubject: 'Final Notice Before Legal Action',
    enClosing: ['The above balance has been overdue for more than 90 days. Please settle it in full within 3 working days of receipt of this notice. Otherwise, we will refer this matter to external counsel for legal action (all litigation costs and attorney fees to be borne by your company) and terminate all business cooperation.', 'Best regards,'],
  },
};

/** 账龄分段（与 reportService.bucketOf 同口径） */
export const BUCKET_LABELS_ZH: Record<string, string> = {
  current: '未到期', d1_30: '1-30 天', d31_60: '31-60 天', d61_90: '61-90 天', d90plus: '90 天以上',
};
export const BUCKET_LABELS_EN: Record<string, string> = {
  current: 'Not Due', d1_30: '1-30 Days', d31_60: '31-60 Days', d61_90: '61-90 Days', d90plus: '90+ Days',
};

export type DunningResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

/** 逾期发票明细行（loadOverdueInvoices / 函注入同构） */
interface DunningLetterItem {
  invoiceNumber: string;
  open: number;
  dueDate: string | null;
  daysOverdue: number;
  bucket: string;
}

const fail = (code: string, message: string, status = 400): DunningResult<never> =>
  ({ ok: false, error: { code, message, status } });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function bucketOf(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

function fmtMoney(n: number, currency: string): string {
  const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createDunningService(prisma: PrismaClient) {
  const db = prisma as any;

  /** 客户×币种 当前未结清逾期发票明细（净额口径，与账龄同源） */
  async function loadOverdueInvoices(params: {
    customerRelationId?: string;
    customerName?: string;
    currency: string;
    asOf: string;
  }) {
    const asOfMs = new Date(params.asOf + 'T00:00:00Z').getTime();
    const where: any = {
      type: 'Receivable',
      status: { in: ['Issued', 'PartiallyPaid'] },
      deletedAt: null,
      currency: params.currency,
    };
    if (params.customerRelationId) {
      where.customerRelationId = params.customerRelationId;
    } else if (params.customerName) {
      where.customerName = params.customerName;
    }
    const invoices = await db.invoice.findMany({
      where,
      select: { id: true, invoiceNumber: true, amount: true, currency: true, issueDate: true, dueDate: true, customerName: true, customerRelationId: true },
      orderBy: { dueDate: 'asc' },
    });

    // 净额：amount − Σ InvoiceAllocation（DR-044 与账龄/对账单同源）
    const paidByInvoice = await sumAppliedAmountByInvoice(db, invoices.map((i: any) => i.id));

    const items = invoices
      .map((i: any) => {
        const open = Number(i.amount) - (paidByInvoice.get(i.id) ?? 0);
        const dueMs = i.dueDate ? new Date(String(i.dueDate) + 'T00:00:00Z').getTime() : null;
        const daysOverdue = dueMs != null ? Math.floor((asOfMs - dueMs) / MS_PER_DAY) : 0;
        return {
          invoiceNumber: i.invoiceNumber,
          open,
          dueDate: i.dueDate ? String(i.dueDate) : null,
          daysOverdue,
          bucket: bucketOf(daysOverdue),
        };
      })
      .filter((x: any) => x.open > 0.005 && x.daysOverdue > 0); // 逾期未结清

    const buckets: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    for (const it of items) buckets[it.bucket] += it.open;
    const customerName = params.customerName
      ?? (items.length > 0 ? String(invoices[0].customerName ?? params.customerName) : params.customerName);
    return {
      customerName: customerName ?? '',
      customerRelationId: params.customerRelationId
        ?? (items.length > 0 ? (invoices[0].customerRelationId ?? null) : null),
      currency: params.currency,
      asOf: params.asOf,
      items,
      buckets,
      totalOverdue: Math.round(items.reduce((s: number, x: any) => s + x.open, 0) * 100) / 100,
    };
  }

  // ── 中英双语催款函生成（DR-050-①：即时组装，账龄明细注入；P0-2：stage 四档语气） ──
  async function buildLetter(input: {
    customerRelationId?: string;
    customerName?: string;
    currency: string;
    asOf?: string;
    /** P0-2 分级档位：缺省按「DunningProfile 钉住 × 账龄自动定级」合成生效分级 */
    stage?: string;
  }): Promise<DunningResult<any>> {
    try {
      const currency = String(input.currency ?? '').trim().toUpperCase();
      if (!currency) return fail('CURRENCY_REQUIRED', 'currency 必填（账龄行币种）');
      const asOf = input.asOf ?? todayLocalKey();
      if (!input.customerRelationId && !input.customerName) {
        return fail('CUSTOMER_REQUIRED', 'customerRelationId 与 customerName 必传其一');
      }
      const ctx = await loadOverdueInvoices({ ...input, currency, asOf });
      if (ctx.items.length === 0) {
        return fail('NO_OVERDUE', `该客户 ${currency} 无逾期未结清发票（asOf=${asOf}）`, 409);
      }

      // 分级合成：显式 stage（预览他档）> DunningProfile 钉住 × 账龄自动定级（与看板同口径）
      let stage: LetterStage;
      if (input.stage != null && String(input.stage).trim() !== '') {
        const requested = String(input.stage).trim();
        if (!(LETTER_STAGES as readonly string[]).includes(requested)) {
          return fail('INVALID_STAGE', `stage 须为 ${LETTER_STAGES.join(' | ')}`);
        }
        stage = requested as LetterStage;
      } else {
        const profile = await db.dunningProfile.findUnique({
          where: { scopeKey: scopeKeyOf(ctx.customerRelationId ?? input.customerRelationId ?? null, ctx.customerName || input.customerName || '', currency) },
        });
        const autoStage = stageOfBuckets(ctx.buckets);
        stage = resolveEffectiveStage(profile, autoStage).stage as LetterStage;
      }
      const tone = STAGE_TONES[stage];

      const name = ctx.customerName || input.customerName || '客户';
      const detailZh = ctx.items.map((x: DunningLetterItem) =>
        `${x.invoiceNumber} | ${fmtMoney(x.open, currency)} | 到期 ${x.dueDate ?? '—'} | 逾期 ${x.daysOverdue} 天（${BUCKET_LABELS_ZH[x.bucket]}）`);
      const summaryZh = Object.entries(ctx.buckets)
        .filter(([, v]) => (v as number) > 0)
        .map(([k, v]) => `${BUCKET_LABELS_ZH[k]}：${fmtMoney(v as number, currency)}`);

      const detailEn = ctx.items.map((x: DunningLetterItem) =>
        `${x.invoiceNumber} | ${fmtMoney(x.open, currency)} | Due ${x.dueDate ?? '—'} | ${x.daysOverdue} days overdue (${BUCKET_LABELS_EN[x.bucket]})`);
      const summaryEn = Object.entries(ctx.buckets)
        .filter(([, v]) => (v as number) > 0)
        .map(([k, v]) => `${BUCKET_LABELS_EN[k]}: ${fmtMoney(v as number, currency)}`);

      const zh = {
        subject: `${tone.zhSubject}${name} 逾期账款 ${fmtMoney(ctx.totalOverdue, currency)}（截至 ${asOf}）`,
        body: [
          `${name}：`,
          '',
          `经核对，贵司截至 ${asOf} 尚有逾期未付款项共计 ${fmtMoney(ctx.totalOverdue, currency)}（${ctx.items.length} 张发票），明细如下：`,
          '',
          '发票号 | 未付金额 | 到期日 | 逾期情况',
          ...detailZh,
          '',
          '账龄汇总：',
          ...summaryZh,
          '',
          ...tone.zhClosing,
        ].join('\n'),
      };
      const en = {
        subject: `${tone.enSubject} — Overdue Balance ${fmtMoney(ctx.totalOverdue, currency)} (as of ${asOf})`,
        body: [
          `Dear ${name},`,
          '',
          `As of ${asOf}, the following overdue invoices remain unsettled, with a total outstanding balance of ${fmtMoney(ctx.totalOverdue, currency)} (${ctx.items.length} invoices):`,
          '',
          'Invoice No. | Open Amount | Due Date | Overdue',
          ...detailEn,
          '',
          'Aging Summary:',
          ...summaryEn,
          '',
          ...tone.enClosing,
        ].join('\n'),
      };

      logger.info('[Dunning] letter built', { customer: name, currency, stage, invoices: ctx.items.length, total: ctx.totalOverdue });
      return {
        ok: true,
        data: {
          zh, en, stage,
          summary: {
            customerName: name,
            currency,
            asOf,
            invoiceCount: ctx.items.length,
            totalOverdue: ctx.totalOverdue,
            buckets: ctx.buckets,
            items: ctx.items,
          },
        },
      };
    } catch (e: any) {
      logger.error('[Dunning] build letter failed', { error: e?.message });
      return fail('LETTER_FAILED', e?.message || '催款函生成失败', 500);
    }
  }

  // ── 登记催款记录（DR-050-②：快照留痕） ──
  async function recordDunning(input: Record<string, unknown>): Promise<DunningResult<any>> {
    try {
      const customerName = String(input.customerName ?? '').trim();
      if (!customerName) return fail('CUSTOMER_NAME_REQUIRED', 'customerName 必填');
      const currency = String(input.currency ?? '').trim().toUpperCase();
      if (!currency) return fail('CURRENCY_REQUIRED', 'currency 必填');
      const channel = String(input.channel ?? '').trim();
      if (!(DUNNING_CHANNELS as readonly string[]).includes(channel)) {
        return fail('INVALID_CHANNEL', `channel 须为 ${DUNNING_CHANNELS.join(' | ')}`);
      }
      const result = String(input.result ?? '').trim();
      if (!(DUNNING_RESULTS as readonly string[]).includes(result)) {
        return fail('INVALID_RESULT', `result 须为 ${DUNNING_RESULTS.join(' | ')}`);
      }
      // P0-2：分级快照（记录发生时的档位；缺省 null = 未分级）
      const stage = input.stage != null && String(input.stage).trim() !== '' ? String(input.stage).trim() : null;
      if (stage != null && !(LETTER_STAGES as readonly string[]).includes(stage)) {
        return fail('INVALID_STAGE', `stage 须为 ${LETTER_STAGES.join(' | ')}`);
      }
      const totalOverdue = Number(input.totalOverdue);
      if (!Number.isFinite(totalOverdue) || totalOverdue < 0) return fail('INVALID_AMOUNT', 'totalOverdue 须为非负数');

      const ts = Date.now();
      const record = await db.dunningRecord.create({
        data: {
          id: `DUN__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          customerRelationId: input.customerRelationId != null && String(input.customerRelationId).trim() !== ''
            ? String(input.customerRelationId) : null,
          customerName,
          currency,
          totalOverdue,
          invoiceCount: Number(input.invoiceCount) || 0,
          agingBuckets: (input.agingBuckets ?? {}) as any,
          channel,
          result,
          stage,
          note: input.note != null ? String(input.note).trim() || null : null,
          operator: input.operator != null ? String(input.operator).trim() || null : null,
          createdAt: BigInt(ts),
        },
      });
      logger.info('[Dunning] recorded', { id: record.id, customer: customerName, channel, result });
      return { ok: true, data: { record } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[Dunning] record failed', { error: e?.message });
      return fail('RECORD_FAILED', e?.message || '登记失败', 500);
    }
  }

  // ── 催款历史（客户维度 or 全量倒序） ──
  async function listDunning(params: { customerRelationId?: string; customerName?: string; limit?: number }): Promise<DunningResult<{ items: any[] }>> {
    const where: any = {};
    if (params.customerRelationId) where.customerRelationId = params.customerRelationId;
    else if (params.customerName) where.customerName = params.customerName;
    const items = await db.dunningRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
    });
    return { ok: true, data: { items } };
  }

  return { buildLetter, recordDunning, listDunning };
}
