/** Shared custody authority kernel. Callers own projection, locks and business gates. */
import { createHash } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { authorizeDevelopmentSource } from '../development/developmentConversionAuthority';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';

export type SampleCustodySubject = { kind: 'card' | 'sample' | 'case' | 'order' | 'batch'; id: string };
export type SampleCustodyMode = 'read' | 'write';
export class SampleCustodyAuthorizationError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); this.name = 'SampleCustodyAuthorizationError'; }
}
const deny = (code: string, status: number, message: string): never => { throw new SampleCustodyAuthorizationError(code, status, message); };
const normalized = (v: any): any => typeof v === 'bigint' ? String(v) : v instanceof Date ? v.toISOString()
  : Array.isArray(v) ? v.map(normalized) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalized(v[k])])) : v;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(normalized(v))).digest('hex');
export interface SampleCustodyGuard {
  version: 1; subject: SampleCustodySubject; mode: SampleCustodyMode; allowUnownedCatalog: boolean;
  historical: boolean;
  visibility: 'full' | 'catalog'; actorId: string; authorizationHash: string; parentHash: string; lockRefsHash: string;
}
export type SampleCustodyLockRef = { kind: 'case' | 'relation' | 'batch' | 'order' | 'asset' | 'warehouse' | 'sample' | 'card'; id: string };
export interface SampleCustodyAuthorization {
  actor: TokenPayload; visibility: 'full' | 'catalog'; issues: string[]; guard: SampleCustodyGuard;
  /** Server-only; never serialize this helper result as a catalog/full HTTP DTO. */
  lockRefs: readonly SampleCustodyLockRef[];
}

const unavailable = (): never => deny('NOT_FOUND', 404, '实物或业务归属不存在或不可见。');
const sorted = (values: string[]) => [...new Set(values)].sort();
const ownerSlots = ['sampleId', 'devCaseId', 'orderId', 'batchId'] as const;
const lockTables = { case: 'DevelopmentCase', relation: 'Relation', batch: 'SampleBatch', order: 'Order', asset: 'ProductAsset',
  warehouse: 'Warehouse', sample: 'Sample', card: 'SampleCardItem' } as const;
const lockOrder = Object.keys(lockTables) as Array<keyof typeof lockTables>;
const graphLockRefs = (graph: Graph): SampleCustodyLockRef[] => {
  const refs = new Map<string, SampleCustodyLockRef>();
  for (const row of graph.records) if (row.identity) {
    const kind = row.kind === 'customer' || row.kind === 'factory' ? 'relation' : row.kind;
    refs.set(`${kind}:${row.id}`, { kind, id: row.id });
  }
  return [...refs.values()].sort((a,b) => lockOrder.indexOf(a.kind) - lockOrder.indexOf(b.kind) || a.id.localeCompare(b.id));
};

/** Exact null or the deliberately narrow manual marker. Unknown JSON is not proof of no source. */
export function isSharedUnownedSampleCard(card: any): boolean {
  const receipt = card?.receiptSnapshot;
  const manual = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && Object.getPrototypeOf(receipt) === Object.prototype && Object.keys(receipt).length === 1 && receipt.kind === 'manual';
  return !!card && card.customerRelationId == null && card.custodianUserId == null && card.deletedAt === null && ownerSlots.every(field => card[field] === null) && (receipt === null || manual === true);
}

type Graph = { records: any[]; issues: string[]; requiresAll: boolean; customers: string[]; card: any };
const recordDefinitions: Record<string, { delegate: string; fields: string[] }> = {
  card: { delegate: 'sampleCardItem', fields: ['id', 'createdAt', 'deletedAt', 'sampleId', 'devCaseId', 'orderId', 'batchId', 'productAssetId', 'warehouseId', 'receiptSnapshot', 'customerRelationId', 'custodianUserId'] },
  sample: { delegate: 'sample', fields: ['id', 'createdAt', 'deletedAt', 'sourceCaseId', 'sourceOrderId', 'productAssetId', 'customerRelationId', 'supplierRelationId'] },
  case: { delegate: 'developmentCase', fields: ['id', 'createdAt', 'deletedAt', 'type', 'customerRelationId', 'supplierRelationId', 'ownerId', 'departmentId'] },
  order: { delegate: 'order', fields: ['id', 'createdAt', 'deletedAt', 'sourceCaseId', 'customerRelationId', 'type', 'businessLine'] },
  batch: { delegate: 'sampleBatch', fields: ['id', 'createdAt', 'deletedAt', 'developmentCaseId', 'supplierRelationId', 'sampleType'] },
  customer: { delegate: 'relation', fields: ['id', 'createdAt', 'deletedAt', 'ownerId', 'salesRepIds', 'departmentId'] },
  factory: { delegate: 'relation', fields: ['id', 'createdAt', 'deletedAt'] },
  warehouse: { delegate: 'warehouse', fields: ['id', 'createdAt', 'deletedAt', 'isActive'] },
  asset: { delegate: 'productAsset', fields: ['id', 'deletedAt', 'mainCategory', 'fabricProfile', 'garmentProfile'] },
};
const recordSelect = (kind: string): any => {
  const select: any = Object.fromEntries(recordDefinitions[kind].fields.map(field => [field, true]));
  if (kind === 'asset') { select.fabricProfile = { select: { id: true, deletedAt: true } }; select.garmentProfile = { select: { id: true, deletedAt: true } }; }
  return select;
};
/** Real current owners only. Material descriptors and supplier links never become customer access. */
async function readGraph(db: any, subject: SampleCustodySubject, historical: boolean): Promise<Graph> {
  const graph: Graph = { records: [], issues: [], requiresAll: false, customers: [], card: null };
  const cache = new Map<string, any>(), caseIds: string[] = [], orderIds: string[] = [], businessLines: string[] = [];
  const issue = (code: string, needsAll = true) => { graph.issues.push(code); if (needsAll) graph.requiresAll = true; };
  const reference = (value: any, label: string): string | null => {
    if (value == null) return null;
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 200) { issue(`${label}_REFERENCE_INVALID`); return null; }
    return value;
  };
  const load = async (kind: string, value: any, root = false): Promise<any> => {
    const id = reference(value, kind.toUpperCase()); if (!id) return null;
    const key = `${kind}:${id}`;
    if (cache.has(key)) return cache.get(key);
    const spec = recordDefinitions[kind], select = recordSelect(kind);
    const row = await db[spec.delegate].findUnique({ where: { id }, select });
    cache.set(key, row);
    graph.records.push({ kind, id, identity: row ? Object.fromEntries(spec.fields.map(field => [field,
      field === 'salesRepIds' && Array.isArray(row[field]) ? [...row[field]].sort() : row[field] ?? null])) : null });
    if (!row) { if (root) unavailable(); issue(`${kind.toUpperCase()}_MISSING`); }
    else if (row.deletedAt != null) {
      if (root && !historical) unavailable();
      issue(`${kind.toUpperCase()}_DELETED`, !(root && historical));
    }
    return row;
  };
  const customer = async (value: any) => { const id = reference(value, 'CUSTOMER'); if (id) { graph.customers.push(id); await load('customer', id); } };
  const factory = async (value: any) => { if (value != null) await load('factory', value); };
  const vote = (value: any) => { const line = typeof value === 'string' ? value.trim().toLowerCase() : null;
    if (line === 'fabric' || line === 'garment') businessLines.push(line); };
  const development = async (value: any) => {
    const id = reference(value, 'CASE'); if (!id) return; caseIds.push(id);
    const row = await load('case', id); if (!row) return;
    vote(row.type); await customer(row.customerRelationId); await factory(row.supplierRelationId);
  };
  const order = async (value: any) => {
    const id = reference(value, 'ORDER'); if (!id) return; orderIds.push(id);
    const row = await load('order', id); if (!row) return;
    vote(row.type); vote(row.businessLine); await customer(row.customerRelationId); await development(row.sourceCaseId);
  };
  const sample = async (value: any) => {
    const row = await load('sample', value); if (!row) return;
    await customer(row.customerRelationId); await factory(row.supplierRelationId);
    await development(row.sourceCaseId); await order(row.sourceOrderId);
    if (row.productAssetId != null) {
      const asset = await load('asset', row.productAssetId);
      if (asset && asset.deletedAt == null) { vote(asset.mainCategory); if (asset.fabricProfile && asset.fabricProfile.deletedAt == null) vote('fabric'); if (asset.garmentProfile && asset.garmentProfile.deletedAt == null) vote('garment'); }
    }
  };
  const batch = async (value: any) => {
    const row = await load('batch', value); if (!row) return;
    if (!row.developmentCaseId) issue('BATCH_CASE_MISSING');
    await development(row.developmentCaseId); await factory(row.supplierRelationId);
  };
  // The subject's existence is checked before any catalog possibility. Deleted
  // root subjects are opt-in historical reads, never a shared orphan or a write.
  const root = await load(subject.kind, subject.id, true);
  if (subject.kind === 'card') {
    graph.card = root; await sample(root.sampleId); await development(root.devCaseId); await order(root.orderId); await batch(root.batchId);
    // Descriptor/warehouse presence belongs in stability proof, not a business-line vote.
    if (root.productAssetId != null) await load('asset', root.productAssetId);
    if (root.warehouseId != null) await load('warehouse', root.warehouseId);
    await customer(root.customerRelationId);
  } else if (subject.kind === 'sample') await sample(subject.id);
  else if (subject.kind === 'case') await development(subject.id);
  else if (subject.kind === 'order') await order(subject.id);
  else await batch(subject.id);
  if (sorted(caseIds).length > 1) issue('CASE_SOURCE_CONFLICT');
  if (sorted(orderIds).length > 1) issue('ORDER_SOURCE_CONFLICT');
  if (sorted(businessLines).length > 1) issue('BUSINESS_LINE_CONFLICT');
  if (!graph.customers.length) {
    const c=graph.card;
    const manual=c && ownerSlots.every(field=>c[field] == null) && (c.receiptSnapshot===null || c.receiptSnapshot?.kind==='manual' && Object.keys(c.receiptSnapshot).length===1);
    const internalDevelopment = !graph.records.some(row => row.kind === 'order')
      && graph.records.some(row => row.kind === 'case' && row.identity?.deletedAt == null
        && typeof row.identity?.ownerId === 'string' && row.identity.ownerId.trim());
    if (!(manual && typeof c.custodianUserId==='string' && c.custodianUserId.trim()) && !internalDevelopment) issue('NO_CUSTOMER_ANCHOR');
  }
  graph.customers = sorted(graph.customers); graph.issues = sorted(graph.issues);
  graph.records.sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return graph;
}

type CustodyParams = { db: any; actor: TokenPayload | null | undefined; subject: SampleCustodySubject;
  mode?: SampleCustodyMode; allowUnownedCatalog?: boolean; historical?: boolean };
function validateSubject(subject: SampleCustodySubject) {
  if (!subject || !['card','sample','case','order','batch'].includes(subject.kind) || typeof subject.id !== 'string'
    || !subject.id.trim() || subject.id.trim() !== subject.id || subject.id.length > 200)
    deny('INVALID_INPUT', 400, '请指定明确的实物或真实业务归属。');
}
async function loadAuthority(db: any, trustedActor: TokenPayload | null | undefined, mode: SampleCustodyMode) {
  if (!trustedActor?.userId || typeof trustedActor.userId !== 'string') deny('UNAUTHORIZED', 401, '请使用当前登录账号读取实物台账。');
  const ceiling = trustedActor!.permissionCeiling;
  if (ceiling !== undefined && (!Array.isArray(ceiling) || ceiling.some(s => typeof s !== 'string' || !s.trim() || s.trim() !== s)))
    deny('FORBIDDEN', 403, '当前凭据权限上限不可用。');
  const user = await db.userAccount.findFirst({ where: { id: trustedActor!.userId, deletedAt: null, status: 'active' } });
  if (!user || user.id !== trustedActor!.userId || user.status !== 'active' || user.deletedAt != null) deny('UNAUTHORIZED', 401, '当前账号不可用，请重新登录。');
  const service = createPermissionService({ prisma: db });
  const context = await service.getUserPermissionContext(trustedActor!.userId);
  if (!context || context.userId !== trustedActor!.userId) deny('AUTHORIZATION_UNAVAILABLE', 503, '当前实物台账授权未能核对。');
  const actor: TokenPayload = { ...trustedActor!, roles: context!.legacyRoleCodes, roleIds: context!.roleIds,
    permissions: context!.scopes, departmentIds: context!.departmentIds, authorizationLoaded: true };
  if (!hasScope({ ...actor, roles: [] }, 'products:read') || mode === 'write' && !hasScope({ ...actor, roles: [] }, 'sample:room:write'))
    deny('FORBIDDEN', 403, '当前账号没有本次实物台账操作所需权限。');
  const scope = await service.getDataScopeResolver(actor, 'relations');
  return { user, context, actor, scope, ceiling };
}
type Authority = Awaited<ReturnType<typeof loadAuthority>>;
type ReadSession = { authority: Authority; accesses: Map<string, Promise<string>>; graphs: Map<string, Graph> };
const subjectKey = (subject: SampleCustodySubject) => `${subject.kind}:${subject.id}`;
async function fromGraph(params: CustodyParams, graph: Graph, authority: Authority, session?: ReadSession): Promise<SampleCustodyAuthorization> {
  const { actor, user, context, scope, ceiling } = authority;
  const mode = params.mode ?? 'read', historical = params.historical === true, subject = params.subject;
  const storedAll = resolveWriteKind(scope.rule) === 'all';
  const catalog = subject.kind === 'card' && mode === 'read' && !historical && params.allowUnownedCatalog === true && isSharedUnownedSampleCard(graph.card);
  const visibility = catalog && !storedAll ? 'catalog' as const : 'full' as const;
  const accesses: any[] = [];
  if (visibility === 'full') {
    if (graph.requiresAll && !storedAll) unavailable();
    if (!graph.customers.length && !storedAll) {
      for (const row of graph.records.filter(row => row.kind === 'case' && row.identity?.ownerId)) {
        const key=`development:${row.id}:${mode}`;
        let verdict=session?.accesses.get(key);
        if (!verdict) {
          verdict=(async()=>{
            try { await authorizeDevelopmentSource(params.db,actor.userId,actor,row.id,{scope:'products:read',write:mode==='write'}); }
            catch(error) { if(error instanceof DevelopmentDomainError) deny(error.code,error.statusCode,error.message); throw error; }
            return JSON.stringify(normalized(await createPermissionService({prisma:params.db}).getDataScopeResolver(actor,'development')));
          })();
          session?.accesses.set(key,verdict);
        }
        accesses.push({caseId:row.id,developmentScope:await verdict});
      }
    }
    const c=graph.card;
    // Custodian ownership is valid only for an internal, standalone manual card.
    const internal=c && !graph.customers.length && ownerSlots.every(field=>c[field] == null) && (c.receiptSnapshot===null || c.receiptSnapshot?.kind==='manual' && Object.keys(c.receiptSnapshot).length===1);
    if(internal && c.custodianUserId != null && c.custodianUserId!==actor.userId && !storedAll) unavailable();
    for (const id of graph.customers) {
      let verdict = session?.accesses.get(id);
      if (!verdict) { verdict = createTeamShareService(params.db).resolveRelationAccess(actor, id, { fresh: true }); session?.accesses.set(id, verdict); }
      const access = await verdict;
      accesses.push({ id, access });
      if (access === 'none' || mode === 'write' && !['owner','team-followup'].includes(access)) unavailable();
    }
  }
  // Grant/role/department lists are sets; incidental DB row order is not an authority change.
  const contextIdentity = { ...context } as Record<string, any>;
  for (const key of ['roleIds','legacyRoleCodes','scopes','departmentIds','departmentSubtreeIds']) contextIdentity[key] = sorted(contextIdentity[key] ?? []);
  const scopeIdentity = { ...scope } as Record<string, any>;
  for (const key of ['allowedDepartmentIds','allowedUserIds','allowedTeamIds']) if (scopeIdentity[key]) scopeIdentity[key] = sorted(scopeIdentity[key]);
  const authorizationHash = digest({ user: { id: user.id, status: user.status, deletedAt: user.deletedAt ?? null },
    context: contextIdentity, dataScope: scopeIdentity, ceiling: ceiling === undefined ? null : sorted(ceiling), accesses, visibility });
  const lockRefs = graphLockRefs(graph);
  return { actor, visibility, issues: graph.issues, lockRefs, guard: { version: 1, subject: { kind: subject.kind, id: subject.id }, mode, historical,
    allowUnownedCatalog: params.allowUnownedCatalog === true, visibility, actorId: actor.userId, authorizationHash, parentHash: digest(graph.records), lockRefsHash: digest(lockRefs) } };
}
async function authorizeCore(params: CustodyParams, session?: ReadSession): Promise<SampleCustodyAuthorization> {
  validateSubject(params.subject);
  const mode = params.mode ?? 'read';
  if (!['read','write'].includes(mode) || params.historical === true && mode !== 'read') deny('INVALID_INPUT', 400, '操作方式或历史读取不合法。');
  let authority = session?.authority ?? await loadAuthority(params.db, params.actor, mode);
  const graph = await readGraph(params.db, params.subject, params.historical === true);
  session?.graphs.set(subjectKey(params.subject), graph);
  // Writes never reuse a read session; source reads cannot conceal a withdrawn action grant.
  if (mode === 'write') authority = await loadAuthority(params.db, params.actor, mode);
  return fromGraph(params, graph, authority, session);
}
/** db may be the writer transaction. Projection, locks, terminal/stock gates and CAS belong to callers.
 * No session/context argument is public. A catalog decision never permits a full HTTP DTO. */
export async function authorizeSampleCustody(params: CustodyParams): Promise<SampleCustodyAuthorization> { return authorizeCore(params); }

/** One private read snapshot. No context/cache can be supplied by a caller or reused for a write.
 * Permission service/team-share retain their real implementations; this only coalesces identical reads. */
function readSnapshot(db: any) {
  const rows = new Map<string, any>(), known = new Set<string>(), queryMemo = new Map<string, Promise<any>>();
  const canonical = (kind: string) => kind === 'factory' ? 'customer' : kind;
  const nodeKey = (kind: string, id: string) => `${canonical(kind)}:${id}`;
  const clockKey = (v: any): any => v instanceof Date ? '__this_read_clock__' : Array.isArray(v) ? v.map(clockKey)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,clockKey(v[k])])) : v;
  const wrapped = Object.create(db);
  const delegates = sorted([...Object.values(recordDefinitions).map(s=>s.delegate), 'userAccount','userPermissionOverrides','teamMember','teamDataGrant','department']);
  for (const name of delegates) {
    const native = db[name]; if (!native) continue;
    const proxy = Object.create(native);
    for (const method of ['findFirst','findUnique','findMany']) if (typeof native[method] === 'function') {
      Object.defineProperty(proxy,method,{value:(args: any = {}) => {
        const kind = Object.keys(recordDefinitions).find(k=>recordDefinitions[k].delegate === name);
        if (kind && ['findUnique','findFirst'].includes(method) && typeof args.where?.id === 'string'
          && Object.keys(args.where).every(k=>['id','deletedAt'].includes(k))) {
          const key = nodeKey(kind,args.where.id);
          if (known.has(key)) { const row=rows.get(key) ?? null; return Promise.resolve(row && args.where.deletedAt === null && row.deletedAt != null ? null : row); }
        }
        const key = `${name}:${method}:${digest(clockKey(args))}`;
        if (!queryMemo.has(key)) queryMemo.set(key,Promise.resolve().then(()=>native[method](args)));
        return queryMemo.get(key)!;
      }});
    }
    Object.defineProperty(wrapped,name,{value:proxy});
  }
  const validId = (v: any): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && v.length <= 200;
  async function prime(seeds: Array<{kind:string;id:string}>) {
    let pending=seeds;
    while(pending.length) {
      const groups=new Map<string,string[]>();
      for(const node of pending) {
        if(!validId(node.id))continue;
        const kind=canonical(node.kind),key=nodeKey(kind,node.id); if(known.has(key))continue;
        known.add(key);const ids=groups.get(kind)??[];ids.push(node.id);groups.set(kind,ids);
      }
      pending=[];
      for(const [kind,ids] of groups) {
        const spec=recordDefinitions[kind],unique=sorted(ids);
        for(let offset=0;offset<unique.length;offset+=200) {
          const chunk=unique.slice(offset,offset+200);
          const found=await db[spec.delegate].findMany({where:{id:{in:chunk}},select:recordSelect(kind)});
          const byId=new Map<string,any>(found.map((row:any)=>[row.id,row]));
          for(const id of chunk) {
            const row=byId.get(id)??null;rows.set(nodeKey(kind,id),row);if(!row)continue;
            const add=(nextKind:string,value:any)=>{if(validId(value))pending.push({kind:nextKind,id:value});};
            if(kind==='card'){add('sample',row.sampleId);add('case',row.devCaseId);add('order',row.orderId);add('batch',row.batchId);add('asset',row.productAssetId);add('warehouse',row.warehouseId);add('customer',row.customerRelationId);}
            if(kind==='sample'){add('case',row.sourceCaseId);add('order',row.sourceOrderId);add('asset',row.productAssetId);add('customer',row.customerRelationId);add('factory',row.supplierRelationId);}
            if(kind==='order'){add('case',row.sourceCaseId);add('customer',row.customerRelationId);}
            if(kind==='case'){add('customer',row.customerRelationId);add('factory',row.supplierRelationId);}
            if(kind==='batch'){add('case',row.developmentCaseId);add('factory',row.supplierRelationId);}
          }
        }
      }
    }
  }
  return {db:wrapped,prime,row:(kind:string,id:string)=>rows.get(nodeKey(kind,id))??null};
}
export type SampleCustodyBatchResult = {subject:SampleCustodySubject;ok:true;authorization:SampleCustodyAuthorization}
  | {subject:SampleCustodySubject;ok:false;error:{code:'NOT_FOUND';status:404}};
type ReadEntry = {subject:SampleCustodySubject;allowUnownedCatalog?:boolean;historical?:boolean};
async function readBatch(db:any,actor:TokenPayload|null|undefined,entries:ReadEntry[]) {
  const snapshot=readSnapshot(db);
  const authority=await loadAuthority(snapshot.db,actor,'read'); // Before any entity read, even for an empty batch.
  const session:ReadSession={authority,accesses:new Map(),graphs:new Map()};
  await snapshot.prime(entries.map(e=>e.subject));
  const items:SampleCustodyBatchResult[]=[];
  for(const entry of entries) {
    try {items.push({subject:entry.subject,ok:true,authorization:await authorizeCore({db:snapshot.db,actor,mode:'read',...entry},session)});}
    catch(error) {
      if(!(error instanceof SampleCustodyAuthorizationError)||error.code!=='NOT_FOUND')throw error;
      items.push({subject:entry.subject,ok:false,error:{code:'NOT_FOUND',status:404}});
    }
  }
  return {items,session};
}
function validateBatch(subjects:SampleCustodySubject[]) {
  if(!Array.isArray(subjects)||subjects.length>10000)deny('INVALID_INPUT',400,'单次实物授权读取最多10000个明确主体。');
  const keys=new Set<string>();for(const subject of subjects){validateSubject(subject);const key=subjectKey(subject);if(keys.has(key))deny('INVALID_INPUT',400,'实物授权主体不能重复。');keys.add(key);}
}
/** Read-only. Caller owns RR and filters qualified entities BEFORE count/pagination; unknown failures abort all.
 * The bounded private cache exists only for this invocation, never across identities, requests or writes. */
export async function authorizeSampleCustodyBatch(params:{db:any;actor:TokenPayload|null|undefined;subjects:SampleCustodySubject[];
  allowUnownedCatalog?:boolean;historical?:boolean}):Promise<SampleCustodyBatchResult[]> {
  if ((params as any).mode !== undefined && (params as any).mode !== 'read') deny('INVALID_INPUT',400,'批量授权仅支持只读，写操作必须独立核验。');
  validateBatch(params.subjects);
  return (await readBatch(params.db,params.actor,params.subjects.map(subject=>({subject,allowUnownedCatalog:params.allowUnownedCatalog,historical:params.historical})))).items;
}
/** Outside RR only. Fresh source reads, then a NEW current authority/customer epoch at the end.
 * Missing/revoked previously qualified rows are errors, not silently removed from an old page. */
export async function recheckSampleCustodyBatchAuthorization(params:{currentPrisma:PrismaClient;actor:TokenPayload|null|undefined;guards:SampleCustodyGuard[]}) {
  if(!params.currentPrisma||typeof params.currentPrisma.$transaction!=='function')deny('AUTHORIZATION_UNAVAILABLE',503,'最终授权核验须使用当前主连接。');
  if(!Array.isArray(params.guards)||params.guards.some(g=>g.version!==1||g.mode!=='read'))deny('INVALID_INPUT',400,'批量最终核验只支持原服务器只读授权。');
  validateBatch(params.guards.map(g=>g.subject));
  const entries=params.guards.map(g=>({subject:g.subject,allowUnownedCatalog:g.allowUnownedCatalog,historical:g.historical}));
  const first=await readBatch(params.currentPrisma,params.actor,entries);
  for(let i=0;i<first.items.length;i++){
    const item=first.items[i];
    if(item.ok)assertSampleCustodyGuardStable(params.guards[i],item.authorization.guard);
    else unavailable();
  }
  // Never reuse first.session's permission or customer cache for the last check.
  const finalSnapshot=readSnapshot(params.currentPrisma);
  const customers=sorted([...first.session.graphs.values()].flatMap(g=>g.customers));
  await finalSnapshot.prime(customers.map(id=>({kind:'customer',id})));
  const finalSession:ReadSession={authority:await loadAuthority(finalSnapshot.db,params.actor,'read'),accesses:new Map(),graphs:new Map()};
  const result:SampleCustodyAuthorization[]=[];
  for(let i=0;i<entries.length;i++) {
    const before=first.session.graphs.get(subjectKey(entries[i].subject))!;
    const graph:Graph={...before,records:before.records.map(record=>record.kind!=='customer'?record:{...record,identity:(()=>{
      const row=finalSnapshot.row('customer',record.id);return row?Object.fromEntries(recordDefinitions.customer.fields.map(field=>[field,
        field==='salesRepIds'&&Array.isArray(row[field])?[...row[field]].sort():row[field]??null])):null;
    })()}),issues:[...before.issues]};
    if(graph.customers.some(id=>!finalSnapshot.row('customer',id)||finalSnapshot.row('customer',id).deletedAt!=null))graph.requiresAll=true;
    const current=await fromGraph({db:finalSnapshot.db,actor:params.actor,mode:'read',...entries[i]},graph,finalSession.authority,finalSession);
    assertSampleCustodyGuardStable(params.guards[i],current.guard);result.push(current);
  }
  return result;
}

/** Caller: authorize → lock this frozen graph → authorize again → assert stable → original stock operation.
 * Never acquire new discovered parents after a Card lock, and never create missing parents. */
export async function lockSampleCustodyGraph(tx: any, authorization: SampleCustodyAuthorization): Promise<void> {
  if (!tx || typeof tx.$queryRaw !== 'function' || typeof tx.$transaction === 'function')
    deny('AUTHORIZATION_UNAVAILABLE', 503, '实物父图锁须在当前写事务内取得。');
  if (digest(authorization.lockRefs) !== authorization.guard.lockRefsHash) deny('SOURCE_CHANGED', 409, '实物父图锁清单已变化。');
  for (const ref of authorization.lockRefs) {
    if (!lockOrder.includes(ref.kind)) deny('INVALID_INPUT', 400, '实物父图锁类别不可用。');
    const table = Prisma.raw(`"${lockTables[ref.kind]}"`); // Identifier comes only from the fixed internal table map.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${table} WHERE "id" = ${ref.id} FOR UPDATE`);
  }
}
export function assertSampleCustodyGuardStable(before: SampleCustodyGuard, after: SampleCustodyGuard): void {
  if (digest(before) !== digest(after)) deny('SOURCE_CHANGED', 409, '实物归属或授权已变化，请重新读取，不会追锁新父。');
}

/** Must receive the root CURRENT Prisma connection, never the old RR transaction. */
export async function recheckSampleCustodyAuthorization(params: { currentPrisma: PrismaClient; actor: TokenPayload | null | undefined; guard: SampleCustodyGuard }) {
  if (!params.currentPrisma || typeof params.currentPrisma.$transaction !== 'function')
    deny('AUTHORIZATION_UNAVAILABLE', 503, '最终授权核验须使用当前主连接，不能使用旧读取事务。');
  const result = await authorizeSampleCustody({ db: params.currentPrisma, actor: params.actor, subject: params.guard.subject, mode: params.guard.mode,
    allowUnownedCatalog: params.guard.allowUnownedCatalog, historical: params.guard.historical });
  assertSampleCustodyGuardStable(params.guard, result.guard);
  return result;
}
