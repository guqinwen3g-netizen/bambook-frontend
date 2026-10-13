/**
 * invoiceAppliedSum.ts —— 「发票已核销合计」批量消费点的**唯一真源**（零 import，纯函数）
 *
 * ## 为什么必须存在（2026-09-19 上线验收实锤）
 *
 * 单张票的真源 `finance/allocationService.sumAppliedAmount` 自 2026-09-18 起已含
 * **贷项票抵扣（CreditNoteAllocation）**，注释里写明了它的后果：
 *   「此前只算收款 ⇒ 贷项票把票抵平时发票仍挂在 PartiallyPaid → 永久逾期 →
 *     账龄/催办/授信全被污染」
 *
 * 但**批量汇总处仍在各自手写 `invoiceAllocation.groupBy/appliedAmount`**（共 9 处：
 * 发票列表 / 账龄 / 现金流日历 / 驾驶舱 / 授信 / 催办 / 批次结清×2 / AI 助手未结清额）。
 * ⇒ 上面那句后果**在批量路径上依然成立**，只是换了个表现：从「状态错」变成
 *   **「状态对、余额错」** —— 同一张票**状态显示已结清，列表却仍显示欠着折让额**。
 *   而「同一实体同一字段在不同页面必须一致」是本项目的红线。
 *
 * ## 判据
 *   「发票已核销合计」= Σ 收款核销（`InvoiceAllocation.appliedAmount`，硬删除模型无软删过滤）
 *                     + Σ 贷项票抵扣（`CreditNoteAllocation.appliedAmount`）
 *   —— 与 `allocationService.sumAppliedAmount` **完全同源**。
 *
 * ## ⚠️ 不适用本模块的两种场景（别顺手改）
 *   ① **凭证侧**汇总（`InvoiceAllocation WHERE voucherId`）：贷项票没有凭证，语义不同。
 *      典型：`reportService` 代付来源追踪 / 未核销凭证 / 汇兑损益、`receiptClaimService`。
 *   ② **实收（现金流）语义**：`dashboard.collectOrderReceipts` = 订单级**实收**（只认
 *      `type=Receipt` 的凭证）⇒ 贷项是折让不是收到的钱，**刻意不计**。
 *
 * ## 为什么放在 shared/ 且零 import
 *   1. 本仓约定：判定逻辑单独成零依赖文件，避免跨层 import 穿透 tsconfig。
 *   2. **避免循环依赖**：`shipping/orderShipmentBatchService` 也要用本判据，而它被
 *      `finance/shipmentBatchSettlementHook` 反向依赖、后者又被 `finance/allocationService`
 *      依赖 ⇒ 若把真源放在 allocationService 里，会形成
 *      `orderShipmentBatchService → allocationService → hook → orderShipmentBatchService` 的环。
 */

/** duck-typed tx/prisma（不 import Prisma，保持零依赖） */
export type AppliedSumTx = {
  invoiceAllocation?: { findMany?: (args: unknown) => Promise<unknown[]> } | null;
  creditNoteAllocation?: { findMany?: (args: unknown) => Promise<unknown[]> } | null;
} | null | undefined;

// B273（评审 I-10，修期 M3 前）：这里原本每个失败分支都 `return 0` —— 而这个 0 会被
// 累加进「已核销额」唯一真源，`未收额 = 票面额 − Σ已核销` ⇒ 一笔读不出来的核销金额会让客户凭空多欠一笔钱。
// 两张核销表的 appliedAmount 都是 Decimal NOT NULL（schema 与现库都核过），正常路径喂不出坏形状；
// ★ 现量核过：7 个生产消费者全部直接把 `PrismaClient` / `$transaction` 的 tx 传进来（含 agent/toolRuntime —— 它只拼 where，
//   不自己造核销行）⇒ **这四条坏形状今天没有活路径**，本改不是关掉一条已发生的错账，而是把这个金额真源的入口
//   从"静默造一个 0"换成"当场失败"，让**未来**新增的消费点不能悄悄把错数写进应收。
function num(v: unknown): number {
  const bad = (why: string): never => {
    throw new Error(`appliedAmount 无法解读为金额（${why}）⇒ 拒绝按 0 累加进「已核销额」真源`);
  };
  if (v == null) bad('值为空');
  if (typeof v === 'number') return Number.isFinite(v) ? v : bad(`值非有限数 ${v}`);
  const anyV = v as { toNumber?: () => number };
  if (typeof anyV.toNumber === 'function') {
    const n = (() => { try { return anyV.toNumber!(); } catch (e: any) { bad(`Decimal.toNumber 抛错 ${e?.message || e}`); } })();
    return Number.isFinite(n) ? (n as number) : bad(`Decimal 转数后非有限值 ${n}`);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : bad(`字符串/其他类型读不出数（原值形如 ${JSON.stringify(v)}）`);
}

/**
 * Σ 已核销额（按发票批量）→ `Map<发票id, 已核销额>`。
 * = 收款核销 + 贷项票抵扣。**任何「该发票已收/还欠多少」的批量汇总都必须走这里。**
 *
 * ⚠️ 返回 number 是为兼容既有批量消费点（它们本就 `Number(...)` 转换）；
 *    单张票的**精确判据**仍用 `allocationService.sumAppliedAmount`（Decimal，含状态机守卫）。
 */
export async function sumAppliedAmountByInvoice(
  tx: AppliedSumTx,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!tx || invoiceIds.length === 0) return out;

  if (tx.invoiceAllocation?.findMany) {
    const allocs = (await tx.invoiceAllocation.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { invoiceId: true, appliedAmount: true },
    })) as Array<{ invoiceId: string; appliedAmount: unknown }>;
    for (const a of allocs) {
      out.set(a.invoiceId, (out.get(a.invoiceId) ?? 0) + num(a.appliedAmount));
    }
  }

  // 兼容性守卫：历史测试替身的 mock prisma 未必有 creditNoteAllocation（真库恒存在）
  if (tx.creditNoteAllocation?.findMany) {
    const cnAllocs = (await tx.creditNoteAllocation.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { invoiceId: true, appliedAmount: true },
    })) as Array<{ invoiceId: string; appliedAmount: unknown }>;
    for (const a of cnAllocs) {
      out.set(a.invoiceId, (out.get(a.invoiceId) ?? 0) + num(a.appliedAmount));
    }
  }
  return out;
}

/**
 * 仅「贷项票抵扣」部分的 Σ（按发票批量）—— 供**已有自身过滤条件**的消费点叠加。
 *
 * 有些消费点不能直接用 `sumAppliedAmountByInvoice`，因为它们的「已收」有额外过滤
 * （如批次结清要排除作废发票）。那些地方保留原有过滤逻辑，只把贷项这一块叠加进去。
 */
export async function sumCreditNoteAppliedByInvoice(
  tx: AppliedSumTx,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!tx || invoiceIds.length === 0) return out;
  if (tx.creditNoteAllocation?.findMany) {
    const cnAllocs = (await tx.creditNoteAllocation.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: { invoiceId: true, appliedAmount: true },
    })) as Array<{ invoiceId: string; appliedAmount: unknown }>;
    for (const a of cnAllocs) {
      out.set(a.invoiceId, (out.get(a.invoiceId) ?? 0) + num(a.appliedAmount));
    }
  }
  return out;
}
