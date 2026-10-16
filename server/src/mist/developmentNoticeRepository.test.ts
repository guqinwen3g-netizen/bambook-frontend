import {beforeEach,afterEach,expect,it,vi,describe} from 'vitest';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as contract from '../shared/mistWorkspace';
import {developmentNoticeOutdated,developmentNotices} from '../shared/mistDevelopmentNotice';
import {renderDevelopmentNoticeHtml} from '../templates/developmentNotice';
import {MistRepository,type MistCommandRequest} from './repository';
import {MistPrivateFiles} from './files';
import {MemoryMistDatabase,testActor,testAuthority} from './__tests__/support';

vi.mock('./context',()=>({mistApprovalAuthority:async()=>({supplier:{},businessReviewerId:'leader'})}));

const now='2026-10-16T08:00:00.000Z';
const company={legalName:'杭州竹语服饰有限公司',englishName:'Hangzhou Bamboo Apparel Co., Ltd.',address:'杭州市西湖区 1 号',englishAddress:'',phone:'0571-1',email:'dev@example.com',taxId:'',customsCode:'',bankName:'',bankAccount:'',swift:'',defaultCurrency:'USD'};
let directory:string,db:MemoryMistDatabase,auth:ReturnType<typeof testAuthority>,files:MistPrivateFiles,repo:MistRepository,workspaceId:string,devId:string,revision=0;
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const htmls:string[]=[];
const renderPdf=vi.fn(async(html:string)=>{htmls.push(html);const pdf=Buffer.from('%PDF-1.4\n'+digest(Buffer.from(html))+'\n%%EOF');return {pdf,sha:digest(pdf),bytes:pdf.length,generatedAt:now,format:'A4'};});
const state=()=>db.workspaces.get(workspaceId).state as contract.MistState;
const version=(label:string)=>state().versions.find(v=>v.devId===devId&&v.label===label)!;
const dev=()=>state().devs.find(d=>d.id===devId)!;
const names=async()=>(await readdir(path.join(directory,workspaceId)).catch(()=>[] as string[]));
const exec=async(requestId:string,command:contract.MistCommand)=>{const r=await repo.execute(testActor(),workspaceId,{requestId,expectedRevision:revision,command} as MistCommandRequest);revision=r.workspace.revision;return r;};
const notice=(requestId:string,label:string,extra:Record<string,unknown>={})=>exec(requestId,{type:'development.notice.generate',payload:{devId,versionId:version(label).id,...extra}} as never);

beforeEach(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'mist-dev-notice-'));db=new MemoryMistDatabase();auth=testAuthority();auth.users.get('owner')!.permissions=['products:read','products:write'];files=new MistPrivateFiles(directory);renderPdf.mockClear();htmls.length=0;revision=0;
 repo=new MistRepository(db,contract,files,auth.authorize,()=>new Date(now),undefined,renderPdf);workspaceId=(await repo.create(testActor(),{name:'通知单仓储测试空间',seed:'empty'})).id;
 const s=state();s.settings.companyProfile={...company};
 s.customers.push({id:'c',name:'测试客户',code:'C',country:'',city:'',industry:'',owner:'',grade:'',currency:'EUR',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 let n=0;const ctx:contract.MistContext={id:()=>`seed-${++n}`,now,actorName:'业务员',actorId:'owner'};let next=s;
 const run=(c:contract.MistCommand)=>{const r=contract.applyMistCommand(next,c,ctx);next=r.state;return r.result as Record<string,any>;};
 devId=run({type:'development.submit',payload:{values:{name:'通知单大衣',customer:'c',style:'ST-N',season:'AW26',category:'大衣',kind:'new',fabric:'羊毛',color:'灰',target:'',sizeBase:'M',goal:'首轮',factories:['A厂'],due:'2026-10-30',collaborators:[],sampleQuantity:1},fileIds:[]}}).devId;
 run({type:'development.round.create',payload:{devId,factories:['A厂','B厂'],requirements:'收腰 2cm，换哑光扣',targetDate:'2026-11-10',factoryTasks:[
  {factory:'A厂',extraRequirements:'A 厂另改青果领',sampleForm:'样衣',sampleQuantity:2,sampleUnit:'件',dueDate:'2026-11-05'},
  {factory:'B厂',extraRequirements:'B 厂袖口加襻',sampleForm:'半成品',sampleQuantity:1,sampleUnit:'套',dueDate:'2026-11-08'}]}});
 db.workspaces.get(workspaceId).state=next;
});
afterEach(async()=>{vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});

describe('BB-DEV-4 试样通知单',()=>{
 it('two factories with different differences each get their own correct notice',async()=>{
  await notice('n-a','R2-A');await notice('n-b','R2-B');
  expect(renderPdf).toHaveBeenCalledTimes(2);
  const [a,b]=htmls;
  for(const html of [a,b]){expect(html).toContain('服装开发通知单');expect(html).toContain('收腰 2cm，换哑光扣');}
  expect(a).toContain('A 厂另改青果领');expect(a).toContain('致：A厂');expect(a).toContain('2 件');expect(a).toContain('2026-11-05');expect(a).not.toContain('B 厂袖口加襻');
  expect(b).toContain('B 厂袖口加襻');expect(b).toContain('致：B厂');expect(b).toContain('1 套');expect(b).toContain('半成品');expect(b).toContain('2026-11-08');expect(b).not.toContain('A 厂另改青果领');
  const na=version('R2-A').notices![0],nb=version('R2-B').notices![0];
  expect(na.snapshot).toMatchObject({factory:'A厂',extraRequirements:'A 厂另改青果领',sampleQuantity:2,sampleUnit:'件',dueDate:'2026-11-05',noticeNo:`${dev().code}-R2-A-N01`});
  expect(nb.snapshot).toMatchObject({factory:'B厂',extraRequirements:'B 厂袖口加襻',sampleForm:'半成品',dueDate:'2026-11-08'});
  const fa=state().files.find(f=>f.id===na.fileId)!;expect(fa).toMatchObject({mimeType:'application/pdf',name:`服装开发通知单-${na.noticeNo}.pdf`});
  expect((await files.read(workspaceId,fa)).subarray(0,8).toString()).toBe('%PDF-1.4');expect(await names()).toHaveLength(2);
 });
 it('after the factory task is updated it is marked outdated, and regenerating keeps the old notice',async()=>{
  await notice('n1','R2-A');expect(developmentNoticeOutdated(state(),dev(),version('R2-A'))).toBe(false);
  await exec('edit',{type:'development.round.updateRequirements',payload:{devId,roundId:version('R2-A').roundId!,requirements:'收腰 3cm，换哑光扣'}});
  expect(developmentNoticeOutdated(state(),dev(),version('R2-A'))).toBe(false); // 共同要求改了但本厂任务未同步，通知单仍对应本厂任务
  await exec('sync',{type:'development.version.syncRequirements',payload:{devId,versionId:version('R2-A').id}});
  expect(developmentNoticeOutdated(state(),dev(),version('R2-A'))).toBe(true);
  await notice('n2','R2-A');
  const list=developmentNotices(version('R2-A'));expect(list.map(n=>n.seq)).toEqual([2,1]);
  expect(list[0].snapshot.commonRequirements).toBe('收腰 3cm，换哑光扣');expect(list[1].snapshot.commonRequirements).toBe('收腰 2cm，换哑光扣');
  expect(list[0].fileId).not.toBe(list[1].fileId);expect(state().files.some(f=>f.id===list[1].fileId)).toBe(true);
  expect(developmentNoticeOutdated(state(),dev(),version('R2-A'))).toBe(false);
  const replay=await repo.execute(testActor(),workspaceId,{requestId:'n2',expectedRevision:revision-1,command:{type:'development.notice.generate',payload:{devId,versionId:version('R2-A').id}}} as never);
  expect(replay.replayed).toBe(true);expect(renderPdf).toHaveBeenCalledTimes(2);
 });
 it.each([{html:'<h1>client</h1>'},{snapshot:{extraRequirements:'伪造'}},{fileId:'forged'}])('refuses client overrides %j before render or persistence',async forged=>{
  const before=structuredClone(state());await expect(notice('forged','R2-A',forged)).rejects.toMatchObject({status:422});
  expect(renderPdf).not.toHaveBeenCalled();expect(state()).toEqual(before);expect(await names()).toHaveLength(0);
 });
 it('requires products:write, a company profile and an open case, without rendering or writing',async()=>{
  auth.users.get('owner')!.permissions=['products:read'];let before=structuredClone(state());
  await expect(notice('no-perm','R2-A')).rejects.toMatchObject({status:403});expect(state()).toEqual(before);
  auth.users.get('owner')!.permissions=['products:read','products:write'];
  delete (state().settings as any).companyProfile;before=structuredClone(state());
  await expect(notice('no-company','R2-A')).rejects.toThrow(/公司抬头/);expect(state()).toEqual(before);
  state().settings.companyProfile={...company};
  await exec('close',{type:'development.close',payload:{devId,kind:'cancelled',reason:'客户撤单'}});before=structuredClone(state());
  await expect(notice('closed','R2-A')).rejects.toThrow(/已取消，不能再生成通知单/);expect(state()).toEqual(before);
  expect(renderPdf).not.toHaveBeenCalled();expect(await names()).toHaveLength(0);
 });
 it('rejects the command when no server-built artifact is bound (direct contract call)',()=>{
  expect(()=>contract.applyMistCommand(state(),{type:'development.notice.generate',payload:{devId,versionId:version('R2-A').id}},{id:()=>'x',now,actorName:'业务员',actorId:'owner'})).toThrow(/须由服务端按当前工厂任务生成/);
 });
 it('titles fabric notices 面料试样通知单 and escapes user text',()=>{
  const html=renderDevelopmentNoticeHtml({domain:'fabric',title:'面料试样通知单',factory:'<b>织厂</b>',devId:'d',devCode:'DEV-F-1',devName:'斜纹',versionId:'v',versionLabel:'R1-A',roundNumber:1,roundTargetDate:'2026-11-01',style:'',category:'斜纹',season:'AW',color:'蓝',fabric:'',sizeBase:'',fabricRequirements:[{label:'成分',value:'棉:100'}],commonRequirements:'克重 240',extraRequirements:'',sampleForm:'米样',sampleQuantity:2,sampleUnit:'米',dueDate:'2026-11-01',attachments:[{fileId:'f',name:'色卡.pdf'}],issuer:{legalName:'公司',englishName:'',address:'',phone:'',email:''},noticeNo:'DEV-F-1-R1-A-N01',seq:1,templateVersion:1,generatedAt:now,generatedBy:'林',generatedById:'u'});
  expect(html).toContain('面料试样通知单');expect(html).toContain('成分');expect(html).toContain('2 米');expect(html).toContain('色卡.pdf');expect(html).toContain('无（按共同要求）');
  expect(html).not.toContain('<b>织厂</b>');expect(html).toContain('&lt;b&gt;织厂&lt;/b&gt;');
 });
});
