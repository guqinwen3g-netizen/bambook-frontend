/**
 * company-sim/hr-kb.ts — HR 全套（12 员工）+ KB 文档 + Insight + 邮件往来
 */

import { Prisma } from '@prisma/client';
import {
  at, isoDate, isoDateTime, createManyLogged, USERS, SIM_EXTRA_ACCOUNTS,
} from './common';
import { CUSTOMERS } from './master-data';
import type { FabricOrderPlan } from './fabric-orders';
import type { OrderPlan } from './orders';

const DAY = 24 * 3600 * 1000;

interface EmpDef {
  userId: string; employeeNo: string; name: string; hireDate: string;
  status: string; phone: string; location: string;
}

export async function seedHrKbEmailInsight(prisma: PrismaClient, plans: Array<OrderPlan | FabricOrderPlan>): Promise<void> {
  console.log('── HR：12 员工档案 + 生命周期事件 + 绩效周期 ──');

  // 1. EmployeeProfile × 12（9 个 usr_demo_* + 3 个 SIM 跟单账号；不改动既有账号）
  const empDefs: EmpDef[] = [
    { userId: USERS.boss, employeeNo: 'ZYF-0001', name: 'Jason Shen', hireDate: '2019-03-01', status: 'Regular', phone: '+86-138-0000-0001', location: '上海总部' },
    { userId: USERS.gm, employeeNo: 'ZYF-0002', name: 'Raymond Lin', hireDate: '2019-06-10', status: 'Regular', phone: '+86-138-0000-0002', location: '上海总部' },
    { userId: USERS.salesManager, employeeNo: 'ZYF-0003', name: 'Vivian Chen', hireDate: '2020-04-13', status: 'Regular', phone: '+86-138-0000-0003', location: '上海总部' },
    { userId: USERS.salesA, employeeNo: 'ZYF-0004', name: 'Chloe Su', hireDate: '2021-07-05', status: 'Regular', phone: '+86-138-0000-0004', location: '上海总部' },
    { userId: USERS.salesB, employeeNo: 'ZYF-0005', name: 'Marcus Zhou', hireDate: '2022-02-21', status: 'Regular', phone: '+86-138-0000-0005', location: '上海总部' },
    { userId: USERS.financeManager, employeeNo: 'ZYF-0006', name: 'Melissa Zhao', hireDate: '2020-09-07', status: 'Regular', phone: '+86-138-0000-0006', location: '上海总部' },
    { userId: USERS.finance, employeeNo: 'ZYF-0007', name: 'Charlie Qian', hireDate: '2022-08-15', status: 'Regular', phone: '+86-138-0000-0007', location: '上海总部' },
    { userId: USERS.qc, employeeNo: 'ZYF-0008', name: 'Wilson Wu', hireDate: '2021-03-15', status: 'Regular', phone: '+86-138-0000-0008', location: '温州驻场' },
    { userId: USERS.logistics, employeeNo: 'ZYF-0009', name: 'Hank Zheng', hireDate: '2021-10-11', status: 'Regular', phone: '+86-138-0000-0009', location: '上海总部' },
    { userId: SIM_EXTRA_ACCOUNTS[0].id, employeeNo: 'ZYF-0010', name: 'Grace Liu', hireDate: '2026-05-18', status: 'Probation', phone: '+86-138-0000-0010', location: '上海总部' },
    { userId: SIM_EXTRA_ACCOUNTS[1].id, employeeNo: 'ZYF-0011', name: 'Tony Fang', hireDate: '2026-02-09', status: 'Regular', phone: '+86-138-0000-0011', location: '上海总部' },
    { userId: SIM_EXTRA_ACCOUNTS[2].id, employeeNo: 'ZYF-0012', name: 'Ivy Zhang', hireDate: '2025-04-01', status: 'Regular', phone: '+86-138-0000-0012', location: '苏州驻场' },
  ];
  const empRows: Prisma.EmployeeProfileUncheckedCreateInput[] = empDefs.map((e, i) => ({
    id: `SIM-EMP-${String(101 + i)}`,
    userId: e.userId, employeeNo: e.employeeNo, positionId: null, hireDate: e.hireDate,
    regularDate: e.status === 'Regular' ? e.hireDate : null,
    contractType: 'OpenEnded', employmentStatus: e.status,
    phone: e.phone, workLocation: e.location,
    emergencyContact: 'HR 档案备份', notes: null,
  }));
  await createManyLogged(prisma, 'employeeProfile', 'EmployeeProfile', empRows);

  // 2. EmploymentEvent × 3（入/转/调）
  const eventRows: Prisma.EmploymentEventUncheckedCreateInput[] = [
    {
      id: 'SIM-EE-101', userId: SIM_EXTRA_ACCOUNTS[0].id, type: 'Onboard', effectiveDate: '2026-05-18',
      reason: '旺季跟单扩编', operatorId: USERS.gm,
    },
    {
      id: 'SIM-EE-102', userId: SIM_EXTRA_ACCOUNTS[1].id, type: 'Regularize', effectiveDate: '2026-08-09',
      reason: '试用期考核通过，按期转正', operatorId: USERS.gm,
    },
    {
      id: 'SIM-EE-103', userId: SIM_EXTRA_ACCOUNTS[2].id, type: 'Transfer', effectiveDate: '2026-07-01',
      reason: '面料验货需求增加，调往苏州驻场', operatorId: USERS.gm,
    },
  ];
  await createManyLogged(prisma, 'employmentEvent', 'EmploymentEvent', eventRows);

  // 3. 本月绩效周期（2026-Q3 Open）+ 3 份 Draft 评定
  await prisma.performanceCycle.upsert({
    where: { period: '2026-Q3' },
    create: {
      id: 'SIM-PERF-2026Q3', name: '2026 年第三季度绩效考核', period: '2026-Q3', status: 'Open',
      startDate: '2026-08-01', endDate: '2026-09-30',
    },
    update: { status: 'Open' },
  });
  console.log('  PerformanceCycle: 1（2026-Q3 Open）');
  const reviewRows: Prisma.PerformanceReviewUncheckedCreateInput[] = [
    { userId: USERS.salesManager, selfScore: 92, kpi: { orders: 20, revenueUsd: 415000, onTimeRate: 0.98 } },
    { userId: USERS.salesA, selfScore: 88, kpi: { orders: 18, revenueUsd: 372000, onTimeRate: 0.97 } },
    { userId: USERS.salesB, selfScore: 85, kpi: { orders: 18, revenueUsd: 351000, onTimeRate: 0.96 } },
  ].map((r, i) => ({
    id: `SIM-PRF-${String(101 + i)}`, cycleId: 'SIM-PERF-2026Q3', userId: r.userId,
    selfScore: r.selfScore, managerScore: null, finalScore: null, grade: null,
    kpi: r.kpi as unknown as Prisma.InputJsonValue,
    comment: '自评已提交，待主管评定。', status: 'Submitted', reviewerId: USERS.boss,
  }));
  await createManyLogged(prisma, 'performanceReview', 'PerformanceReview', reviewRows);

  // 4. KB：6 篇知识文档 + 切片
  console.log('── KB：6 篇知识文档 ──');
  const kbDefs: Array<{ id: string; title: string; sourceType: string; chunks: string[] }> = [
    {
      id: 'SIM-KD-001', title: '成衣终期验货 SOP（AQL 2.5/4.0）', sourceType: 'sop',
      chunks: [
        '终期验货在出货前 2-3 天执行，按 AQL 2.5/4.0 Level II 抽样。致命疵点零容忍，主要疵点超出接受数即整批拒收。',
        '验货流程：核对箱唛与装箱单 → 抽箱 → 尺寸测量 → 外观检查（线头/污渍/色差）→ 功能测试（拉链/纽扣）→ 出具报告。',
        '终验通过（pass）后由业务部批准放行，QC 在系统填写 InspectionReport 并关联出运批次；conditional 结论需注明整改项与复验时间。',
      ],
    },
    {
      id: 'SIM-KD-002', title: '常见针织面料成分与克重速查', sourceType: 'knowledge',
      chunks: [
        '棉氨汗布（Cotton Spandex Jersey）：常见 95/5 与 92/8，克重 160-220gsm，弹力好，适用于修身 T 恤与针织上衣。',
        '莫代尔针织布：手感柔滑悬垂性好，克重 140-200gsm，适合女性贴身上衣；注意缩率控制 5% 以内。',
        '罗纹组织（Rib）：袖口/领口用 2×2 罗纹常见克重 220-300gsm；空气层适合初秋针织外套类。',
      ],
    },
    {
      id: 'SIM-KD-003', title: '出运单证清单与客户须知', sourceType: 'knowledge',
      chunks: [
        '海运出运标准单证：商业发票（CI）、装箱单（PL）、提单（B/L）、产地证（CO/FORM A/E）、保险单（CIF 条款时）。',
        '客户须知：美国客户常要求 ISF 申报（开船前 72 小时）；欧盟客户注意 EPR 与 OEKO-TEX 证书随附。',
      ],
    },
    {
      id: 'SIM-KD-004', title: '信用控制规则摘要', sourceType: 'policy',
      chunks: [
        '新客户首单建议 30% 前定金 + 70% 见提单副本；Gold 层级可给 30 天账期，Platinum 可给 45 天。',
        '60 天逾期自动冻结额度（crmService.runCreditRiskScan），冻结后新订单需走审批解冻通道。',
      ],
    },
    {
      id: 'SIM-KD-005', title: '催款分级处理指引', sourceType: 'policy',
      chunks: [
        '分级口径：reminder（d1-30，邮件轻提醒）→ firm（d31-60，正式催款函+电话）→ urgent（d61-90，暂停接单+高层沟通）→ legal（d90+，法务准备）。',
        '催款记录必须落 DunningRecord（账龄快照），还款后分级自动回落；人工钉住仅限升级场景。',
      ],
    },
    {
      id: 'SIM-KD-006', title: '新员工入职：订单全流程概览', sourceType: 'manual',
      chunks: [
        '订单主流程：询价报价 → PI 确认（Pending→Confirmed）→ 生产排期（Production，10 阶段门禁）→ 出运放行（Shipping，需 QC 终验）→ 签收（Delivered）→ 开票收款。',
        '每次订单状态流转都会写入 OrderStatusTransition 审计；出运放行硬门禁：成衣链需 Final QC 通过，面料链需大货 QC/确认样/RC 确认。',
      ],
    },
  ];
  const docRows: Prisma.KnowledgeDocumentUncheckedCreateInput[] = kbDefs.map((d, i) => ({
    id: d.id, title: d.title, sourceType: d.sourceType, mimeType: 'text/markdown',
    checksum: null, version: 1, status: 'active',
    metadata: { author: '竹衍服饰运营部', seededBy: 'seed-company-sim' } as unknown as Prisma.InputJsonValue,
    createdAt: new Date(at(1, 1, 9) + i * DAY), updatedAt: new Date(at(10, 3, 14)),
  }));
  await createManyLogged(prisma, 'knowledgeDocument', 'KnowledgeDocument', docRows);
  const chunkRows: Prisma.KnowledgeChunkUncheckedCreateInput[] = [];
  kbDefs.forEach((d) => {
    d.chunks.forEach((content, ci) => {
      chunkRows.push({
        id: `${d.id}-C${ci + 1}`, documentId: d.id, chunkIndex: ci, content,
        summary: content.slice(0, 40) + '…', tags: ['company-sim'],
        metadata: null,
      });
    });
  });
  await createManyLogged(prisma, 'knowledgeChunk', 'KnowledgeChunk', chunkRows);

  // 5. Insight × 5
  const insightRows: Prisma.InsightUncheckedCreateInput[] = [
    { id: 'SIM-INS-101', fact: 'Nordic Apparel GmbH 已连续 3 季复购亚麻连衣裙系列，建议纳入 Platinum 层级评估。', importance: 'high', timestamp: BigInt(at(11, 2, 10)), isPinned: true, deletedAt: null },
    { id: 'SIM-INS-102', fact: 'W1-W6 交付的 28 单：交期已过的 9 单中 7 单全额回款（周期中位数 26 天）、2 单逾期半款催收中；交期未到的 19 单提前出运——12 单已收 30% 定金、6 单开票待收、1 单逾期半款。', importance: 'high', timestamp: BigInt(at(12, 3, 15)), isPinned: false, deletedAt: null },
    { id: 'SIM-INS-103', fact: 'Maple & Thread SS27 胶囊系列商机 32 万美元，需在 9 月底前锁定面料产能。', importance: 'high', timestamp: BigInt(at(12, 4, 11)), isPinned: true, deletedAt: null },
    { id: 'SIM-INS-104', fact: '3 笔逾期尾款集中在 USD 客户，逾期天数 9-29 天，均已发催款函并登记 DunningRecord。', importance: 'medium', timestamp: BigInt(at(12, 5, 16)), isPinned: false, deletedAt: null },
    { id: 'SIM-INS-105', fact: '针织上衣品类毛利率高于连衣裙约 3.2 个百分点，报价时优先引导。', importance: 'medium', timestamp: BigInt(at(10, 3, 10)), isPinned: false, deletedAt: null },
  ];
  await createManyLogged(prisma, 'insight', 'Insight', insightRows);

  // 6. 邮件 × 8（4 线程往来）
  console.log('── 邮件：8 封（4 线程） ──');
  const emailRows: Prisma.EmailUncheckedCreateInput[] = [];
  const custByName = new Map(CUSTOMERS.map((c) => [c.name, c]));
  // T1: Nordic 询价 → Chloe 报价回复
  const nordic = custByName.get('Nordic Apparel GmbH')!;
  const ord2 = plans.find((p) => p.id === 'SIM-ORD-002')!;
  emailRows.push({
    id: 'SIM-EML-901', messageId: '<sim-thread1-a@nordicapparel.example.de>',
    direction: 'inbound', status: 'read',
    fromAddress: 'j.weber@nordicapparel.example.de', fromName: 'Jonas Weber',
    toAddresses: JSON.stringify(['chloe.su@pandaclothing.example.cn']),
    mailbox: 'INBOX', threadId: 'SIM-THR-1',
    sentAt: isoDateTime(at(1, 2, 15, 30)), receivedAt: isoDateTime(at(1, 2, 15, 42)),
    relationId: nordic.id, relationName: nordic.name,
    orderId: ord2.id, orderPo: ord2.poNumber,
    subject: 'RFQ: Linen blend dresses AW26 (approx. 12,000 pcs)',
    bodyText: 'Hi Chloe, we are planning an AW26 replenishment for our linen dress line. Could you quote FOB Shanghai for approx. 12,000 pcs across 3 colorways? Best, Jonas',
    snippet: 'RFQ for AW26 linen dress replenishment ~12,000 pcs',
    labels: ['quote'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(1, 2, 15, 30)), updatedAt: BigInt(at(1, 2, 15, 42)), deletedAt: null,
  });
  emailRows.push({
    id: 'SIM-EML-902', messageId: '<sim-thread1-b@pandaclothing.example.cn>',
    direction: 'outbound', status: 'read',
    fromAddress: 'chloe.su@pandaclothing.example.cn', fromName: 'Chloe Su',
    toAddresses: JSON.stringify(['j.weber@nordicapparel.example.de']),
    mailbox: 'Sent Messages', threadId: 'SIM-THR-1',
    sentAt: isoDateTime(at(1, 3, 10, 5)),
    relationId: nordic.id, relationName: nordic.name,
    orderId: ord2.id, orderPo: ord2.poNumber,
    subject: 'RE: RFQ: Linen blend dresses AW26 (approx. 12,000 pcs)',
    bodyText: 'Hi Jonas, thanks for your inquiry. Please find our quotation: FOB Shanghai USD 7.15/pc for 12,000 pcs, lead time 60 days after deposit. Looking forward to your PO.',
    snippet: 'Quotation sent: USD 7.15/pc FOB Shanghai',
    // 2026-09-02 修复：hasAttachments=true 但 EmailAttachment 0 行（无真实文件实体，
    // 附件下载会 404）——诚实置 false，正文已含报价数字
    labels: ['quote'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(1, 3, 10, 5)), updatedAt: BigInt(at(1, 3, 10, 5)), deletedAt: null,
  });
  // T2: Maple PI 确认
  const maple = custByName.get('Maple & Thread Co.')!;
  const ord1 = plans.find((p) => p.id === 'SIM-ORD-001')!;
  emailRows.push({
    id: 'SIM-EML-903', messageId: '<sim-thread2-a@pandaclothing.example.cn>',
    direction: 'outbound', status: 'read',
    fromAddress: 'vivian.chen@pandaclothing.example.cn', fromName: 'Vivian Chen',
    toAddresses: JSON.stringify(['emily.carter@maplethread.example.com']),
    mailbox: 'Sent Messages', threadId: 'SIM-THR-2',
    sentAt: isoDateTime(at(1, 1, 14, 20)),
    relationId: maple.id, relationName: maple.name,
    orderId: ord1.id, orderPo: ord1.poNumber,
    subject: `PI ${ord1.code} — Floral Wrap Dress order confirmation`,
    bodyText: 'Hi Emily, please confirm the proforma invoice for PO ' + ord1.poNumber + ' (quoted in our separate PI document). Kindly sign and arrange the 30% deposit.',
    snippet: 'PI sent for signature and deposit',
    // 2026-09-02 修复：无真实附件文件实体，hasAttachments 诚实置 false
    labels: ['pi'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(1, 1, 14, 20)), updatedAt: BigInt(at(1, 1, 14, 20)), deletedAt: null,
  });
  emailRows.push({
    id: 'SIM-EML-904', messageId: '<sim-thread2-b@maplethread.example.com>',
    direction: 'inbound', status: 'read',
    fromAddress: 'emily.carter@maplethread.example.com', fromName: 'Emily Carter',
    toAddresses: JSON.stringify(['vivian.chen@pandaclothing.example.cn']),
    mailbox: 'INBOX', threadId: 'SIM-THR-2',
    sentAt: isoDateTime(at(1, 2, 9, 40)), receivedAt: isoDateTime(at(1, 2, 9, 55)),
    relationId: maple.id, relationName: maple.name,
    orderId: ord1.id, orderPo: ord1.poNumber,
    subject: `RE: PI ${ord1.code} — Floral Wrap Dress order confirmation`,
    bodyText: 'Hi Vivian, PI signed. Deposit will be wired today. Please proceed with production scheduling.',
    snippet: 'PI signed, deposit wired',
    // 2026-09-02 修复：无真实附件文件实体，hasAttachments 诚实置 false
    labels: ['pi'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(1, 2, 9, 40)), updatedAt: BigInt(at(1, 2, 9, 55)), deletedAt: null,
  });
  // T3: Sakura 验货报告（Wilson 发出）
  const sakura = custByName.get('Sakura Brands K.K.')!;
  const ord3 = plans.find((p) => p.id === 'SIM-ORD-003')!;
  emailRows.push({
    id: 'SIM-EML-905', messageId: '<sim-thread3-a@pandaclothing.example.cn>',
    direction: 'outbound', status: 'read',
    fromAddress: 'wilson.wu@pandaclothing.example.cn', fromName: 'Wilson Wu',
    toAddresses: JSON.stringify(['y.tanaka@sakurabrands.example.jp']),
    ccAddresses: JSON.stringify(['vivian.chen@pandaclothing.example.cn']),
    mailbox: 'Sent Messages', threadId: 'SIM-THR-3',
    sentAt: isoDateTime(at(2, 5, 17, 10)),
    relationId: sakura.id, relationName: sakura.name,
    orderId: ord3.id, orderPo: ord3.poNumber,
    subject: `Final inspection report — ${ord3.poNumber} (PASS)`,
    bodyText: 'Dear Yuki, final inspection for PO ' + ord3.poNumber + ' was completed with PASS result (AQL 2.5/4.0). Goods are ready for shipment.',
    snippet: 'Final inspection PASS, goods ready',
    // 2026-09-02 修复：无真实附件文件实体，hasAttachments 诚实置 false
    labels: ['inspection'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(2, 5, 17, 10)), updatedAt: BigInt(at(2, 5, 17, 10)), deletedAt: null,
  });
  emailRows.push({
    id: 'SIM-EML-906', messageId: '<sim-thread3-b@sakurabrands.example.jp>',
    direction: 'inbound', status: 'read',
    fromAddress: 'y.tanaka@sakurabrands.example.jp', fromName: 'Yuki Tanaka',
    toAddresses: JSON.stringify(['wilson.wu@pandaclothing.example.cn']),
    mailbox: 'INBOX', threadId: 'SIM-THR-3',
    sentAt: isoDateTime(at(3, 1, 11, 25)), receivedAt: isoDateTime(at(3, 1, 11, 40)),
    relationId: sakura.id, relationName: sakura.name,
    orderId: ord3.id, orderPo: ord3.poNumber,
    subject: `RE: Final inspection report — ${ord3.poNumber} (PASS)`,
    bodyText: 'Wilson, report received with thanks. Please arrange booking for the next available vessel.',
    snippet: 'Confirmed, arrange vessel booking',
    labels: ['inspection'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(3, 1, 11, 25)), updatedAt: BigInt(at(3, 1, 11, 40)), deletedAt: null,
  });
  // T4: Southern Cross 催款往来（Melissa）
  const scross = custByName.get('Southern Cross Fashion Pty Ltd')!;
  const overduePlan = plans.find((p) => p.overdue && p.customerId === scross.id) ?? plans.find((p) => p.overdue)!;
  emailRows.push({
    id: 'SIM-EML-907', messageId: '<sim-thread4-a@pandaclothing.example.cn>',
    direction: 'outbound', status: 'read',
    fromAddress: 'melissa.zhao@pandaclothing.example.cn', fromName: 'Melissa Zhao',
    toAddresses: JSON.stringify(['olivia.b@scrossfashion.example.au']),
    mailbox: 'Sent Messages', threadId: 'SIM-THR-4',
    sentAt: isoDateTime(at(12, 3, 10, 30)),
    relationId: scross.id, relationName: scross.name,
    orderId: overduePlan.id, orderPo: overduePlan.poNumber,
    subject: `Payment reminder — overdue balance ${overduePlan.poNumber}`,
    bodyText: 'Dear Olivia, our records show the balance of invoice for PO ' + overduePlan.poNumber + ' is overdue. Kindly arrange payment at your earliest convenience.',
    snippet: 'Formal payment reminder for overdue balance',
    labels: ['payment_reminder'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(12, 3, 10, 30)), updatedAt: BigInt(at(12, 3, 10, 30)), deletedAt: null,
  });
  emailRows.push({
    id: 'SIM-EML-908', messageId: '<sim-thread4-b@scrossfashion.example.au>',
    direction: 'inbound', status: 'important',
    fromAddress: 'olivia.b@scrossfashion.example.au', fromName: 'Olivia Bennett',
    toAddresses: JSON.stringify(['melissa.zhao@pandaclothing.example.cn']),
    mailbox: 'INBOX', threadId: 'SIM-THR-4',
    sentAt: isoDateTime(at(12, 4, 9, 15)), receivedAt: isoDateTime(at(12, 4, 9, 30)),
    relationId: scross.id, relationName: scross.name,
    orderId: overduePlan.id, orderPo: overduePlan.poNumber,
    subject: `RE: Payment reminder — overdue balance ${overduePlan.poNumber}`,
    bodyText: 'Apologies for the delay — finance will release the payment this Friday. We value our partnership and will keep future payments on schedule.',
    snippet: 'Payment promised this Friday',
    labels: ['payment_reminder'], hasAttachments: false, attachmentCount: 0,
    createdAt: BigInt(at(12, 4, 9, 15)), updatedAt: BigInt(at(12, 4, 9, 30)), deletedAt: null,
  });
  await createManyLogged(prisma, 'email', 'Email', emailRows);
}
