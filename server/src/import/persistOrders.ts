import { Prisma as PrismaSql } from '@prisma/client';
import { refreshOrderQuantityHeader } from '../shared/orderQuantityProjection';
import { parseOrderQuantity } from '../shared/orderQuantitySummary';
import { PrismaClient, Prisma } from '@prisma/client';
import { ParsedOrder, ParsedShipTo } from './types';
import { allocateInternalOrderCode } from '../orders/orderIdentity';
import { businessError, ERROR_CODES } from '../shared/errorCodes';

export interface PersistResult {
  poNumber: string;
  orderId: string;
  action: 'created' | 'updated';
  linesSaved: number;
  /** Names of header fields skipped because they were marked 'manual' in fieldSources. */
  skippedFields: string[];
  /** Per-line fields skipped (key = itemNo, value = list of field names). */
  skippedLineFields: Record<string, string[]>;
}

/** Historical per-field provenance tag stored in `Order.fieldSources` (JSONB). */
export type FieldSourceTag = 'pdf' | 'manual' | 'imported-then-edited';

export type PersistMode =
  /**
   * (default) Per-field overwrite protection for privileged legacy parsed-order
   * migrations. This is not connected to the current customer PO workflow.
   */
  | 'overwrite-pdf-fields-only'
  /** Force-overwrite every field, regardless of its provenance tag. */
  | 'force-overwrite';

export interface PersistOrdersOptions {
  /** Override the current timestamp (test seam). */
  now?: () => number;
  /**
   * @deprecated Use `mode` instead. When false, an existing PO is left alone.
   * When true (default), behaviour depends on `mode` (default 'overwrite-pdf-fields-only').
   */
  overwriteExisting?: boolean;
  /** See `PersistMode` JSDoc. */
  mode?: PersistMode;
}

/**
 * Persist a batch of parsed PO orders into the Order + OrderLine tables.
 *
 * Idempotency: keyed on the legacy customer + fabric domain + external PO.
 * Shared garment references never identify this migration's target. Re-running
 * the same legacy record updates that row,
 * but per-field overwrite protection (via `fieldSources`) prevents trampling on
 * any field a user has manually edited from the detail card or manual entry form.
 *
 * Atomicity: each order is saved in its own transaction; one bad order will not
 * roll back the others. The caller decides how to handle partial success.
 */
export async function persistOrders(
  prisma: PrismaClient,
  parsedOrders: ParsedOrder[],
  opts: PersistOrdersOptions = {},
): Promise<PersistResult[]> {
  const now = opts.now ?? (() => Date.now());
  const mode: PersistMode =
    opts.mode ?? (opts.overwriteExisting === false ? 'overwrite-pdf-fields-only' : 'overwrite-pdf-fields-only');
  const skipExisting = opts.overwriteExisting === false;
  const results: PersistResult[] = [];

  for (const parsed of parsedOrders) {
    if (!parsed.poNumber) {
      throw new Error('persistOrders: poNumber is required');
    }

    const identity = { poNumber: parsed.poNumber, customerCode: parsed.customerId, type: { equals: 'fabric', mode: 'insensitive' as const } };
    const candidates = await prisma.order.findMany({ where: identity, select: { id: true, fieldSources: true }, take: 2 });
    if (candidates.length > 1) throw businessError('AMBIGUOUS_ORDER_REFERENCE', '历史导入存在多张相同客户与面料 PO 的订单，请先选择准确内部记录。');
    const existing = candidates[0];

    if (existing && skipExisting) {
      results.push({
        poNumber: parsed.poNumber,
        orderId: existing.id,
        action: 'updated',
        linesSaved: 0,
        skippedFields: [],
        skippedLineFields: {},
      });
      continue;
    }

    let orderId = existing?.id ?? makeOrderId(parsed.poNumber);
    const ts = now();
    const incoming = mapHeader(parsed, ts);
    let lineRows = parsed.lines.map((l, i) => mapLine(orderId, l, i));
    let skippedFields: string[] = [];

    const skippedLineFields: Record<string, string[]> = {};

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(PrismaSql.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-order:fabric:${parsed.customerId}:${parsed.poNumber}`}, 0))`);
      // Re-read provenance only after the actual parent lock; a queued import
      // must honor manual edits committed while it waited for this lock.
      await tx.$queryRaw(PrismaSql.sql`SELECT "id" FROM "Order" WHERE "poNumber"=${parsed.poNumber} FOR UPDATE`);
      const freshCandidates = await tx.order.findMany({ where: identity, select: { id: true, fieldSources: true }, take: 2 });
      if (freshCandidates.length > 1) throw businessError('AMBIGUOUS_ORDER_REFERENCE', ERROR_CODES.AMBIGUOUS_ORDER_REFERENCE.message);
      const freshOrder = freshCandidates[0];
      if (freshOrder) {
        orderId = freshOrder.id;
        lineRows = parsed.lines.map((line, index) => mapLine(orderId, line, index));
      }
      if (freshOrder?.id && await tx.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: freshOrder.id, status: 'pending' }, select: { id: true } })) {
        throw Object.assign(new Error(`PO ${parsed.poNumber} 正在等待主单审批，不能通过导入改写冻结内容。`), { code: 'ORDER_APPROVAL_PENDING' });
      }
      const headerUpdate = { ...incoming.update };
      // Empty parsing is not an employee deleting the final line. Do not erase
      // a real legacy header merely because there is nothing to reconcile.
      delete headerUpdate.quantity;
      delete headerUpdate.unit;
      const protectedHeader = applyOverwriteProtection(headerUpdate, parseFieldSources(freshOrder?.fieldSources), mode);
      const { update, nextSources } = protectedHeader;
      skippedFields = protectedHeader.skippedFields;
      await tx.$queryRaw(PrismaSql.sql`SELECT "id" FROM "OrderLine" WHERE "orderId"=${orderId} ORDER BY "id" FOR UPDATE`);
      const freshLines = await tx.orderLine.findMany({ where: { orderId }, select: { itemNo: true, fieldSources: true } });
      const lineSourcesByItemNo = new Map<string, Record<string, FieldSourceTag>>();
      for (const line of freshLines) if (line.itemNo) lineSourcesByItemNo.set(line.itemNo, parseFieldSources(line.fieldSources));
      if (freshOrder) {
        await tx.order.update({ where: { id: orderId }, data: { ...update, fieldSources: nextSources as Prisma.InputJsonValue } });
      } else {
        await tx.order.create({ data: { id: orderId, code: await allocateInternalOrderCode(tx),
          ...incoming.create, fieldSources: incoming.pdfSources as Prisma.InputJsonValue } as Prisma.OrderCreateInput });
      }

      for (const line of lineRows) {
        const itemNo = line.itemNo ?? String(line.lineNumber * 10).padStart(4, '0');
        const prevLineSources = lineSourcesByItemNo.get(itemNo) ?? {};
        const linePdfSources = line._pdfSources;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _pdfSources, ...lineCreateData } = line;

        // Build the raw update payload (same as before, but without fieldSources).
        const rawUpdate: Record<string, unknown> = {
          lineNumber: line.lineNumber,
          materialCode: line.materialCode,
          millQuality: line.millQuality,
          description: line.description,
          width: line.width,
          exMillDate: line.exMillDate,
          deliveryDate: line.deliveryDate,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          netValue: line.netValue,
          via: line.via,
          cloth: line.cloth,
          weight: line.weight,
          category: line.category,
          notes: line.notes,
        };

        const { update: protectedUpdate, skippedFields: lineSkipped, nextSources: nextLineSources } =
          applyOverwriteProtection(rawUpdate, prevLineSources, mode);

        if (lineSkipped.length > 0) {
          skippedLineFields[itemNo] = lineSkipped;
        }

        await tx.orderLine.upsert({
          where: {
            orderId_itemNo: { orderId, itemNo },
          },
          create: {
            ...lineCreateData,
            // The controlled legacy importer only models fabric POs. Freeze
            // today's mandatory sample families for newly imported rows; a
            // re-import must not rewrite a previously frozen requirement.
            requiredSampleFamilies: ['fabric_eps', 'fabric_ss'] as Prisma.InputJsonValue,
            fieldSources: linePdfSources as Prisma.InputJsonValue,
          },
          update: {
            ...protectedUpdate,
            fieldSources: nextLineSources as Prisma.InputJsonValue,
          },
        });
      }

      // PDF is the source of truth for the line set: delete old lines that are
      // no longer present in the re-imported PDF (e.g. source PDF has fewer lines).
      const newItemNos = lineRows.map((l) => l.itemNo ?? String(l.lineNumber * 10).padStart(4, '0'));
      if (newItemNos.length > 0) {
        await tx.orderLine.deleteMany({
          where: { orderId, NOT: { itemNo: { in: newItemNos } } },
        });
      }
      if (lineRows.length > 0) await refreshOrderQuantityHeader(tx, orderId);
    });

    results.push({
      poNumber: parsed.poNumber,
      orderId,
      action: existing ? 'updated' : 'created',
      linesSaved: lineRows.length,
      skippedFields,
      skippedLineFields,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Overwrite-protection layer (exported for unit tests)
// ---------------------------------------------------------------------------

export function parseFieldSources(raw: unknown): Record<string, FieldSourceTag> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, FieldSourceTag> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === 'pdf' || v === 'manual' || v === 'imported-then-edited') out[k] = v;
  }
  return out;
}

/**
 * Strip fields the user has manually overridden from the update payload.
 * Returns the filtered update + the new fieldSources map to write back.
 *
 * Exported so unit tests can verify the protection rules without spinning
 * up a Prisma client.
 */
export function applyOverwriteProtection(
  update: Record<string, unknown>,
  previous: Record<string, FieldSourceTag>,
  mode: PersistMode,
): {
  update: Record<string, unknown>;
  skippedFields: string[];
  nextSources: Record<string, FieldSourceTag>;
} {
  const skipped: string[] = [];
  const filtered: Record<string, unknown> = {};
  const next: Record<string, FieldSourceTag> = { ...previous };

  for (const [k, v] of Object.entries(update)) {
    if (mode === 'force-overwrite') {
      filtered[k] = v;
      next[k] = 'pdf';
      continue;
    }
    const prevTag = previous[k];
    if (prevTag === 'manual' || prevTag === 'imported-then-edited') {
      skipped.push(k);
      // Leave the existing tag untouched.
      continue;
    }
    filtered[k] = v;
    next[k] = 'pdf';
  }

  return { update: filtered, skippedFields: skipped, nextSources: next };
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

/**
 * Build both `create` and `update` payloads for the Order upsert. We split them
 * because `id` may only appear in `create` and we want to stamp `importedAt`
 * differently on first insert vs subsequent overwrites.
 *
 * Phase 3 changes:
 *   - Stop writing ship-to company into `factoryName` (semantic mismatch).
 *     `factoryName` is now legacy. Ship-to data goes into `consigneeName /
 *     consigneeAddress / consigneeContact`.
 *   - Emit `pdfSources` so the caller can stamp `fieldSources` for new rows.
 */
function mapHeader(parsed: ParsedOrder, ts: number) {
  const firstExMill = parsed.lines.find((l) => l.exMillDate)?.exMillDate ?? '';
  const customerLabel = humanizeCustomer(parsed.customerId);
  // product 字段在订单列表里当"描述"列用，所以放第一行的实际描述（cloth/description）。
  const firstLine = parsed.lines[0];
  const firstDesc = firstLine?.description || firstLine?.cloth || '';
  const productLabel = firstDesc
    ? (parsed.lines.length > 1 ? `${firstDesc} · 共${parsed.lines.length}行` : firstDesc)
    : `PO ${parsed.poNumber} (${parsed.lines.length} 行)`;
  const ship = flattenShipTo(parsed.shipTo);

  // Header values written by the legacy parsed-order migration. Each becomes an
  // `fieldSources`. Phase 6 dropped `factoryName` from the schema.
  //
  // ★★ S4 步骤 6.3 登记（2026-09-25，**未改行为**）：本处是**未走真源**的写入路径。
  //   真源 = server/src/shared/orderAmount.ts（口径：订单金额 = Σ明细行 netValue，
  //   主档金额由明细行派生、不手工填 —— Kevin 2026-09-18 拍板）。
  //   而这里直接落主档金额、**不校验真源**：
  //     · quoteAmount    = parsed.totalActual ?? 0      ← ★ `??` 挡不住 `0`（0 ?? null 仍是 0）
  //     · totalNet       = parsed.totalNet
  //     · totalActual    = parsed.totalActual
  //     · contractAmount = parsed.totalActual ?? null   ← 同款 `??` 问题
  //   ⇒ 与 S4 任务 5（手动编辑路径与真源不同步）**同类**：都是「写入点没走收口」。
  //   ⇒ 此落库函数仅供受控历史数据迁移；业务员不得通过 POST /orders/import 写正式订单，
  //      该兼容入口由 `data:import` + `users:admin` JWT 双权限保护，不用于 PO 上传/录单。
  const common: Record<string, unknown> = {
    customer: customerLabel,
    product: productLabel,
    type: 'Fabric',
    quantity: null,
    unit: null,
    status: 'Pending',
    // 订单主交期以 Exmill（出厂日期）为准，和前端卡片保持一致。
    dueDate: firstExMill,
    quoteAmount: parsed.totalActual ?? 0,

    poNumber: parsed.poNumber,
    customerCode: parsed.customerId,
    season: parsed.season,
    poDate: parsed.poDate,
    contactPerson: parsed.contactPerson,
    contactPhone: parsed.contactPhone,
    currency: parsed.currency,
    deliveryTerms: parsed.deliveryTerms,
    paymentTerms: parsed.paymentTerms,
    shipToName: ship.name,
    shipToAddress1: ship.address1,
    shipToAddress2: ship.address2,
    shipToCountry: ship.country,
    deliverTo: parsed.deliverTo ?? null,
    totalNet: parsed.totalNet,
    totalActual: parsed.totalActual,
    source: 'pdf-import',
    updatedAt: BigInt(ts),

    // Phase 3: role + currency + sticky overlays
    consigneeName: ship.company ?? null,
    consigneeAddress: joinAddress(ship.address1, ship.address2),
    consigneeContact: parsed.contactPerson ?? null,
    salesCurrency: parsed.currency ?? 'USD',
    purchaseCurrency: 'CNY',
    contractAmount: parsed.totalActual ?? null,
    // Sticky overlays for the detail card so the rich card has something to
    // show on first import. Per-field overwrite protection means subsequent
    // imports won't trample manual edits.
    clientCode: firstLine?.materialCode ?? null,
    productColorCode: firstLine?.millQuality ?? null,
    productionDate: firstLine?.deliveryDate ?? null,
    clientDate: firstExMill || null,
    fabricCode: firstLine?.itemNo ?? null,
    fabricContent: firstLine?.cloth ?? null,
    width: firstLine?.width ?? null,
    gsm: firstLine?.weight ?? null,
  };

  const pdfSources: Record<string, FieldSourceTag> = {};
  for (const k of Object.keys(common)) {
    // Internal bookkeeping columns aren't user-visible — don't bother tagging.
    if (k === 'updatedAt' || k === 'source' || k === 'type') continue;
    pdfSources[k] = 'pdf';
  }

  return {
    create: { ...common, importedAt: BigInt(ts) } as Omit<Prisma.OrderUncheckedCreateInput, 'id'>,
    // On re-import we refresh everything except importedAt (keep first-import time).
    update: common,
    pdfSources,
  };
}

type LineRowWithSources = Prisma.OrderLineCreateManyInput & {
  _pdfSources: Record<string, FieldSourceTag>;
};

function mapLine(orderId: string, l: ParsedOrder['lines'][number], idx: number): LineRowWithSources {
  const fields: Record<string, unknown> = {
    id: `${orderId}__L${String(idx + 1).padStart(3, '0')}`,
    orderId,
    lineNumber: idx + 1,
    itemNo: l.itemNo || String((idx + 1) * 10).padStart(4, '0'),
    materialCode: l.materialCode || null,
    millQuality: l.millQuality || null,
    description: l.description || null,
    width: l.width || null,
    exMillDate: l.exMillDate || null,
    deliveryDate: l.deliveryDate || null,
    quantity: parseOrderQuantity(l.quantity),
    unit: l.unit || null,
    unitPrice: Number.isFinite(l.unitPrice) ? l.unitPrice : null,
    netValue: Number.isFinite(l.netValue) ? l.netValue : null,
    via: l.via || null,
    cloth: l.cloth || null,
    weight: l.weight ?? null,
    category: l.category ?? null,
    notes: l.notes && l.notes.length ? l.notes.join('\n') : null,
    status: 'Pending',
  };

  // Build fieldSources: tag every PDF-origin field as 'pdf'.
  const pdfSources: Record<string, FieldSourceTag> = {};
  for (const k of Object.keys(fields)) {
    if (k === 'id' || k === 'orderId' || k === 'status') continue;
    pdfSources[k] = 'pdf';
  }

  return { ...fields, _pdfSources: pdfSources } as LineRowWithSources;
}

function flattenShipTo(s: ParsedShipTo | undefined) {
  if (!s) return { name: undefined, company: undefined, address1: undefined, address2: undefined, country: undefined };
  const name = s.company || s.contactName || undefined;
  const lines = s.addressLines ?? [];
  return {
    name,
    company: s.company || undefined,
    address1: lines[0],
    address2: lines.slice(1).filter(Boolean).join(' / ') || undefined,
    country: s.country,
  };
}

function joinAddress(a?: string, b?: string): string | null {
  const parts = [a, b].filter((x) => !!x && String(x).trim() !== '');
  return parts.length ? parts.join(' ') : null;
}

function humanizeCustomer(code: string): string {
  if (!code) return '';
  if (code === 'peerless') return 'Peerless';
  return code.charAt(0).toUpperCase() + code.slice(1);
}

function makeOrderId(poNumber: string): string {
  // Stable, human-readable id derived from PO number. Sanitised so it stays URL-safe.
  const safe = poNumber.replace(/[^A-Za-z0-9_-]/g, '-');
  return `PO-${safe}`;
}

function sum(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
