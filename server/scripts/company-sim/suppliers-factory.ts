/**
 * company-sim/suppliers-factory.ts — 供应商工厂域（2026-09-02 补数，审计 P1：
 * FactoryProfile / FactoryEvaluation / FactoryCertification / FactoryCapacity 全 0 行，
 * SuppliersManager 五 tab 空转）
 *
 * 覆盖（10 家供应商 SIM-SUP-01..10 全量）：
 *   - FactoryProfile 10 条：月产能 / 工人数 / 设备 / 擅长品类 / 价格档 /
 *     银行信息（成立年份 + 地址入 notes，schema 无独立列）；totalOrders/totalAmount
 *     按 DB 实况聚合——面料厂（SUP-01..04）取采购单原币（CNY）累计，
 *     成衣厂（SUP-08..10）取 millRelationId 订单数 + totalNet 按 common 汇率常量折 CNY；
 *   - FactoryEvaluation：真源挂 DB 实查——验货评估（kind=inspection，
 *     sourceType=inspectionReport，挂真实 InspectionReport，分数口径与
 *     factoryService.inspectionScoreForResult 一致：pass=95 / conditional=70）+
 *     交期评估（kind=delivery，sourceType=shipment 挂真实运单 / purchaseOrder 挂真实
 *     采购单到料）+ 辅料商人工评估（sourceType=manual）+ 1 条延迟人工记录（剧情）；
 *   - FactoryCertification 每厂 1-2 条（ISO9001/OEKO-TEX/GRS/BSCI/SEDEX），
 *     3 条临近到期 / 已过期喂认证预警扫描（2026-09-20 / 2026-10-15 / 2026-08-15）；
 *   - FactoryCapacity 产能日历 2026-06..09 × 10 厂（月度计划产能）。
 *
 * 评分缓存一致性：FactoryProfile.qualityScore/deliveryScore = 各自 kind 评估均值
 * （与 factoryService.addEvaluation 同事务重算口径完全一致——append-only 真源，
 * 缓存分只读派生，seed 后续真实追加评估触发重算不会漂移）。
 *
 * 确定性：SIM- 前缀 ID；幂等：--reset 全清重建（reset-dev-business-data 已覆盖四表）。
 * 依赖：须在 orders/fabric-orders（阶段 2/2.1）之后执行（评估锚点实查订单链数据）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { createManyLogged, USERS, USD_CNY_RATE, EUR_CNY_RATE } from './common';
import { SUPPLIERS, SUPPLIER_ADDR } from './master-data';

const DAY = 24 * 3600 * 1000;
const CAPACITY_MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09'];

/** 验货评分（与 factoryService.inspectionScoreForResult 同口径；致命疵点场景本 seed 无 fail 单） */
function inspectionScore(result: string): number {
  if (result === 'fail') return 20;
  if (result === 'conditional') return 70;
  return 95;
}

interface CertSpec { type: string; certNo: string; issuedAt: string; validUntil: string }

interface FactorySpec {
  monthlyCapacity: number;
  capacityUnit: 'M' | 'PC';
  workerCount: number;
  equipmentList: string;
  specialties: string[];
  priceLevel: 'High' | 'Mid' | 'Low';
  founded: string;
  bankName: string;
  bankAccount: string;
  certs: CertSpec[];
  /** 辅料商（无订单链）人工评估分；有订单链的厂走 DB 实查 */
  manualScore?: number;
  manualNote?: string;
}

const FACTORY_SPECS: FactorySpec[] = [
  { // SUP-01 吴江恒溢织造（梭织面料厂）
    monthlyCapacity: 520000, capacityUnit: 'M', workerCount: 265,
    equipmentList: '喷水织机 120 台 / 浆纱机 4 套 / 定型机 3 台',
    specialties: ['梭织面料', '天丝/莫代尔', '弹力斜纹'], priceLevel: 'Mid',
    founded: '2008', bankName: '中国工商银行吴江支行', bankAccount: '1102-4456-8801',
    certs: [
      { type: 'ISO9001', certNo: 'ISO-9001-2015-JS0881', issuedAt: '2024-06-30', validUntil: '2027-06-30' },
      { type: 'OEKO-TEX Standard 100', certNo: 'OT-2026-1122', issuedAt: '2026-03-31', validUntil: '2027-03-31' },
    ],
  },
  { // SUP-02 绍兴瑞丰针织（针织面料厂，1 条临近到期认证喂预警）
    monthlyCapacity: 460000, capacityUnit: 'M', workerCount: 198,
    equipmentList: '大圆机 68 台 / 溢流染色缸 12 组 / 定型机 4 台',
    specialties: ['针织面料', '汗布/罗纹', '空气层'], priceLevel: 'Mid',
    founded: '2011', bankName: '中国银行绍兴柯桥支行', bankAccount: '1055-8890-2231',
    certs: [
      { type: 'ISO9001', certNo: 'ISO-9001-2015-ZX0412', issuedAt: '2023-09-20', validUntil: '2026-09-20' },
      { type: 'GRS', certNo: 'GRS-2025-7741', issuedAt: '2025-05-12', validUntil: '2027-12-31' },
    ],
    manualScore: 60,
    manualNote: '旺季染缸排产延迟 9 天，交期评估降档（人工记录，剧情：延迟整改跟踪中）',
  },
  { // SUP-03 常州华瑞印染（染整厂）
    monthlyCapacity: 680000, capacityUnit: 'M', workerCount: 175,
    equipmentList: '溢流染色线 8 条 / 轧染线 2 条 / 数码印花机 6 台',
    specialties: ['染整加工', '印花', '功能性后整理'], priceLevel: 'Mid',
    founded: '2006', bankName: '中国建设银行常州支行', bankAccount: '3205-6612-0093',
    certs: [
      { type: 'ISO9001', certNo: 'ISO-9001-2015-CZ1155', issuedAt: '2024-01-31', validUntil: '2027-01-31' },
      { type: 'OEKO-TEX Standard 100', certNo: 'OT-2026-0768', issuedAt: '2025-10-15', validUntil: '2026-10-15' },
    ],
  },
  { // SUP-04 江苏鹿港高科技针织（针织面料厂）
    monthlyCapacity: 590000, capacityUnit: 'M', workerCount: 320,
    equipmentList: '经编机 45 台 / 大圆机 90 台 / 磨毛机 3 台',
    specialties: ['经编', '摇粒绒', '高弹针织'], priceLevel: 'Low',
    founded: '2003', bankName: '招商银行张家港支行', bankAccount: '5129-3307-4415',
    certs: [
      { type: 'ISO9001', certNo: 'ISO-9001-2015-JS2207', issuedAt: '2025-03-31', validUntil: '2028-03-31' },
      { type: 'GRS', certNo: 'GRS-2026-1190', issuedAt: '2026-02-28', validUntil: '2027-08-31' },
    ],
  },
  { // SUP-05 上海永信拉链（辅料）
    monthlyCapacity: 1500000, capacityUnit: 'PC', workerCount: 86,
    equipmentList: '尼龙制链线 12 条 / 金属排牙线 3 条 / 电镀线 2 条',
    specialties: ['尼龙拉链', '金属拉链', '隐形拉链'], priceLevel: 'Mid',
    founded: '2014', bankName: '中国农业银行上海闵行支行', bankAccount: '0337-5521-8866',
    certs: [{ type: 'ISO9001', certNo: 'ISO-9001-2015-SH3391', issuedAt: '2024-09-30', validUntil: '2027-09-30' }],
    manualScore: 92, manualNote: '打样响应快，交期稳定（人工季度评估）',
  },
  { // SUP-06 宁波华孚纽扣（辅料）
    monthlyCapacity: 2600000, capacityUnit: 'PC', workerCount: 62,
    equipmentList: '注塑机 24 台 / 造面机 8 台 / 激光刻字机 4 台',
    specialties: ['树脂纽扣', '贝壳纽扣', '金属扣'], priceLevel: 'Low',
    founded: '2016', bankName: '中国工商银行宁波支行', bankAccount: '3902-1145-7788',
    certs: [{ type: 'ISO9001', certNo: 'ISO-9001-2015-NB0674', issuedAt: '2025-05-31', validUntil: '2027-05-31' }],
    manualScore: 85, manualNote: '常规扣类品质稳定，贝壳扣批次色差偶发（人工季度评估）',
  },
  { // SUP-07 苏州锦绣织标（辅料）
    monthlyCapacity: 900000, capacityUnit: 'PC', workerCount: 48,
    equipmentList: '织唛机 32 台 / 印标机 10 台 / 模切机 5 台',
    specialties: ['织标', '印标', '吊牌'], priceLevel: 'Low',
    founded: '2018', bankName: '江苏银行苏州分行', bankAccount: '7008-9923-1140',
    certs: [{ type: 'ISO9001', certNo: 'ISO-9001-2015-SZ5518', issuedAt: '2026-01-31', validUntil: '2028-01-31' }],
    manualScore: 88, manualNote: '小单灵活，交样快（人工季度评估）',
  },
  { // SUP-08 杭州锦盛服饰（成衣厂）
    monthlyCapacity: 160000, capacityUnit: 'PC', workerCount: 340,
    equipmentList: '平缝机 260 台 / 包缝机 48 台 / 自动裁床 2 套',
    specialties: ['连衣裙', '雪纺衬衫', '女上装'], priceLevel: 'Mid',
    founded: '2009', bankName: '中国银行杭州萧山支行', bankAccount: '6228-4401-9927',
    certs: [
      { type: 'BSCI', certNo: 'BSCI-2025-4471', issuedAt: '2025-04-30', validUntil: '2027-04-30' },
      { type: 'SEDEX', certNo: 'SMETA-2025-2210', issuedAt: '2025-07-31', validUntil: '2027-07-31' },
    ],
  },
  { // SUP-09 无锡雅妮时装（成衣厂）
    monthlyCapacity: 130000, capacityUnit: 'PC', workerCount: 280,
    equipmentList: '平缝机 210 台 / 包缝机 36 台 / 整烫流水线 4 条',
    specialties: ['针织上衣', '针织连衣裙', '内搭'], priceLevel: 'Mid',
    founded: '2012', bankName: '中国建设银行无锡支行', bankAccount: '3203-7789-6612',
    certs: [
      { type: 'BSCI', certNo: 'BSCI-2025-3308', issuedAt: '2025-02-28', validUntil: '2027-02-28' },
      { type: 'ISO9001', certNo: 'ISO-9001-2015-WX0921', issuedAt: '2025-11-30', validUntil: '2027-11-30' },
    ],
  },
  { // SUP-10 南通蓝羽服装（成衣厂，1 条已过期认证喂预警扫描）
    monthlyCapacity: 110000, capacityUnit: 'PC', workerCount: 220,
    equipmentList: '平缝机 180 台 / 自动开袋机 6 台 / 吊挂系统 2 套',
    specialties: ['衬衫', '梭织上装', '轻商务'], priceLevel: 'Low',
    founded: '2015', bankName: '中国农业银行南通支行', bankAccount: '1129-6634-2205',
    certs: [
      { type: 'BSCI', certNo: 'BSCI-2024-1166', issuedAt: '2024-08-15', validUntil: '2026-08-15' },
      { type: 'SEDEX', certNo: 'SMETA-2025-3347', issuedAt: '2025-10-31', validUntil: '2027-10-31' },
    ],
  },
];

export async function seedSuppliersFactory(prisma: PrismaClient): Promise<void> {
  console.log('── 供应商工厂域（FactoryProfile 10 + 评估 + 认证 + 产能日历） ──');

  // ── 0. DB 实况聚合：采购单（面料厂）+ 订单（成衣厂 millRelationId） ──
  const poAgg = await prisma.purchaseOrder.groupBy({
    by: ['supplierRelationId'],
    where: { deletedAt: null },
    _count: { _all: true },
    _sum: { totalAmount: true },
  });
  const poBySupplier = new Map(poAgg.map((g) => [g.supplierRelationId as string, {
    count: g._count._all, amount: Number(g._sum.totalAmount ?? 0),
  }] as const));

  const millOrders = await prisma.order.findMany({
    where: { millRelationId: { not: null }, deletedAt: null },
    select: { millRelationId: true, poDate: true, currency: true, totalNet: true },
  });
  const orderAggBySupplier = new Map<string, { count: number; amountCny: number; firstDate: string | null }>();
  for (const o of millOrders) {
    const key = o.millRelationId!;
    const cur = orderAggBySupplier.get(key) ?? { count: 0, amountCny: 0, firstDate: null as string | null };
    const fx = o.currency === 'EUR' ? EUR_CNY_RATE : o.currency === 'USD' ? USD_CNY_RATE : 1;
    cur.count += 1;
    cur.amountCny += Number(o.totalNet) * fx;
    if (o.poDate && (!cur.firstDate || o.poDate < cur.firstDate)) cur.firstDate = o.poDate;
    orderAggBySupplier.set(key, cur);
  }
  const poFirstDates = await prisma.purchaseOrder.findMany({
    where: { deletedAt: null }, select: { supplierRelationId: true, orderDate: true },
  });
  const poFirstBySupplier = new Map<string, string>();
  for (const p of poFirstDates) {
    const key = p.supplierRelationId!;
    const prev = poFirstBySupplier.get(key);
    if (!prev || p.orderDate < prev) poFirstBySupplier.set(key, p.orderDate);
  }

  // ── 1. FactoryProfile 10 条（评分缓存先落 0，评估建完后回填均值） ──
  const profileRows: Prisma.FactoryProfileUncheckedCreateInput[] = [];
  const profileIds: string[] = [];
  SUPPLIERS.forEach((sup, si) => {
    const spec = FACTORY_SPECS[si];
    const id = `SIM-FACP-${String(si + 1).padStart(2, '0')}`;
    profileIds.push(id);
    const poStat = poBySupplier.get(sup.id);
    const ordStat = orderAggBySupplier.get(sup.id);
    // 合作历史口径：有采购单走采购单（原币 CNY，与 factoryService.accumulate 口径一致）；
    // 无采购单的成衣厂走订单 millRelationId（totalNet 按汇率常量折 CNY，seed 口径注释留痕）
    const totalOrders = poStat?.count ?? ordStat?.count ?? 0;
    const totalAmount = poStat ? poStat.amount : Math.round((ordStat?.amountCny ?? 0) * 100) / 100;
    const firstOrderAt = poFirstBySupplier.get(sup.id) ?? ordStat?.firstDate ?? '2026-06-08';
    profileRows.push({
      id, relationId: sup.id,
      monthlyCapacity: new Prisma.Decimal(spec.monthlyCapacity), capacityUnit: spec.capacityUnit,
      equipmentList: spec.equipmentList, workerCount: spec.workerCount,
      specialties: spec.specialties, priceLevel: spec.priceLevel,
      firstOrderAt,
      totalOrders, totalAmount: new Prisma.Decimal(totalAmount),
      bankName: spec.bankName, bankAccount: spec.bankAccount,
      notes: `成立于 ${spec.founded} 年。地址：${SUPPLIER_ADDR[sup.id] ?? ''}。13 周模拟 seed 工厂档案。`,
      createdAt: BigInt(Date.parse('2026-05-20T09:00:00Z')), updatedAt: BigInt(Date.parse('2026-08-28T09:00:00Z')),
      deletedAt: null,
    });
  });
  await createManyLogged(prisma, 'factoryProfile', 'FactoryProfile（10 厂）', profileRows);

  // ── 2. FactoryEvaluation：订单链厂走 DB 实查（验货报告/运单/采购单），辅料商人工评估 ──
  const evalRows: Prisma.FactoryEvaluationUncheckedCreateInput[] = [];
  let evalSeq = 0;
  const evalsByFactory = new Map<string, { inspection: number[]; delivery: number[] }>();
  const pushEval = (factoryIdx: number, e: Omit<Prisma.FactoryEvaluationUncheckedCreateInput, 'id' | 'factoryId'>) => {
    evalSeq += 1;
    const factoryId = profileIds[factoryIdx];
    evalRows.push({ id: `SIM-FAEV-${String(evalSeq).padStart(3, '0')}`, factoryId, ...e });
    const agg = evalsByFactory.get(factoryId) ?? { inspection: [], delivery: [] };
    if (e.kind === 'inspection') agg.inspection.push(e.score as number);
    else agg.delivery.push(e.score as number);
    evalsByFactory.set(factoryId, agg);
  };

  for (let si = 0; si < SUPPLIERS.length; si++) {
    const sup = SUPPLIERS[si];
    const spec = FACTORY_SPECS[si];
    // 2a. 验货评估：该厂订单（millRelationId）的终期验货报告，最多取 2 张
    const orders = await prisma.order.findMany({
      where: { millRelationId: sup.id, deletedAt: null },
      select: { id: true }, orderBy: { id: 'asc' },
    });
    if (orders.length) {
      const reports = await prisma.inspectionReport.findMany({
        where: { orderId: { in: orders.map((o) => o.id) }, inspectionType: 'final' },
        select: { id: true, result: true, inspectionDate: true },
        orderBy: { id: 'asc' }, take: 2,
      });
      for (const r of reports) {
        pushEval(si, {
          kind: 'inspection', score: inspectionScore(r.result),
          sourceType: 'inspectionReport', sourceId: r.id,
          evaluatedAt: r.inspectionDate,
          note: `终期验货 ${r.result}（自动评分口径：pass=95 / conditional=70）`,
          actorId: USERS.qc, createdAt: BigInt(Date.parse(`${r.inspectionDate}T09:00:00Z`)),
        });
      }
      // 2b. 交期评估：该厂首票运单（sourceType=shipment）
      const shipment = await prisma.shipment.findFirst({
        where: { orderId: { in: orders.map((o) => o.id) }, deletedAt: null },
        select: { id: true, etd: true, atd: true }, orderBy: { id: 'asc' },
      });
      if (shipment) {
        const daysLate = shipment.atd && shipment.etd
          ? Math.round((Date.parse(shipment.atd) - Date.parse(shipment.etd)) / DAY)
          : null;
        const score = daysLate === null || daysLate <= 0 ? 100 : daysLate <= 7 ? 80 : daysLate <= 14 ? 60 : 40;
        pushEval(si, {
          kind: 'delivery', score,
          sourceType: 'shipment', sourceId: shipment.id,
          evaluatedAt: shipment.atd ?? shipment.etd,
          note: `出运交期评估（ETD ${shipment.etd} / ATD ${shipment.atd ?? '—'}，延迟 ${daysLate ?? '—'} 天）`,
          actorId: USERS.logistics, createdAt: BigInt(Date.parse(`${shipment.atd ?? shipment.etd}T09:00:00Z`)),
        });
      }
    }
    // 2c. 采购单到料交期评估（面料厂有 PO 时，sourceType=purchaseOrder）
    const firstPo = await prisma.purchaseOrder.findFirst({
      where: { supplierRelationId: sup.id, status: 'Received', deletedAt: null },
      select: { id: true, expectedDeliveryDate: true, actualDeliveryDate: true },
      orderBy: { id: 'asc' },
    });
    if (firstPo && firstPo.actualDeliveryDate) {
      const daysLate = firstPo.expectedDeliveryDate
        ? Math.round((Date.parse(firstPo.actualDeliveryDate) - Date.parse(firstPo.expectedDeliveryDate)) / DAY)
        : null;
      const score = daysLate === null || daysLate <= 0 ? 100 : daysLate <= 7 ? 80 : daysLate <= 14 ? 60 : 40;
      pushEval(si, {
        kind: 'delivery', score,
        sourceType: 'purchaseOrder', sourceId: firstPo.id,
        evaluatedAt: firstPo.actualDeliveryDate,
        note: `采购到料交期评估（期望 ${firstPo.expectedDeliveryDate ?? '—'} / 实收 ${firstPo.actualDeliveryDate}）`,
        actorId: USERS.logistics, createdAt: BigInt(Date.parse(`${firstPo.actualDeliveryDate}T09:00:00Z`)),
      });
    }
    // 2d. 无订单链（辅料商）或带人工剧情（SUP-02 延迟）→ manual 评估
    if (!orders.length && spec.manualScore !== undefined) {
      pushEval(si, {
        kind: 'inspection', score: spec.manualScore,
        sourceType: 'manual', sourceId: null,
        evaluatedAt: '2026-08-20',
        note: spec.manualNote ?? '人工季度评估',
        actorId: USERS.qc, createdAt: BigInt(Date.parse('2026-08-20T09:00:00Z')),
      });
    } else if (orders.length && spec.manualScore !== undefined) {
      pushEval(si, {
        kind: 'delivery', score: spec.manualScore,
        sourceType: 'manual', sourceId: null,
        evaluatedAt: '2026-08-22',
        note: spec.manualNote ?? '人工评估',
        actorId: USERS.gm, createdAt: BigInt(Date.parse('2026-08-22T09:00:00Z')),
      });
    }
  }
  await createManyLogged(prisma, 'factoryEvaluation', 'FactoryEvaluation（验货/交期/人工，多 sourceType）', evalRows);

  // ── 3. 评分缓存回填：均值口径与 factoryService.addEvaluation 事务重算完全一致 ──
  let updated = 0;
  for (let si = 0; si < profileIds.length; si++) {
    const agg = evalsByFactory.get(profileIds[si]) ?? { inspection: [], delivery: [] };
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : 0);
    await prisma.factoryProfile.update({
      where: { id: profileIds[si] },
      data: { qualityScore: avg(agg.inspection), deliveryScore: avg(agg.delivery) },
    });
    updated += 1;
  }
  console.log(`  FactoryProfile 评分缓存回填: ${updated} 厂（quality/delivery = 各 kind 评估均值）`);

  // ── 4. FactoryCertification：每厂 1-2 条（3 条临期/过期喂预警扫描） ──
  const certRows: Prisma.FactoryCertificationUncheckedCreateInput[] = [];
  let certSeq = 0;
  FACTORY_SPECS.forEach((spec, si) => {
    for (const c of spec.certs) {
      certSeq += 1;
      certRows.push({
        id: `SIM-FACR-${String(certSeq).padStart(3, '0')}`, factoryId: profileIds[si],
        type: c.type, certificateNo: c.certNo, issuedAt: c.issuedAt, validUntil: c.validUntil,
        createdAt: BigInt(Date.parse(`${c.issuedAt}T09:00:00Z`)),
        updatedAt: BigInt(Date.parse('2026-08-28T09:00:00Z')), deletedAt: null,
      });
    }
  });
  await createManyLogged(prisma, 'factoryCertification', 'FactoryCertification（含临期/过期预警喂点）', certRows);

  // ── 5. FactoryCapacity：产能日历 2026-06..09 × 10 厂 ──
  const capacityRows: Prisma.FactoryCapacityUncheckedCreateInput[] = [];
  let capSeq = 0;
  FACTORY_SPECS.forEach((spec, si) => {
    CAPACITY_MONTHS.forEach((month, mi) => {
      capSeq += 1;
      // 旺季波动：确定性系数（90%-110%），7/8 月为出运高峰
      const factor = 0.9 + ((si + mi * 2) % 5) * 0.05;
      capacityRows.push({
        id: `SIM-FACC-${String(capSeq).padStart(3, '0')}`, factoryId: profileIds[si],
        month, capacity: new Prisma.Decimal(Math.round(spec.monthlyCapacity * factor)),
        unit: spec.capacityUnit,
        note: mi >= 1 && mi <= 2 ? 'SS26 出运高峰月（计划产能上浮）' : null,
        createdAt: BigInt(Date.parse('2026-05-20T09:00:00Z')),
        updatedAt: BigInt(Date.parse('2026-05-20T09:00:00Z')), deletedAt: null,
      });
    });
  });
  await createManyLogged(prisma, 'factoryCapacity', 'FactoryCapacity（2026-06..09 × 10 厂）', capacityRows);

  console.log('── 供应商工厂域完成（喂点：评估多 sourceType / 认证临期预警 2 + 过期 1 / 产能日历 40 行） ──');
}
