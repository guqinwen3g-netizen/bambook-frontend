import { describe, expect, it, vi } from 'vitest';
import { authorizeSampleCustody, recheckSampleCustodyAuthorization, authorizeSampleCustodyBatch,
  recheckSampleCustodyBatchAuthorization, lockSampleCustodyGraph, assertSampleCustodyGuardStable } from '../sampleCustodyAuthorization';
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const actor: any = { userId: 'CUSTODY-ACTOR', roles: ['owner'], departmentIds: [], permissions: ['*'], permissionCeiling: ['products:read', 'sample:room:write'] };
const copy = (x: any): any => Array.isArray(x) ? x.map(copy) : x instanceof Date ? new Date(x) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k,v]) => [k,copy(v)])) : x;
function fixture() {
  const state: any = { users: [{ id: actor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ departmentId: null, role: { id: 'custom-custody-employee', permissions: ['products:read', 'sample:room:write'].map(scope => ({ permission: { scope } })) } }] }], overrides: [],
    relations: [{ id: 'CUSTOMER', ownerId: actor.userId, salesRepIds: [], departmentId: null, deletedAt: null }, { id: 'FOREIGN', ownerId: 'OTHER', salesRepIds: [], deletedAt: null },
      { id: 'FACTORY', ownerId: 'OTHER', salesRepIds: [], deletedAt: null }],
    cases: [{ id: 'CASE', type: 'garment', customerRelationId: 'CUSTOMER', supplierRelationId: 'FACTORY', deletedAt: null }],
    orders: [{ id: 'ORDER', sourceCaseId: null, customerRelationId: 'CUSTOMER', type: 'garment', businessLine: 'garment', deletedAt: null }],
    batches: [{ id: 'BATCH', developmentCaseId: 'CASE', supplierRelationId: 'FACTORY', deletedAt: null }],
    samples: [{ id: 'SAMPLE', sourceCaseId: null, sourceOrderId: 'ORDER', productAssetId: null, customerRelationId: 'CUSTOMER', supplierRelationId: 'FACTORY', status: 'draft', deletedAt: null }],
    cards: [{ id: 'CARD', code: 'SC-SYNTHETIC', name: 'MUST NOT RETURN', cardType: 'fabric', unit: 'PC', quantity: 3, availableQty: 2, status: 'borrowed',
      sampleId: 'SAMPLE', devCaseId: null, orderId: null, batchId: null, productAssetId: null, warehouseId: null, receiptSnapshot: null, createdAt: BigInt(1), updatedAt: BigInt(2), deletedAt: null }],
    assets: [], warehouses: [], memberships: [], grants: [] };
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([k,v]:any) => k === 'OR' ? v.some((w:any) => matches(row,w))
    : k === 'AND' ? v.every((w:any) => matches(row,w)) : k === 'team' ? row.team?.deletedAt === v.deletedAt
      : v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : v && typeof v === 'object' && 'gt' in v ? row[k] > v.gt : row[k] === v);
  // Real Prisma rows are detached values, not live references to later DB mutations.
  const delegate = (key: string) => ({ findFirst: vi.fn(async ({where}:any) => copy(state[key].find((x:any) => matches(x,where)) ?? null)),
    findUnique: vi.fn(async ({where}:any) => copy(state[key].find((x:any) => matches(x,where)) ?? null)),
    findMany: vi.fn(async ({where}:any={}) => copy(state[key].filter((x:any) => matches(x,where)))) });
  const db: any = { userAccount: delegate('users'), userPermissionOverrides: delegate('overrides'), relation: delegate('relations'), developmentCase: delegate('cases'),
    order: delegate('orders'), sample: delegate('samples'), sampleBatch: delegate('batches'), sampleCardItem: delegate('cards'), productAsset: delegate('assets'), warehouse: delegate('warehouses'),
    teamMember: delegate('memberships'), teamDataGrant: delegate('grants'), $transaction: vi.fn(),
    $queryRaw: vi.fn(async (query:any) => [{id:query.values[0]}]) };
  const grant = (scopes: string[]) => state.users[0].roles[0].role.permissions = scopes.map(scope => ({ permission: { scope } }));
  const all = () => state.users[0].roles[0].role.id = 'role-admin';
  const unowned = () => Object.assign(state.cards[0], { sampleId: null, devCaseId: null, orderId: null, batchId: null, receiptSnapshot: null });
  return { state, db, grant, all, unowned };
}
const auth = (f: ReturnType<typeof fixture>, more: any = {}) => authorizeSampleCustody({ db: f.db, actor, subject: { kind: 'card', id: 'CARD' }, ...more });
const denied = async (promise: Promise<any>, code: string) => expect(promise).rejects.toMatchObject({ code });

describe('shared physical custody authority, actual permission/L2 implementations', () => {
  it('the recorded owner can read and operate physical samples of an internal development case without a customer', async () => {
    const f=fixture(); f.unowned();
    Object.assign(f.state.cards[0],{devCaseId:'CASE',batchId:'BATCH'});
    Object.assign(f.state.cases[0],{customerRelationId:null,ownerId:actor.userId,departmentId:null});
    expect(await auth(f)).toMatchObject({visibility:'full',issues:[]});
    expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full',issues:[]});
  });
  it('internal development ownership is current authority, not access to another group or an ownerless legacy case', async () => {
    const f=fixture(); f.unowned();Object.assign(f.state.cards[0],{devCaseId:'CASE',batchId:'BATCH'});
    Object.assign(f.state.cases[0],{customerRelationId:null,ownerId:'OTHER',departmentId:null});
    await denied(auth(f,{mode:'write'}),'NOT_FOUND');
    f.state.cases[0].ownerId=null; await denied(auth(f),'NOT_FOUND');
  });
  it('ordinary Order-only draft + fabric material in garment business is full read/write, factory ownership is not customer authority', async () => {
    const f=fixture(); const before=copy(f.state);
    const r=await auth(f); expect(r.visibility).toBe('full'); expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full'});
    expect(r).not.toHaveProperty('card'); expect(r).not.toHaveProperty('parents'); expect(JSON.stringify(r)).not.toContain('MUST NOT RETURN'); expect(f.state).toEqual(before);
  });
  it.each(['case','order','batch','sample'])('%s subject uses genuine current owner without exact source rows', async kind => {
    const f=fixture(); expect(await auth(f,{subject:{kind,id:kind.toUpperCase()}})).toMatchObject({visibility:'full'});
  });
  it('fully unowned null receipt is only opt-in minimal catalog, full/write requires stored all', async () => {
    const f=fixture(); f.unowned(); await denied(auth(f),'NOT_FOUND'); expect(await auth(f,{allowUnownedCatalog:true})).toMatchObject({visibility:'catalog'});
    await denied(auth(f,{mode:'write',allowUnownedCatalog:true}),'NOT_FOUND'); f.all(); expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full'});
  });
  it.each([undefined,'',3,true,[],{version:2},{version:1,batchId:'OLD'},{kind:'manual',sourceCaseId:'CASE'},{kind:'manual',nativeFamily:'garment-round'}])('unknown/malformed/history receipt %j never downgrades to shared catalog', async receipt => {
    const f=fixture(); f.unowned(); f.state.cards[0].receiptSnapshot=receipt; await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');
  });
  it('explicit supported manual marker without any source permits catalog', async () => {
    const f=fixture(); f.unowned(); f.state.cards[0].receiptSnapshot={kind:'manual'}; expect(await auth(f,{allowUnownedCatalog:true})).toMatchObject({visibility:'catalog'});
  });
  it.each(['missing','deleted','foreign','invalid'])('real/invalid %s parent never downgrades to shared catalog', async kind => {
    const f=fixture(); f.unowned(); f.state.cards[0].devCaseId=kind==='invalid'?' ':kind==='missing'?'MISSING':'CASE';
    if(kind==='deleted') f.state.cases[0].deletedAt=BigInt(9); if(kind==='foreign') f.state.cases[0].customerRelationId='FOREIGN';
    await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');
  });
  it('real Sample without customer/source anchor is never a catalog orphan; stored all full custody retains explicit reason', async () => {
    const f=fixture(); Object.assign(f.state.samples[0],{sourceOrderId:null,customerRelationId:null});
    await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND'); f.all(); const r=await auth(f); expect(r.visibility).toBe('full'); expect(r.issues).toContain('NO_CUSTOMER_ANCHOR');
  });
  it.each(['missing','deleted'])('stored all can read %s source for review, with distinct reasons', async kind => {
    const f=fixture(); f.all(); f.state.samples[0].sourceOrderId='ORDER'; if(kind==='missing') f.state.orders=[]; else f.state.orders[0].deletedAt=BigInt(7);
    expect((await auth(f)).issues).toContain(kind==='missing'?'ORDER_MISSING':'ORDER_DELETED');
  });
  it('explicit parent ID conflicts and actual Sample business asset conflicts require stored all review', async () => {
    const f=fixture(); f.state.cards[0].devCaseId='CASE'; f.state.orders[0].sourceCaseId='OTHERCASE'; f.state.cases.push({...f.state.cases[0],id:'OTHERCASE'});
    await denied(auth(f),'NOT_FOUND'); f.all(); expect((await auth(f)).issues).toContain('CASE_SOURCE_CONFLICT');
    const g=fixture(); g.state.samples[0].productAssetId='BUSINESS-ASSET'; g.state.assets.push({id:'BUSINESS-ASSET',mainCategory:'fabric',fabricProfile:{id:'FP',deletedAt:null},garmentProfile:null,deletedAt:null});
    await denied(auth(g),'NOT_FOUND'); g.all(); expect((await auth(g)).issues).toContain('BUSINESS_LINE_CONFLICT');
  });
  it('Card asset is only a material descriptor, never another business-line vote', async () => {
    const f=fixture(); f.state.cards[0].productAssetId='FABRIC'; f.state.assets.push({id:'FABRIC',mainCategory:'fabric',fabricProfile:{id:'FP'},deletedAt:null}); expect(await auth(f)).toMatchObject({visibility:'full'});
  });
  it.each(['products','room','ceiling','inactive','deleted-user','no-actor'])('fresh %s revocation/identity rejects despite token owner and wildcard', async kind => {
    const f=fixture(); let who=actor; let mode:any='read';
    if(kind==='products')f.grant(['sample:room:write']); if(kind==='room'){f.grant(['products:read']);mode='write';}
    if(kind==='ceiling')who={...actor,permissionCeiling:[]}; if(kind==='inactive')f.state.users[0].status='inactive'; if(kind==='deleted-user')f.state.users[0].deletedAt=BigInt(1); if(kind==='no-actor')who=null;
    await denied(auth(f,{actor:who,mode}),['inactive','deleted-user','no-actor'].includes(kind)?'UNAUTHORIZED':'FORBIDDEN');
  });
  it('real custom user personal override active/not-deleted/not-expired is loaded; stale overrides cannot authorize', async () => {
    const f=fixture(); f.grant([]); f.state.overrides.push({userId:actor.userId,scope:'products:read',isActive:true,deletedAt:null,expiresAt:null}); expect(await auth(f)).toMatchObject({visibility:'full'});
    f.state.overrides[0].expiresAt=new Date(0); await denied(auth(f),'FORBIDDEN'); f.state.overrides[0].expiresAt=null;f.state.overrides[0].deletedAt=BigInt(1);await denied(auth(f),'FORBIDDEN');
  });
  it('fresh team read permits custody read and Room action grant remains separately required', async () => {
    const f=fixture(); f.state.relations[0].ownerId='OTHER'; f.state.memberships.push({userId:actor.userId,teamId:'TEAM',leftAt:null,team:{deletedAt:null}});
    f.state.grants.push({teamId:'TEAM',entityType:'relation',entityId:'CUSTOMER',permission:'read',revokedAt:null,team:{deletedAt:null}});
    expect(await auth(f)).toMatchObject({visibility:'full'}); f.state.grants[0].revokedAt=new Date(); await denied(auth(f),'NOT_FOUND');
  });
  it('SQL/authorization query failures propagate and cannot become catalog/empty authorization', async () => {
    const f=fixture(); f.db.userPermissionOverrides.findMany.mockRejectedValueOnce(Error('synthetic SQL failed')); await expect(auth(f)).rejects.toThrow('synthetic SQL failed');
    const g=fixture();g.db.order.findUnique.mockRejectedValueOnce(Error('synthetic order failed'));await expect(auth(g)).rejects.toThrow('synthetic order failed');
  });
  it('explicit current main connection recheck rejects old RR transaction and actual revoked current grant', async () => {
    const f=fixture(); const r=await auth(f); const tx={...f.db};delete tx.$transaction;
    await denied(recheckSampleCustodyAuthorization({currentPrisma:tx,actor,guard:r.guard}),'AUTHORIZATION_UNAVAILABLE');
    const frozen=fixture();const rr=await auth(frozen);f.grant(['sample:room:write']);await denied(recheckSampleCustodyAuthorization({currentPrisma:f.db,actor,guard:rr.guard}),'FORBIDDEN');
  });
  it('RR-external parent ownership/source/customer facts and irrelevant permission changes reject stale guard', async () => {
    const f=fixture();const r=await auth(f);f.state.relations[0].salesRepIds=['COLLEAGUE'];await denied(recheckSampleCustodyAuthorization({currentPrisma:f.db,actor,guard:r.guard}),'SOURCE_CHANGED');
    const g=fixture();const q=await auth(g);g.state.samples[0].sourceCaseId='CASE';await denied(recheckSampleCustodyAuthorization({currentPrisma:g.db,actor,guard:q.guard}),'SOURCE_CHANGED');
    const h=fixture();const s=await auth(h);h.state.users[0].roles[0].role.permissions.push({permission:{scope:'products:write'}});await denied(recheckSampleCustodyAuthorization({currentPrisma:h.db,actor,guard:s.guard}),'SOURCE_CHANGED');
  });
  it('catalog guard is invalidated if a genuine business owner appears, not chased into a new scope', async () => {
    const f=fixture();f.unowned();const r=await auth(f,{allowUnownedCatalog:true});f.state.cards[0].devCaseId='CASE';await denied(recheckSampleCustodyAuthorization({currentPrisma:f.db,actor,guard:r.guard}),'SOURCE_CHANGED');
  });
  it('unchanged root-current guard rechecks successfully, stock changes are caller snapshot/CAS responsibility', async () => {
    const f=fixture();const r=await auth(f);f.state.cards[0].quantity=4;f.state.cards[0].availableQty=3;f.state.cards[0].updatedAt=BigInt(8);
    expect(await recheckSampleCustodyAuthorization({currentPrisma:f.db,actor,guard:r.guard})).toMatchObject({visibility:'full'});
  });
  it.each(['case','order','batch','consistent-mixed'])('Card %s parent combination keeps legal existing custody without origin/approval evidence', async kind => {
    const f=fixture();f.unowned();
    if(kind==='case')f.state.cards[0].devCaseId='CASE';
    if(kind==='order')f.state.cards[0].orderId='ORDER';
    if(kind==='batch')f.state.cards[0].batchId='BATCH';
    if(kind==='consistent-mixed') { Object.assign(f.state.cards[0],{sampleId:'SAMPLE',devCaseId:'CASE',orderId:'ORDER',batchId:'BATCH'}); f.state.samples[0].sourceCaseId='CASE';f.state.orders[0].sourceCaseId='CASE'; }
    expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full',issues:[]});
  });
  it('ordinary customer-only Sample is lawful custody and never an orphan catalog', async () => {
    const f=fixture(); f.state.samples[0].sourceOrderId=null;
    expect(await auth(f,{allowUnownedCatalog:true})).toMatchObject({visibility:'full',issues:[]});
  });
  it('legitimate paused/closed source does not create approval or block a physical custody read', async () => {
    const f=fixture();Object.assign(f.state.cards[0],{devCaseId:'CASE'});f.state.orders[0].sourceCaseId='CASE';
    Object.assign(f.state.cases[0],{status:'closed',paused:true});const before=copy(f.state);expect(await auth(f)).toMatchObject({visibility:'full'});expect(f.state).toEqual(before);
  });
  it('deleted original Card requires explicit historical read and cannot become catalog/write', async () => {
    const f=fixture();f.state.cards[0].deletedAt=BigInt(9);await denied(auth(f),'NOT_FOUND');
    expect(await auth(f,{historical:true})).toMatchObject({visibility:'full',issues:['CARD_DELETED']});await denied(auth(f,{historical:true,mode:'write'}),'INVALID_INPUT');
    f.unowned();await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');
  });
  it.each(['missing','deleted'])('all-scope %s customer is explicit historical source review, not shared orphan fallback', async kind => {
    const f=fixture();if(kind==='missing')f.state.relations=f.state.relations.filter((x:any)=>x.id!=='CUSTOMER');else f.state.relations[0].deletedAt=BigInt(1);
    await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');f.all();expect((await auth(f)).issues).toContain(kind==='missing'?'CUSTOMER_MISSING':'CUSTOMER_DELETED');
  });
  it('all real customer anchors are checked; an own Sample does not conceal foreign Case/Order data', async () => {
    const f=fixture();f.state.cards[0].devCaseId='CASE';f.state.cases[0].customerRelationId='FOREIGN';
    await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');
  });
  it('same authoritative role/grant/ceiling sets in different order do not invalidate a fresh guard', async () => {
    const f=fixture();f.state.users[0].roles.push({departmentId:null,role:{id:'second-custom-role',permissions:[]}});
    f.state.relations[0].salesRepIds=['B','A'];const r=await auth(f);f.state.users[0].roles.reverse();f.state.relations[0].salesRepIds.reverse();
    expect(await recheckSampleCustodyAuthorization({currentPrisma:f.db,actor:{...actor,permissionCeiling:[...actor.permissionCeiling].reverse()},guard:r.guard})).toMatchObject({visibility:'full'});
  });
  it('changed original signed ceiling and stored all role cannot reuse an earlier guard', async () => {
    const f=fixture();const r=await auth(f);await denied(recheckSampleCustodyAuthorization({currentPrisma:f.db,actor:{...actor,permissionCeiling:['products:read']},guard:r.guard}),'SOURCE_CHANGED');
    const g=fixture();g.unowned();g.all();const q=await auth(g);g.state.users[0].roles[0].role.id='custom-custody-employee';await denied(recheckSampleCustodyAuthorization({currentPrisma:g.db,actor,guard:q.guard}),'NOT_FOUND');
  });
  it.each(['read','read+followup'])('actual team %s share keeps read and uses existing owner/followup write contract despite Room grant', async permission => {
    const f=fixture();f.state.relations[0].ownerId='OTHER';
    f.state.memberships.push({userId:actor.userId,teamId:'TEAM',leftAt:null,team:{deletedAt:null}});
    f.state.grants.push({teamId:'TEAM',entityType:'relation',entityId:'CUSTOMER',permission,revokedAt:null,team:{deletedAt:null}});
    expect(await auth(f)).toMatchObject({visibility:'full'});
    if(permission==='read')await denied(auth(f,{mode:'write'}),'NOT_FOUND');
    else expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full'});
  });
  it('locks only the frozen actual graph: Case, deduplicated customer/factory Relations, Batch, Order, assets, warehouse, Sample, Card', async () => {
    const f=fixture();Object.assign(f.state.cards[0],{devCaseId:'CASE',orderId:'ORDER',batchId:'BATCH',productAssetId:'DESCRIPTOR',warehouseId:'WAREHOUSE'});
    f.state.samples[0].sourceCaseId='CASE';f.state.orders[0].sourceCaseId='CASE';f.state.batches[0].supplierRelationId='CUSTOMER';
    f.state.samples[0].productAssetId='BUSINESS-ASSET';
    f.state.assets.push({id:'BUSINESS-ASSET',mainCategory:'garment',garmentProfile:{id:'GP',deletedAt:null},fabricProfile:null,deletedAt:null},
      {id:'DESCRIPTOR',mainCategory:'fabric',fabricProfile:{id:'FP',deletedAt:null},garmentProfile:null,deletedAt:null});
    f.state.warehouses.push({id:'WAREHOUSE',isActive:true,deletedAt:null});
    const r=await auth(f,{mode:'write'}),before=copy(f.state),tx={...f.db};delete tx.$transaction;
    await lockSampleCustodyGraph(tx,r);
    expect(r.lockRefs.map(x=>`${x.kind}:${x.id}`)).toEqual(['case:CASE','relation:CUSTOMER','relation:FACTORY','batch:BATCH','order:ORDER',
      'asset:BUSINESS-ASSET','asset:DESCRIPTOR','warehouse:WAREHOUSE','sample:SAMPLE','card:CARD']);
    expect(f.db.$queryRaw.mock.calls.map(([q]:any)=>q.values[0])).toEqual(r.lockRefs.map(x=>x.id));
    expect(f.db.$queryRaw.mock.calls.map(([q]:any)=>q.sql.match(/FROM "([^"]+)"/)![1])).toEqual([
      'DevelopmentCase','Relation','Relation','SampleBatch','Order','ProductAsset','ProductAsset','Warehouse','Sample','SampleCardItem']);
    expect(f.state).toEqual(before);
  });
  it('missing parents are never invented or locked; root client and tampered lock list refuse; SQL lock failures propagate', async () => {
    const f=fixture();f.all();f.state.samples[0].sourceOrderId='MISSING';const r=await auth(f),tx={...f.db};delete tx.$transaction;
    await lockSampleCustodyGraph(tx,r);expect(f.db.$queryRaw.mock.calls.every(([q]:any)=>q.values[0]!=='MISSING')).toBe(true);
    await denied(lockSampleCustodyGraph(f.db,r),'AUTHORIZATION_UNAVAILABLE');
    await denied(lockSampleCustodyGraph(tx,{...r,lockRefs:[...r.lockRefs,{kind:'order',id:'MISSING'}]}),'SOURCE_CHANGED');
    f.db.$queryRaw.mockRejectedValueOnce(Error('synthetic lock SQL failed'));await expect(lockSampleCustodyGraph(tx,r)).rejects.toThrow('synthetic lock SQL failed');
  });
  it('a newly discovered parent after locking invalidates the guard without acquiring that new parent', async () => {
    const f=fixture(),before=await auth(f,{mode:'write'}),tx={...f.db};delete tx.$transaction;
    await lockSampleCustodyGraph(tx,before);const calls=f.db.$queryRaw.mock.calls.length;
    f.state.samples[0].sourceCaseId='CASE';const after=await auth(f,{mode:'write'});
    expect(()=>assertSampleCustodyGuardStable(before.guard,after.guard)).toThrowError(expect.objectContaining({code:'SOURCE_CHANGED'}));
    expect(f.db.$queryRaw.mock.calls).toHaveLength(calls);expect(before.lockRefs.some(x=>x.kind==='case')).toBe(false);
  });
  it('10000 shared-parent Cards use one native authority epoch and bounded parent prefetch, matching single-item guards', async () => {
    const f=fixture(),base=copy(f.state.cards[0]);f.state.cards=Array.from({length:10000},(_,i)=>({...base,id:`CARD-${String(i).padStart(5,'0')}`}));
    const subjects=f.state.cards.map((x:any)=>({kind:'card' as const,id:x.id}));
    const result=await authorizeSampleCustodyBatch({db:f.db,actor,subjects});
    expect(result).toHaveLength(10000);expect(result.every(x=>x.ok&&x.authorization.visibility==='full')).toBe(true);
    expect(f.db.userAccount.findFirst).toHaveBeenCalledTimes(1);expect(f.db.userAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(f.db.userPermissionOverrides.findMany).toHaveBeenCalledTimes(1);expect(f.db.sampleCardItem.findMany).toHaveBeenCalledTimes(50);
    expect(f.db.sample.findMany).toHaveBeenCalledTimes(1);expect(f.db.order.findMany).toHaveBeenCalledTimes(1);expect(f.db.relation.findMany).toHaveBeenCalledTimes(1);
    for(const delegate of ['sampleCardItem','sample','order','relation'])expect(f.db[delegate].findUnique).not.toHaveBeenCalled();
    expect(f.db.relation.findFirst).not.toHaveBeenCalled();
    const single=await auth(f,{subject:subjects[0]});expect(result[0].ok&&result[0].authorization.guard).toEqual(single.guard);
  },30000);
  it('distinct shared customers resolve actual team grants once per distinct customer, not per Card', async () => {
    const f=fixture();f.state.relations[0].ownerId='OTHER';
    f.state.memberships.push({userId:actor.userId,teamId:'TEAM',leftAt:null,team:{deletedAt:null}});
    f.state.grants.push({teamId:'TEAM',entityType:'relation',entityId:'CUSTOMER',permission:'read',revokedAt:null,team:{deletedAt:null}});
    const base=copy(f.state.cards[0]);f.state.cards=Array.from({length:200},(_,i)=>({...base,id:`CARD-${i}`}));
    const r=await authorizeSampleCustodyBatch({db:f.db,actor,subjects:f.state.cards.map((x:any)=>({kind:'card',id:x.id}))});
    expect(r.every(x=>x.ok)).toBe(true);expect(f.db.teamMember.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.teamDataGrant.findMany).toHaveBeenCalledTimes(1);expect(f.db.teamDataGrant.findFirst).toHaveBeenCalledTimes(1);
    expect(f.db.userAccount.findUnique).toHaveBeenCalledTimes(1);
  });
  it('batch foreign and broken parents stay denied; only genuinely unowned Cards receive catalog projection authority', async () => {
    const f=fixture(),base=copy(f.state.cards[0]);f.state.orders.push({...f.state.orders[0],id:'FOREIGN-ORDER',customerRelationId:'FOREIGN'});
    f.state.cards.push({...base,id:'FOREIGN-CARD',sampleId:null,orderId:'FOREIGN-ORDER'},
      {...base,id:'BROKEN',sampleId:null,devCaseId:'MISSING'}, {...base,id:'ORPHAN',sampleId:null},
      {...base,id:'HISTORY',sampleId:null,receiptSnapshot:{version:1,batchId:'OLD'}});
    const r=await authorizeSampleCustodyBatch({db:f.db,actor,subjects:f.state.cards.map((x:any)=>({kind:'card',id:x.id})),allowUnownedCatalog:true});
    expect(r.map(x=>x.ok?x.authorization.visibility:x.error.code)).toEqual(['full','NOT_FOUND','NOT_FOUND','catalog','NOT_FOUND']);
  });
  it('empty batch still authenticates, write mode cannot reuse read authority, duplicates/over-limit reject, bulk SQL errors abort', async () => {
    const f=fixture();await denied(authorizeSampleCustodyBatch({db:f.db,actor:null,subjects:[]}),'UNAUTHORIZED');
    await denied(authorizeSampleCustodyBatch({db:f.db,actor,subjects:[],mode:'write'} as any),'INVALID_INPUT');
    await denied(authorizeSampleCustodyBatch({db:f.db,actor,subjects:[{kind:'card',id:'CARD'},{kind:'card',id:'CARD'}]}),'INVALID_INPUT');
    await denied(authorizeSampleCustodyBatch({db:f.db,actor,subjects:Array.from({length:10001},(_,i)=>({kind:'card',id:String(i)}))}),'INVALID_INPUT');
    f.db.order.findMany.mockRejectedValueOnce(Error('synthetic bulk SQL failed'));
    await expect(authorizeSampleCustodyBatch({db:f.db,actor,subjects:[{kind:'card',id:'CARD'}]})).rejects.toThrow('synthetic bulk SQL failed');
  });
  it('RR-external batch recheck rejects grant withdrawal during current entity reads using a NEW last authority epoch', async () => {
    const f=fixture(),rr=await auth(f);const native=f.db.order.findMany.getMockImplementation();
    f.db.order.findMany.mockImplementationOnce(async(args:any)=>{const rows=await native(args);f.grant(['sample:room:write']);return rows;});
    await denied(recheckSampleCustodyBatchAuthorization({currentPrisma:f.db,actor,guards:[rr.guard]}),'FORBIDDEN');
    expect(f.db.userAccount.findUnique.mock.calls.length).toBeGreaterThan(2);
    const tx={...f.db};delete tx.$transaction;await denied(recheckSampleCustodyBatchAuthorization({currentPrisma:tx,actor,guards:[rr.guard]}),'AUTHORIZATION_UNAVAILABLE');
  });
  it('RR-external final customer snapshot rejects ownership changes and never silently removes a previously qualified Card', async () => {
    const f=fixture(),rr=await auth(f);const native=f.db.relation.findMany.getMockImplementation();let reads=0;
    f.db.relation.findMany.mockImplementation(async(args:any)=>{const rows=await native(args);if(++reads===1)f.state.relations[0].ownerId='OTHER';return rows;});
    await denied(recheckSampleCustodyBatchAuthorization({currentPrisma:f.db,actor,guards:[rr.guard]}),'NOT_FOUND');
    const g=fixture(),guard=(await auth(g)).guard;g.state.cards=[];
    await denied(recheckSampleCustodyBatchAuthorization({currentPrisma:g.db,actor,guards:[guard]}),'NOT_FOUND');
  });
  it('fresh batch checks share no cache across requests or writers; unchanged current main batch rechecks safely', async () => {
    const f=fixture();const first=await authorizeSampleCustodyBatch({db:f.db,actor,subjects:[{kind:'card',id:'CARD'}]});
    if(!first[0].ok)throw Error('fixture must qualify');
    expect(await recheckSampleCustodyBatchAuthorization({currentPrisma:f.db,actor,guards:[first[0].authorization.guard]})).toHaveLength(1);
    f.grant(['products:read']);await denied(auth(f,{mode:'write'}),'FORBIDDEN');
    f.grant([]);await denied(authorizeSampleCustodyBatch({db:f.db,actor,subjects:[{kind:'card',id:'CARD'}]}),'FORBIDDEN');
  });
});


describe('actual ProductAsset schema projection for physical descriptors', () => {
  it.each(['single', 'batch'])('the %s reader never selects a nonexistent asset timestamp', async mode => {
    const f = fixture(); f.state.cards[0].productAssetId = 'SCHEMA-ASSET';
    f.state.assets.push({id:'SCHEMA-ASSET',mainCategory:'fabric',fabricProfile:null,garmentProfile:null,deletedAt:null});
    const check = (args:any) => { if (Object.prototype.hasOwnProperty.call(args.select, 'createdAt')) throw Error('Unknown field createdAt on ProductAsset'); };
    const one = f.db.productAsset.findUnique.getMockImplementation(), many = f.db.productAsset.findMany.getMockImplementation();
    f.db.productAsset.findUnique.mockImplementation(async (args:any) => { check(args); return one(args); });
    f.db.productAsset.findMany.mockImplementation(async (args:any) => { check(args); return many(args); });
    if (mode === 'single') expect((await auth(f)).visibility).toBe('full');
    else { const r = await authorizeSampleCustodyBatch({db:f.db,actor,subjects:[{kind:'card',id:'CARD'}]}); expect(r[0].ok).toBe(true); }
  });
});


describe('standalone manual custodian isolation',()=>{
 it('creator gets full read/write, another scoped actor does not get catalog, stored all retains access',async()=>{
  const f=fixture();f.unowned();f.state.cards[0].custodianUserId=actor.userId;
  expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full'});
  f.state.cards[0].custodianUserId='OTHER';await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');
  f.all();expect(await auth(f,{mode:'write'})).toMatchObject({visibility:'full'});
 });
 it('custodian cannot bypass source ownership and own customer field cannot bypass another source customer',async()=>{
  const f=fixture();f.state.cards[0].custodianUserId=actor.userId;f.state.orders[0].customerRelationId='FOREIGN';
  await denied(auth(f,{allowUnownedCatalog:true}),'NOT_FOUND');
  f.state.cards[0].customerRelationId='CUSTOMER';await denied(auth(f),'NOT_FOUND');
 });
 it('custodian and customer ownership changes invalidate the server guard',async()=>{
  const f=fixture();f.unowned();f.state.cards[0].custodianUserId=actor.userId;const before=await auth(f);
  f.state.cards[0].customerRelationId='CUSTOMER';
  await denied(recheckSampleCustodyAuthorization({currentPrisma:f.db,actor,guard:before.guard}),'SOURCE_CHANGED');
 });
});
