/**
 * company-sim/trade-docs.ts — 订单→出运→报关→单据归档（联动④）
 *
 * 剧情（确定性）：
 *   - 全部已出运订单（成衣 38 单 38 票 + 面料 9 单 10 票 = 48 票）每票一张出口报关单
 *     （SIM-CD-xxxx，status=Released，行级 hsCode 按品类/面料行级真源）+ 报关行/口岸/毛净重对齐 Shipment；
 *   - 每票归档 3 张单据中心 TradeDocument（domain='customs'，status=Issued）：
 *     BillOfLading（提单）/ CommercialInvoice（sourceInvoiceId=财务 Invoice，引用不复制）/ PackingList，
 *     各挂 DocumentVersion v1 内容快照；
 *   - 回填 Shipment.customsDeclarationNumber / customsClearanceDate；
 *   - 一单一票为主；面料分批出运大单（SIM-FORD-006）一单 2 票 → 2 张报关单 + 6 张单据。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { isoDate, createManyLogged } from './common';
import { CUSTOMERS } from './master-data';
import type { OrderPlan } from './orders';
import { type FabricOrderPlan } from './fabric-orders';

const DAY = 24 * 3600 * 1000;
const HS_BY_CATEGORY: Record<string, string> = { Dress: '6204.43.00', Blouse: '6206.40.00', 'Knit Top': '6110.20.99' };
const CONSIGNOR = '竹衍服饰有限公司（PandaClothing）';

interface ShipmentSnap {
  id: string;
  totalPackages: number | null;
  grossWeight: Prisma.Decimal | null;
  netWeight: Prisma.Decimal | null;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  carrierName: string | null;
  customsBroker: string | null;
}

/** 报关行文案：成衣按品类；面料行带行级真源（description/hsCode/unit/kgPerUnit） */
function lineProductName(l: OrderPlan['linePlans'][number] | FabricOrderPlan['linePlans'][number]): string {
  const anyLine = l as Record<string, unknown>;
  return typeof anyLine.description === 'string' ? (anyLine.description as string) : `Ladies' ${(l as OrderPlan['linePlans'][number]).category}`;
}
function lineHsCode(l: OrderPlan['linePlans'][number] | FabricOrderPlan['linePlans'][number]): string {
  const anyLine = l as Record<string, unknown>;
  return typeof anyLine.hsCode === 'string' ? (anyLine.hsCode as string) : HS_BY_CATEGORY[(l as OrderPlan['linePlans'][number]).category] ?? '6204.43.00';
}
function lineUnit(l: OrderPlan['linePlans'][number] | FabricOrderPlan['linePlans'][number]): string {
  const anyLine = l as Record<string, unknown>;
  return typeof anyLine.unit === 'string' ? (anyLine.unit as string) : 'PCS';
}
function lineKgPerUnit(l: OrderPlan['linePlans'][number] | FabricOrderPlan['linePlans'][number]): number {
  const anyLine = l as Record<string, unknown>;
  return typeof anyLine.kgPerUnit === 'number' ? (anyLine.kgPerUnit as number) : 0.38;
}
function lineNetKgPerUnit(l: OrderPlan['linePlans'][number] | FabricOrderPlan['linePlans'][number]): number {
  const anyLine = l as Record<string, unknown>;
  return typeof anyLine.kgPerUnit === 'number' ? (anyLine.kgPerUnit as number) * 0.875 : 0.33;
}

export async function seedTradeDocs(prisma: PrismaClient, plans: Array<OrderPlan | FabricOrderPlan>): Promise<void> {
  console.log('── 报关单 + 单据中心归档（48 票已出运，含面料分批 2 票） ──');

  // reset-dev-business-data 的 DELETE_PLAN 未包含 documentVersion（遗留缺口）：
  // 历史会话的孤儿版本会跨 reset 存活，此处清空后由本次归档重建，保证「版本表 ↔ 单据表」一致。
  const purged = await prisma.documentVersion.deleteMany({});
  if (purged.count > 0) console.log(`  DocumentVersion 预清理（reset 缺口/历史孤儿）: ${purged.count} 行`);

  const shipped = plans.filter((p) => p.fate === 'Delivered' || p.fate === 'Shipping');
  const orderIds = shipped.map((p) => p.id);

  const shipments = await prisma.shipment.findMany({
    where: { orderId: { in: orderIds }, deletedAt: null },
    select: {
      id: true, orderId: true, totalPackages: true, grossWeight: true, netWeight: true,
      portOfLoading: true, portOfDischarge: true, carrierName: true, customsBroker: true,
    },
  });
  // 一单一票为主；面料分批出运单（SIM-FORD-006）一单 2 票
  const shipsByOrder = new Map<string, ShipmentSnap[]>();
  for (const s of shipments) {
    const snap: ShipmentSnap = {
      id: s.id, totalPackages: s.totalPackages, grossWeight: s.grossWeight, netWeight: s.netWeight,
      portOfLoading: s.portOfLoading, portOfDischarge: s.portOfDischarge,
      carrierName: s.carrierName, customsBroker: s.customsBroker,
    };
    const arr = shipsByOrder.get(s.orderId!) ?? [];
    arr.push(snap);
    shipsByOrder.set(s.orderId!, arr);
  }
  const invoices = await prisma.invoice.findMany({
    where: { orderId: { in: orderIds }, deletedAt: null },
    select: { id: true, orderId: true },
  });
  const invoiceIdsByOrder = new Map<string, string[]>();
  for (const i of invoices) {
    const arr = invoiceIdsByOrder.get(i.orderId!) ?? [];
    arr.push(i.id);
    invoiceIdsByOrder.set(i.orderId!, arr);
  }

  const cdRows: Prisma.CustomsDeclarationUncheckedCreateInput[] = [];
  const cdlRows: Prisma.CustomsDeclarationLineUncheckedCreateInput[] = [];
  const tdRows: Prisma.TradeDocumentUncheckedCreateInput[] = [];
  const dverRows: Prisma.DocumentVersionUncheckedCreateInput[] = [];
  const shipmentUpdates: Array<{ id: string; declarationNumber: string; clearanceDate: string; updatedAt: number }> = [];

  let cdSeq = 0; // 成衣 38 票在前（CD-001..038 保持不变），面料 10 票追加在后
  for (const p of shipped) {
    const ships = shipsByOrder.get(p.id) ?? [];
    if (ships.length === 0) throw new Error(`订单 ${p.id} 缺少 Shipment，无法铺报关链`);
    const cust = CUSTOMERS.find((c) => c.id === p.customerId) ?? CUSTOMERS[0];
    const invoiceIds = invoiceIdsByOrder.get(p.id) ?? [];

    ships.forEach((ship, shipIdx) => {
      cdSeq += 1;
      const shipMs = p.shipMs ?? p.createdAtMs;
      const cdId = `SIM-CD-${String(cdSeq).padStart(3, '0')}`;
      const declarationNumber = `SIM-CD-2026-${String(cdSeq).padStart(4, '0')}`;
      // 分批出运：报关金额按票数均摊（首票全额-尾票、或按比例）；面料分批单票额已按 70/30 落库，
      // 此处以「订单额 ÷ 票数 × 票序权重」近似——分批单由 shipment/batch/invoice 侧真源承载精确金额。
      const isSplit = ships.length > 1;
      const legRatio = isSplit ? (shipIdx === 0 ? 0.7 : 0.3) : 1;
      const cdValue = Math.round(Number(new Prisma.Decimal(p.amount).mul(legRatio)) * 100) / 100;

      cdRows.push({
        id: cdId, declarationNumber,
        shipmentId: ship.id, orderId: p.id, relationId: p.customerId,
        type: 'Export', status: 'Released',
        declarationDate: isoDate(shipMs + shipIdx * 7 * DAY), customsCode: '2201', declarationPort: 'Shanghai',
        tradeTerms: 'FOB',
        totalValue: new Prisma.Decimal(cdValue), currency: p.currency,
        totalPackages: ship.totalPackages, grossWeight: ship.grossWeight, netWeight: ship.netWeight,
        originCountry: 'China', destinationCountry: cust.country,
        consignee: p.customerName, consignor: CONSIGNOR,
        declarant: 'Hank Zheng', agent: ship.customsBroker ?? '上海华港报关行',
        notes: isSplit ? `分批出运第 ${shipIdx + 1} 票（${Math.round(legRatio * 100)}% 口径）。` : null,
        createdAt: BigInt(shipMs - 2 * DAY + shipIdx * 7 * DAY), updatedAt: BigInt(shipMs + shipIdx * 7 * DAY), deletedAt: null,
      });
      p.linePlans.forEach((l, li) => {
        const legQty = Math.round(l.qty * legRatio / 100) * 100;
        cdlRows.push({
          id: `${cdId}-L${li + 1}`, declarationId: cdId, lineNumber: li + 1,
          productCode: l.styleNo, productName: lineProductName(l),
          hsCode: lineHsCode(l),
          brandName: null, specification: `${l.color} / SS26`,
          quantity: new Prisma.Decimal(legQty), unit: lineUnit(l),
          unitPrice: new Prisma.Decimal(l.price), totalAmount: new Prisma.Decimal(Math.round(l.netValue * legRatio * 100) / 100),
          currency: p.currency,
          grossWeight: new Prisma.Decimal(Math.round(legQty * lineKgPerUnit(l) * 100) / 100),
          netWeight: new Prisma.Decimal(Math.round(legQty * lineNetKgPerUnit(l) * 100) / 100),
          originCountry: 'China', notes: null,
          createdAt: BigInt(shipMs - 2 * DAY + shipIdx * 7 * DAY), updatedAt: BigInt(shipMs + shipIdx * 7 * DAY),
        });
      });
      shipmentUpdates.push({
        id: ship.id, declarationNumber, clearanceDate: isoDate(shipMs + shipIdx * 7 * DAY), updatedAt: shipMs + shipIdx * 7 * DAY,
      });

      // 单据中心归档：每票 3 张（B/L / CommercialInvoice / PackingList）
      const invoiceId = invoiceIds[shipIdx] ?? invoiceIds[0] ?? null;
      const docDefs: Array<{
        type: string; issueDate: string; issuedBy: string;
        totalAmount: Prisma.Decimal | null; currency: string | null;
        sourceInvoiceId: string | null; notes: string | null;
      }> = [
        {
          type: 'BillOfLading', issueDate: isoDate(shipMs + shipIdx * 7 * DAY), issuedBy: ship.carrierName ?? '货代签发',
          totalAmount: null, currency: null, sourceInvoiceId: null,
          notes: `提单随船签发（${ship.portOfLoading} → ${ship.portOfDischarge}）`,
        },
        {
          type: 'CommercialInvoice', issueDate: isoDate(shipMs + shipIdx * 7 * DAY), issuedBy: CONSIGNOR,
          totalAmount: new Prisma.Decimal(cdValue), currency: p.currency,
          sourceInvoiceId: invoiceId,
          notes: invoiceId ? '交单号=财务发票号（引用不复制）' : '财务发票缺失（SIM 兜底）',
        },
        {
          type: 'PackingList', issueDate: isoDate(shipMs - 1 * DAY + shipIdx * 7 * DAY), issuedBy: CONSIGNOR,
          totalAmount: null, currency: null, sourceInvoiceId: null,
          notes: `箱数 ${ship.totalPackages ?? 0}，毛重 ${Number(ship.grossWeight ?? 0)}kg，净重 ${Number(ship.netWeight ?? 0)}kg`,
        },
      ];
      docDefs.forEach((d) => {
        const tdSeq = tdRows.length + 1;
        const tdId = `SIM-TD-${String(tdSeq).padStart(4, '0')}`;
        tdRows.push({
          id: tdId, documentNumber: tdId, domain: 'customs', type: d.type, status: 'Issued',
          shipmentId: ship.id, declarationId: cdId, orderId: p.id, relationId: p.customerId,
          sourceInvoiceId: d.sourceInvoiceId, sourceRef: null,
          issueDate: d.issueDate, expiryDate: null, issuedBy: d.issuedBy,
          consignee: p.customerName, consignor: CONSIGNOR,
          portOfLoading: ship.portOfLoading, portOfDischarge: ship.portOfDischarge,
          totalAmount: d.totalAmount, currency: d.currency,
          filePath: null, fileName: null, notes: d.notes,
          createdAt: BigInt(shipMs - 2 * DAY + shipIdx * 7 * DAY), updatedAt: BigInt(shipMs + shipIdx * 7 * DAY), deletedAt: null,
        });
        dverRows.push({
          id: `${tdId}-V1`, documentId: tdId, version: 1,
          content: {
            documentNumber: tdId, domain: 'customs', type: d.type, status: 'Issued',
            shipmentId: ship.id, declarationId: cdId, orderId: p.id,
            issueDate: d.issueDate, issuedBy: d.issuedBy,
            consignee: p.customerName, consignor: CONSIGNOR,
            portOfLoading: ship.portOfLoading, portOfDischarge: ship.portOfDischarge,
            totalAmount: d.totalAmount === null ? null : Number(d.totalAmount),
            currency: d.currency, notes: d.notes,
          },
          changeReason: null, changedBy: 'Hank Zheng', createdAt: BigInt(shipMs + shipIdx * 7 * DAY),
        });
      });
    });
  }

  await createManyLogged(prisma, 'customsDeclaration', 'CustomsDeclaration', cdRows);
  await createManyLogged(prisma, 'customsDeclarationLine', 'CustomsDeclarationLine', cdlRows);
  await createManyLogged(prisma, 'tradeDocument', 'TradeDocument', tdRows);
  await createManyLogged(prisma, 'documentVersion', 'DocumentVersion', dverRows);

  // 回填 Shipment 报关单号 + 清关日期
  for (const u of shipmentUpdates) {
    await prisma.shipment.update({
      where: { id: u.id },
      data: {
        customsDeclarationNumber: u.declarationNumber,
        customsClearanceDate: u.clearanceDate,
        updatedAt: BigInt(u.updatedAt),
      },
    });
  }
  console.log(`  Shipment 回填（报关单号/清关日期）: ${shipmentUpdates.length} 票`);
}
