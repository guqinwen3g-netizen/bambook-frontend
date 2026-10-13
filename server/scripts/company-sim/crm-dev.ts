/**
 * company-sim/crm-dev.ts — CRM（额度/分层/跟进/商机）+ 开发案 + 样衣节点 + 审批 + 审计
 */

import { Prisma } from '@prisma/client';
import {
  at, isoDate, round2, createManyLogged, USERS, SALES_NAME, SALES_POOL, deliveredFinance,
} from './common';
import { CUSTOMERS } from './master-data';
import type { FabricOrderPlan } from './fabric-orders';
import type { OrderPlan } from './orders';

const DAY = 24 * 3600 * 1000;

const TIERS = ['Gold', 'Platinum', 'Gold', 'Silver', 'Silver', 'Bronze', 'Gold', 'Silver'];
const CREDIT_BASE = [420000, 500000, 380000, 260000, 240000, 150000, 300000, 220000];

export async function seedCrmAndDev(prisma: PrismaClient, plans: Array<OrderPlan | FabricOrderPlan>): Promise<void> {
  console.log('── CRM：CreditLimit / CustomerTier / FollowUp / Opportunity ──');
  const nowMs = at(13, 6, 10);

  // 1. CreditLimit × 8 + CustomerTier × 8
  const creditRows: Prisma.CreditLimitUncheckedCreateInput[] = [];
  const tierRows: Prisma.CustomerTierUncheckedCreateInput[] = [];
  CUSTOMERS.forEach((c, i) => {
    // 已用额度 = 该客户未清货款占用（近似聚合）：
    //   Shipping 在途未收 + Delivered 未清部分（逾期半款 / 未来交期定金单尾款 70% / 零收款单全额 / 已结清单 0）
    const openOrders = plans.filter((p) => p.customerId === c.id && (p.fate === 'Shipping' || p.fate === 'Delivered'));
    const used = round2(openOrders.reduce((s, p) => {
      if (p.fate === 'Shipping') return s + p.amount * (p.idx % 2 === 0 ? 0.7 : 1);
      return s + p.amount * (1 - deliveredFinance(p).paidRatio);
    }, 0));
    creditRows.push({
      id: `SIM-CL-${String(101 + i)}`, relationId: c.id,
      totalLimit: new Prisma.Decimal(CREDIT_BASE[i]), usedAmount: new Prisma.Decimal(used),
      currency: c.currency, validFrom: '2026-01-01', validTo: null, status: 'Active',
      approvedBy: 'Melissa Zhao', approvedAt: BigInt(Date.UTC(2026, 0, 5)),
      notes: `年度授信，核验于 2026 年初。`, createdAt: BigInt(Date.UTC(2026, 0, 5)), updatedAt: BigInt(nowMs), deletedAt: null,
    });
    tierRows.push({
      id: `SIM-TIER-${String(101 + i)}`, relationId: c.id, level: TIERS[i],
      criteria: TIERS[i] === 'Platinum' ? '年采购额 > 200 万 USD' : TIERS[i] === 'Gold' ? '年采购额 > 100 万 USD' : '常规合作客户',
      discountRate: new Prisma.Decimal(TIERS[i] === 'Platinum' ? 5 : TIERS[i] === 'Gold' ? 2 : 0),
      paymentTermsDays: 30, creditPriority: TIERS[i] === 'Platinum' ? 'High' : 'Normal',
      moqOverrideRatio: TIERS[i] === 'Platinum' ? new Prisma.Decimal(0.7) : null,
      evaluatedAt: '2026-05-30', validUntil: '2027-05-30', evaluatedBy: 'Jason Shen',
      notes: null, createdAt: BigInt(Date.UTC(2026, 4, 30)), updatedAt: BigInt(Date.UTC(2026, 4, 30)), deletedAt: null,
    });
  });
  await createManyLogged(prisma, 'creditLimit', 'CreditLimit', creditRows);
  await createManyLogged(prisma, 'customerTier', 'CustomerTier', customerTierLog(tierRows));

  // 2. FollowUpRecord：每客户 2-4 条
  const fuContents = [
    ['Email', 'Sent SS26 lookbook and best-seller list for knit tops; buyer asked for lace dress quotation.', 'Share lace dress costing'],
    ['Call', 'Discussed AW26 replenishment plan; client confirmed linen dress reorder intent.', 'Send replenishment PI'],
    ['Meeting', 'Quarterly review meeting; client satisfied with on-time delivery rate (98%).', 'Discuss SS27 capsule program'],
    ['WeChat', 'Shared shipping schedule photos; client confirmed carton marking requirements.', 'Book inspection slot'],
    ['Visit', 'On-site visit during trade fair week; new fabric swatches presented.', 'Follow up swatch feedback'],
    ['Email', 'Sent updated quotation with 2% tier discount; awaiting PO.', 'Chase PO confirmation'],
  ];
  const fuRows: Prisma.FollowUpRecordUncheckedCreateInput[] = [];
  let fuSeq = 1;
  CUSTOMERS.forEach((c, ci) => {
    const count = 2 + (ci % 3); // 2/3/4 条
    for (let k = 0; k < count; k++) {
      const w = 1 + ((ci * 3 + k * 4) % 12);
      const [type, content, nextTopic] = fuContents[(ci + k) % fuContents.length];
      const owner = c.ownerId && SALES_NAME[c.ownerId] ? c.ownerId : SALES_POOL[ci % 3];
      fuRows.push({
        id: `SIM-FU-${String(101 + fuSeq++)}`, relationId: c.id,
        type: type as string, content: content as string, followUpAt: isoDate(at(w, 2 + (k % 4), 14)),
        nextFollowUpAt: isoDate(at(Math.min(13, w + 2), 2, 14)), nextFollowUpTopic: nextTopic as string,
        salesRepId: owner, salesRepName: SALES_NAME[owner] ?? 'Vivian Chen',
        notes: null, createdAt: BigInt(at(w, 2 + (k % 4), 14)), updatedAt: BigInt(at(w, 2 + (k % 4), 14)),
        deletedAt: null,
      });
    }
  });
  await createManyLogged(prisma, 'followUpRecord', 'FollowUpRecord', fuRows);

  // 3. Opportunity × 5（Maple 2 / Nordic 2 / Sakura 1）
  const oppRows: Prisma.OpportunityUncheckedCreateInput[] = [
    {
      id: 'SIM-OPP-101', relationId: 'SIM-CUS-01', title: 'SS27 Capsule Program — 45,000 pcs',
      description: '女式连衣裙+针织上衣胶囊系列，目标 2027 春夏上架。',
      amount: new Prisma.Decimal(320000), currency: 'USD', stage: 'Negotiation', probability: 60,
      expectedCloseDate: '2026-09-30', source: '展会', salesRepId: USERS.salesManager, salesRepName: 'Vivian Chen',
      tags: ['capsule', 'SS27'], createdAt: BigInt(at(7, 3, 11)), updatedAt: BigInt(at(12, 4, 15)), deletedAt: null,
    },
    {
      id: 'SIM-OPP-102', relationId: 'SIM-CUS-02', title: 'AW26 Linen Dress Replenishment',
      description: '亚麻连衣裙补单 12,000 件，已确认转订单 SIM-SO-1002。',
      amount: new Prisma.Decimal(86000), currency: 'EUR', stage: 'ClosedWon', probability: 100,
      expectedCloseDate: '2026-06-12', source: '复购', orderId: 'SIM-ORD-002',
      salesRepId: USERS.salesA, salesRepName: 'Chloe Su', closedAt: BigInt(at(2, 3, 16)),
      tags: ['reorder'], createdAt: BigInt(at(1, 4, 10)), updatedAt: BigInt(at(2, 3, 16)), deletedAt: null,
    },
    {
      id: 'SIM-OPP-103', relationId: 'SIM-CUS-03', title: 'Knit Tops Autumn Drop — 30,000 pcs',
      description: '秋季针织上衣系列报价中，等待客户内部分析。',
      amount: new Prisma.Decimal(150000), currency: 'USD', stage: 'Proposal', probability: 45,
      expectedCloseDate: '2026-10-15', source: '主动开发', salesRepId: USERS.salesB, salesRepName: 'Marcus Zhou',
      tags: ['knit'], createdAt: BigInt(at(9, 2, 10)), updatedAt: BigInt(at(12, 3, 11)), deletedAt: null,
    },
    {
      id: 'SIM-OPP-104', relationId: 'SIM-CUS-02', title: 'Eco Linen Program SS27',
      description: 'GRS 认证亚麻项目，客户要求全链 TC 证书。',
      amount: new Prisma.Decimal(120000), currency: 'EUR', stage: 'Qualification', probability: 25,
      expectedCloseDate: '2026-11-30', source: '展会', salesRepId: USERS.salesA, salesRepName: 'Chloe Su',
      tags: ['eco', 'GRS'], createdAt: BigInt(at(10, 5, 14)), updatedAt: BigInt(at(12, 5, 9)), deletedAt: null,
    },
    {
      id: 'SIM-OPP-105', relationId: 'SIM-CUS-01', title: 'Holiday Pajama Capsule 2026',
      description: '圣诞家居服胶囊系列试单意向。',
      amount: new Prisma.Decimal(60000), currency: 'USD', stage: 'Prospecting', probability: 15,
      expectedCloseDate: '2026-12-20', source: '转介绍', salesRepId: USERS.salesManager, salesRepName: 'Vivian Chen',
      tags: ['holiday'], createdAt: BigInt(at(11, 3, 10)), updatedAt: BigInt(at(13, 2, 10)), deletedAt: null,
    },
  ];
  await createManyLogged(prisma, 'opportunity', 'Opportunity', oppRows);

  // 4. 开发案 12 + 样衣节点
  console.log('── 开发案 12（含 SampleNode） ──');
  const devDefs: Array<{ w: number; type: string; stage: string; name: string; sampleType: string; converted?: number }> = [
    { w: 1, type: 'garment', stage: 'approved', name: '法式碎花连衣裙 — Maple 专属款开发', sampleType: 'pp-sample', converted: 3 },
    { w: 2, type: 'fabric', stage: 'approved', name: '天丝麻针织面料 — Nordic 秋季系列', sampleType: 'lab-dip', converted: 9 },
    { w: 2, type: 'garment', stage: 'revision', name: '泡泡袖衬衫 — Sakura 修改第二轮', sampleType: 'fit-sample' },
    { w: 3, type: 'garment', stage: 'shipping', name: '吊带雪纺连衣裙 — Southern Cross 新款', sampleType: 'pp-sample' },
    { w: 3, type: 'fabric', stage: 'developing', name: '棉锦弹力面料 — Willow 客户专属', sampleType: 'lab-dip' },
    { w: 4, type: 'garment', stage: 'feedback', name: '收腰针织连衣裙 — Bleu Marlin 5A 重点', sampleType: 'size-set', },
    { w: 5, type: 'fabric', stage: 'shipping', name: '仿麻雪纺 — Cascadia 度假系列', sampleType: 'yardage' },
    { w: 5, type: 'garment', stage: 'approved', name: 'V领雪纺衬衫 — Aurora 首单开发', sampleType: 'pp-sample', converted: 16 },
    { w: 6, type: 'garment', stage: 'developing', name: '坑条针织背心 — Maple 补充款', sampleType: 'fit-sample' },
    { w: 7, type: 'fabric', stage: 'developing', name: '空气层面料 — Nordic 2027 预研', sampleType: 'lab-dip' },
    { w: 8, type: 'garment', stage: 'feedback', name: '荷叶边衬衫 — Sakura 批色反馈', sampleType: 'pp-sample' },
    { w: 9, type: 'garment', stage: 'approved', name: '两件套针织上衣 — Southern Cross 追加', sampleType: 'top-sample', converted: 24 },
  ];
  const devRows: Prisma.DevelopmentCaseUncheckedCreateInput[] = [];
  const sampleRows: Prisma.SampleNodeUncheckedCreateInput[] = [];
  devDefs.forEach((d, i) => {
    const id = `SIM-DEV-${String(5001 + i)}`;
    const cust = CUSTOMERS[i % 8];
    const owner = SALES_POOL[i % 3];
    const createdMs = at(d.w, 2, 10);
    devRows.push({
      id, code: `SIM-DEV-${String(5001 + i)}`, name: d.name, type: d.type, stage: d.stage,
      priority: i % 4 === 0 ? 'high' : 'normal', owner: SALES_NAME[owner],
      customerRelationId: cust.id, customerName: cust.name,
      supplierName: i % 2 === 0 ? '杭州锦盛服饰有限公司' : '绍兴瑞丰针织有限公司',
      currentRound: d.stage === 'revision' ? 2 : 1,
      nextAction: d.stage === 'developing' ? '等待样品制作' : d.stage === 'shipping' ? '客户反馈跟进' : d.stage === 'revision' ? '按客户意见修改后重寄' : '结案归档',
      targetDate: isoDate(createdMs + 30 * DAY),
      completedDate: d.stage === 'approved' ? isoDate(createdMs + 24 * DAY) : null,
      sampleCategory: i === 5 ? '5a' : 'normal',
      reviewStatus: i === 5 ? 'passed' : null, reviewerId: i === 5 ? USERS.gm : null,
      reviewDate: i === 5 ? isoDate(createdMs + 6 * DAY) : null,
      reviewNote: i === 5 ? '5A 重点样衣，生产部评审通过。' : null,
      sampleType: d.sampleType, sampleQuantity: d.type === 'fabric' ? 3 : 2,
      sampleUnit: d.type === 'fabric' ? 'meter' : 'pcs',
      sampleSentDate: d.stage === 'shipping' || d.stage === 'feedback' || d.stage === 'approved' || d.stage === 'revision' ? isoDate(createdMs + 8 * DAY) : null,
      sampleFeedbackDate: d.stage === 'feedback' || d.stage === 'approved' || d.stage === 'revision' ? isoDate(createdMs + 16 * DAY) : null,
      sampleFeedback: d.stage === 'revision' ? '袖长改短 1cm，领口收紧 0.5cm。' : d.stage === 'approved' ? '样品确认通过，可排大货。' : null,
      linkedOrderId: d.converted ? `SIM-ORD-${String(d.converted).padStart(3, '0')}` : null,
      linkedOrderPo: d.converted ? `SIM-PO-${String(1000 + d.converted)}` : null,
      convertedAt: d.converted ? BigInt(createdMs + 20 * DAY) : null,
      tags: [d.type], notes: null, createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 10 * DAY), deletedAt: null,
    });
    // 样衣节点：approved → confirmation+pp approved（转单的加 top）；在途 → confirmation sent/making
    const nid = (level: string) => `SIM-SN-${String(5001 + i)}-${level}`;
    if (d.stage === 'approved') {
      sampleRows.push({
        id: nid('confirmation'), developmentCaseId: id, level: 'confirmation', round: 1, status: 'approved',
        sentDate: isoDate(createdMs + 6 * DAY), courier: 'DHL', trackingNumber: `SIM-DHL-${8100 + i}`,
        feedback: '确认样通过', feedbackDate: isoDate(createdMs + 12 * DAY),
        approvedAt: BigInt(createdMs + 12 * DAY), approvedBy: SALES_NAME[owner],
        createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 12 * DAY), deletedAt: null,
      });
      sampleRows.push({
        id: nid('pp'), developmentCaseId: id, level: 'pp', round: 1, status: 'approved',
        sentDate: isoDate(createdMs + 14 * DAY), courier: 'FedEx', trackingNumber: `SIM-FDX-${8200 + i}`,
        feedback: '产前样双签通过', feedbackDate: isoDate(createdMs + 19 * DAY),
        approvedAt: BigInt(createdMs + 19 * DAY), approvedBy: 'Wilson Wu',
        createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 19 * DAY), deletedAt: null,
      });
      if (d.converted) {
        sampleRows.push({
          id: nid('top'), developmentCaseId: id, level: 'top', round: 1, status: 'approved',
          sentDate: isoDate(createdMs + 26 * DAY), courier: 'DHL', trackingNumber: `SIM-DHL-${8300 + i}`,
          feedback: '大货样（TOP）留档通过', feedbackDate: isoDate(createdMs + 28 * DAY),
          approvedAt: BigInt(createdMs + 28 * DAY), approvedBy: 'Wilson Wu',
          createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 28 * DAY), deletedAt: null,
        });
      }
    } else if (d.stage === 'shipping' || d.stage === 'feedback') {
      sampleRows.push({
        id: nid('confirmation'), developmentCaseId: id, level: 'confirmation', round: 1, status: 'sent',
        sentDate: isoDate(createdMs + 8 * DAY), courier: 'DHL', trackingNumber: `SIM-DHL-${8400 + i}`,
        feedback: null, feedbackDate: null, approvedAt: null, approvedBy: null,
        createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 8 * DAY), deletedAt: null,
      });
    } else if (d.stage === 'revision') {
      sampleRows.push({
        id: nid('confirmation'), developmentCaseId: id, level: 'confirmation', round: 2, status: 'revising',
        sentDate: isoDate(createdMs + 8 * DAY), courier: 'DHL', trackingNumber: `SIM-DHL-${8500 + i}`,
        feedback: '袖长/领口需修改（第二轮）', feedbackDate: isoDate(createdMs + 16 * DAY),
        approvedAt: null, approvedBy: null,
        createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 16 * DAY), deletedAt: null,
      });
    } else {
      sampleRows.push({
        id: nid('confirmation'), developmentCaseId: id, level: 'confirmation', round: 1, status: 'making',
        sentDate: null, courier: null, trackingNumber: null, feedback: null, feedbackDate: null,
        approvedAt: null, approvedBy: null, createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + 4 * DAY), deletedAt: null,
      });
    }
  });
  await createManyLogged(prisma, 'developmentCase', 'DevelopmentCase', devRows);
  await createManyLogged(prisma, 'sampleNode', 'SampleNode', sampleRows);

  // 5. MOQ 豁免审批 × 3（approved）
  const moqTargets = plans.filter((p) => p.fate === 'Confirmed').slice(0, 3);
  const approvalRows: Prisma.ApprovalRequestUncheckedCreateInput[] = moqTargets.map((p, i) => {
    const createdMs = p.createdAtMs + 3600 * 1000;
    const decidedMs = (p.confirmMs ?? p.createdAtMs) - 2 * 3600 * 1000;
    return {
      id: `SIM-APP-${String(701 + i)}`, requesterId: p.salesId, reviewerId: USERS.gm,
      actionType: 'order:moq-exemption', targetType: 'Order', targetId: p.id, status: 'approved',
      risk: 'medium',
      payload: {
        policyKey: 'moq_exemption', orderCode: p.code, orderQty: p.totalQty,
        moqRequired: 500, orderMoqShort: 500 - (p.totalQty % 500), reason: '老客户补色小单，产线有尾量可消化。',
      } as unknown as Prisma.InputJsonValue,
      decisionNote: '客户为 Gold/Platinum 层级且当季已有大货，同意 MOQ 豁免（小单补色）。— Raymond Lin',
      createdAt: new Date(createdMs), decidedAt: new Date(decidedMs),
      reviewerResolverRoute: 'DEPT_HEAD', clientReviewerIdSupplied: false,
      departmentSnapshotId: null,
    };
  });
  await createManyLogged(prisma, 'approvalRequest', 'ApprovalRequest（MOQ 豁免）', approvalRows);
}

/** CustomerTier 行透传（保持与上面对称的日志口径） */
function customerTierLog(rows: Prisma.CustomerTierUncheckedCreateInput[]): Prisma.CustomerTierUncheckedCreateInput[] {
  return rows;
}
