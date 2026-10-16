import { createHash, randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import type { MistState, MistCommand, MistContext } from '../shared/mistWorkspace';
import { freshMistAuthority, type FreshAuthority } from './authority';
import { fail } from './errors';
import { mistApprovalAuthority } from './context';
import type { MistReviewTask } from '../shared/mistReview';
import { hasScope } from '../auth/permissionService';
import { isMember, isOwner, memberIds, members, MEMBER_PERSONAL_COMMANDS, projectState, canReadFile, canReadTarget, type MistWorkspaceAccess, type MistMemberLog } from './access';
import { payablesCommandPermissions } from '../shared/mistPayables';
import { MIST_LOCAL_PROFILES, mistLocalPublicUser } from './local';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { MistPrivateFiles, validateFileInput, type MistFileInput, type MistStoredFile } from './files';
import { prepareMistBusinessNumbers } from './businessNumbers';
import { buildIssueArchive, bindIssueArchive, prepareCreditDocumentSnapshot, assertCreditIssuePayload, assertIssuedCreditArchive, type PreparedCreditIssueArchive } from './creditPrint';
import { buildQuotationDocument, bindQuotationDocument, nextQuotationDocumentSeq, prepareQuotationDocumentSnapshot } from './quotationPrint';
import type { PdfRenderResult } from '../templates/pdf';
import { canonicalCreditDocument, creditDocumentFingerprint, creditSourceFingerprint, type MistBusinessNumberNeed, type MistCreditPrintSnapshot } from '../shared/mistCreditDocuments';
/** 演示工作区里指派给演示成员（demo-*）的审批无人能处理，不阻止移入回收站。 */
const demoOnlyReview=(task:{reviewerIds:string[]})=>task.reviewerIds.length>0&&task.reviewerIds.every(id=>id.startsWith('demo-'));
export type MistContract = {
  createMistState: (context: MistContext, seed?: 'demo' | 'empty') => MistState;
  /** 演示工作区的示例附件：按工作区数据生成可下载 PDF，创建时写入私有存储。 */
  renderDemoFile?: (state: MistState, file: MistState['files'][number]) => Uint8Array;
  applyMistCommand: (state: MistState, command: MistCommand, context: MistContext) => { state: MistState; result: Record<string, unknown> };
  mistCommandPermission: (command: MistCommand) => string | null;
  getMistReviewTasks?: (state:MistState)=>MistReviewTask[];
  normalizeMistState?: (state:MistState,context:MistContext)=>void;
  getRequiredBusinessNumberPlan?: (state: MistState, command: MistCommand) => MistBusinessNumberNeed[];
};
export type MistWorkspaceRow = { id: string; ownerId: string; slug: string; name: string; revision: number; state: MistState; createdAt: Date; updatedAt: Date };
export type MistCommandRequest = { requestId: string; expectedRevision: number; command: MistCommand };
export type MistUploadRequest = { requestId: string; expectedRevision: number; claimId?: string };
function canonical(value: any, depth = 0): string {
  if (depth > 32) fail('INVALID_INPUT', '请求嵌套层级过深', 400);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  fail('INVALID_INPUT', '请求必须是有效JSON', 400);
}
function identifier(value: unknown, label: string, maxLength = 120): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLength) fail('INVALID_INPUT', `${label}无效`, 400);
  return value;
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail('INVALID_INPUT', '工作区版本无效', 400); return Number(value); }
/** 服务端版本标记占用的请求编号前缀；客户端请求编号不得使用，避免伪造或占用版本标记。 */
const REVISION_MARKER_PREFIX = 'mist-revision:';
const REVISION_MARKER_HASH = 'mist-revision-change-keys:v1';
/** 自动合并只跨越有限个落后版本；整笔事务因并发序列化失败最多尝试有限次，不睡眠、不无界循环。 */
export const MIST_MAX_REBASE_GAP = 20;
export const MIST_MAX_SAVE_ATTEMPTS = 3;
const MAX_CHANGE_KEYS = 2000;
const RETRYABLE_TRANSACTION_CODES = ['P2034', 'P2002'];
/** PostgreSQL 可串行化失败 / 死锁：经 Prisma 普通查询报 P2034，经行锁原生查询（FOR UPDATE）报 P2010 并带原始 SQLSTATE。 */
const retryableTransaction = (error: any) => RETRYABLE_TRANSACTION_CODES.includes(error?.code) || error?.code === 'P2010' && ['40001', '40P01'].includes(error?.meta?.code);
/** 审批 / 确认 / 签发 / 放行 / 正式单据：操作人依据所见内容作出判断，版本落后时必须刷新重新确认，不自动合并。 */
const NON_REBASABLE_COMMAND = /\.(decide|confirm|issue|release|document)$/;
function requestIdentifier(value: unknown, maxLength = 120): string {
  const id = identifier(value, '请求编号', maxLength);
  if (id.startsWith(REVISION_MARKER_PREFIX)) fail('INVALID_INPUT', '请求编号无效', 400);
  return id;
}
const revisionMarker = (value: number) => `${REVISION_MARKER_PREFIX}${value}`;
function plainRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function keyedById(list: unknown[]): Map<string, unknown> | null {
  const map = new Map<string, unknown>();
  for (const item of list) { if (!plainRecord(item) || typeof item.id !== 'string' || !item.id || map.has(item.id)) return null; map.set(item.id, item); }
  return map;
}
/**
 * 本次命令实际写入的位置：对象逐字段下钻，带唯一 id 的记录数组按记录（整条记录为最小单位）比较，
 * 其余数组或值整体比较。返回 null 表示写入范围过大，无法作为安全合并依据。
 */
export function mistChangeKeys(before: unknown, after: unknown): string[][] | null {
  const out = new Map<string, string[]>();
  const add = (path: string[]) => { out.set(JSON.stringify(path), path); };
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (out.size > MAX_CHANGE_KEYS || Object.is(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const left = keyedById(a), right = keyedById(b);
      if (left && right) {
        for (const id of new Set([...left.keys(), ...right.keys()])) {
          const x = left.get(id), y = right.get(id);
          if (x === undefined || y === undefined || canonical(x) !== canonical(y)) add([...path, 'i:' + id]);
        }
        return;
      }
    } else if (plainRecord(a) && plainRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], [...path, 'k:' + key]);
      return;
    }
    if (a === undefined || b === undefined || canonical(a) !== canonical(b)) add(path);
  };
  walk(before, after, []);
  out.delete(JSON.stringify(['k:reviewerIds'])); // 由最新状态重新派生，不代表业务写入。
  return out.size > MAX_CHANGE_KEYS ? null : [...out.values()];
}
const overlapping = (a: string[], b: string[]) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return false; return true; };
function claimIdentifier(value:unknown):string { const id=identifier(value,'案件编号');if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))fail('INVALID_INPUT','案件编号无效',400);return id; }
function activeUploadClaim(state:MistState,claimId:string){
  const claim=Array.isArray(state.platform?.claims)?state.platform.claims.find(item=>item.id===claimId):undefined;
  if(!claim)fail('CLAIM_NOT_FOUND','案件不存在或不属于当前工作区',404);
  if(claim!.state==='Closed'||claim!.state==='Cancelled')fail('CLAIM_CLOSED','案件已结束，不能上传新的案件凭据',409);
}
export function publicWorkspace(row: MistWorkspaceRow) { return { id: row.id, ownerId: row.ownerId, name: row.name, revision: row.revision, state: row.state }; }
const archived=(row:MistWorkspaceRow)=>!!row.state.workspaceArchive;
const localMode=(actor:TokenPayload)=>(actor as any).mistLocal===true&&process.env.MIST_LOCAL_WORKSPACE==='1'&&process.env.NODE_ENV!=='production';
export class MistRepository {
  constructor(private readonly prisma: any, private readonly contract: MistContract, private readonly files: MistPrivateFiles, private readonly authorize: FreshAuthority = freshMistAuthority, private readonly now = () => new Date(), private readonly creditArchiveBuilder: (snapshot: MistCreditPrintSnapshot, options?: {draft?: boolean}) => Promise<PreparedCreditIssueArchive> = buildIssueArchive, private readonly quotationPdfRenderer?: (html: string) => Promise<PdfRenderResult>) {}
  private context(actor: TokenPayload): MistContext { return { id: randomUUID, now: this.now().toISOString(), actorName: actor.displayName || actor.userId, actorId:actor.userId }; }
  private async authorizeCompoundCommand(db: any, prior: TokenPayload, command?: MistCommand) {
    if (command?.type.startsWith('payable.')) for (const scope of payablesCommandPermissions(command as any).slice(1)) await this.authorize(db, prior, scope);
  }
  /** 所有者或被所有者明确授权的成员可进入；ownerOnly 的动作（回收站、成员管理）只限所有者。 */
  private async own(db: any, prior: TokenPayload, id: string, permission?: string | null, lock = false, allowArchived = false, ownerOnly = false): Promise<{ actor: TokenPayload; row: MistWorkspaceRow }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail('INVALID_INPUT', '工作区编号无效', 400);
    const actor = await this.authorize(db, prior, permission);
    if (lock) await db.$queryRawUnsafe('SELECT "id" FROM "MistWorkspace" WHERE "id" = $1::uuid FOR UPDATE', id);
    const row = await db.mistWorkspace.findFirst({ where: { id } });
    if (!row || !(isOwner(row, actor) || (!ownerOnly && isMember(row, actor)))) fail('NOT_FOUND', '工作区不存在或当前账号无权访问', 404);
    if(archived(row)&&!allowArchived)fail('NOT_FOUND','工作区已移入回收站，请先恢复',404);
    this.contract.normalizeMistState?.(row.state,this.context(actor));
    return { actor, row };
  }
  private transact<T>(run: (db: any) => Promise<T>): Promise<T> { return this.prisma.$transaction(run, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 30000 }); }
  private emptyState(actor: TokenPayload) { return () => { const context = this.context(actor), state = this.contract.createMistState(context, 'empty'); this.contract.normalizeMistState?.(state, context); return state; }; }
  /** 返回给当前账号的工作空间：按其现有读权限裁剪，并附带访问说明。 */
  private view(row: MistWorkspaceRow, actor: TokenPayload) {
    const projected = projectState(row.state, actor, this.emptyState(actor), row.ownerId), owner = isOwner(row, actor);
    const access: MistWorkspaceAccess = { role: owner ? 'owner' : 'member', canManageMembers: owner, hidden: projected.hidden.map(s => ({ key: s.key, label: s.label, permissions: [...s.permissions] })) };
    return { ...publicWorkspace({ ...row, state: projected.state }), access };
  }
  async list(prior: TokenPayload) { return this.transact(async db => { const actor = await this.authorize(db, prior); const rows = await db.mistWorkspace.findMany({ where: { OR: [{ ownerId: actor.userId }, { state: { path: ['memberIds'], array_contains: [actor.userId] } }] }, orderBy: { updatedAt: 'desc' } }); return rows.filter((row:MistWorkspaceRow)=>!archived(row)&&(isOwner(row,actor)||isMember(row,actor))).map((row:MistWorkspaceRow)=>{this.contract.normalizeMistState?.(row.state,this.context(actor));return this.view(row,actor);}); }); }
  async listArchived(prior:TokenPayload){return this.transact(async db=>{const actor=await this.authorize(db,prior);const rows: MistWorkspaceRow[]=await db.mistWorkspace.findMany({where:{ownerId:actor.userId},orderBy:{updatedAt:'desc'}});return rows.filter(archived).map(row=>({id:row.id,name:row.name,revision:row.revision,archivedAt:row.state.workspaceArchive!.at}));});}
  private async activeWorkspace(db:any,actor:TokenPayload,preferredId?:string){const rows:MistWorkspaceRow[]=await db.mistWorkspace.findMany({where:{ownerId:actor.userId},orderBy:{updatedAt:'desc'}});const active=rows.filter(row=>!archived(row));const existing=active.find(row=>row.id===preferredId)??active[0];if(existing){this.contract.normalizeMistState?.(existing.state,this.context(actor));return existing;}const context=this.context(actor),state=this.contract.createMistState(context,'empty');state.settings.workspaceName='新的工作空间';return db.mistWorkspace.create({data:{id:randomUUID(),ownerId:actor.userId,slug:'continuation-'+randomUUID(),name:state.settings.workspaceName,revision:0,state}});}
  async changeArchive(prior:TokenPayload,workspaceId:string,input:{requestId:string;expectedRevision:number},action:'archive'|'restore'){
    requestIdentifier(input.requestId);revision(input.expectedRevision);const hash=createHash('sha256').update(canonical({actorId:prior.userId,action,expectedRevision:input.expectedRevision})).digest('hex');
    return this.transact(async db=>{const{actor,row}=await this.own(db,prior,workspaceId,null,true,true,true);const previous=await db.mistCommandReceipt.findUnique({where:{workspaceId_requestId:{workspaceId,requestId:input.requestId}}});
      if(previous){if(previous.actorId!==actor.userId||previous.inputHash!==hash)fail('REQUEST_CONFLICT','请求编号已用于另一项操作',409);const active=await this.activeWorkspace(db,actor,previous.result.result.activeWorkspaceId);return{workspace:this.view(active,actor),receipt:{requestId:previous.requestId,...previous.result},replayed:true};}
      if(row.revision!==input.expectedRevision)fail('REVISION_CONFLICT','工作区已更新，请刷新后重试',409);
      if(action==='archive'&&archived(row)||action==='restore'&&!archived(row))fail('WORKSPACE_STATE_CONFLICT',action==='archive'?'工作区已在回收站':'工作区已恢复',409);
      if(action==='archive'&&this.reviews(row.state).some(task=>task.status==='pending'&&!demoOnlyReview(task)))fail('PENDING_REVIEWS','请先处理或撤销工作区中的待审批事项，再移入回收站',409);
      const state=structuredClone(row.state),context=this.context(actor);if(action==='archive')state.workspaceArchive={at:context.now,actorId:actor.userId};else delete state.workspaceArchive;
      if(Array.isArray(state.events))state.events.unshift({id:context.id(),entityType:'workspace',entityId:row.id,actor:context.actorName,at:context.now,text:action==='archive'?'工作空间移入回收站':'工作空间从回收站恢复',fileIds:[]});
      const saved=await db.mistWorkspace.update({where:{id:row.id},data:{state,revision:row.revision+1}});const active=action==='restore'?saved:await this.activeWorkspace(db,actor);
      const result={revision:saved.revision,result:{workspaceId:row.id,action,activeWorkspaceId:active.id}};await db.mistCommandReceipt.create({data:{id:randomUUID(),workspaceId:row.id,requestId:input.requestId,actorId:actor.userId,inputHash:hash,expectedRevision:input.expectedRevision,result}});await this.authorize(db,prior);
      return{workspace:this.view(active,actor),receipt:{requestId:input.requestId,...result},replayed:false};
    });
  }
  /** 所有者明确授权/撤销其他账号进入本空间；只记录访问，不授予任何业务权限，历史保留。 */
  async changeMember(prior:TokenPayload,workspaceId:string,input:{requestId:string;expectedRevision:number;action:'add'|'remove';account:string}){
    requestIdentifier(input.requestId);revision(input.expectedRevision);const account=identifier(input.account,'账号',200);
    if(!['add','remove'].includes(input.action))fail('INVALID_INPUT','请选择授权或撤销',400);
    const hash=createHash('sha256').update(canonical({actorId:prior.userId,type:'workspace.member',action:input.action,account,expectedRevision:input.expectedRevision})).digest('hex');
    return this.transact(async db=>{
      const{actor,row}=await this.own(db,prior,workspaceId,null,true,false,true);
      const previous=await db.mistCommandReceipt.findUnique({where:{workspaceId_requestId:{workspaceId,requestId:input.requestId}}});
      if(previous){if(previous.actorId!==actor.userId||previous.inputHash!==hash)fail('REQUEST_CONFLICT','请求编号已用于另一项操作',409);return{workspace:this.view(row,actor),receipt:{requestId:previous.requestId,...previous.result},replayed:true};}
      if(row.revision!==input.expectedRevision)fail('REVISION_CONFLICT','工作区已更新，请刷新后重试',409);
      let target:{id:string;name:string};
      const existingMember=input.action==='remove'?members(row.state).find(m=>m.userId===account):undefined;
      if(existingMember)target={id:existingMember.userId,name:existingMember.name};
      else if(localMode(actor)){const profile=MIST_LOCAL_PROFILES.find(p=>p.id===account);if(!profile)fail('ACCOUNT_NOT_FOUND','没有找到这个本地账号',404);target={id:profile!.id,name:profile!.name};}
      else{const user=await db.userAccount.findFirst({where:{OR:[{id:account},{email:account}],...(input.action==='add'?{deletedAt:null}:{})}});if(!user||input.action==='add'&&user.status!=='active')fail('ACCOUNT_NOT_FOUND','没有找到可用的员工账号',404);target={id:user.id,name:user.displayName||user.id};}
      if(target!.id===row.ownerId)fail('INVALID_INPUT','所有者本来就能进入此空间',400);
      const state:any=structuredClone(row.state),context=this.context(actor),ids=memberIds(state),list=members(state);
      if(input.action==='add'){if(ids.includes(target!.id))fail('MEMBER_EXISTS','该账号已被授权',409);state.memberIds=[...ids,target!.id];state.members=[...list,{userId:target!.id,name:target!.name,addedBy:actor.userId,addedByName:context.actorName,addedAt:context.now}];}
      else{if(!ids.includes(target!.id))fail('MEMBER_NOT_FOUND','该账号当前没有被授权',409);state.memberIds=ids.filter(id=>id!==target!.id);state.members=list.filter(m=>m.userId!==target!.id);}
      const log:MistMemberLog={id:context.id(),action:input.action,userId:target!.id,name:target!.name,actorId:actor.userId,actorName:context.actorName,at:context.now};
      state.memberLog=[log,...(Array.isArray(state.memberLog)?state.memberLog:[])];
      state.events.unshift({id:context.id(),entityType:'workspace',entityId:row.id,actor:context.actorName,at:context.now,text:(input.action==='add'?'授权账号进入工作空间：':'撤销账号的工作空间访问：')+target!.name,fileIds:[]});
      const saved=await db.mistWorkspace.update({where:{id:row.id},data:{state,revision:row.revision+1}});
      const result={revision:saved.revision,result:{workspaceId:row.id,action:input.action,userId:target!.id}};
      await db.mistCommandReceipt.create({data:{id:randomUUID(),workspaceId:row.id,requestId:input.requestId,actorId:actor.userId,inputHash:hash,expectedRevision:input.expectedRevision,result}});
      await this.authorize(db,prior);
      return{workspace:this.view(saved,actor),receipt:{requestId:input.requestId,...result},replayed:false};
    });
  }
  async get(prior: TokenPayload, id: string) { return this.transact(async db => { const { actor, row } = await this.own(db, prior, id); return this.view(row, actor); }); }
  /** 当前真实执行者（事务内重新加载账号与授权，保留会话自身的权限上限）。 */
  async currentActor(prior:TokenPayload,permission?:string|null){return this.transact(db=>this.authorize(db,prior,permission));}
  /** 工作助手读取：与 get 相同的进入与投影规则，同时返回重新加载后的执行者供逐类型复核。 */
  async getForAgent(prior:TokenPayload,id:string){return this.transact(async db=>{const {row,actor}=await this.own(db,prior,id);return {workspace:this.view(row,actor),actor};});}
  async getForAssistant(prior:TokenPayload,id:string){return this.transact(async db=>{const {row,actor}=await this.own(db,prior,id,'ai:chat');return {workspace:this.view(row,actor),actor};});}

  async create(prior: TokenPayload, input: { name: string; slug?: string; seed?: 'demo' | 'empty' }, defaultOnly = false) {
    const name = identifier(input.name, '工作区名称'), slug = defaultOnly ? 'default' : identifier(input.slug || randomUUID(), '工作区标识');
    if (input.seed !== undefined && !['demo', 'empty'].includes(input.seed)) fail('INVALID_INPUT', '工作区初始方式无效', 400);
    const seed = input.seed ?? 'demo', requestId = `create:${slug}`;
    const inputHash = createHash('sha256').update(canonical({ type: 'workspace.create', actorId: prior.userId, name, seed })).digest('hex');
    const create = () => this.transact(async db => {
      const actor = await this.authorize(db, prior);
      const found = await db.mistWorkspace.findUnique({ where: { ownerId_slug: { ownerId: actor.userId, slug } } });
      if (found) {
        if(archived(found)){if(defaultOnly)return this.view(await this.activeWorkspace(db,actor),actor);fail('WORKSPACE_ARCHIVED','\u5de5\u4f5c\u533a\u5df2\u5728\u56de\u6536\u7ad9\uff0c\u8bf7\u5148\u6062\u590d',409);}
        if (defaultOnly) {this.contract.normalizeMistState?.(found.state,this.context(actor));return this.view(found,actor);}
        const previous = await db.mistCommandReceipt.findUnique({ where: { workspaceId_requestId: { workspaceId: found.id, requestId } } });
        if (!previous || previous.actorId !== actor.userId || previous.inputHash !== inputHash || previous.expectedRevision !== 0) fail('REQUEST_CONFLICT', '此创建请求已用于不同的工作区参数', 409);
        await this.authorize(db, prior);
        this.contract.normalizeMistState?.(found.state,this.context(actor));return this.view(found,actor);
      }
      if (defaultOnly) {
        // A default lookup selects an existing active workspace before creating
        // anything. Named workspaces and archive continuations need not own the
        // reserved default slug, and must not be replaced with another seed.
        const rows: MistWorkspaceRow[] = await db.mistWorkspace.findMany({ where: { ownerId: actor.userId }, orderBy: { updatedAt: 'desc' } });
        const active = rows.find(row => !archived(row));
        if (active) {
          this.contract.normalizeMistState?.(active.state, this.context(actor));
          return this.view(active, actor);
        }
      }
      const state = this.contract.createMistState(this.context(actor), seed), workspaceId = randomUUID();
      state.settings.workspaceName = name;
      await this.writeDemoFiles(workspaceId, state);
      const row = await db.mistWorkspace.create({ data: { id: workspaceId, ownerId: actor.userId, slug, name, revision: 0, state } });
      if (!defaultOnly) await db.mistCommandReceipt.create({ data: { id: randomUUID(), workspaceId: row.id, requestId, actorId: actor.userId, inputHash, expectedRevision: 0, result: { revision: 0, result: { workspaceId: row.id } } } });
      await this.authorize(db, prior);
      return this.view(row, actor);
    });
    try { return await create(); } catch (error: any) {
      if (defaultOnly && ['P2002', 'P2034'].includes(error?.code)) return create();
      // The competing transaction may already have committed this creation.
      // A fresh serializable read must verify its durable input before replay.
      if (['P2002', 'P2034'].includes(error?.code)) return create();
      throw error;
    }
  }
  async receipt(prior: TokenPayload, workspaceId: string, requestId: string) { return this.transact(async db => {
    await this.own(db, prior, workspaceId,null,false,true);
    const receipt = await db.mistCommandReceipt.findUnique({ where: { workspaceId_requestId: { workspaceId, requestId: requestIdentifier(requestId, typeof requestId === 'string' && requestId.startsWith('create:') ? 127 : 120) } } });
    if (!receipt || receipt.actorId !== prior.userId) fail('NOT_FOUND', '请求回执不存在', 404);
    return { requestId: receipt.requestId, ...receipt.result };
  }); }
  async execute(prior: TokenPayload, workspaceId: string, input: MistCommandRequest) {
    if (!input.command || typeof input.command.type !== 'string' || !input.command.payload || typeof input.command.payload !== 'object' || Array.isArray(input.command.payload)) fail('INVALID_COMMAND', '业务命令格式无效', 400);
    if (input.command.type === 'files.add') fail('INVALID_COMMAND', '附件只能通过真实上传接口添加', 400);
    return this.executeInternal(prior, workspaceId, input, { command: input.command });
  }
  private async executeInternal(prior: TokenPayload, workspaceId: string, input: Omit<MistCommandRequest, 'command'> & { command?: any; claimId?: string }, hashPayload: any, upload?: MistFileInput) {
    requestIdentifier(input.requestId); revision(input.expectedRevision);
    const hash = createHash('sha256').update(canonical({ actorId: prior.userId, expectedRevision: input.expectedRevision, ...hashPayload })).digest('hex');
    const permissionFor = () => upload&&input.claimId!==undefined?'aftersales:write':this.contract.mistCommandPermission(input.command ?? { type: 'files.add', payload: {} });
    // 每次尝试都是一笔全新事务：重新读取最新状态并重新核验账号、成员、权限与业务门禁；不复用旧整份状态。
    for (let attempt = 1; ; attempt++) {
      let stored: MistStoredFile | undefined;
      try { return await this.transact(async db => {
        const permission = permissionFor();
        const { actor, row } = await this.own(db, prior, workspaceId, permission, true);
        await this.authorizeCompoundCommand(db, prior, input.command);
        if (!isOwner(row, actor) && permission === null && !MEMBER_PERSONAL_COMMANDS.includes(input.command?.type)) fail('FORBIDDEN', '工作空间设置只能由所有者修改', 403);
        const previous = await db.mistCommandReceipt.findUnique({ where: { workspaceId_requestId: { workspaceId, requestId: input.requestId } } });
        if (previous) {
          if (previous.actorId !== actor.userId || previous.inputHash !== hash || previous.expectedRevision !== input.expectedRevision) fail('REQUEST_CONFLICT', '此请求编号已用于另一项操作', 409);
          return { workspace: this.view(row, actor), receipt: { requestId: previous.requestId, ...previous.result }, replayed: true };
        }
        // 版本落后时只在能证明安全时把本命令重新应用到最新状态；否则照旧明确拒绝。
        const concurrent = row.revision === input.expectedRevision ? undefined : await this.concurrentChanges(db, workspaceId, row.revision, input.expectedRevision, upload ? 'files.add' : input.command?.type);
        if(upload&&input.claimId!==undefined)activeUploadClaim(row.state,input.claimId);
        const context = this.context(actor);
        if (MEMBER_PERSONAL_COMMANDS.includes(input.command?.type)) {
          const visible = projectState(row.state, actor, this.emptyState(actor), row.ownerId).state;
          const { type, payload } = input.command;
          const collection = type === 'notification.read' ? visible.notifications : type === 'task.complete' ? visible.tasks : type === 'calendar.save' && payload.id ? visible.calendar : undefined;
          if (collection && !collection.some(item => item.id === payload.id)) fail('NOT_FOUND', '记录不存在或当前账号无权访问', 404);
          if (type === 'calendar.save' && !canReadTarget(actor, payload.target)) fail('FORBIDDEN', '无权关联该业务来源', 403);
          if (type === 'notification.readAll') context.visibleNotificationIds = visible.notifications.map(item => item.id);
        }
        if(input.command) context.authority = await mistApprovalAuthority(db,actor,input.command.type);
        const plan = input.command ? this.contract.getRequiredBusinessNumberPlan?.(row.state, input.command) ?? [] : [];
        const numbers = await prepareMistBusinessNumbers(db, row.state, plan, context.now);
        context.consumeBusinessNumber = prefix => numbers.consume(prefix);
        if (upload) stored = { ...await this.files.write(workspaceId, upload, context.now), uploadedBy: actor.userId };
        if (input.command?.type === 'platform.credit.issue') {
          const payload = assertCreditIssuePayload(input.command.payload);
          const credit = row.state.platform.credits.find(note => note.id === payload.creditId);
          if (credit?.printVersions?.some(version => version.sourceVersionId === payload.versionId)) fail('CREDIT_ALREADY_ISSUED', '该来源版本已签发，请读取已归档的正式原件', 409);
          const printSnapshot = prepareCreditDocumentSnapshot(row.state, payload.creditId, payload.versionId, context);
          const prepared = await this.creditArchiveBuilder(printSnapshot);
          stored = await this.files.write(workspaceId, prepared.file, context.now);
          context.creditDocumentIssue = bindIssueArchive(prepared, stored, { id: context.id, workspaceId, requestId: input.requestId });
        }
        if (input.command?.type === 'market.quotation.document') {
          const snapshot = prepareQuotationDocumentSnapshot(row.state, input.command.payload || {}, context);
          const prepared = await buildQuotationDocument(snapshot, nextQuotationDocumentSeq(row.state, snapshot.quotationId), { renderPdf: this.quotationPdfRenderer });
          stored = await this.files.write(workspaceId, prepared.file, context.now);
          (context as typeof context & { quotationDocument?: unknown }).quotationDocument = bindQuotationDocument(prepared, stored, { id: context.id, workspaceId, requestId: input.requestId });
        }
        const command = upload ? { type: 'files.add', payload: { file: stored } } : input.command;
        const applied = this.contract.applyMistCommand(structuredClone(row.state), command, context);
        numbers.assertConsumed();
        if(upload&&input.claimId!==undefined)applied.result={...applied.result,claimId:input.claimId};
        if(this.contract.getMistReviewTasks)(applied.state as any).reviewerIds=[...new Set(this.contract.getMistReviewTasks(applied.state).flatMap(t=>t.reviewerIds))];
        canonical(applied.state); canonical(applied.result);
        const changeKeys = mistChangeKeys(row.state, applied.state);
        if (concurrent) {
          if (!changeKeys) fail('REVISION_CONFLICT', '工作区已被他人更新，本次修改范围过大无法自动合并，请刷新后重试', 409);
          if (changeKeys!.some(key => concurrent.some(other => overlapping(key, other)))) fail('REVISION_CONFLICT', '其他人已修改同一记录，为避免覆盖对方的更新未自动合并，请刷新核对后重试', 409);
        }
        const nextRevision = row.revision + 1;
        const saved = await db.mistWorkspace.update({ where: { id: workspaceId }, data: { state: applied.state, name: identifier(applied.state.settings.workspaceName, '工作区名称'), revision: nextRevision } });
        const result = { revision: nextRevision, result: applied.result };
        await db.mistCommandReceipt.create({ data: { id: randomUUID(), workspaceId, requestId: input.requestId, actorId: actor.userId, inputHash: hash, expectedRevision: input.expectedRevision, result } });
        // 同事务记下本版本写入的位置，供之后落后版本的保存判断能否安全合并；原请求回执保持原样。
        await db.mistCommandReceipt.create({ data: { id: randomUUID(), workspaceId, requestId: revisionMarker(nextRevision), actorId: actor.userId, inputHash: REVISION_MARKER_HASH, expectedRevision: row.revision, result: { revision: nextRevision, keys: changeKeys } } });
        await this.authorize(db, prior, permission);
        await this.authorizeCompoundCommand(db, prior, input.command);
        return { workspace: this.view(saved, actor), receipt: { requestId: input.requestId, ...result }, replayed: false };
      }); } catch (error: any) {
        let blobSettled = true;
        if (stored) {
          blobSettled = false;
          // A competing copy can own this request receipt while referencing a
          // different file. Check the durable workspace before retaining this
          // attempt's blob; never delete a committed attachment or guess after
          // an unavailable/unknown commit result.
          try {
            const receipt = await this.prisma.mistCommandReceipt.findUnique({ where: { workspaceId_requestId: { workspaceId, requestId: input.requestId } } });
            const durable = receipt && retryableTransaction(error)
              ? await this.transact(db => db.mistWorkspace.findFirst({ where: { id: workspaceId } })) as MistWorkspaceRow | null
              : null;
            if (!receipt || durable && Array.isArray(durable.state.files) && !durable.state.files.some(file => file.id === stored!.id)) {
              await this.files.remove(workspaceId, stored); blobSettled = true;
            }
          } catch { /* Do not delete a potentially committed attachment. */ }
        }
        if (!retryableTransaction(error)) throw error;
        // A competing copy of this same request may have committed while this
        // serializable transaction rolled back. Resolve its durable receipt.
        const replay = await this.transact(async db => {
          const { row, actor } = await this.own(db, prior, workspaceId, permissionFor());
          await this.authorizeCompoundCommand(db, prior, input.command);
          const receipt = await db.mistCommandReceipt.findUnique({ where: { workspaceId_requestId: { workspaceId, requestId: input.requestId } } });
          if (!receipt) return undefined;
          if (receipt.actorId !== prior.userId || receipt.inputHash !== hash) fail('REQUEST_CONFLICT', '此请求编号已用于另一项操作', 409);
          return { workspace: this.view(row, actor), receipt: { requestId: receipt.requestId, ...receipt.result }, replayed: true };
        });
        if (replay) return replay;
        // 文件副作用无法确认已清理时不再重试，避免重复生成或残留。
        if (!blobSettled) fail('REVISION_CONFLICT', '工作区并发更新，请核对原请求回执后重试', 409);
        if (attempt >= MIST_MAX_SAVE_ATTEMPTS) fail('REVISION_CONFLICT', `多人同时保存发生冲突，已自动重试${MIST_MAX_SAVE_ATTEMPTS}次仍未成功，请刷新后重试`, 409);
      }
    }
  }
  /** 收集从客户端所见版本到最新版本之间每个版本的写入位置；任何一个版本无法证明时拒绝自动合并。 */
  private async concurrentChanges(db: any, workspaceId: string, current: number, expected: number, type: string | undefined): Promise<string[][]> {
    const refuse = (message: string): never => fail('REVISION_CONFLICT', message, 409);
    if (expected > current) refuse('工作区版本无效，请刷新后重试');
    if (!type || NON_REBASABLE_COMMAND.test(type) || type === 'development.notice.generate') refuse('工作区已被他人更新，此操作需基于最新内容重新确认，请刷新后重试');
    if (current - expected > MIST_MAX_REBASE_GAP) refuse('工作区已有较多更新，无法自动合并，请刷新后重试');
    const keys: string[][] = [];
    for (let value = expected + 1; value <= current; value++) {
      const marker = await db.mistCommandReceipt.findUnique({ where: { workspaceId_requestId: { workspaceId, requestId: revisionMarker(value) } } });
      const recorded = marker?.inputHash === REVISION_MARKER_HASH && marker.result?.revision === value && Array.isArray(marker.result.keys) && marker.result.keys.every((key: unknown) => Array.isArray(key) && key.every(part => typeof part === 'string')) ? marker.result.keys as string[][] : null;
      if (!recorded) refuse('工作区已被他人更新，无法确认本次修改可安全合并，请刷新后重试');
      keys.push(...recorded!);
    }
    return keys;
  }
  /** 演示种子里的附件只有占位记录；这里生成真实 PDF 并改写为工作区私有存储路径。 */
  private async writeDemoFiles(workspaceId: string, state: MistState) {
    const render = this.contract.renderDemoFile;
    if (!render) return;
    for (const file of state.files) {
      if (!file.storageKey.startsWith('demo-seed/')) continue;
      const stored = await this.files.writeWithId(workspaceId, file.id, { bytes: Buffer.from(render(state, file)), name: file.name, mimeType: file.mimeType }, file.createdAt);
      file.size = stored.size; file.storageKey = stored.storageKey;
    }
  }
  private reviews(state:MistState):MistReviewTask[]{return this.contract.getMistReviewTasks?.(state)||[];}
  async listReviews(prior:TokenPayload){return this.transact(async db=>{
    const actor=await this.authorize(db,prior);
    const rows=await db.mistWorkspace.findMany({where:{OR:[{ownerId:actor.userId},{state:{path:['reviewerIds'],array_contains:[actor.userId]}}]},orderBy:{updatedAt:'desc'},take:200});
    return rows.filter((row:MistWorkspaceRow)=>!archived(row)).flatMap((row:MistWorkspaceRow)=>this.reviews(row.state).filter(t=>row.ownerId===actor.userId||(t.reviewerIds.includes(actor.userId)&&hasScope(actor,t.requiredPermission as any))).map(t=>({workspaceId:row.id,workspaceName:row.name,revision:row.revision,canDecide:t.status==='pending'&&t.reviewerIds.includes(actor.userId)&&hasScope(actor,t.requiredPermission as any),files:(t.fileIds||[]).flatMap(id=>{const file=row.state.files.find(f=>f.id===id);return file?[{id:file.id,name:file.name,size:file.size}]:[];}),...t})));
  });}
  async reviewFile(prior:TokenPayload,workspaceId:string,reviewId:string,fileId:string){return this.transact(async db=>{
    const actor=await this.authorize(db,prior),row=await db.mistWorkspace.findFirst({where:{id:workspaceId}});
    if(!row||archived(row))fail('NOT_FOUND','审批不存在',404);
    const task=this.reviews(row.state).find(t=>t.id===reviewId);
    if(!task||(row.ownerId!==actor.userId&&(!task.reviewerIds.includes(actor.userId)||!hasScope(actor,task.requiredPermission as any))))fail('NOT_FOUND','该审批不属于当前账号',404);
    if(!(task.fileIds||[]).includes(fileId))fail('FILE_NOT_FOUND','附件不在提交的审批快照中',404);
    const file=row.state.files.find((f:MistStoredFile)=>f.id===fileId);if(!file)fail('FILE_NOT_FOUND','附件不存在',404);
    const bytes=await this.files.read(workspaceId,file);await this.authorize(db,prior);return {file,bytes};
  });}
  async reviewReceipt(prior:TokenPayload,workspaceId:string,requestId:string){return this.transact(async db=>{
    const actor=await this.authorize(db,prior);requestIdentifier(requestId);
    const item=await db.mistCommandReceipt.findUnique({where:{workspaceId_requestId:{workspaceId,requestId}}});
    if(!item||item.actorId!==actor.userId)fail('NOT_FOUND','原审批回执不存在',404);
    return {requestId:item.requestId,...item.result};
  });}
  async decideReview(prior:TokenPayload,workspaceId:string,reviewId:string,input:{requestId:string;expectedRevision:number;decision:'approved'|'rejected';note:string}){
    if(!/^[0-9a-f-]{36}$/i.test(workspaceId))fail('INVALID_INPUT','工作区编号无效',400);
    requestIdentifier(input.requestId);revision(input.expectedRevision);identifier(reviewId,'审批编号');
    if(!['approved','rejected'].includes(input.decision)||typeof input.note!=='string'||!input.note.trim()||input.note.length>4000)fail('INVALID_INPUT','请选择审批结论并填写意见',400);
    const hash=createHash('sha256').update(canonical({actorId:prior.userId,reviewId,...input})).digest('hex');
    return this.transact(async db=>{
      const actor=await this.authorize(db,prior);
      await db.$queryRawUnsafe('SELECT "id" FROM "MistWorkspace" WHERE "id" = $1::uuid FOR UPDATE',workspaceId);
      const row=await db.mistWorkspace.findFirst({where:{id:workspaceId}});if(!row||archived(row))fail('NOT_FOUND','审批对象不存在',404);
      const previous=await db.mistCommandReceipt.findUnique({where:{workspaceId_requestId:{workspaceId,requestId:input.requestId}}});
      if(previous){if(previous.actorId!==actor.userId||previous.inputHash!==hash)fail('REQUEST_CONFLICT','原请求编号用于另一项决定',409);return {receipt:{requestId:previous.requestId,...previous.result},replayed:true};}
      const task=this.reviews(row.state).find(t=>t.id===reviewId);
      if(!task||!task.reviewerIds.includes(actor.userId))fail('NOT_FOUND','该审批不属于当前账号',404);
      await this.authorize(db,prior,task.requiredPermission);
      if(task.status!=='pending')fail('REVIEW_RESOLVED','审批已处理，请刷新记录',409);
      if(row.revision!==input.expectedRevision)fail('REVISION_CONFLICT','业务记录已有更新，请刷新审批并重新核对',409);
      let subject:TokenPayload;
      if((actor as any).mistLocal===true && process.env.MIST_LOCAL_WORKSPACE==='1' && process.env.NODE_ENV!=='production'){
        if(!MIST_LOCAL_PROFILES.some(p=>p.id===task.requesterId))fail('REQUESTER_UNAVAILABLE','本地申请身份无效',409);
        const requester=mistLocalPublicUser(task.requesterId);subject={...requester,userId:requester.id,mistLocal:true} as unknown as TokenPayload;
      }else{const requester=await loadUserWithRoles(db,task.requesterId);if(!requester||requester.status!=='active'||requester.deletedAt)fail('REQUESTER_UNAVAILABLE','申请账号当前不可核验，请联系管理员',409);subject=await buildLoadedAuthTokenPayload(db,requester);}
      const type=task.kind==='procurement'?'fulfillment.procurement.decide':task.kind==='quotation'?'market.quotation.decide':task.kind==='order'?'order.governance.decide':task.kind==='payment'?'payable.request.decide':'platform.claim.decide';
      const command={type,payload:{id:task.entityId,decision:input.decision,note:input.note}} as MistCommand;
      const context=this.context(actor);context.authority=await mistApprovalAuthority(db,subject,type);
      const applied=this.contract.applyMistCommand(structuredClone(row.state),command,context);
      (applied.state as any).reviewerIds=[...new Set(this.reviews(applied.state).flatMap(t=>t.reviewerIds))];
      canonical(applied.state);canonical(applied.result);
      const next=await db.mistWorkspace.update({where:{id:workspaceId},data:{state:applied.state,revision:{increment:1}}});
      const result={revision:next.revision,result:{...applied.result,reviewId}};
      await db.mistCommandReceipt.create({data:{id:randomUUID(),workspaceId,requestId:input.requestId,actorId:actor.userId,inputHash:hash,expectedRevision:input.expectedRevision,result}});
      await this.authorize(db,prior,task.requiredPermission);
      return {receipt:{requestId:input.requestId,...result},replayed:false};
    });
  }
  async upload(prior: TokenPayload, workspaceId: string, input: MistUploadRequest, file: MistFileInput) {
    const claimId=input.claimId===undefined?undefined:claimIdentifier(input.claimId);
    const meta = validateFileInput(file);
    return this.executeInternal(prior, workspaceId, {...input,claimId}, { upload: meta,...(claimId===undefined?{}:{claimId}) }, file);
  }
  async download(prior: TokenPayload, workspaceId: string, fileId: string) {
    const result = await this.transact(async db => {
      const { row, actor } = await this.own(db, prior, workspaceId);
      const file = Array.isArray(row.state.files) ? row.state.files.find((item: MistStoredFile) => item.id === fileId) : null;
      if (!file || !canReadFile(row.state, actor, fileId, this.emptyState(actor), row.ownerId)) fail('FILE_NOT_FOUND', '附件不存在或不属于此工作区', 404);
      const bytes = await this.files.read(workspaceId, file);
      await this.authorize(db, prior);
      return { file, bytes };
    });
    return result;
  }
  async previewCreditDocument(prior: TokenPayload, workspaceId: string, creditId: string, versionId: string) {
    identifier(creditId, '贷项编号'); identifier(versionId, '来源版本编号');
    return this.transact(async db => {
      const { actor, row } = await this.own(db, prior, workspaceId, 'aftersales:read');
      const snapshot = prepareCreditDocumentSnapshot(row.state, creditId, versionId, this.context(actor));
      const prepared = await this.creditArchiveBuilder(snapshot, { draft: true });
      await this.authorize(db, prior, 'aftersales:read');
      return { name: prepared.file.name, bytes: Buffer.from(prepared.file.bytes), sha256: prepared.sha256 };
    });
  }
  async downloadCreditDocument(prior: TokenPayload, workspaceId: string, creditId: string, versionId: string) {
    identifier(creditId, '贷项编号'); identifier(versionId, '已签版本编号');
    return this.transact(async db => {
      const { row } = await this.own(db, prior, workspaceId, 'aftersales:read');
      const credit = row.state.platform.credits.find(note => note.id === creditId);
      const version = credit?.printVersions?.find(item => item.id === versionId);
      const source = version && credit?.sourceVersions?.find(item => item.id === version.sourceVersionId);
      if (!credit || !version || !source) fail('CREDIT_DOCUMENT_NOT_FOUND', '该贷项没有所选已签发版本', 404);
      if (version!.snapshot.creditId !== credit!.id || version!.snapshot.sourceVersionId !== source!.id || version!.sourceFingerprint !== creditSourceFingerprint(source!) || version!.snapshotFingerprint !== creditDocumentFingerprint(version!.snapshot) || canonicalCreditDocument(version!.snapshot.sourceLines) !== canonicalCreditDocument(source!.lines)) fail('CREDIT_DOCUMENT_INVALID', '正式CN版本及冻结来源不一致', 422);
      const file = row.state.files.find(item => item.id === version!.fileId);
      if (!file || file.name !== version!.fileName || file.mimeType !== 'application/pdf' || file.size !== version!.bytes) fail('CREDIT_DOCUMENT_INVALID', '正式CN缺少匹配原件', 422);
      const bytes = assertIssuedCreditArchive(version!, await this.files.read(workspaceId, file));
      await this.authorize(db, prior, 'aftersales:read');
      return { name: version!.fileName, bytes, sha256: version!.sha256 };
    });
  }
}
