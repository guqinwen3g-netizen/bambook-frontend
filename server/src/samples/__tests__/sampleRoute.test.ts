import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSampleRouter } from '../sampleRoute';
import { authHeader } from '../../__tests__/authTestHelper';
import { registrationCaseContent, registrationDigest, registrationBatchContext } from '../sampleRegistrationContextService';
import { fabricAuthorizationFixture } from '../../development/__tests__/fabricAuthorizationFixture';

/**
 * 样品域路由契约测试：
 *  - 写操作必须 JWT（API key 不可写，fail-closed）
 *  - scope 守卫（无 scope → 403）
 *  - DR-008 内部门禁（QC 未通过提交客户 → 409）
 *  - DR-012 资格判定端点输出
 *  - DR-039 寄送必填校验透传
 */
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const noScopeToken = jwt.sign({ userId: 'u_noscope', roles: [], permissions: [] }, JWT_SECRET);

function makeFabricOrder(overrides: any = {}) {
  return {
    id: 'ORD-F1',
    orderNo: 'SO-F-1',
    type: 'Fabric',
    businessLine: 'fabric',
    status: 'in_production',
    clientDate: '2099-12-31',
    deletedAt: null,
    ...overrides,
  };
}

function makeGarmentCase(overrides: any = {}) {
  return {
    id: 'CASE-G1',
    code: 'DEV-G-1',
    type: 'garment',
    attachments: {},
    createdAt: BigInt(1000),
    updatedAt: BigInt(1000),
    deletedAt: null,
    ...overrides,
  };
}

function makeApp(opts: { requireAuth?: boolean; apiKeys?: Set<string> } = {}) {
  const state: any = {
    order: makeFabricOrder(),
    devCase: makeGarmentCase(),
    samples: [],
    eps: [],
    sampleRows: [], // DR-052 统一样品对象 Sample（封存产前样 → Sample(type=pp) 写通）
    batches: [], // DR-054 阶段 G-Ⅱ：成衣轮次落 SampleBatch(garment-round)
    lifecycleEvents: [], // 当前生命周期由事件查询得出；未产生事件是合法的初始开发前提。
    seq: 0, sources: [], audits: [], sampleCards: [], developmentSampleRounds: [], developmentSampleVersions: [],
  };
  const fabricShipmentSample: any = {
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { createdAt: BigInt(1000), updatedAt: BigInt(1000), deletedAt: null, ...data };
      state.samples.push(row);
      return row;
    }),
    findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
      state.samples.find((s: any) => s.id === where.id && !s.deletedAt) ?? null,
    ),
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
      let rows = state.samples.filter((s: any) => !s.deletedAt);
      if (where?.orderId) rows = rows.filter((s: any) => s.orderId === where.orderId);
      return rows;
    }),
    count: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      where?.sampleCode?.startsWith
        ? state.samples.filter((s: any) => s.sampleCode.startsWith(where.sampleCode.startsWith)).length
        : state.samples.length,
    ),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const idx = state.samples.findIndex((s: any) => s.id === where.id);
      if (idx >= 0) state.samples[idx] = { ...state.samples[idx], ...data };
      return state.samples[idx];
    }),
  };
  const earlyProductionSample: any = {
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { createdAt: BigInt(1000), updatedAt: BigInt(1000), deletedAt: null, ...data };
      state.eps.push(row);
      return row;
    }),
    findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
      state.eps.find((s: any) => s.id === where.id && !s.deletedAt) ?? null,
    ),
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
      let rows = state.eps.filter((s: any) => !s.deletedAt);
      if (where?.orderId) rows = rows.filter((s: any) => s.orderId === where.orderId);
      return rows;
    }),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const idx = state.eps.findIndex((s: any) => s.id === where.id);
      if (idx >= 0) state.eps[idx] = { ...state.eps[idx], ...data };
      return state.eps[idx];
    }),
  };
  const matches=(row:any,where:any):boolean=>!where||Object.entries(where).every(([key,value]:any)=>key==='OR'?value.some((part:any)=>matches(row,part)):value&&typeof value==='object'&&'in'in value?value.in.includes(row[key]):row[key]===value);
  const stored=(rows:()=>any[])=>({findMany:vi.fn(async({where}:any={})=>rows().filter(row=>matches(row,where))),create:vi.fn(async({data}:any)=>{rows().push(data);return data;})});
  const sampleSource=stored(()=>state.sources), auditLog=stored(()=>state.audits);
  const sampleCardItem = {
    findFirst: vi.fn(async ({ where }: any = {}) => state.sampleCards.find((row: any) =>
      (!where?.orderId || row.orderId === where.orderId) && (where?.deletedAt === undefined || row.deletedAt === where.deletedAt)) ?? null),
  };
  const developmentSampleRound = {
    findFirst: vi.fn(async ({ where }: any = {}) => state.developmentSampleRounds.find((row: any) =>
      row.developmentCaseId === where?.developmentCaseId && row.round === where?.round) ?? null),
    create: vi.fn(async ({ data }: any) => { state.developmentSampleRounds.push(data); return data; }),
    update: vi.fn(async ({ where, data }: any) => {
      const index = state.developmentSampleRounds.findIndex((row: any) => row.id === where.id);
      if (index < 0) return null;
      state.developmentSampleRounds[index] = { ...state.developmentSampleRounds[index], ...data };
      return state.developmentSampleRounds[index];
    }),
  };
  const developmentSampleVersion = {
    findFirst: vi.fn(async ({ where }: any = {}) => state.developmentSampleVersions.find((row: any) =>
      (!where?.roundId || row.roundId === where.roundId)
      && (!where?.supplierRelationId || row.supplierRelationId === where.supplierRelationId)
      && (where?.minorVersion === undefined || row.minorVersion === where.minorVersion)
      && (where?.deletedAt === undefined || row.deletedAt === where.deletedAt)) ?? null),
    create: vi.fn(async ({ data }: any) => { state.developmentSampleVersions.push(data); return data; }),
    update: vi.fn(async ({ where, data }: any) => {
      const index = state.developmentSampleVersions.findIndex((row: any) => row.id === where.id);
      if (index < 0) return null;
      state.developmentSampleVersions[index] = { ...state.developmentSampleVersions[index], ...data };
      return state.developmentSampleVersions[index];
    }),
  };
  // Explicitly legacy-only data: the mandatory installed native delegate exists
  // and reports no native identity; missing storage is never a fallback.
  const orderSampleSource={findFirst:vi.fn(async()=>null),findUnique:vi.fn(async()=>null),findMany:vi.fn(async()=>[])};
  const developmentCase: any = {
    findMany:vi.fn(async({where}:any)=>state.devCase&&matches(state.devCase,where)?[state.devCase]:[]),
    findFirst: vi.fn().mockImplementation(async () => state.devCase),
    update: vi.fn().mockImplementation(async ({ data }: any) => {
      state.devCase = { ...state.devCase, ...data };
      return state.devCase;
    }),
  };
  const inspectionReport: any = { findUnique: vi.fn().mockResolvedValue(null) };
  const dr013ExceptionRequest: any = { findMany: vi.fn().mockResolvedValue([]) };
  // DR-052 统一样品对象 Sample：封存产前样 → Sample(type=pp, approved) 写通（upsertPpSampleFromSealedRound）
  const sampleModel: any = {
    findUnique:vi.fn(async({where}:any)=>state.sampleRows.find((row:any)=>matches(row,where))??null),
    findFirst: vi.fn().mockImplementation(async ({ where }: any = {}) =>
      state.sampleRows.find((s: any) =>
        (!where?.sourceCaseId || s.sourceCaseId === where.sourceCaseId)
        && (!where?.type || s.type === where.type)
        && (!where?.id || s.id === where.id)
        && !s.deletedAt) ?? null,
    ),
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { id: data.id, code: data.code, createdAt: data.createdAt, updatedAt: data.updatedAt, deletedAt: null, ...data };
      state.sampleRows.push(row);
      return row;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const idx = state.sampleRows.findIndex((s: any) => s.id === where.id);
      if (idx >= 0) state.sampleRows[idx] = { ...state.sampleRows[idx], ...data };
      return state.sampleRows[idx];
    }),
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => state.sampleRows.filter((s: any) =>
      (!where?.sourceCaseId || s.sourceCaseId === where.sourceCaseId) && (!where?.type || s.type === where.type) && !s.deletedAt)),
    count: vi.fn().mockResolvedValue(0),
  };
  // DR-054 阶段 G-Ⅱ：成衣轮次落 SampleBatch（garment-round）
  const sampleBatch: any = {
    findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
      state.batches.find((b: any) => b.id === where.id && !b.deletedAt) ?? null,
    ),
    findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
      let rows = state.batches.filter((b: any) => !b.deletedAt);
      if (where?.id?.in) rows=rows.filter((b:any)=>where.id.in.includes(b.id));
      if (where?.developmentCaseId) rows = rows.filter((b: any) => b.developmentCaseId === where.developmentCaseId);
      return rows;
    }),
    findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
      state.batches.find((b: any) => b.id === where.id) ?? null,
    ),
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      const row = { ...data, createdAt: data.createdAt ?? BigInt(0), updatedAt: data.updatedAt ?? BigInt(0), deletedAt: null };
      state.batches.push(row);
      return row;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const idx = state.batches.findIndex((b: any) => b.id === where.id);
      if (idx >= 0) state.batches[idx] = { ...state.batches[idx], ...data };
      return state.batches[idx];
    }),
  };
  // 只模拟查询输入/返回和模型副作用，不能证明真实 PostgreSQL FOR UPDATE 或事务回滚。
  const currentGrant=fabricAuthorizationFixture('u_owner');
  const tx: any = {
    ...currentGrant,
    orderSampleSource, fabricShipmentSample, earlyProductionSample, developmentCase, inspectionReport, sample: sampleModel, sampleBatch, sampleCardItem, sampleSource, auditLog,
    developmentSampleRound, developmentSampleVersion,
    $queryRaw: vi.fn(async (query: any) => {
      const caseId = query.values[0];
      return state.devCase?.id === caseId && !state.devCase.deletedAt ? [{ id: caseId }] : [];
    }),
    developmentLifecycleEvent: {
      findFirst: vi.fn(async ({ where }: any) => state.lifecycleEvents
        .filter((event: any) => event.developmentCaseId === where.developmentCaseId)
        .sort((a: any, b: any) => b.revision - a.revision)[0] ?? null),
    },
  };
  const prisma: any = {
    ...currentGrant, orderSampleSource, sampleSource, auditLog,
    order: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
        state.order && (!where?.id || state.order.id === where.id) ? state.order : null,
      ),
    },
    fabricShipmentSample,
    earlyProductionSample,
    developmentCase,
    inspectionReport,
    sample: sampleModel,
    sampleBatch,
    dr013ExceptionRequest,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/samples',
    createSampleRouter({
      prisma,
      requireAuth: opts.requireAuth ?? false,
      apiKeys: opts.apiKeys ?? new Set<string>(),
      onDataChange,
    }),
  );
  return { app, state, onDataChange, tx };
}

describe('面料 S/S + RC 路由', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['shipment-sample','head-sample'])('retired POST /fabric/:orderId/%s is 410 with guidance and no legacy/source/audit writes',async endpoint=>{
    const{app,state,tx,onDataChange}=makeApp();const before=structuredClone(state);
    const res=await request(app).post('/api/v1/samples/fabric/ORD-F1/'+endpoint).set(authHeader()).send({sampleQuantity:2,cuttingDate:'2099-01-01',enabledReason:'Synthetic'});
    expect(res.status).toBe(410);expect(res.body.error).toMatchObject({code:'GONE',message:expect.stringContaining('订单样品登记流程')});expect(state).toEqual(before);expect(tx.fabricShipmentSample.create).not.toHaveBeenCalled();expect(tx.sample.create).not.toHaveBeenCalled();expect(tx.sampleSource.create).not.toHaveBeenCalled();expect(tx.auditLog.create).not.toHaveBeenCalled();expect(onDataChange).not.toHaveBeenCalled();
  });

  it('POST /:id/ship + /:id/confirm 全链路 → GET shipment-eligibility eligible=true（DR-012）', async () => {
    const { app,state } = makeApp();
    // Persisted historical fact may still be read/operated; retired registration
    // must not be used to manufacture a new legacy Sample for this test.
    const sampleId='FSS__historical';state.samples.push({id:sampleId,sampleCode:'FSS-HISTORICAL',orderId:'ORD-F1',sentToCustomer:false,customerStatus:'pending',attachments:{sampleKind:'SS'},createdAt:BigInt(1000),updatedAt:BigInt(1000),deletedAt:null});

    // 未确认前：不具备正常发货条件
    const before = await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-eligibility').set(authHeader());
    expect(before.status).toBe(200);
    expect(before.body.eligibility.eligibleForNormalShipment).toBe(false);
    expect(before.body.eligibility.blockingReasons).toContain('SS_NOT_SENT');

    const ship = await request(app)
      .post(`/api/v1/samples/${sampleId}/ship`)
      .set(authHeader())
      .send({ courier: 'DHL', trackingNumber: 'T-1', recipientName: 'ABC QA' });
    expect(ship.status).toBe(200);
    expect(ship.body.sample.sentToCustomer).toBe(true);

    const mid = await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-eligibility').set(authHeader());
    expect(mid.body.eligibility.blockingReasons).toContain('SS_NOT_CONFIRMED');

    const confirm = await request(app)
      .post(`/api/v1/samples/${sampleId}/confirm`)
      .set(authHeader())
      .send({ result: 'approved', confirmationDate: '2099-01-10', channel: 'email' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.sample.customerStatus).toBe('approved');

    const after = await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-eligibility').set(authHeader());
    expect(after.body.eligibility.eligibleForNormalShipment).toBe(true);
  });

  it('legacy shipment refuses when a warehouse physical card already exists for the order', async () => {
    const { app, state, tx } = makeApp();
    const sampleId = 'FSS__legacy-with-card';
    state.samples.push({ id: sampleId, sampleCode: 'FSS-CARD', orderId: 'ORD-F1', sentToCustomer: false,
      customerStatus: 'pending', attachments: { sampleKind: 'SS' }, deletedAt: null });
    state.sampleCards.push({ id: 'SCI-1', orderId: 'ORD-F1', deletedAt: null });
    const before = structuredClone(state.samples[0]);

    const ship = await request(app).post(`/api/v1/samples/${sampleId}/ship`).set(authHeader())
      .send({ courier: 'DHL', trackingNumber: 'T-2', recipientName: 'ABC QA' });

    expect(ship.status).toBe(409);
    expect(ship.body.error.code).toBe('NATIVE_SHIPMENT_REQUIRED');
    expect(state.samples[0]).toEqual(before);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('POST /:id/ship 缺 DR-039 必填字段 → 400 INVALID_INPUT', async () => {
    const { app, state } = makeApp();
    state.samples.push({
      id: 'FSS__x',
      sampleCode: 'FSS-1',
      orderId: 'ORD-F1',
      sentToCustomer: false,
      customerStatus: 'pending',
      attachments: { sampleKind: 'SS' },
      deletedAt: null,
    });
    const res = await request(app).post('/api/v1/samples/FSS__x/ship').set(authHeader()).send({ courier: 'DHL' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('GET /fabric/:orderId/shipment-gate：无样品且无生效例外 → 409 GATE_BLOCKED + 申请入口提示（DR-013 消费端）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-gate').set(authHeader());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GATE_BLOCKED');
    expect(res.body.error.blockingReasons).toContain('SS_NOT_REGISTERED');
    expect(res.body.error.exceptionReason).toBe('NO_ACTIVE_EXCEPTION');
    expect(res.body.error.exceptionEntryHint).toContain('POST /api/v1/exceptions');
  });

  it('GET /fabric/:orderId/shipment-gate：S/S 已确认 → 200 passedVia=gate + eligibility 透传', async () => {
    const { app, state } = makeApp();
    state.samples.push({
      id: 'FSS__ok',
      sampleCode: 'FSS-20990101-001',
      orderId: 'ORD-F1',
      sentToCustomer: true,
      sentDate: '2099-01-05',
      customerStatus: 'approved',
      attachments: { sampleKind: 'SS' },
      deletedAt: null,
      createdAt: BigInt(1000),
    });
    const res = await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-gate').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pass).toEqual({ passedVia: 'gate' });
    expect(res.body.eligibility.eligibleForNormalShipment).toBe(true);
  });
});

describe('早期生产样路由（DR-028）', () => {
  it.each(['in_production','pending'])('retired EPS registration stays 410 for %s and never writes',async status=>{
    const {app,state,tx,onDataChange}=makeApp();state.order=makeFabricOrder({status});const before=structuredClone(state);
    const res=await request(app).post('/api/v1/samples/early-production/ORD-F1/rounds').set(authHeader()).send({sampleQuantity:3,cuttingDate:'2099-01-01'});
    expect(res.status).toBe(410);expect(res.body.error).toMatchObject({code:'GONE',message:expect.stringContaining('订单样品登记流程')});expect(state).toEqual(before);expect(tx.earlyProductionSample.create).not.toHaveBeenCalled();expect(tx.sample.create).not.toHaveBeenCalled();expect(tx.auditLog.create).not.toHaveBeenCalled();expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('explicit physical origin HTTP integration',()=>{
  function prepare(){
    const f=makeApp();f.state.devCase={...makeGarmentCase(),type:'fabric',stage:'developing',customerRelationId:'CUSTOMER',specComposition:'cotton'};
    f.state.batches.push({id:'B-EXACT',batchCode:'SB-EXACT',developmentCaseId:'CASE-G1',supplierRelationId:'SUP-A',sampleType:'yardage',
      round:2,status:'pending',updatedAt:20n,deletedAt:null,specNote:'sample-v2',attachments:{}});
    return f;
  }
  const input={type:'dev',sourceCaseId:'CASE-G1',origin:{batchId:'B-EXACT',sourceRound:2,expectedUpdatedAt:'20'}};
  it('generic origin submission is refused with exact V2 guidance and no source/sample/audit writes',async()=>{
    const{app,state,tx,onDataChange}=prepare();const before=structuredClone(state);const created=await request(app).post('/api/v1/samples').set(authHeader()).send(input);
    expect(created.status,JSON.stringify(created.body)).toBe(400);expect(created.body.error).toMatchObject({code:'INVALID_INPUT',message:expect.stringContaining('版本 2')});expect(state).toEqual(before);expect(tx.sample.create).not.toHaveBeenCalled();expect(tx.sampleSource.create).not.toHaveBeenCalled();expect(tx.auditLog.create).not.toHaveBeenCalled();expect(onDataChange).not.toHaveBeenCalled();
  });
  it('revoked current DB grant denies dedicated complete V2 request before any write',async()=>{
    const{app,state,tx,onDataChange}=prepare();const complete={registrationVersion:2,requestKey:'synthetic-v2-revoked',type:'dev',sourceCaseId:'CASE-G1',expectedCaseUpdatedAt:String(state.devCase.updatedAt),expectedCaseContentFingerprint:registrationDigest(registrationCaseContent(state.devCase)),origin:registrationBatchContext(state.batches[0],state.devCase).command};
    const before=structuredClone(state);tx.userAccount.findUnique.mockResolvedValue({id:'u_owner',status:'active',deletedAt:null,primaryDeptId:null,roles:[]});
    const denied=await request(app).post('/api/v1/samples/registration/exact').set(authHeader()).send(complete);
    expect(denied.status,JSON.stringify(denied.body)).toBe(403);expect(denied.body.error.code).toBe('FORBIDDEN');expect(state).toEqual(before);expect(tx.sample.create).not.toHaveBeenCalled();expect(tx.sampleSource.create).not.toHaveBeenCalled();expect(tx.auditLog.create).not.toHaveBeenCalled();expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('服装双门禁路由（DR-008）', () => {
  it('已绑定工厂版本的样品必须转入 QC 工作台，旧直写入口不能跳过跨模块评审', async () => {
    const { app, state, tx } = makeApp();
    const created = await request(app)
      .post('/api/v1/samples/garment/CASE-G1/rounds')
      .set(authHeader())
      .send({ purpose: '首版', version: 'V1', materialConfig: '面料A', plannedQuantity: 1, plannedUnit: 'PC', supplierRelationId:'SUP-A', supplierName:'Factory A' });
    expect(created.status, JSON.stringify(created.body.error ?? null)).toBe(201);
    const roundId = created.body.round.id;
    expect(tx.$queryRaw).toHaveBeenCalledWith(expect.objectContaining({ values: ['CASE-G1'] }));
    expect(tx.developmentLifecycleEvent.findFirst).toHaveBeenCalledWith({
      where: { developmentCaseId: 'CASE-G1' }, orderBy: { revision: 'desc' },
    });
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0]).toEqual(expect.objectContaining({
      id: roundId, developmentCaseId: 'CASE-G1', sampleType: 'garment-round', status: 'pending',
    }));
    const updatesBeforeQcGate = tx.sampleBatch.update.mock.calls.length;

    // 内部门禁 fail-closed
    const early = await request(app)
      .post(`/api/v1/samples/garment/${roundId}/submit-customer`)
      .set(authHeader())
      .send({ courier: 'DHL', trackingNumber: 'T', recipientName: 'R' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('QC_GATE_NOT_PASSED');
    expect(tx.sampleBatch.update.mock.calls.length).toBe(updatesBeforeQcGate);

    const qc = await request(app)
      .post(`/api/v1/samples/garment/${roundId}/submit-qc`)
      .set(authHeader())
      .send({ result: 'passed' });
    expect(qc.status).toBe(409);
    expect(qc.body.error).toMatchObject({ code: 'DEVELOPMENT_SAMPLE_QC_WORKFLOW_REQUIRED' });
    expect(qc.body.error.message).toContain('QC 工作台');
    expect(tx.sampleBatch.update.mock.calls.length).toBe(updatesBeforeQcGate);

    const stillBlocked = await request(app)
      .post(`/api/v1/samples/garment/${roundId}/submit-customer`)
      .set(authHeader())
      .send({ courier: 'DHL', trackingNumber: 'T', recipientName: 'R' });
    expect(stillBlocked.status).toBe(409);
    expect(stillBlocked.body.error.code).toBe('QC_GATE_NOT_PASSED');
    expect(state.sampleRows).toHaveLength(0);
  });
});

describe('守卫口径（fail-closed）', () => {
  it('写操作无 JWT → 401', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/samples/fabric/ORD-F1/shipment-sample')
      .send({ sampleQuantity: 2, cuttingDate: '2099-01-01' });
    expect(res.status).toBe(401);
  });

  it('无 scope JWT → 403 INSUFFICIENT_SCOPE', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/samples/fabric/ORD-F1/shipment-sample')
      .set(authHeader(noScopeToken))
      .send({ sampleQuantity: 2, cuttingDate: '2099-01-01' });
    expect(res.status).toBe(403);
  });

  it('requireAuth=true 时 API key 单独不可写 → 401；但可读 → 200', async () => {
    const { app } = makeApp({ requireAuth: true, apiKeys: new Set(['test-key']) });
    const write = await request(app)
      .post('/api/v1/samples/fabric/ORD-F1/shipment-sample')
      .set('X-Bambook-API-Key', 'test-key')
      .send({ sampleQuantity: 2, cuttingDate: '2099-01-01' });
    expect(write.status).toBe(401);

    const read = await request(app)
      .get('/api/v1/samples/fabric/ORD-F1/shipment-eligibility')
      .set('X-Bambook-API-Key', 'test-key');
    expect(read.status).toBe(200);
    expect(read.body.ok).toBe(true);
  });

  it('requireAuth=true 时无任何凭证 → 401', async () => {
    const { app } = makeApp({ requireAuth: true, apiKeys: new Set(['test-key']) });
    const res = await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-eligibility');
    expect(res.status).toBe(401);
  });
});


it('legacy eligibility cannot silently fall back when installed native storage is unavailable',async()=>{
  const{app,tx,onDataChange}=makeApp();delete tx.orderSampleSource.findFirst;
  const r=await request(app).get('/api/v1/samples/fabric/ORD-F1/shipment-eligibility').set(authHeader());
  expect(r.status).toBe(500);expect(r.body.eligibility).toBeUndefined();expect(onDataChange).not.toHaveBeenCalled();
});


describe('样品仓库 MVP 范围', () => {
  it('不暴露盘点调整写接口', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/api/v1/samples/room/items/ANY/adjust').send({ newQuantity: 999 });
    expect(response.status).toBe(404);
  });
});
