import { snapshotSampleOrigin } from '../../samples/sampleOriginService';
import { fabricAuthorizationFixture, legacyApprovedFabricBatch } from './fabricAuthorizationFixture';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDevelopmentRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';
import { convertDevCaseToOrder, resolveConfirmedSource } from '../convertService';

function makeDevCase(overrides: any = {}) {
  return {
    id: 'DC__1', code: 'DC-001', name: 'Test Case', type: 'fabric', stage: 'approved',
    priority: 'normal', customerRelationId: 'R1', customerName: 'Cust',
    supplierRelationId: 'R2', supplierName: 'Supp', productAssetId: 'P1', productName: 'Prod',
    linkedOrderId: null, convertedAt: null, deletedAt: null,
    createdAt: BigInt(0), updatedAt: BigInt(0),
    ...overrides,
  };
}

it.each([undefined, null, '', true, [12], { value: 12 }])('U1 explicit bulk quantity %j never falls back or coerces old case sample quantity', async quantity => {
  const f = makeConvertApp({ existingCase: makeDevCase({ sampleQuantity: 200, sampleUnit: 'meter' }) });
  const result = await convertDevCaseToOrder({ prisma: f.prisma, caseId: 'DC__1', mode: 'autoCreate', quantity, dueDate: '2026-10-15' } as any);
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
  expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.orderCreate).not.toHaveBeenCalled(); expect(f.orderLineCreate).not.toHaveBeenCalled(); expect(f.auditCreate).not.toHaveBeenCalled();
});

function makeConvertApp(opts: {
  existingCase?: any;
  orderExists?: boolean;
  syncFail?: boolean;
  auditFail?: boolean;
  stageFail?: boolean;
  txFail?: boolean;
  seals?: any[];      // DR-053 阶段 1：封样（confirmedSourceType=SealSample）
  samples?: any[];    // DR-053 阶段 1：样品（confirmedSourceType=Sample）
  assets?: any[];     // DR-053 阶段 1：档案（含 fabricProfile/garmentProfile）
  ready?: boolean;
  orderByRequestId?: any; // DR-053 阶段 1：clientRequestId 幂等命中的已有订单
} = {}) {
  const existingCase = opts.existingCase === undefined ? makeDevCase() : opts.existingCase;
  const devCaseUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...existingCase, ...data, id: where.id, code: existingCase.code || 'DC-001', tags: data.tags || [], createdAt: existingCase.createdAt || BigInt(0), updatedAt: data.updatedAt || BigInt(0) }));

  const orderCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id }));
  const orderLineCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id }));
  // prisma.order.findUnique（事务外，link 模式校验）与 tx.order.findUnique（事务内）分离
  const prismaOrderFindUnique = vi.fn().mockResolvedValue(opts.orderExists ? { id: 'ORD-EXIST' } : null);
  const txOrderFindUnique = vi.fn().mockResolvedValue({
    id: 'ORD-EXIST', poNumber: 'PO-001', customer: 'Cust', product: 'Prod',
    type: existingCase?.type==='pp'?'garment':existingCase?.type, customerRelationId: existingCase?.customerRelationId ?? null, millName: 'Supp', millRelationId: 'R2',
    importedAt: BigInt(0), createdAt: BigInt(0), updatedAt: BigInt(0),
  });
  const orderFindFirst = vi.fn().mockImplementation(async ({ where }: any) => (where?.clientRequestId ? (opts.orderByRequestId ?? null) : where?.id && opts.orderExists ? await txOrderFindUnique({where:{id:where.id}}) : null));

  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({});
  const entityRefUpsert = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const entityLinkFindMany = vi.fn().mockResolvedValue([]);
  const entityLinkUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    productionStage:{upsert:opts.stageFail?vi.fn().mockRejectedValue(new Error('PRIVATE_STAGE_REQUIRED')):vi.fn(async({create}:any)=>create)},
    ...fabricAuthorizationFixture(),
    creditLimit:{findFirst:vi.fn(async()=>null)},invoice:{findMany:vi.fn(async()=>[])},
    moqThresholdConfig:{findFirst:vi.fn(async()=>({id:'actual-moq-fixture',fabricDefaultMoq:800,garmentDefaultMoq:200,capsuleMoq:20}))},customerTier:{findFirst:vi.fn(async()=>null)},
    relation: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, ownerId: 'u_owner', salesRepIds: [], deletedAt: null,
      name: opts.seals?.find((seal: any) => seal.supplierRelationId === where.id)?.supplierName ?? existingCase?.supplierName ?? null })) },
    $queryRaw: vi.fn(async()=>[{id:existingCase?.id}]),
    developmentLifecycleEvent:{findFirst:vi.fn(async()=>null)},
    developmentCase: { update: devCaseUpdate, findFirst:vi.fn(async()=>existingCase) },
    sampleBatch: { findFirst: vi.fn().mockResolvedValue(opts.ready === false ? null : { id: 'APPROVED-BATCH' }), findMany: vi.fn(async ({where}:any) => opts.ready === false ? [] : [...new Set([existingCase?.productAssetId, ...(opts.assets || []).map((a:any) => a.id)].filter(Boolean))].map(assetId => legacyApprovedFabricBatch({ id: `APPROVED-${assetId}`, developmentCaseId: existingCase?.id, convertedProductAssetId: assetId })).filter(batch => (!where?.id?.in || where.id.in.includes(batch.id)) && (typeof where?.convertedProductAssetId !== 'string' || where.convertedProductAssetId === batch.convertedProductAssetId))) },
    sealSample: { findFirst: vi.fn(async({where}:any)=>opts.seals?.map((x:any)=>({developmentCaseId:existingCase.id,...x})).find((x:any)=>x.id===where.id&&!x.deletedAt)??null), findMany: vi.fn(async()=>[]) },
    sealSampleBatch: { findMany: vi.fn(async({where}:any)=> { const seal=opts.seals?.find((s:any)=>s.id===where.sealSampleId); return seal?[{sampleBatchId:`APPROVED-${seal.convertedProductAssetId}`}]:[]; }) },
    sample:{findFirst:vi.fn(async({where}:any)=>opts.samples?.map((x:any)=>({sourceCaseId:existingCase.id,...x})).find((x:any)=>x.id===where.id&&!x.deletedAt)??null)},
    productAsset:{findUnique:vi.fn(async({where}:any)=>opts.assets?.find((x:any)=>x.id===where.id) ?? (where.id===existingCase?.productAssetId?{id:where.id,sku:'SKU',name:existingCase?.productName,mainCategory:['garment','pp'].includes(existingCase?.type)?'Garment':'Fabric',fabricProfile:existingCase?.type==='fabric'?{millOrganizationId:existingCase?.supplierRelationId}:null,garmentProfile:['garment','pp'].includes(existingCase?.type)?{factoryRelationId:existingCase?.supplierRelationId}:null}:null))},
    order: { create: orderCreate, findUnique: txOrderFindUnique, findFirst: orderFindFirst },
    orderLine: { create: orderLineCreate },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityRefUpsert },
    entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
  };

  (tx.developmentCase as any).findMany=vi.fn(async()=>[]);
  (tx.auditLog as any).findMany=vi.fn(async({where}:any)=>where?.action==='convert_fabric_to_asset' && where?.targetId===existingCase?.productAssetId ? [{id:'asset-conversion-audit',actorId:'u_owner',detail:{source:'route:dev:fabric-convert-asset',after:{fromCase:existingCase.id,sourceType:'batch',sourceId:'APPROVED-'+where.targetId}}}] : []);
  tx.sampleBatch.findFirst=vi.fn(async({where}:any)=>opts.ready===false?null:legacyApprovedFabricBatch({id:where?.id??'APPROVED-'+existingCase?.productAssetId,developmentCaseId:existingCase?.id,convertedProductAssetId:existingCase?.productAssetId}));
  if(opts.seals?.length){
    // Storage fixture records an immutable accepted origin, never a live Profile projection.
    const frozenCase={...existingCase,specWeave:'斜纹'};
    const batches=opts.seals.map((seal:any)=>legacyApprovedFabricBatch({id:'APPROVED-'+seal.convertedProductAssetId,developmentCaseId:existingCase.id,convertedProductAssetId:seal.convertedProductAssetId,supplierRelationId:seal.supplierRelationId,updatedAt:1n,attachments:{fabricHistory:{schemaVersion:1,revision:3,events:[{id:seal.id+'approve',kind:'approve',round:1,actorId:'u_owner',auditId:seal.id+'approveAudit',at:'2026-10-01T00:00:00.000Z',before:{},after:{},requestKey:null,requestFingerprint:null,commandInput:null},{id:seal.id+'seal',kind:'seal',round:1,actorId:'u_owner',auditId:seal.id+'sealAudit',at:'2026-10-01T00:00:00.000Z',before:{},after:{sealId:seal.id},requestKey:null,requestFingerprint:null,commandInput:null},{id:seal.id+'convert',kind:'convert',round:1,actorId:'u_owner',auditId:seal.id+'convertAudit',at:'2026-10-01T00:00:00.000Z',before:{},after:{convertedProductAssetId:seal.convertedProductAssetId},requestKey:null,requestFingerprint:null,commandInput:null}]}}}));
    tx.developmentCase.findFirst=vi.fn(async()=>frozenCase);
    tx.sampleBatch.findMany=vi.fn(async({where}:any)=>batches.filter((b:any)=>!where?.id?.in||where.id.in.includes(b.id)));
    (tx.auditLog as any).findUnique=vi.fn(async({where}:any)=>{const seal=opts.seals?.find((seal:any)=>where.id===seal.id+'sealAudit');if(!seal)return null;const batch=batches.find((b:any)=>b.convertedProductAssetId===seal.convertedProductAssetId);return{id:where.id,actorId:'u_owner',action:'seal_sample_confirm',targetType:'SealSample',targetId:seal.id,detail:{source:'route:dev:fabric-seal',after:{batchFacts:[{batchId:batch.id,snapshot:{},originSnapshot:snapshotSampleOrigin(batch,frozenCase)}]}}};});
    (tx.auditLog as any).findFirst=vi.fn(async({where}:any)=>{const event=batches.flatMap((b:any)=>b.attachments.fabricHistory.events).find((e:any)=>e.auditId===where.id);if(!event)return null;if(event.kind==='seal')return (tx.auditLog as any).findUnique({where:{id:where.id}});return{id:where.id,actorId:event.actorId,detail:{after:{roundFact:{kind:event.kind,before:event.before,after:event.after}}}};});
  }
  const prisma = {
    userAccount:tx.userAccount,userPermissionOverrides:tx.userPermissionOverrides,relation:tx.relation,creditLimit:tx.creditLimit,invoice:tx.invoice,
    developmentCase: { findFirst: vi.fn().mockResolvedValue(existingCase) },
    order: { findUnique: prismaOrderFindUnique, findFirst: orderFindFirst },
    // DR-053 阶段 1：确认成果解析依赖
    sealSample: { findFirst: vi.fn().mockImplementation(async ({ where }: any) => opts.seals?.find((s: any) => s.id === where.id && !s.deletedAt) ?? null) },
    sample: { findFirst: vi.fn().mockImplementation(async ({ where }: any) => opts.samples?.find((s: any) => s.id === where.id && !s.deletedAt) ?? null) },
    productAsset: { findUnique: vi.fn().mockImplementation(async ({ where }: any) => opts.assets?.find((a: any) => a.id === where.id) ?? null) },
    $transaction: opts.txFail
      ? vi.fn().mockRejectedValue(new Error('TX_BOOM'))
      : vi.fn(async (fn: any) => fn(tx)),
  } as any;

  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/development', createDevelopmentRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, tx, prisma, onDataChange, devCaseUpdate, orderCreate, auditCreate, entityLinkUpsert, orderLineCreate };
}

describe('task ERP-P1 dev-convert: POST /:id/convert 成功路径', () => {
  it('autoCreate → 200 + DevCase update + Order create + sync + audit（同事务）', async () => {
    const { app, tx, devCaseUpdate, orderCreate, auditCreate } = makeConvertApp();
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', quoteAmount: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.case.stage).toBe('approved');
    expect(res.body.case.linkedOrderId).toBeTruthy();
    expect(res.body.order).toBeTruthy();
    // 事务内调用
    expect(devCaseUpdate).toHaveBeenCalledTimes(1);
    expect(orderCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1); // audit 写入
    expect(tx.productionStage.upsert).toHaveBeenCalledTimes(10);
    const firstLine=res.body.order.lines?.[0]; // Default asset snapshot is not a fabricated sample approval.
    if(firstLine) {expect(firstLine.confirmedSourceId).toBeNull();expect(firstLine.confirmedAt).toBeNull();}
  });

  it('link 模式（传 orderId）→ 200 + 不创建新 order', async () => {
    const { app, orderCreate } = makeConvertApp({ orderExists: true });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-EXIST', orderPo: 'PO-001' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.order).toBeNull(); // link 模式不返回 createdOrder
    expect(orderCreate).not.toHaveBeenCalled();
  });
});

describe('conversion stage initialization is mandatory inside transaction',()=>{
  it('stage write failure cannot become a successful converted response',async()=>{const f=makeConvertApp({stageFail:true});const response=await request(f.app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({autoCreate:true,quantity:100,dueDate:'2026-10-15'});expect(response.status).toBe(500);expect(response.body.ok).toBe(false);expect(f.tx.productionStage.upsert).toHaveBeenCalledTimes(1);expect(f.onDataChange).not.toHaveBeenCalled();});
});

describe('task ERP-P1 dev-convert: fail closed（error code 稳定）', () => {
  it('DEV_CASE_NOT_FOUND（case 不存在）→ 404', async () => {
    const { app } = makeConvertApp({ existingCase: null });
    const res = await request(app).post('/api/v1/development/NOPE/convert').set(authHeader()).send({ autoCreate: true,quantity:100,dueDate:'2026-10-15' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('已 linkedOrderId 的 case 再次转换（合法返单，DR-053 阶段 1 解除单次限制）→ 200 新订单', async () => {
    const { app, orderCreate } = makeConvertApp({ existingCase: makeDevCase({ linkedOrderId: 'ORD-OLD' }) });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', clientRequestId: 'req-2' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recovered).toBe(false);
    expect(orderCreate).toHaveBeenCalledTimes(1); // 合法返单=新请求建新单
  });

  it('CASE_CANCELLED（stage=cancelled 终态）→ 400（区分 已linked=409 vs cancelled=400）', async () => {
    const { app } = makeConvertApp({ existingCase: makeDevCase({ stage: 'cancelled' }) });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true,quantity:100,dueDate:'2026-10-15' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CASE_CANCELLED');
  });

  it('ORDER_NOT_FOUND（link 模式 order 不存在）→ 404', async () => {
    const { app } = makeConvertApp({ orderExists: false });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-MISSING', orderPo: 'PO-1' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('INVALID_INPUT（link 模式无 orderId）→ 400', async () => {
    const { app } = makeConvertApp();
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderPo: 'PO-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});

describe('task ERP-P1 dev-convert: 事务失败 fail closed（不伪成功）', () => {
  it('历史已确认案没有获认可成果时仍拦截转单，避免旧错误状态继续传播', async () => {
    const { app, orderCreate } = makeConvertApp({ ready: false });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVELOPMENT_SOURCE_CHANGED');
    expect(orderCreate).not.toHaveBeenCalled();
  });
  it('内部开发转单保留当前操作者为负责人，避免新订单被自身数据范围隐藏', async () => {
    const { app, orderCreate } = makeConvertApp({ existingCase: makeDevCase({ customerRelationId: null, customerName: null }) });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(200);
    expect(orderCreate.mock.calls[0][0].data.ownerId).toBeTruthy();
    expect(orderCreate.mock.calls[0][0].data.salesCurrency).toBe('USD');
    expect(orderCreate.mock.calls[0][0].data.purchaseCurrency).toBe('CNY');
    expect(orderCreate.mock.calls[0][0].data).not.toHaveProperty('unit'); // 单位属于 OrderLine，订单头无此列
  });
  it('sync reject → CONVERT_FAILED（事务回滚）', async () => {
    const { app } = makeConvertApp({ syncFail: true });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CONVERT_FAILED');
  });

  it('audit reject → CONVERT_FAILED（事务回滚，不静默成功）', async () => {
    const { app } = makeConvertApp({ auditFail: true });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CONVERT_FAILED');
  });

  it('tx boom → CONVERT_FAILED', async () => {
    const { app } = makeConvertApp({ txFail: true });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CONVERT_FAILED');
  });
});

describe('task ERP-P1 dev-convert: onDataChange 事务成功后触发', () => {
  it('成功后 onDataChange 被调用', async () => {
    const { app, onDataChange } = makeConvertApp();
    await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(onDataChange).toHaveBeenCalled();
  });

  it('事务失败 → onDataChange 不被调用', async () => {
    const { app, onDataChange } = makeConvertApp({ syncFail: true });
    await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('task ERP-P1 dev-convert: EntityLink 行为（同事务 sync）', () => {
  it('autoCreate → syncOrderEntityReferences + syncDevelopmentCaseReferences 调用（entityLink.upsert 多次）', async () => {
    const { app, entityLinkUpsert } = makeConvertApp();
    await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    // Order sync（orderedBy + suppliedBy）+ DevCase sync（developFor + developBy + aboutProduct）
    expect(entityLinkUpsert.mock.calls.length).toBeGreaterThan(0);
  });
});


describe('task ERP-P1 dev-convert review-fix: link 模式 Order EntityLink 维护', () => {
  it('link 模式 → 事务内读 linked Order + 调 syncOrderEntityReferences（精确断言 order EntityLink payload）', async () => {
    const { app, entityLinkUpsert } = makeConvertApp({ orderExists: true });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-EXIST', orderPo: 'PO-001' });
    expect(res.status).toBe(200);
    // 精确断言：至少有一条 entityLink.upsert 的 payload 含 fromType='order' + fromId='ORD-EXIST'
    // （区分 Order sync 与 DevelopmentCase sync，后者 fromType='development-case'）
    const orderLinks = entityLinkUpsert.mock.calls.filter((call: any) => {
      const data = call[0]?.create || call[0]?.data || {};
      return data.fromType === 'order' && data.fromId === 'ORD-EXIST';
    });
    expect(orderLinks.length).toBeGreaterThan(0);
    // 进一步断言 orderedBy（customer R1）或 suppliedBy（mill R2）存在
    const linkKinds = orderLinks.map((call: any) => (call[0]?.create || call[0]?.data || {}).linkKind);
    expect(linkKinds).toEqual(expect.arrayContaining(['orderedBy', 'suppliedBy']));
  });

  it('link 模式 Order 不存在 → ORDER_NOT_FOUND（事务前校验）', async () => {
    const { app } = makeConvertApp({ orderExists: false });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-MISSING', orderPo: 'PO-1' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('link 模式 Order 事务内缺失（tx.findUnique null）→ CONVERT_FAILED（fail closed，不伪成功）', async () => {
    // prisma.order.findUnique 通过校验，但 tx.order.findUnique 返回 null → 事务内 fail closed
    const tx = {
    ...fabricAuthorizationFixture(),
      $queryRaw:vi.fn(async()=>[{id:'DC__1'}]),
      developmentLifecycleEvent:{findFirst:vi.fn(async()=>null)},
      sampleBatch:{findFirst:vi.fn(async()=>({id:'ready'})),findMany:vi.fn(async()=>[legacyApprovedFabricBatch()])},
      productAsset:{findUnique:vi.fn(async()=>({sku:'sku'}))},
      developmentCase: { findFirst:vi.fn(async()=>makeDevCase()), update: vi.fn().mockResolvedValue({ id: 'DC__1', stage: 'approved', createdAt: BigInt(0), updatedAt: BigInt(0), tags: [] }) },
      order: { create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) }, // 事务内返回 null
      orderLine: { create: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      developmentCase: { findFirst: vi.fn().mockResolvedValue(makeDevCase()) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD-EXIST' }) }, // 事务外通过
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/development', createDevelopmentRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-EXIST', orderPo: 'PO-1' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CONVERT_FAILED');
    // audit 不应落盘（事务回滚）
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('link 模式 Order sync reject → CONVERT_FAILED（事务回滚，不 audit 不 onDataChange）', async () => {
    const tx = {
    ...fabricAuthorizationFixture(),
      $queryRaw:vi.fn(async()=>[{id:'DC__1'}]),
      developmentLifecycleEvent:{findFirst:vi.fn(async()=>null)},
      sampleBatch:{findFirst:vi.fn(async()=>({id:'ready'})),findMany:vi.fn(async()=>[legacyApprovedFabricBatch()])},
      productAsset:{findUnique:vi.fn(async()=>({sku:'sku'}))},
      developmentCase: { findFirst:vi.fn(async()=>makeDevCase()), update: vi.fn().mockResolvedValue({ id: 'DC__1', stage: 'approved', createdAt: BigInt(0), updatedAt: BigInt(0), tags: [] }) },
      order: { create: vi.fn(), findUnique: vi.fn().mockResolvedValue({ id: 'ORD-EXIST', customerRelationId: 'R1', millRelationId: 'R2' }) },
      orderLine: { create: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) }, // sync 失败
      entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    };
    const onDataChange = vi.fn();
    const prisma = {
      developmentCase: { findFirst: vi.fn().mockResolvedValue(makeDevCase()) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD-EXIST' }) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/development', createDevelopmentRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-EXIST', orderPo: 'PO-1' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CONVERT_FAILED');
    expect(tx.auditLog.create).not.toHaveBeenCalled(); // audit 未落盘
    expect(onDataChange).not.toHaveBeenCalled(); // onDataChange 未触发
  });
});

describe('P1 修复：stage 门 + 空心订单防线（autoCreate 入参校验）', () => {
  it('INVALID_STAGE（stage=developing 越界转单，绕过 DEV_STAGE_TRANSITIONS）→ 409 中文消息', async () => {
    const { app } = makeConvertApp({ existingCase: makeDevCase({ stage: 'developing' }) });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STAGE');
    expect(res.body.error.message).toContain('approved');
  });

  it('INVALID_STAGE 同样约束 link 模式（developing 直接挂既有订单也越界）→ 409', async () => {
    const { app } = makeConvertApp({ existingCase: makeDevCase({ stage: 'revision' }), orderExists: true });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ orderId: 'ORD-EXIST', orderPo: 'PO-001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STAGE');
  });

  it('autoCreate 缺数量 → INVALID_INPUT 400（防 0 数量空心订单）', async () => {
    const { app } = makeConvertApp();
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, dueDate: '2026-10-15' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.message).toContain('数量');
  });

  it('autoCreate 数量 0 / 负数 / 非整数 → INVALID_INPUT', async () => {
    const { app } = makeConvertApp();
    for (const badQty of [0, -5, 1.5]) {
      const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: badQty, dueDate: '2026-10-15' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('autoCreate 缺交期 / 交期格式非法 → INVALID_INPUT 400', async () => {
    const { app } = makeConvertApp();
    const noDue = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100 });
    expect(noDue.status).toBe(400);
    expect(noDue.body.error.code).toBe('INVALID_INPUT');
    expect(noDue.body.error.message).toContain('交期');
    const badDue = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026/10/15' });
    expect(badDue.status).toBe(400);
    expect(badDue.body.error.code).toBe('INVALID_INPUT');
  });

  it('autoCreate 金额为负 → INVALID_INPUT', async () => {
    const { app } = makeConvertApp();
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', quoteAmount: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('数量/交期/金额透传落库（quantity/dueDate/quoteAmount 进 Order create）', async () => {
    const { app, orderCreate } = makeConvertApp();
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', quoteAmount: 5000 });
    expect(res.status).toBe(200);
    expect(orderCreate).toHaveBeenCalledTimes(1);
    const orderData = orderCreate.mock.calls[0][0].data;
    expect(orderData.quantity).toBe(100);
    expect(orderData.dueDate).toBe('2026-10-15');
    expect(Number(orderData.quoteAmount)).toBe(5000);
  });

  it('quoteAmount 缺省 → 落库 0（可选字段默认值）', async () => {
    const { app, orderCreate } = makeConvertApp();
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15' });
    expect(res.status).toBe(200);
    expect(Number(orderCreate.mock.calls[0][0].data.quoteAmount)).toBe(0);
  });
});

describe('DR-053 阶段 1：按确认成果与工厂转单（同案双厂/返单/幂等/工厂校验/规格快照）', () => {
  const sealA = { id: 'SEAL-A', sealCode: 'SEAL-A-001', status: 'sealed', supplierRelationId: 'R-A', supplierName: 'Factory A', convertedProductAssetId: 'PA-A', deletedAt: null };
  const sealB = { id: 'SEAL-B', sealCode: 'SEAL-B-001', status: 'sealed', supplierRelationId: 'R-B', supplierName: 'Factory B', convertedProductAssetId: 'PA-B', deletedAt: null };
  const assetA = { id: 'PA-A', sku: 'SKU-A', name: '档案A', mainCategory: 'Fabric', fabricProfile: { millName: 'Factory A', construction: '斜纹' } };
  const assetB = { id: 'PA-B', sku: 'SKU-B', name: '档案B', mainCategory: 'Fabric', fabricProfile: { millName: 'Factory B', construction: '平纹' } };

  it('同案两厂分别下单：A/B 封样各建一单，OrderLine 版本引用 + 工厂快照不同', async () => {
    const { app, orderCreate, orderLineCreate } = makeConvertApp({ seals: [sealA, sealB], assets: [assetA, assetB] });
    const ra = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-A', millRelationId: 'R-A', clientRequestId: 'req-A' });
    const rb = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-B', millRelationId: 'R-B', clientRequestId: 'req-B' });
    expect(ra.status,JSON.stringify(ra.body)).toBe(200);
    expect(rb.status).toBe(200);
    expect(orderCreate).toHaveBeenCalledTimes(2);
    // 工厂取成果归属（修"显示 B 厂实际关联 A 厂"）
    expect(orderCreate.mock.calls[0][0].data.millRelationId).toBe('R-A');
    expect(orderCreate.mock.calls[1][0].data.millRelationId).toBe('R-B');
    expect(orderCreate.mock.calls[1][0].data.millName).toBe('Factory B');
    // OrderLine 版本引用不同 + 规格快照写入（档案修改不影响历史订单）
    const lineA = orderLineCreate.mock.calls[0][0].data;
    const lineB = orderLineCreate.mock.calls[1][0].data;
    expect(lineA.confirmedSourceId).toBe('SEAL-A');
    expect(lineB.confirmedSourceId).toBe('SEAL-B');
    expect(lineA.confirmedSourceType).toBe('SealSample');
    expect(lineA.specSnapshot.fabric.construction).toBe('斜纹');
  });

  it('错误工厂被拒绝：millRelationId ≠ 封样归属工厂 → 409 MILL_MISMATCH（不建单）', async () => {
    const { app, orderCreate } = makeConvertApp({ seals: [sealA], assets: [assetA] });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-A', millRelationId: 'R-B', clientRequestId: 'req-X' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MILL_MISMATCH');
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('未封样成果 → 409 CONFIRMED_SOURCE_NOT_APPROVED', async () => {
    const { app } = makeConvertApp({ seals: [{ ...sealA, status: 'draft' }], assets: [assetA] });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-A', millRelationId: 'R-A' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMED_SOURCE_NOT_APPROVED');
  });

  it('重复请求不重复建单：同 clientRequestId → recovered=true 返回已有订单，orderCreate 不调用', async () => {
    const { app, orderCreate } = makeConvertApp({ orderByRequestId: { id: 'ORD-EXIST', clientRequestId: 'req-dup' } });
    const res = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', clientRequestId: 'req-dup' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recovered).toBe(true);
    expect(res.body.order.id).toBe('ORD-EXIST');
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('同成果多次返单：同 SealSample 两个不同 clientRequestId → 各建一单（合法返单）', async () => {
    const { app, orderCreate } = makeConvertApp({ seals: [sealA], assets: [assetA] });
    const r1 = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-A', millRelationId: 'R-A', clientRequestId: 'repeat-1' });
    const r2 = await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-A', millRelationId: 'R-A', clientRequestId: 'repeat-2' });
    expect(r1.status,JSON.stringify(r1.body)).toBe(200);
    expect(r2.status).toBe(200);
    expect(orderCreate).toHaveBeenCalledTimes(2);
  });

  it('Order 写入 sourceCaseId + clientRequestId（多订单关系反查）', async () => {
    const { app, orderCreate } = makeConvertApp({ seals: [sealA], assets: [assetA] });
    await request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({ autoCreate: true, quantity: 100, dueDate: '2026-10-15', confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-A', millRelationId: 'R-A', clientRequestId: 'req-src' });
    const orderData = orderCreate.mock.calls[0][0].data;
    expect(orderData.sourceCaseId).toBe('DC__1');
    expect(orderData.clientRequestId).toBe('req-src');
  });
});

describe('转单生命周期与锁后重读',()=>{
 const send=(app:any)=>request(app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({autoCreate:true,quantity:100,dueDate:'2026-10-15'});
 it.each([{state:'paused',code:'DEVELOPMENT_PAUSED'},{state:'closed',outcome:'stopped',code:'DEVELOPMENT_CLOSED'}])('$state拒绝创建',async event=>{const f=makeConvertApp();f.tx.developmentLifecycleEvent.findFirst.mockResolvedValue(event as any);const r=await send(f.app);expect(r.status).toBe(409);expect(r.body.error.code).toBe(event.code);expect(f.orderCreate).not.toHaveBeenCalled();});
 it('成功结案可转单但不重开生命周期',async()=>{const f=makeConvertApp();f.tx.developmentLifecycleEvent.findFirst.mockResolvedValue({state:'closed',outcome:'completed'} as any);expect((await send(f.app)).status).toBe(200);expect(f.orderCreate).toHaveBeenCalledOnce();});
 it('事务外approved、锁后revision则拒绝',async()=>{const f=makeConvertApp();f.tx.developmentCase.findFirst.mockResolvedValue(makeDevCase({stage:'revision'}));expect((await send(f.app)).body.error.code).toBe('INVALID_STAGE');expect(f.orderCreate).not.toHaveBeenCalled();});
 it('订单客户与品名使用真实Relation和Asset，不信Case自由标签',async()=>{const f=makeConvertApp();f.tx.developmentCase.findFirst.mockResolvedValue(makeDevCase({customerName:'新客户',productName:'新产品'}));expect((await send(f.app)).status).toBe(200);expect(f.orderCreate.mock.calls[0][0].data).toMatchObject({customer:'Supp',product:'Prod'});});
});

it.each(['SealSample','Sample'])('不接受另一开发案的%s确认成果',async type=>{const f=makeConvertApp();const source={id:'foreign',status:'approved',developmentCaseId:'other',sourceCaseId:'other'};if(type==='SealSample')f.tx.sealSample.findFirst.mockResolvedValue(source as any);else f.tx.sample.findFirst.mockResolvedValue(source as any);const r=await request(f.app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({autoCreate:true,quantity:1,dueDate:'2026-10-15',confirmedSourceType:type,confirmedSourceId:'foreign'});expect(r.status).toBe(404);expect(r.body.error.code).toBe('CONFIRMED_SOURCE_NOT_FOUND');expect(f.orderCreate).not.toHaveBeenCalled();});
it('锁时开发案消失返回404',async()=>{const f=makeConvertApp();f.tx.$queryRaw.mockResolvedValue([]);const r=await request(f.app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({autoCreate:true,quantity:1,dueDate:'2026-10-15'});expect(r.status).toBe(404);expect(r.body.error.code).toBe('DEV_CASE_NOT_FOUND');});

it('锁后才出现的同案请求恢复原单，不重复写订单或审计',async()=>{const f=makeConvertApp();f.tx.order.findFirst.mockResolvedValue({id:'CONCURRENT',sourceCaseId:'DC__1',clientRequestId:'same'});const r=await request(f.app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({autoCreate:true,quantity:1,dueDate:'2026-10-15',clientRequestId:'same'});expect(r.status).toBe(200);expect(r.body.recovered).toBe(true);expect(r.body.order.id).toBe('CONCURRENT');expect(f.orderCreate).not.toHaveBeenCalled();expect(f.auditCreate).not.toHaveBeenCalled();expect(f.tx.order.findFirst).toHaveBeenCalledWith({where:{clientRequestId:'same',sourceCaseId:'DC__1'}});expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(f.tx.order.findFirst.mock.invocationCallOrder[0]);});


describe('actual Asset family and factory authority',()=>{
 const asset=()=>({id:'G1',sku:'G',name:'Garment',mainCategory:'Garment',deletedAt:null,garmentProfile:{factoryRelationId:'FACTORY',deletedAt:null},fabricProfile:{millOrganizationId:'WRONG',deletedAt:null}});
 const storage=(row:any)=>({productAsset:{findUnique:vi.fn(async()=>row)},relation:{findFirst:vi.fn(async({where}:any)=>({id:where.id,name:'Actual Factory'}))}});
 it('capitalized actual producer category uses garment profile and actual Relation name only',async()=>{const r=await resolveConfirmedSource({prisma:storage(asset()) as any,confirmedSourceType:'Asset',confirmedSourceId:'G1'});expect(r.ok).toBe(true);if(r.ok){expect(r.data.millRelationId).toBe('FACTORY');expect(r.data.millName).toBe('Actual Factory');expect(r.data.specSnapshot.fabric).toBeUndefined();}});
 it('soft-deleted corresponding profile never falls back to another family',async()=>{const row=asset();row.garmentProfile.deletedAt=1 as any;const r=await resolveConfirmedSource({prisma:storage(row) as any,confirmedSourceType:'Asset',confirmedSourceId:'G1'});expect(r.ok).toBe(false);if(!r.ok)expect(r.error.code).toBe('CONFIRMED_SOURCE_NOT_FOUND');});
 it('missing corresponding profile never guesses category from remaining profile',async()=>{const row=asset();row.garmentProfile=null as any;expect((await resolveConfirmedSource({prisma:storage(row) as any,confirmedSourceType:'Asset',confirmedSourceId:'G1'})).ok).toBe(false);});
 it('actual garment factory mismatch blocks even though both Relations exist',async()=>{const r=await resolveConfirmedSource({prisma:storage(asset()) as any,confirmedSourceType:'Asset',confirmedSourceId:'G1',millRelationId:'OTHER'});expect(r.ok).toBe(false);if(!r.ok)expect(r.error.code).toBe('MILL_MISMATCH');});
});

it('link target actual storage failure returns safe typed 503 result to route and scalar service caller without writing',async()=>{
 const f=makeConvertApp({orderExists:true});f.prisma.order.findUnique.mockRejectedValue(new Error('INTERNAL_ONLY SELECT secret_column FROM private_order_storage'));
 const result=await convertDevCaseToOrder({prisma:f.prisma,caseId:'DC__1',mode:'link',orderId:'ORD-EXIST',actorId:'u_owner',trustedActor:{userId:'u_owner',roles:['owner'],departmentIds:[]}});
 expect(result).toMatchObject({ok:false,error:{code:'AUTHORIZATION_UNAVAILABLE'}});expect(JSON.stringify(result)).not.toContain('INTERNAL_ONLY');expect(JSON.stringify(result)).not.toContain('secret_column');
 const response=await request(f.app).post('/api/v1/development/DC__1/convert').set(authHeader()).send({orderId:'ORD-EXIST'});expect(response.status).toBe(503);expect(response.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE');expect(JSON.stringify(response.body)).not.toContain('secret_column');
 expect(f.prisma.$transaction).not.toHaveBeenCalled();expect(f.devCaseUpdate).not.toHaveBeenCalled();expect(f.orderCreate).not.toHaveBeenCalled();expect(f.auditCreate).not.toHaveBeenCalled();
});
