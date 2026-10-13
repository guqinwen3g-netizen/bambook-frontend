import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createGarmentSampleGateService } from '../garmentSampleGateService';
import { logger } from '../../lib/logger';
import { readSampleOriginContexts } from '../sampleOriginService';

function makeGarmentCase(overrides: any = {}) {
  return {
    id: 'CASE-G1',
    code: 'DEV-G-1',
    name: 'Garment case',
    type: 'garment',
    stage: 'developing',
    attachments: {},
    createdAt: BigInt(1000),
    updatedAt: BigInt(1000),
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(opts: { devCase?: any; reportIds?: string[] } = {}) {
  const state = {
    devCase: opts.devCase === undefined ? makeGarmentCase() : opts.devCase,
    reportIds: opts.reportIds ?? [],
    // DR-054 阶段 G-Ⅱ：轮次落 SampleBatch(sampleType='garment-round')
    batches: [] as any[], samples: [] as any[], sources: [] as any[], audits: [] as any[], rounds: [] as any[], versions: [] as any[],
  };
  const developmentCase: any = {
    findFirst: vi.fn().mockImplementation(async () => state.devCase),
    // The Sample projection resolves its business line from this stored case;
    // keep the actual source fixture instead of stubbing classification.
    findMany: vi.fn().mockImplementation(async ({ where }: any) =>
      state.devCase && where.id.in.includes(state.devCase.id) ? [state.devCase] : [],
    ),
    update: vi.fn().mockImplementation(async ({ data }: any) => {
      state.devCase = { ...state.devCase, ...data };
      return state.devCase;
    }),
  };
  const inspectionReport: any = {
    findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
      state.reportIds.includes(where.id) ? { id: where.id } : null,
    ),
  };
  const matches=(row:any,where:any):boolean=>!where||Object.entries(where).every(([key,value]:any)=>key==='OR'?value.some((part:any)=>matches(row,part)):value&&typeof value==='object'&&'in'in value?value.in.includes(row[key]):row[key]===value);
  const stored=(rows:()=>any[])=>({findMany:vi.fn(async({where}:any={})=>rows().filter(row=>matches(row,where))),create:vi.fn(async({data}:any)=>{rows().push(data);return data;})});
  const sampleSource=stored(()=>state.sources), auditLog=stored(()=>state.audits);
  // DR-052 写通：封存产前样 → Sample(type=pp) 投影（sealRound 内调用）
  const sample: any = {
    findFirst: vi.fn(async({where}:any)=>state.samples.find(row=>matches(row,where))??null),
    findUnique: vi.fn(async({where}:any)=>state.samples.find(row=>matches(row,where))??null),
    findMany: vi.fn(async({where}:any={})=>state.samples.filter(row=>matches(row,where))),
    create: vi.fn(async({data}:any)=>{const row={deletedAt:null,...data};state.samples.push(row);return row;}),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...data, id: where.id })),
  };
  const sampleBatch: any = {
    findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
      state.batches.find(b => b.id === where.id && !b.deletedAt) ?? null,
    ),
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      state.batches.filter(b => b.sampleType === 'garment-round' && !b.deletedAt && (!where?.id?.in || where.id.in.includes(b.id))),
    ),
    findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
      state.batches.find(b => b.id === where.id) ?? null,
    ),
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { ...data, deletedAt: null, createdAt: data.createdAt ?? BigInt(0), updatedAt: data.updatedAt ?? BigInt(0) };
      state.batches.push(row);
      return row;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const row = state.batches.find(b => b.id === where.id);
      if (!row) throw new Error('batch not found');
      Object.assign(row, data);
      return row;
    }),
  };
  const developmentSampleRound: any = {
    findFirst: vi.fn(async ({ where }: any) => state.rounds.find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => state.rounds.filter(row => matches(row, where))),
    create: vi.fn(async ({ data }: any) => { const row = { deletedAt: null, ...data }; state.rounds.push(row); return row; }),
    update: vi.fn(async ({ where, data }: any) => { const row = state.rounds.find(item => item.id === where.id); if (!row) throw new Error('round not found'); Object.assign(row, data); return row; }),
  };
  const developmentSampleVersion: any = {
    findFirst: vi.fn(async ({ where }: any) => state.versions.find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => state.versions.filter(row => matches(row, where))),
    create: vi.fn(async ({ data }: any) => { const row = { deletedAt: null, ...data }; state.versions.push(row); return row; }),
    update: vi.fn(async ({ where, data }: any) => { const row = state.versions.find(item => item.id === where.id); if (!row) throw new Error('version not found'); Object.assign(row, data); return row; }),
  };
  const developmentSampleQualityReview = { findMany: vi.fn(async () => []) };
  const developmentVersionConfirmation = { findMany: vi.fn(async () => []) };
  const sampleCardItem: any = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) };
  const tx: any = { developmentSampleQualityReview, developmentVersionConfirmation, developmentCase, inspectionReport, sample, sampleBatch, sampleSource, sampleCardItem, auditLog, developmentSampleRound, developmentSampleVersion, $queryRaw: vi.fn().mockResolvedValue([{id:'CASE-G1'}]), developmentLifecycleEvent:{findFirst:vi.fn().mockResolvedValue(null)} };
  const prisma: any = {
    developmentSampleQualityReview, developmentVersionConfirmation,
    developmentCase,
    inspectionReport,
    sample,
    sampleBatch,
    developmentSampleRound,
    developmentSampleVersion,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, state, tx };
}

const ACTOR = 'u_sales_1';
const QC_ACTOR = 'u_qc_1';

function roundInput(overrides: any = {}) {
  return { purpose: '首版产前样', version: 'V1', materialConfig: '面料A + 工艺单v1', plannedQuantity: 1, plannedUnit: '件', supplierRelationId:'SUP-A', supplierName:'Factory A', ...overrides };
}
const SHIP = { courier: 'DHL', trackingNumber: 'DHL-1', recipientName: 'ABC QA' };
const CONFIRM_OK = { result: 'approved' as const, confirmationDate: '2099-01-10', channel: 'email' };

/** 把样品轮驱动到指定状态（辅助函数，走真实服务调用链） */
async function driveRound(svc: any, stage: 'created' | 'qc_passed' | 'submitted' | 'confirmed' | 'sealed') {
  const created = await svc.createRound({ caseId: 'CASE-G1', input: roundInput(), actorId: ACTOR });
  expect(created.ok).toBe(true);
  const roundId = created.data.round.id;
  if (stage === 'created') return roundId;
  const qc = await svc.submitQcConclusion({ roundId, input: { result: 'passed', qcNote: '做工 OK' }, actorId: QC_ACTOR });
  expect(qc.ok).toBe(true);
  if (stage === 'qc_passed') return roundId;
  const sub = await svc.submitToCustomer({ roundId, input: SHIP, actorId: ACTOR });
  expect(sub.ok).toBe(true);
  if (stage === 'submitted') return roundId;
  const conf = await svc.registerCustomerConfirmation({ roundId, input: CONFIRM_OK, actorId: ACTOR });
  expect(conf.ok).toBe(true);
  if (stage === 'confirmed') return roundId;
  const seal = await svc.sealRound({ roundId, actorId: ACTOR });
  expect(seal.ok).toBe(true);
  return roundId;
}

describe('createRound（DR-008 每轮记录：目的/版本/材料工艺配置）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功创建首轮：round=1 + status=in_progress + qcStatus=none', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const r = await svc.createRound({ caseId: 'CASE-G1', input: roundInput(), actorId: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.round).toBe(1);
      expect(r.data.round.status).toBe('in_progress');
      expect(r.data.round.qcStatus).toBe('none');
      expect(r.data.round.purpose).toBe('首版产前样');
      expect(r.data.round.version).toBe('V1');
      expect(r.data.round.materialConfig).toContain('面料A');
      expect(r.data.round.createdBy).toBe(ACTOR);
    }
  });

  it('DR-051 方案 A：创建轮次登记打样工厂（本轮由哪家出品）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const r = await svc.createRound({
      caseId: 'CASE-G1',
      input: roundInput({ supplierRelationId: 'SUP-A', supplierName: '杭州锦盛服饰有限公司' }),
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.supplierRelationId).toBe('SUP-A');
      expect(r.data.round.supplierName).toBe('杭州锦盛服饰有限公司');
    }
  });

  it('同一轮的多个工厂各有独立版本节点和实体样衣，并共用轮次节点', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const first = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ round: 1, factories: [{ supplierRelationId: 'SUP-A' }] }), actorId: ACTOR });
    const second = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ round: 1, factories: [{ supplierRelationId: 'SUP-B' }] }), actorId: ACTOR });
    expect(first.ok && second.ok).toBe(true);
    expect(state.rounds).toHaveLength(1);
    expect(state.versions.map(version => version.versionLabel).sort()).toEqual(['R1-A-1', 'R1-B-1']);
    expect(state.batches).toHaveLength(2);
    expect(state.batches.every(batch => state.versions.some(version => version.id === batch.sampleVersionId))).toBe(true);
  });

  it('同轮同厂可继续新实物，下一轮保留工厂编号并可从旧版继续', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const create = (round: number, supplierRelationId: string, sourceVersionId?: string) => svc.createRound({
      caseId: 'CASE-G1', input: roundInput({ round, supplierRelationId, sourceVersionId }), actorId: ACTOR,
    });
    expect((await create(1, 'SUP-A')).ok).toBe(true);
    const oldest = state.versions[0].id;
    expect((await create(1, 'SUP-A', oldest)).ok).toBe(true);
    expect((await create(2, 'SUP-B')).ok).toBe(true);
    expect((await create(2, 'SUP-A', oldest)).ok).toBe(true);
    expect(state.versions.map(version => version.versionLabel)).toEqual(['R1-A-1', 'R1-A-2', 'R2-B-1', 'R2-A-3']);
    expect(state.versions[3].sourceVersionId).toBe(oldest);
  });

  it('purpose/version/materialConfig 任一缺失 → INVALID_INPUT', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    for (const input of [
      { version: 'V1', materialConfig: 'x' },
      { purpose: 'p', materialConfig: 'x' },
      { purpose: 'p', version: 'V1' },
    ]) {
      const r = await svc.createRound({ caseId: 'CASE-G1', input: input as any, actorId: ACTOR });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
    }
  });

  it('非服装开发单 → NOT_GARMENT_CASE（DR-008/DR-029 强制边界）', async () => {
    const { prisma } = makePrisma({ devCase: makeGarmentCase({ type: 'fabric' }) });
    const svc = createGarmentSampleGateService({ prisma });
    const r = await svc.createRound({ caseId: 'CASE-G1', input: roundInput(), actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_GARMENT_CASE');
  });

  it('不限轮数：可循环创建，round 递增', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const r1 = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ version: 'V1' }), actorId: ACTOR });
    const r2 = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ version: 'V2' }), actorId: ACTOR });
    const r3 = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ version: 'V3' }), actorId: ACTOR });
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (r3.ok) expect(r3.data.round.round).toBe(3);
  });
});

describe('submitQcConclusion（DR-029 内部 QC 评审）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passed → status=qc_passed + qcReviewedBy 留痕', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'created');
    const r = await svc.submitQcConclusion({ roundId, input: { result: 'passed', qcNote: '做工 OK' }, actorId: QC_ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.status).toBe('qc_passed');
      expect(r.data.round.qcStatus).toBe('passed');
      expect(r.data.round.qcReviewedBy).toBe(QC_ACTOR);
      expect(r.data.round.qcNote).toBe('做工 OK');
    }
  });

  it('failed → 回到 in_progress（工厂重做后可重新送 QC）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'created');
    const r = await svc.submitQcConclusion({ roundId, input: { result: 'failed', qcNote: '跳线' }, actorId: QC_ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.status).toBe('in_progress');
      expect(r.data.round.qcStatus).toBe('failed');
    }
  });

  it('引用不存在的 InspectionReport → QC_REPORT_NOT_FOUND（QC 域只读引用）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'created');
    const r = await svc.submitQcConclusion({
      roundId,
      input: { result: 'passed', qcInspectionReportId: 'IR-missing' },
      actorId: QC_ACTOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('QC_REPORT_NOT_FOUND');
  });

  it('已提交客户后不可再登记 QC → INVALID_TRANSITION', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'submitted');
    const r = await svc.submitQcConclusion({ roundId, input: { result: 'passed' }, actorId: QC_ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('submitToCustomer（DR-008 内部门禁 fail-closed）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('QC 未通过 → QC_GATE_NOT_PASSED 409（禁止提交客户）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'created');
    const r = await svc.submitToCustomer({ roundId, input: SHIP, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('QC_GATE_NOT_PASSED');
      expect(r.error.status).toBe(409);
    }
  });

  it('QC failed 后仍不可提交（fail-closed 不被 failed 状态绕过）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'created');
    await svc.submitQcConclusion({ roundId, input: { result: 'failed' }, actorId: QC_ACTOR });
    const r = await svc.submitToCustomer({ roundId, input: SHIP, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('QC_GATE_NOT_PASSED');
  });

  it('QC 通过 → 提交成功：status=submitted + DR-039 寄送字段齐全', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'qc_passed');
    const r = await svc.submitToCustomer({ roundId, input: { ...SHIP, sentDate: '2099-01-05', documents: [{ type: 'sample_card' }] }, actorId: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.status).toBe('submitted');
      expect(r.data.round.submittedBy).toBe(ACTOR);
      expect(r.data.round.shipment.courier).toBe('DHL');
      expect(r.data.round.shipment.trackingNumber).toBe('DHL-1');
      expect(r.data.round.shipment.recipientName).toBe('ABC QA');
      expect(r.data.round.shipment.sentDate).toBe('2099-01-05');
      expect(r.data.round.shipment.documents).toHaveLength(1);
    }
  });

  it('DR-039 必填：缺 courier/trackingNumber/recipientName → INVALID_INPUT', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'qc_passed');
    for (const input of [
      { trackingNumber: 'T', recipientName: 'R' },
      { courier: 'DHL', recipientName: 'R' },
      { courier: 'DHL', trackingNumber: 'T' },
    ]) {
      const r = await svc.submitToCustomer({ roundId, input: input as any, actorId: ACTOR });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('registerCustomerConfirmation（客户确认登记，不加主管审批）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未提交客户 → INVALID_TRANSITION', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'qc_passed');
    const r = await svc.registerCustomerConfirmation({ roundId, input: CONFIRM_OK, actorId: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('approved → status=confirmed + 渠道/日期/证据/修改项留痕', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'submitted');
    const r = await svc.registerCustomerConfirmation({
      roundId,
      input: { ...CONFIRM_OK, note: '版型 OK', modifications: [], evidence: [{ type: 'email' }] },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.status).toBe('confirmed');
      expect(r.data.round.customerStatus).toBe('approved');
      expect(r.data.round.confirmation.channel).toBe('email');
      expect(r.data.round.confirmation.registeredBy).toBe(ACTOR);
      expect(r.data.round.confirmation.evidence).toHaveLength(1);
    }
  });

  it('rejected → 该轮终止（status=rejected）；改动须开新轮重走 QC（DR-029 闭环）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'submitted');
    const r = await svc.registerCustomerConfirmation({
      roundId,
      input: { result: 'rejected', confirmationDate: '2099-01-10', channel: 'email', modifications: ['袖肥 +1cm'] },
      actorId: ACTOR,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.status).toBe('rejected');
      expect(r.data.round.modifications).toEqual(['袖肥 +1cm']);
    }
  });
});

describe('sealRound（DR-008 封样不可变 + 收口投影）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未 confirmed → SEAL_REQUIRES_CONFIRMED 409（双门禁缺一不可）', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    for (const stage of ['created', 'qc_passed', 'submitted'] as const) {
      const roundId = await driveRound(svc, stage);
      const r = await svc.sealRound({ roundId, actorId: ACTOR });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SEAL_REQUIRES_CONFIRMED');
    }
  });

  it('confirmed → sealed：sealedBy/At 留痕 + sealedRoundId 更新 + pp 样衣节点投影 approved', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'confirmed');
    const r = await svc.sealRound({ roundId, actorId: ACTOR, retainLocation: '样品间 A 柜 3 层' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.round.status).toBe('sealed');
      expect(r.data.round.sealedBy).toBe(ACTOR);
      expect(r.data.round.sealedAt).toBeTruthy();
    }
    // 消双轨 L-2 末件：封样不再写 SampleNode（封样=物理留存登记；放行由 production DR-053 独立驱动）
    expect(prisma.sampleNode).toBeUndefined();
    // DR-054 阶段 G-Ⅱ：轮次落 SampleBatch，封存基准 = sealedRoundStatus 行
    const sealedBatch = state.batches.find((b: any) => b.attachments?.sealedRoundStatus === 'sealed');
    expect(sealedBatch?.id).toBe(roundId);
    expect(sealedBatch?.customerStatus).toBe('approved');
    const readback = await svc.listRounds({ caseId: 'CASE-G1' });
    expect(readback).toMatchObject({ ok: true, data: { items: [expect.objectContaining({
      id: roundId, status: 'sealed', customerStatus: 'approved',
      confirmation: expect.objectContaining({ result: 'approved', registeredBy: ACTOR }),
    })] } });
    // §10.3 封样口径：封存登记的留存位置随轮次 attachments 落库
    expect(sealedBatch?.attachments?.retainLocation).toBe('样品间 A 柜 3 层');
  });

  it('new native approval freezes Case and round content; later Case changes preserve identity but invalidate current use',async()=>{
    const {prisma,state,tx}=makePrisma({devCase:makeGarmentCase({styleSpec:'original fit',sizeSpec:'S/M',fabricSpec:'cotton',processSpec:'washed'})});
    const service=createGarmentSampleGateService({prisma});await driveRound(service,'sealed');
    const proofs=state.audits.filter((row:any)=>['submit_garment_sample_qc','confirm_garment_sample'].includes(row.action));
    expect(proofs).toHaveLength(2);for(const proof of proofs)expect(proof.detail.after.caseContent).toMatchObject({id:'CASE-G1',styleSpec:'original fit'});
    expect((await readSampleOriginContexts(tx,state.samples))[0]).toMatchObject({status:'resolved',currentUsable:true});
    state.devCase={...state.devCase,styleSpec:'changed fit'};
    const [changed]=await readSampleOriginContexts(tx,state.samples);expect(changed.status).toBe('resolved');expect(changed.currentUsable).toBe(false);
    expect(changed.reasons).toContain('ORIGIN_CONTENT_CHANGED');expect(changed.reasons).toContain('ORIGIN_APPROVAL_VERSION_UNPROVEN');
    expect(state.sources).toHaveLength(1);expect(state.sources[0].sourceSnapshot.content.caseContent.styleSpec).toBe('original fit');
  });

  it('legacy scalar omission reads the actual recorded confirmation; explicit current verdict has priority', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'sealed');
    const row = state.batches.find(b => b.id === roundId);
    row.customerStatus = null;
    expect(await svc.listRounds({ caseId: 'CASE-G1' })).toMatchObject({ ok: true,
      data: { items: [expect.objectContaining({ customerStatus: 'approved' })] } });
    row.customerStatus = 'rejected';
    expect(await svc.listRounds({ caseId: 'CASE-G1' })).toMatchObject({ ok: true,
      data: { items: [expect.objectContaining({ customerStatus: 'rejected' })] } });
  });

  it('sealed labels and unknown confirmation results cannot fabricate customer approval', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'sealed');
    const row = state.batches.find(b => b.id === roundId);
    row.customerStatus = null;
    row.attachments.confirmation = null;
    expect(await svc.listRounds({ caseId: 'CASE-G1' })).toMatchObject({ ok: true,
      data: { items: [expect.objectContaining({ customerStatus: 'pending' })] } });
    row.attachments.confirmation = { result: 'unknown' };
    expect(await svc.listRounds({ caseId: 'CASE-G1' })).toMatchObject({ ok: true,
      data: { items: [expect.objectContaining({ customerStatus: 'pending' })] } });
  });

  it('DR-052 §10 #1 写通：封存产前样 → Sample(type=pp, approved)（样品管理域承载，开裁前置语义对齐）', async () => {
    const { prisma, tx } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const roundId = await driveRound(svc, 'confirmed');
    const r = await svc.sealRound({ roundId, actorId: ACTOR, retainLocation: '样品间 A 柜 3 层' });
    expect(r.ok).toBe(true);
    // 封存后创建 Sample(type=pp, status=approved)，来源开发案 + 归属工厂 + 批准人留痕
    expect(tx.sample.create).toHaveBeenCalled();
    const createCall = tx.sample.create.mock.calls[0][0].data;
    expect(createCall.type).toBe('pp');
    expect(createCall.status).toBe('approved');
    expect(createCall.sourceCaseId).toBe('CASE-G1');
    expect(createCall.approvedBy).toBe(ACTOR);
  });

  it('新一轮封存时旧封存轮次转 superseded（历史基准保留不可变）', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const first = await driveRound(svc, 'sealed');

    // 客户要求改动 → 开新轮 → 完整双门禁 → 封存
    const created = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ version: 'V2', purpose: '袖肥修改' }), actorId: ACTOR });
    expect(created.ok).toBe(true); if (!created.ok) throw Error(created.error.message);
    const secondId = created.data.round.id;
    await svc.submitQcConclusion({ roundId: secondId, input: { result: 'passed' }, actorId: QC_ACTOR });
    await svc.submitToCustomer({ roundId: secondId, input: SHIP, actorId: ACTOR });
    await svc.registerCustomerConfirmation({ roundId: secondId, input: CONFIRM_OK, actorId: ACTOR });
    const r = await svc.sealRound({ roundId: secondId, actorId: ACTOR });
    expect(r.ok).toBe(true);

    // DR-054 阶段 G-Ⅱ：轮次落 SampleBatch（attachments.sealedRoundStatus 表达 sealed/superseded）
    const r1 = state.batches.find((b: any) => b.id === first);
    const r2 = state.batches.find((b: any) => b.id === secondId);
    expect(r1.attachments.sealedRoundStatus).toBe('superseded');
    expect(r2.attachments.sealedRoundStatus).toBe('sealed');
    expect(state.batches.filter((b: any) => b.attachments?.sealedRoundStatus === 'sealed').map((b: any) => b.id)).toEqual([secondId]);
  });

  it('sealed/superseded 轮次内容不可再改 → SEALED_IMMUTABLE 409', async () => {
    const { prisma, state } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const sealedId = await driveRound(svc, 'sealed');

    const r1 = await svc.submitQcConclusion({ roundId: sealedId, input: { result: 'failed' }, actorId: QC_ACTOR });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('SEALED_IMMUTABLE');

    const r2 = await svc.submitToCustomer({ roundId: sealedId, input: SHIP, actorId: ACTOR });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('SEALED_IMMUTABLE');

    const r3 = await svc.registerCustomerConfirmation({ roundId: sealedId, input: CONFIRM_OK, actorId: ACTOR });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('SEALED_IMMUTABLE');

    // superseded 同样不可变
    const created = await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ version: 'V2' }), actorId: ACTOR });
    expect(created.ok).toBe(true); if (!created.ok) throw Error(created.error.message);
    const secondId = created.data.round.id;
    await svc.submitQcConclusion({ roundId: secondId, input: { result: 'passed' }, actorId: QC_ACTOR });
    await svc.submitToCustomer({ roundId: secondId, input: SHIP, actorId: ACTOR });
    await svc.registerCustomerConfirmation({ roundId: secondId, input: CONFIRM_OK, actorId: ACTOR });
    await svc.sealRound({ roundId: secondId, actorId: ACTOR });
    const r4 = await svc.submitQcConclusion({ roundId: sealedId, input: { result: 'passed' }, actorId: QC_ACTOR });
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error.code).toBe('SEALED_IMMUTABLE');
    expect(state.batches.find((b: any) => b.id === sealedId).attachments.sealedRoundStatus).toBe('superseded');
  });
});

describe('listRounds', () => {
  it('返回全部轮次 + 当前封存基准', async () => {
    const { prisma } = makePrisma();
    const svc = createGarmentSampleGateService({ prisma });
    const sealedId = await driveRound(svc, 'sealed');
    await svc.createRound({ caseId: 'CASE-G1', input: roundInput({ version: 'V2' }), actorId: ACTOR });
    const r = await svc.listRounds({ caseId: 'CASE-G1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items).toHaveLength(2);
      expect(r.data.sealedRoundId).toBe(sealedId);
    }
  });

  it('开发单不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ devCase: null });
    const svc = createGarmentSampleGateService({ prisma });
    const r = await svc.listRounds({ caseId: 'CASE-X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});

/**
 * §9 **B39** · 位置参数内插原文的执行覆盖（R3 / §6 S1）
 *
 * 本批把该文件 5 处 ``fail(CODE, `…失败: ${String(e?.message ?? e)}`, 500)`` 换成字面中文，
 * **并补上该文件原本没有的 `logger.error`**（实测 `logger.error` 计数为 0，只有 info/warn）—— D51。
 *
 * ★ **D52 覆盖面**：5 处的 `try` 内**唯一写都是那个 `$transaction`**（写全用 `tx`，
 *   连 `:618` 的 `upsertPpSampleFromSealedRound` 也传 `tx`），事务之后只有 `logger.info` + `return`
 *   ⇒ **五处都可以**承诺「本次未确认任何改动」。
 *
 * 出口链已核：`sampleRoute.ts:90` 的 `sendResult` 原样转发 `r.error.message`（同域既有用例已锁）。
 * ⚠️ 本文件**未** `vi.mock` logger ⇒ 用 `vi.spyOn` 打在真 logger 上。
 */
const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/samples/garmentSampleGateService.ts:304 — '
  + 'Unique constraint failed on the fields: (`id`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'garmentSampleGateService.ts:304', 'Unique constraint', '/srv/app', 'P2002'];

function expectB39Copy(msg: unknown, mustMention: string) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|联系管理员)/);
  expect(s.match(/[A-Za-z]{3,}/g) ?? [], `混入拉丁词（疑似原文上屏）：${s}`).toEqual([]);
  expect(s, '唯一写是 $transaction ⇒ 可以承诺零改动').toContain('本次未确认任何改动');
}

describe('§9 B39 · 成衣样品门禁五处出口：内部原文不上屏', () => {
  const CASES: Array<{ name: string; stage: 'created' | 'qc_passed' | 'submitted' | 'confirmed'; code: string; mention: string; run: (svc: any, roundId: string) => Promise<any> }> = [
    { name: 'createRound', stage: 'created', code: 'CREATE_FAILED', mention: '轮次创建', run: (svc) => svc.createRound({ caseId: 'CASE-G1', input: roundInput(), actorId: ACTOR }) },
    { name: 'submitQcConclusion', stage: 'created', code: 'UPDATE_FAILED', mention: 'QC 结论', run: (svc, roundId) => svc.submitQcConclusion({ roundId, input: { result: 'passed', qcNote: '做工 OK' }, actorId: QC_ACTOR }) },
    { name: 'submitToCustomer', stage: 'qc_passed', code: 'UPDATE_FAILED', mention: '提交客户', run: (svc, roundId) => svc.submitToCustomer({ roundId, input: SHIP, actorId: ACTOR }) },
    { name: 'registerCustomerConfirmation', stage: 'submitted', code: 'UPDATE_FAILED', mention: '客户确认', run: (svc, roundId) => svc.registerCustomerConfirmation({ roundId, input: CONFIRM_OK, actorId: ACTOR }) },
    { name: 'sealRound', stage: 'confirmed', code: 'SEAL_FAILED', mention: '封样', run: (svc, roundId) => svc.sealRound({ roundId, actorId: ACTOR }) },
  ];

  for (const c of CASES) {
    it(`★ ${c.name}：500 + 码名不变 + 中文 + 零原文 + 承诺零改动`, async () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
      const { prisma } = makePrisma();
      const svc = createGarmentSampleGateService({ prisma });
      // createRound 自身就是要测的目标 ⇒ 不需要预热；其余先把轮次驱到目标状态
      const roundId = c.name === 'createRound' ? '' : await driveRound(svc, c.stage);
      prisma.$transaction = async () => { throw new Error(B39_RAW); };
      const r = await c.run(svc, roundId);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code, `${c.name} 码名不得随文案一起改`).toBe(c.code);
      const raw = JSON.stringify(r.error);
      for (const frag of B39_FRAGMENTS) expect(raw, `${c.name} 泄漏了「${frag}」`).not.toContain(frag);
      expectB39Copy(r.error.message, c.mention);
      expect(spy, `${c.name} 原文必须仍进日志（本文件原先一处 logger.error 都没有）`).toHaveBeenCalledWith(
        expect.stringContaining('[GarmentGate]'), expect.objectContaining({ error: B39_RAW }));
      spy.mockRestore();
    });
  }
});


describe('开发生命周期事务门禁',()=>{
 it.each(['paused','closed'])('%s阻止全部轮次写入口且原码409',async(state)=>{
  const {prisma,tx,state:db}=makePrisma();const service=createGarmentSampleGateService({ prisma });
  const created=await service.createRound({caseId:'CASE-G1',input:roundInput(),actorId:ACTOR});expect(created.ok).toBe(true);if(!created.ok)return;
  const id=created.data.round.id;tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state});
  for(const action of ['create','qc','submit','confirm','seal']){
   const b=db.batches[0];b.status=action==='confirm'?'sent':action==='seal'?'approved':'making';b.qcStatus='passed';b.attachments={};
   tx.sampleBatch.create.mockClear();tx.sampleBatch.update.mockClear();tx.sample.create.mockClear();
   const r=action==='create'?await service.createRound({caseId:'CASE-G1',input:roundInput(),actorId:ACTOR}):action==='qc'?await service.submitQcConclusion({roundId:id,input:{result:'passed'},actorId:ACTOR}):action==='submit'?await service.submitToCustomer({roundId:id,input:{courier:'DHL',trackingNumber:'T',recipientName:'Buyer'},actorId:ACTOR}):action==='confirm'?await service.registerCustomerConfirmation({roundId:id,input:{result:'approved',confirmationDate:'2026-09-30',channel:'email'},actorId:ACTOR}):await service.sealRound({roundId:id,actorId:ACTOR});
   expect(r).toMatchObject({ok:false,error:{code:state==='paused'?'DEVELOPMENT_PAUSED':'DEVELOPMENT_CLOSED',status:409}});expect(tx.sampleBatch.create).not.toHaveBeenCalled();expect(tx.sampleBatch.update).not.toHaveBeenCalled();expect(tx.sample.create).not.toHaveBeenCalled();
  }
 });
 it('锁后重读轮次：并发变为封样时不得继续QC写入',async()=>{const{prisma,tx,state}=makePrisma();const service=createGarmentSampleGateService({ prisma });const r=await service.createRound({caseId:'CASE-G1',input:roundInput(),actorId:ACTOR});if(!r.ok)throw Error('fixture');tx.$queryRaw.mockImplementation(async()=>{state.batches[0].attachments={sealedRoundStatus:'sealed'};return[{id:'CASE-G1'}];});tx.sampleBatch.update.mockClear();expect(await service.submitQcConclusion({roundId:r.data.round.id,input:{result:'passed'},actorId:ACTOR})).toMatchObject({ok:false,error:{code:'SEALED_IMMUTABLE',status:409}});expect(tx.sampleBatch.update).not.toHaveBeenCalled();});
});

it('active生命周期允许正常新轮次，锁与生命周期查询先于批次写入',async()=>{
 const {prisma,tx}=makePrisma();tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state:'active'});
 const r=await createGarmentSampleGateService({prisma}).createRound({caseId:'CASE-G1',input:roundInput(),actorId:ACTOR});
 expect(r.ok).toBe(true);expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.developmentLifecycleEvent.findFirst.mock.invocationCallOrder[0]);expect(tx.developmentLifecycleEvent.findFirst.mock.invocationCallOrder[0]).toBeLessThan(tx.sampleBatch.create.mock.invocationCallOrder[0]);
});
it('事务内批次读取失败不能当无轮次继续新建',async()=>{
 const{prisma,tx}=makePrisma();tx.sampleBatch.findMany.mockRejectedValue(Error('database unavailable'));
 expect(await createGarmentSampleGateService({prisma}).createRound({caseId:'CASE-G1',input:roundInput(),actorId:ACTOR})).toMatchObject({ok:false,error:{code:'CREATE_FAILED',status:500}});expect(tx.sampleBatch.create).not.toHaveBeenCalled();
});
