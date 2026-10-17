import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Request,Response,RequestHandler} from 'express';
import type {TokenPayload} from '../auth/service';
import type {FreshAuthority} from './authority';
import {MistApiError} from './errors';
import {hasScope} from '../auth/permissionService';
import {getDefaultScopeListForRole,SYSTEM_ROLE_IDS} from '../_shared/rolePermissionMatrix';
import {createAgentDelegation} from './agentDelegation';

const COOKIE='bambook_mist_local';
const SESSION_LIFETIME=7*24*60*60*1000;
const DEFAULT_DIRECTORY=path.resolve(__dirname,'../../private/mist-local');
type LocalBusinessSequence={id:string;prefix:string;year:number;seq:number;updatedAt:string};
type LocalStore={schemaVersion:1;workspaces:Record<string,any>;receipts:Record<string,any>;businessSequences:Record<string,LocalBusinessSequence>};
const emptyStore=():LocalStore=>({schemaVersion:1,workspaces:{},receipts:{},businessSequences:{}});
const queues=new Map<string,Promise<unknown>>();
function invalid(message:string,status=400):never{throw new MistApiError('MIST_LOCAL_INVALID',message,status);}
export function isMistLoopbackHost(host:string){return ['127.0.0.1','localhost','::1','[::1]'].includes(host.toLowerCase());}
export function mistLocalRequested(env:NodeJS.ProcessEnv=process.env){return env.MIST_LOCAL_WORKSPACE==='1';}
export function assertMistLocalMode(host:string,env:NodeJS.ProcessEnv=process.env){if(!mistLocalRequested(env))invalid('独立本地模式尚未开启');if(env.NODE_ENV==='production')invalid('生产环境禁止启用本地工作身份');if(!isMistLoopbackHost(host))invalid('本地工作模式只能绑定loopback地址');}
function serialized<T>(key:string,operation:()=>Promise<T>):Promise<T>{const previous=queues.get(key)??Promise.resolve();const result=previous.then(operation,operation);queues.set(key,result.catch(()=>undefined));return result;}
function duplicate():never{throw Object.assign(new Error('Local record already exists'),{code:'P2002'});}
function record(value:any){return value&&typeof value==='object'&&!Array.isArray(value);}
function sequenceRow(value:any):LocalBusinessSequence{if(!record(value)||typeof value.prefix!=='string'||!/^[A-Z][A-Z0-9]{0,15}$/.test(value.prefix)||!Number.isInteger(value.year)||value.year<1||value.year>9999||value.id!=='SEQ_'+value.prefix+'_'+value.year||!Number.isSafeInteger(value.seq)||value.seq<0)invalid('本地全局编号序列无效，未重置原序列',500);const stamp=String(value.updatedAt);if(!/^\d+$/.test(stamp))invalid('本地全局编号序列时间无效',500);return{...value,updatedAt:stamp};}
function decodeStore(raw:string):LocalStore{let value:any;try{value=JSON.parse(raw);}catch{invalid('本地数据文件无法读取，请保留文件并检查备份',500);}if(value?.schemaVersion!==1||!record(value.workspaces)||!record(value.receipts))invalid('本地数据格式不受支持，未覆盖原文件',500);if(value.businessSequences===undefined)value.businessSequences={};if(!record(value.businessSequences))invalid('本地全局编号序列格式无效，未覆盖原文件',500);for(const [id,row] of Object.entries(value.businessSequences)){const valid=sequenceRow(row);if(valid.id!==id)invalid('本地全局编号序列主键不一致',500);value.businessSequences[id]=valid;}for(const row of Object.values(value.workspaces) as any[]){if(!record(row)||typeof row.id!=='string'||typeof row.ownerId!=='string'||typeof row.slug!=='string'||!Number.isSafeInteger(row.revision)||!record(row.state))invalid('本地工作空间数据不完整，未覆盖原文件',500);row.createdAt=new Date(row.createdAt);row.updatedAt=new Date(row.updatedAt);if(!Number.isFinite(row.createdAt.valueOf())||!Number.isFinite(row.updatedAt.valueOf()))invalid('本地数据日期无效',500);}return value;}

/** Only the small persistence contract consumed by MistRepository; no legacy DB adapter. */
export class MistLocalDatabase{
  readonly directory:string;readonly file:string;readonly ready:Promise<void>;
  constructor(directory=DEFAULT_DIRECTORY){this.directory=path.resolve(directory);this.file=path.join(this.directory,'store.json');this.ready=this.prepare();}
  private async prepare(){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())invalid('本地数据目录必须是实际目录',500);await this.readStore();}
  private async readStore():Promise<LocalStore>{let handle;try{handle=await fs.open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e:any){if(e.code==='ENOENT')return emptyStore();throw e;}try{const stat=await handle.stat();if(!stat.isFile()||stat.size>100*1024*1024)invalid('本地数据文件无效或过大',500);return decodeStore(await handle.readFile('utf8'));}finally{await handle.close();}}
  private async persist(store:LocalStore){const temporary=path.join(this.directory,'.store-'+randomUUID()+'.tmp');let handle;try{handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(JSON.stringify(store));await handle.sync();await handle.close();handle=undefined;await fs.rename(temporary,this.file);}catch(error){await handle?.close().catch(()=>undefined);await fs.unlink(temporary).catch(()=>undefined);throw error;}}
  private match(row:any,where:any):boolean{if(!where)return true;return Object.entries(where).every(([key,value]:[string,any])=>{if(key==='OR')return Array.isArray(value)&&value.some(clause=>this.match(row,clause));if(key==='AND')return Array.isArray(value)&&value.every(clause=>this.match(row,clause));if(key==='state'){if(!record(value)||!Array.isArray(value.path)||!Array.isArray(value.array_contains))invalid('本地查询条件不受支持',500);let current=row.state;for(const segment of value.path)current=current?.[segment];return Array.isArray(current)&&value.array_contains.every((id:any)=>current.includes(id));}if(!['id','ownerId','slug'].includes(key))invalid('本地查询字段不受支持',500);return row[key]===value;});}
  private delegates(store:LocalStore){const clone=<T>(value:T):T=>structuredClone(value);const selected=(row:LocalBusinessSequence|null,select:any)=>{if(!row)return null;const value={...row,updatedAt:BigInt(row.updatedAt)};if(!select)return clone(value);const result:any={};for(const [key,yes] of Object.entries(select)){if(!(key in value))invalid('本地编号查询字段无效',500);if(yes)result[key]=(value as any)[key];}return clone(result);};return{
    $queryRawUnsafe:async(sql:string)=>{if(sql.trim()==='SELECT 1')return[{value:1}];if(/^SELECT "id" FROM "MistWorkspace" WHERE "id" = \$1::uuid(?: AND "ownerId" = \$2)? FOR UPDATE$/.test(sql))return[];invalid('本地存储不执行SQL',500);},
    mistWorkspace:{
      findFirst:async({where}:any)=>clone(Object.values(store.workspaces).find(row=>this.match(row,where))??null),
      findMany:async({where,orderBy,take}:any={})=>{let rows=Object.values(store.workspaces).filter(row=>this.match(row,where));if(orderBy?.updatedAt)rows.sort((a,b)=>(new Date(a.updatedAt).valueOf()-new Date(b.updatedAt).valueOf())*(orderBy.updatedAt==='desc'?-1:1));if(take!==undefined){if(!Number.isSafeInteger(take)||take<0)invalid('本地查询数量无效');rows=rows.slice(0,take);}return clone(rows);},
      findUnique:async({where}:any)=>{if(where.id)return clone(store.workspaces[where.id]??null);const pair=where.ownerId_slug;if(!pair)invalid('本地唯一查询无效',500);return clone(Object.values(store.workspaces).find(row=>row.ownerId===pair.ownerId&&row.slug===pair.slug)??null);},
      create:async({data}:any)=>{if(store.workspaces[data.id]||Object.values(store.workspaces).some(row=>row.ownerId===data.ownerId&&row.slug===data.slug))duplicate();const now=new Date(),row={...clone(data),createdAt:now,updatedAt:now};store.workspaces[row.id]=row;return clone(row);},
      update:async({where,data}:any)=>{const previous=store.workspaces[where.id];if(!previous)throw Object.assign(new Error('Local record not found'),{code:'P2025'});const revision=record(data.revision)?previous.revision+data.revision.increment:data.revision??previous.revision;if(!Number.isSafeInteger(revision)||revision<0)invalid('本地版本无效',500);const row={...previous,...clone(data),revision,updatedAt:new Date()};store.workspaces[row.id]=row;return clone(row);},
    },
    mistCommandReceipt:{
      findUnique:async({where}:any)=>{const pair=where.workspaceId_requestId;if(!pair)invalid('本地回执查询无效',500);return clone(store.receipts[JSON.stringify([pair.workspaceId,pair.requestId])]??null);},
      findMany:async({where}:any)=>{const ids=where?.requestId?.in;if(typeof where?.workspaceId!=='string'||!Array.isArray(ids))invalid('本地回执查询无效',500);return ids.flatMap((requestId:string)=>{const row=store.receipts[JSON.stringify([where.workspaceId,requestId])];return row?[clone(row)]:[];});},
      create:async({data}:any)=>{const key=JSON.stringify([data.workspaceId,data.requestId]);if(store.receipts[key]||Object.values(store.receipts).some(row=>row.id===data.id))duplicate();store.receipts[key]=clone(data);return clone(data);},
    },
    businessSequence:{
      findUnique:async({where,select}:any)=>selected(store.businessSequences[where.id]??null,select),
      upsert:async({where,create,update,select}:any)=>{let row=store.businessSequences[where.id];if(row){if(update.seq!==undefined||update.prefix!==undefined||update.year!==undefined||update.id!==undefined)invalid('已分配全局序列不能重置',500);row=sequenceRow({...row,...clone(update)});}else{row=sequenceRow(clone(create));if(row.id!==where.id)invalid('本地编号主键无效',500);}store.businessSequences[row.id]=row;return selected(row,select);},
      update:async({where,data,select}:any)=>{const old=store.businessSequences[where.id];if(!old)throw Object.assign(new Error('Local sequence not found'),{code:'P2025'});if(Object.keys(data).some(k=>!['seq','updatedAt'].includes(k))||!record(data.seq)||Object.keys(data.seq).some(k=>k!=='increment')||!Number.isSafeInteger(data.seq.increment)||data.seq.increment<=0)invalid('全局编号只能正向递增',500);const row=sequenceRow({...old,seq:old.seq+data.seq.increment,updatedAt:data.updatedAt??old.updatedAt});store.businessSequences[row.id]=row;return selected(row,select);},
    },
  };}
  async $transaction<T>(operation:(db:ReturnType<MistLocalDatabase['delegates']>)=>Promise<T>,_options?:unknown):Promise<T>{await this.ready;return serialized(this.directory,async()=>{const original=await this.readStore(),draft=structuredClone(original);const result=await operation(this.delegates(draft));if(JSON.stringify(draft)!==JSON.stringify(original))await this.persist(draft);return structuredClone(result);});}
  private async read<T>(operation:(db:ReturnType<MistLocalDatabase['delegates']>)=>Promise<T>){await this.ready;return serialized(this.directory,async()=>operation(this.delegates(await this.readStore())));}
  get mistWorkspace(){return{findFirst:(args:any)=>this.read(db=>db.mistWorkspace.findFirst(args)),findMany:(args:any={})=>this.read(db=>db.mistWorkspace.findMany(args)),findUnique:(args:any)=>this.read(db=>db.mistWorkspace.findUnique(args)),create:(args:any)=>this.$transaction(db=>db.mistWorkspace.create(args)),update:(args:any)=>this.$transaction(db=>db.mistWorkspace.update(args))};}
  get mistCommandReceipt(){return{findUnique:(args:any)=>this.read(db=>db.mistCommandReceipt.findUnique(args)),findMany:(args:any)=>this.read(db=>db.mistCommandReceipt.findMany(args)),create:(args:any)=>this.$transaction(db=>db.mistCommandReceipt.create(args))};}
  get businessSequence(){return{findUnique:(args:any)=>this.read(db=>db.businessSequence.findUnique(args)),upsert:(args:any)=>this.$transaction(db=>db.businessSequence.upsert(args)),update:(args:any)=>this.$transaction(db=>db.businessSequence.update(args))};}
  async $queryRawUnsafe(sql:string,..._parameters:unknown[]){return this.read(db=>db.$queryRawUnsafe(sql));}
  async health(){return this.read(async()=>({storage:'local-file',status:'ok'}));}
  async $disconnect(){await this.ready;await queues.get(this.directory);}
}

/**
 * 本地工作身份。前两个是原有的全权限身份（兼容已有本地数据与流程）；
 * 其余是按现有岗位矩阵取权限的测试身份，用于验证不同岗位各办各的事——不新增或放大任何权限。
 */
export const MIST_LOCAL_PROFILES=[
  {id:'local-operator',name:'本地操作员'},{id:'local-reviewer',name:'本地审批员'},
  {id:'local-sales',name:'业务员（测试）',roleId:SYSTEM_ROLE_IDS.SALES},
  {id:'local-manager',name:'业务主管（测试审批人）',roleId:SYSTEM_ROLE_IDS.SALES_MANAGER},
  {id:'local-finance',name:'财务（测试）',roleId:SYSTEM_ROLE_IDS.FINANCE},
  {id:'local-qc',name:'质检（测试）',roleId:SYSTEM_ROLE_IDS.QC},
  {id:'local-logistics',name:'后勤单证（测试）',roleId:SYSTEM_ROLE_IDS.LOGISTICS},
] as const;
export function mistLocalPublicUser(profileId:string){const profile=MIST_LOCAL_PROFILES.find(p=>p.id===profileId);if(!profile)invalid('本地工作身份不存在',401);
  if(!('roleId' in profile))return{id:profile.id,displayName:profile.name,email:'',roles:['owner'],roleIds:['role-super-admin'],permissions:['*'],departmentIds:[],department:'本地工作空间',globalBusinessScope:true,authorizationLoaded:true,mistLocal:true};
  return{id:profile.id,displayName:profile.name,email:'',roles:[] as string[],roleIds:[profile.roleId],permissions:getDefaultScopeListForRole(profile.roleId),departmentIds:[],department:'本地工作空间',globalBusinessScope:false,authorizationLoaded:true,mistLocal:true};}
export type MistLocalRuntime=ReturnType<typeof createMistLocalRuntime>;
export function createMistLocalRuntime(options:{directory?:string;host?:string;env?:NodeJS.ProcessEnv;now?:()=>number}={}){
  assertMistLocalMode(options.host??'127.0.0.1',options.env??process.env);
  const database=new MistLocalDatabase(options.directory),clock=options.now??Date.now;let secret:Buffer;
  const ready=(async()=>{await database.ready;await serialized(database.directory+':session-key',async()=>{const keyFile=path.join(database.directory,'session.key');let handle;try{handle=await fs.open(keyFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(randomBytes(32));await handle.sync();await handle.close();}catch(error:any){await handle?.close().catch(()=>undefined);if(error.code!=='EEXIST')throw error;}const reader=await fs.open(keyFile,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await reader.stat();if(!stat.isFile()||stat.size!==32)invalid('本地会话密钥文件无效',500);await reader.chmod(0o600);secret=await reader.readFile();}finally{await reader.close();}});})();
  const sign=(profileId:string)=>{mistLocalPublicUser(profileId);const data=Buffer.from(JSON.stringify({v:1,profileId,expiresAt:clock()+SESSION_LIFETIME,nonce:randomUUID()})).toString('base64url');return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');};
  const verify=(token:unknown)=>{if(typeof token!=='string'||token.length>4096)invalid('本地会话无效，请重新进入本地工作空间',401);const parts=(token as string).split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))invalid('本地会话签名无效',401);const expected=createHmac('sha256',secret).update(parts[0]).digest('base64url');if(parts[1].length!==expected.length||!timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))invalid('本地会话签名无效',401);let data:any;try{data=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{invalid('本地会话格式无效',401);}if(data.v!==1||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<=clock())invalid('本地会话已失效，请重新进入本地工作空间',401);mistLocalPublicUser(data.profileId);return data.profileId as string;};
  const actor=(profileId:string,token:string):TokenPayload=>{const user=mistLocalPublicUser(profileId);return{...user,userId:user.id,mistLocal:true,mistLocalToken:token} as unknown as TokenPayload;};
  const actorForProfile=async(profileId:string)=>{await ready;return actor(profileId,sign(profileId));};
  const authorize:FreshAuthority=async(_db,prior,permission)=>{await ready;if(!(prior as any)?.mistLocal)invalid('本地接口不接受普通服务会话',401);const id=verify((prior as any).mistLocalToken);if(prior.userId!==id)invalid('本地身份与会话签名不符',401);const current=actor(id,(prior as any).mistLocalToken);if(prior.permissionCeiling!==undefined)current.permissionCeiling=[...prior.permissionCeiling];if(permission&&!hasScope(current,permission as any))throw new MistApiError('FORBIDDEN','当前账号没有执行此操作的权限',403);return current;};
  const requestGuard=(req:Request)=>{if(req.headers['sec-fetch-site']==='cross-site')invalid('本地接口拒绝跨站请求',403);if(!isMistLoopbackHost(req.hostname))invalid('本地接口只接受本机地址',403);const remote=req.socket.remoteAddress;if(remote&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))invalid('本地接口只接受本机连接',403);if(req.headers.origin){let origin:URL;try{origin=new URL(req.headers.origin);}catch{invalid('本地请求来源无效',403);}if(!['http:','https:'].includes(origin!.protocol)||!isMistLoopbackHost(origin!.hostname))invalid('本地接口拒绝外部网站来源',403);}};
  const failure=(res:Response,error:unknown)=>{const known=error instanceof MistApiError;if(known&&error.status===401)res.clearCookie(COOKIE,{httpOnly:true,sameSite:'strict',path:'/api/mist'});res.status(known?error.status:500).json({ok:false,error:{code:known?error.code:'MIST_LOCAL_UNAVAILABLE',message:known?error.message:'本地工作空间暂不可用，请保留数据文件并重试'}});};
  const setSession=(res:Response,id:string)=>{res.cookie(COOKIE,sign(id),{httpOnly:true,sameSite:'strict',secure:false,path:'/api/mist',maxAge:SESSION_LIFETIME});res.setHeader('Cache-Control','no-store');res.json({mode:'local',user:mistLocalPublicUser(id),profiles:MIST_LOCAL_PROFILES.map(p=>({...p}))});};
  const sessionGet:RequestHandler=(req,res)=>{void(async()=>{await ready;requestGuard(req);const token=req.cookies?.[COOKIE],id=token===undefined?'local-operator':verify(token);setSession(res,id);})().catch(e=>failure(res,e));};
  const sessionPost:RequestHandler=(req,res)=>{void(async()=>{await ready;requestGuard(req);verify(req.cookies?.[COOKIE]);if(!record(req.body)||Object.keys(req.body).some(k=>k!=='profileId')||typeof req.body.profileId!=='string')invalid('请选择有效本地工作身份');mistLocalPublicUser(req.body.profileId);setSession(res,req.body.profileId);})().catch(e=>failure(res,e));};
  const authenticate:RequestHandler=(req,res,next)=>{void(async()=>{await ready;requestGuard(req);const token=req.cookies?.[COOKIE],id=verify(token);(req as Request&{actor:TokenPayload}).actor=actor(id,token);next();})().catch(e=>failure(res,e));};
  // 工作助手委托：签名密钥从本地会话密钥派生；还原时为该身份签一份新的本地会话，供仓储照常复核。
  const agentDelegation=createAgentDelegation({rootSecret:()=>{if(!secret)invalid('本地工作空间尚未就绪',503);return secret;},resolve:profileId=>actorForProfile(profileId),now:clock});
  return{ready,database,authenticate,authorize,sessionGet,sessionPost,actorForProfile,agentDelegation,requestGuard};
}
