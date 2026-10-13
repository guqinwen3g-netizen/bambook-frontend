/**
 * entityRefPurgeMiddleware.ts —— ★★ 删除实体时**统一清理引用**（2026-09-18 立）
 *
 * ── 为什么需要它（根因）────────────────────────────────────
 * `server/src` 里 `entityReference` / `entityLink` **只有 `upsert`，一个 `deleteMany` 都没有** ✗
 * ⇒ **删除实体时，引用永远不被清理** ✗ ⇒ **悬挂引用必然累积** ✗
 *   （2026-09-17 做过「悬挂 806 → 49 → 0」是**手工清理** ✗ —— 源头一直在产 ✗）
 *
 * ── 为什么用 Prisma 中间件（而不是逐路由补）──────────────────
 * 删除路径有 **10+ 处**（`router.delete` 遍布各模块）✗
 * ★ **逐条补 = 必然再漂移** ✗ —— 这正是本仓最高产的一类 bug：**收口点错位** ✗
 * ⇒ **收口到 Prisma 这一层** ✓：一次覆盖**所有**删除路径 ✓（含未来的新路由 ✓）
 *
 * ── 安全性 ───────────────────────────────────────────────
 * 「删掉**指向已删实体**的引用」是**无歧义正确**的 ✓ —— 那就是垃圾 ✓
 * 故本中间件**不需要业务判断** ✓，只要保证：
 *   ① 只在 `delete` / `deleteMany` 上生效 ✓
 *   ② **先收集 id，再删实体，最后清引用** ✓（顺序不能反 ✗）
 *   ③ 清理失败**不阻断**删除本身 ✓（实体已删 ⇒ 引用必然是垃圾 ✓），但要**记 error** ✓
 *
 * ── ⚠️ type 字符串**不一致**，必须显式映射（实测）────────────────
 * `sync.ts` 里的写法是混的 ✗：`'order'` · `'development-case'`（**连字符** ✗）·
 * `'orderLine'`（**驼峰** ✗）· `'relation.organization'`（**点分** ✗）· `'paymentVoucher'`
 * ⇒ 只能**照抄**，不能按规律推 ✗
 */
import type { PrismaClient } from '@prisma/client';

/**
 * Prisma 模型名 → `EntityReference.ownerType` / `EntityLink.fromType` 用的 type 字符串。
 * ★ **照抄自 `entities/sync.ts`**（那里的字面量就是真源 ✓），不是推出来的 ✗
 */
export const MODEL_TO_REF_TYPES: Record<string, string[]> = {
  Order: ['order'],
  OrderLine: ['orderLine'],
  DevelopmentCase: ['development-case'],
  Shipment: ['shipment'],
  Invoice: ['invoice'],
  PaymentVoucher: ['paymentVoucher'],
  FxSettlement: ['fxSettlement'],
  OutwardRemittance: ['outwardRemittance'],
  VatInvoice: ['vatInvoice'],
  // ★ Relation 对应**三个** type（点分 ✗）
  Relation: ['relation.contact', 'relation.organization', 'relation.person'],
  // ── 以下是 targetType 里出现过、但可能不被 owner 引用的（一并登记 ✓）──
  Bom: ['bom'],
  CustomsDeclaration: ['customsDeclaration'],
  InventoryItem: ['inventoryItem'],
  Product: ['product'],
  PurchaseOrder: ['purchaseOrder'],
  Quotation: ['quotation'],
  Warehouse: ['warehouse'],
};

/** 供测试断言用：中间件是否覆盖了 sync.ts 里出现的**全部** type（防漏收 ✗） */
export function coveredRefTypes(): Set<string> {
  return new Set(Object.values(MODEL_TO_REF_TYPES).flat());
}

type AnyPrisma = PrismaClient & Record<string, any>;

/**
 * 把清理逻辑挂到 Prisma 上。在创建 PrismaClient 后立即调用：
 *   const prisma = new PrismaClient();
 *   installEntityRefPurge(prisma);
 */
export function installEntityRefPurge(prisma: AnyPrisma, opts?: { onError?: (e: unknown, ctx: { model?: string; action?: string }) => void }): void {
  const onError = opts?.onError ?? ((e, ctx) => {
    // 不阻断业务 ✓，但必须留痕 ✓（否则又变成"静默漏清" ✗）
    // eslint-disable-next-line no-console
    console.error('[entityRefPurge] 清理引用失败（实体已删，引用可能残留）', {
      model: ctx.model, action: ctx.action, message: (e as any)?.message,
    });
  });

  // Prisma 5.x 的 $use（5.10.2 ✓）。若未来升到 6.x 需换 $extends ✓
  (prisma as any).$use(async (params: any, next: (p: any) => Promise<any>) => {
    const types = params?.model ? MODEL_TO_REF_TYPES[params.model] : undefined;
    const action = params?.action;
    if (!types || (action !== 'delete' && action !== 'deleteMany')) return next(params);

    // ① **先**收集要被删的 id（删完就查不到了 ✗）
    let ids: string[] = [];
    try {
      if (action === 'delete') {
        const id = params.args?.where?.id;
        if (typeof id === 'string') ids = [id];
      } else {
        const rows = await (prisma as any)[
          params.model.charAt(0).toLowerCase() + params.model.slice(1)
        ].findMany({ where: params.args?.where ?? {}, select: { id: true } });
        ids = rows.map((r: any) => r.id);
      }
    } catch {
      // 收集失败 ⇒ 不猜，交给 next 正常执行（宁可漏清，也不要误删 ✗）
      return next(params);
    }
    if (ids.length === 0) return next(params);

    // ② 执行真正的删除
    const result = await next(params);

    // ③ 清引用（实体已删 ⇒ 指向它的引用必然是垃圾 ✓）
    try {
      await (prisma as any).entityReference.deleteMany({
        where: {
          OR: [
            { ownerType: { in: types }, ownerId: { in: ids } },
            { targetType: { in: types }, targetId: { in: ids } },
          ],
        },
      });
      await (prisma as any).entityLink.deleteMany({
        where: {
          OR: [
            { fromType: { in: types }, fromId: { in: ids } },
            { toType: { in: types }, toId: { in: ids } },
          ],
        },
      });
    } catch (e) {
      onError(e, { model: params.model, action });
    }
    return result;
  });
}
