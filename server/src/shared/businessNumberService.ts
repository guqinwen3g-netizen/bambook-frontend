/**
 * 统一业务编号服务 Business Number Service（PRD 5.6 落地）
 *
 * 职责：
 *   1. 按年递增编号生成：{PREFIX}-{YYYY}-{NNNN}（4 位补零）
 *   2. 并发安全：upsert 首建行 + increment 原子递增；首建并发 P2002 自动重试（QA-SEC-4A）
 *   3. 作废不回收：序号单调递增，已分配序号永久保留（含软删记录）
 *   4. 全局唯一：同一 prefix+year 组合下序号唯一
 *
 * 使用方式：
 *   - 在创建单据的事务内调用 nextBusinessNumber(tx, 'QT')
 *   - 前端不再传编号字段，服务端强制覆盖
 *
 * 降级策略（QA-SEC-4B）：
 *   - db 无 businessSequence 模型仅允许显式测试注入（NODE_ENV=test 的 mock 场景），
 *     此时降级为时间戳+随机后缀（格式外编号，仅测试可见）。
 *   - 生产/开发环境缺模型属于配置错误，直接 throw fail-closed，绝不产出格式外编号。
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { todayLocalKey } from './localDate';


// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

/** Prisma 客户端或事务句柄（宽松类型，兼容 PrismaClient 与 $transaction 句柄） */
interface DbLike {
  businessSequence?: {
    upsert(args: any): Promise<any>;
    update(args: any): Promise<any>;
    findUnique(args: any): Promise<any>;
    deleteMany(args: any): Promise<any>;
  };
}

/** 支持的单据前缀（PRD 5.6 定义） */
export type BusinessPrefix =
  | 'BI'   // 收费事项 BillingItem
  | 'CR'   // 成本记录 CostRecord
  | 'QT'   // 报价单 Quotation
  | 'ORD'  // 订单 Order
  | 'PO'   // 采购订单 PurchaseOrder
  | 'INV'  // 发票 Invoice
  | 'SH'   // 运单 Shipment
  | 'CD'   // 报关单 CustomsDeclaration
  | 'PV'   // 付款凭证 PaymentVoucher
  | 'IR'   // 检验报告 InspectionReport
  | 'SM'   // 样品 Sample
  | 'SEAL' // 封样 SealSample，历史编号不重写
  | 'SB'   // 开发样品批次 SampleBatch（面料/成衣共用编号池）
  | 'BOM'  // BOM 清单
  | 'LC'   // 信用证 LetterOfCredit
  | 'TR'   // 退税 TaxRefund
  | 'CI'   // 商业发票 CommercialInvoice
  | 'PL'   // 装箱单 PackingList
  | 'CO'   // 原产地证 CertificateOfOrigin
  | 'BL'   // 提单 BillOfLading
  | 'AWB'  // 空运单 AirWaybill
  | 'INS'  // 保险单 InsuranceCert
  | 'IC'   // 检验证书 InspectionCert
  | 'PC'   // 植检证 PhytosanitaryCert
  | 'EDP'  // 外部出口申报/清关完成凭证 ExportDeclarationProof
  | 'SI'   // 供应商询价 SupplierInquiry
  | 'RT'   // 物料退换货单 MaterialReturn（P1-4）
  | 'RW'   // 返修工单 ReworkWorkOrder（A 组 A-3 二期）
  | 'CLM'  // 索赔贷项发票 Claim CreditNote（P1-4，负向 Payable）
  | 'DOC'; // 其他单据 Other

const VALID_PREFIXES: BusinessPrefix[] = [
  'BI', 'CR', 'QT', 'ORD', 'PO', 'INV', 'SH', 'CD', 'PV', 'IR', 'SM', 'BOM',
  'LC', 'TR', 'CI', 'PL', 'CO', 'BL', 'AWB', 'INS', 'IC', 'PC', 'EDP', 'SI', 'RT', 'CLM', 'RW', 'DOC', 'SB', 'SEAL',
];

export function isBusinessPrefix(prefix: string): prefix is BusinessPrefix {
  return (VALID_PREFIXES as string[]).includes(prefix);
}

// ────────────────────────────────────────────────────────────────
// 核心：事务内取号
// ────────────────────────────────────────────────────────────────

/**
 * 生成下一业务编号：{PREFIX}-{YYYY}-{NNNN}（4 位补零）。
 *
 * 实现要点：
 *   1. upsert 确保 BusinessSequence 行存在（首建并发 P2002 自动重试，QA-SEC-4A）
 *   2. increment 原子递增并返回新值
 *   3. 返回格式化编号
 *   4. 占用追平（第三例软删占位根因修复）：opts.occupied 回调校验目标表（含软删行）
 *      实际占用——序列空缺/落后于业务表时（如迁移导入直写单号、序列表重建）自动
 *      递增追平到首个未占用号，杜绝"生成即撞唯一键"（P2002 事务回滚）。
 *
 * 注意：必须在事务内调用，确保取号与单据创建原子提交。
 */
export async function nextBusinessNumber(
  db: DbLike,
  prefix: BusinessPrefix,
  year?: number,
  opts?: {
    /** 编号占用校验（查目标业务表含软删行；返回 true=已占用需继续递增）。由调用方提供表映射。 */
    occupied?: (number: string) => Promise<boolean>;
  },
): Promise<string> {
  if (!isBusinessPrefix(prefix)) {
    throw new Error(`非法业务编号前缀: ${prefix}`);
  }
  const targetYear = year ?? Number(todayLocalKey().slice(0, 4));
  const id = `SEQ_${prefix}_${targetYear}`;

  // QA-SEC-4B：降级仅限显式测试注入（NODE_ENV=test）；生产缺模型直接 throw，禁止格式外编号
  if (!db.businessSequence) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(`BUSINESS_NUMBER_SEQUENCE_UNAVAILABLE: businessSequence 模型缺失（prefix=${prefix}）— 生产环境禁止降级产出格式外编号`);
    }
    const fallback = `${prefix}-${targetYear}-${String(Date.now()).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
    logger.warn('[BusinessNumber] fallback to timestamp (test-only injection)', { prefix, year: targetYear, fallback });
    return fallback;
  }

  // QA-SEC-4A：首建并发 — upsert 的 create 侧可能撞唯一约束（P2002），限定次数重试
  const MAX_UPSERT_RETRIES = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.businessSequence.upsert({
        where: { id },
        create: {
          id,
          prefix,
          year: targetYear,
          seq: 0,
          updatedAt: BigInt(Date.now()),
        },
        // Nonempty update lets Prisma delegate this simple upsert to PostgreSQL
        // ON CONFLICT. An empty update can use read-then-insert instead; its
        // P2002 aborts an interactive transaction, so retrying inside it cannot recover.
        update: { updatedAt: BigInt(Date.now()) },
        select: { seq: true },
      });
      break;
    } catch (e: any) {
      if (e?.code === 'P2002' && attempt < MAX_UPSERT_RETRIES) {
        logger.warn('[BusinessNumber] upsert P2002, retrying', { prefix, year: targetYear, attempt });
        continue;
      }
      throw e;
    }
  }

  // 占用追平上限（防异常数据死循环；正常场景最多追平到业务表最大序号）
  const MAX_OCCUPIED_RETRIES = 1000;
  for (let attempt = 0; ; attempt++) {
    // 原子递增并返回新值
    const updated = await db.businessSequence.update({
      where: { id },
      data: {
        seq: { increment: 1 },
        updatedAt: BigInt(Date.now()),
      },
      select: { seq: true },
    });

    const seq = updated.seq;
    const number = `${prefix}-${targetYear}-${String(seq).padStart(4, '0')}`;

    if (opts?.occupied) {
      let isOccupied = false;
      try {
        isOccupied = await opts.occupied(number);
      } catch (e: any) {
        // 占用校验失败 fail-closed：宁可中止也不产出可能冲突的编号
        throw new Error(`BUSINESS_NUMBER_OCCUPIED_CHECK_FAILED: prefix=${prefix} number=${number} error=${e?.message ?? e}`);
      }
      if (isOccupied) {
        if (attempt >= MAX_OCCUPIED_RETRIES) {
          throw new Error(`BUSINESS_NUMBER_EXHAUSTED_RETRIES: prefix=${prefix} 连续 ${MAX_OCCUPIED_RETRIES} 个编号均被占用`);
        }
        if (typeof logger.debug === 'function') {
          logger.debug('[BusinessNumber] number occupied, advancing', { prefix, year: targetYear, seq, number });
        }
        continue; // 序列落后：继续递增追平
      }
    }

    if (typeof logger.debug === 'function') {
      logger.debug('[BusinessNumber] generated', { prefix, year: targetYear, seq, number });
    }
    return number;
  }
}

/**
 * 预览下一编号（不消费序号）。
 * 用于前端展示"下一编号"提示，不实际分配。
 */
export async function peekNextBusinessNumber(
  db: DbLike,
  prefix: BusinessPrefix,
  year?: number,
): Promise<string> {
  if (!isBusinessPrefix(prefix)) {
    throw new Error(`非法业务编号前缀: ${prefix}`);
  }
  const targetYear = year ?? Number(todayLocalKey().slice(0, 4));
  const id = `SEQ_${prefix}_${targetYear}`;

  // 若 db 无 businessSequence 模型（如单元测试 mock），降级返回 0001
  if (!db.businessSequence) {
    return `${prefix}-${targetYear}-0001`;
  }

  const row = await db.businessSequence.findUnique({
    where: { id },
    select: { seq: true },
  });

  const nextSeq = (row?.seq ?? 0) + 1;
  return `${prefix}-${targetYear}-${String(nextSeq).padStart(4, '0')}`;
}

/**
 * 回退已分配的序号（仅用于测试或极端异常补偿，业务代码禁用）。
 * 会实际删除 BusinessSequence 行，重置计数器。
 */
export async function resetBusinessSequenceForTest(
  db: DbLike,
  prefix: BusinessPrefix,
  year?: number,
): Promise<void> {
  const targetYear = year ?? Number(todayLocalKey().slice(0, 4));
  const id = `SEQ_${prefix}_${targetYear}`;
  if (db.businessSequence) {
    await db.businessSequence.deleteMany({ where: { id } });
  }
  logger.warn('[BusinessNumber] sequence reset (test only)', { prefix, year: targetYear });
}
