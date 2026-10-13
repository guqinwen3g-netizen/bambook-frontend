// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDevelopmentRuntime, exactVersionDecisions, normalizeDevelopmentConfirmation,
  type DevelopmentRuntimeDependencies, type RuntimeAuthority,
} from './development';
import { developmentService, type DevelopmentVersionConfirmationInput } from '../../../../services/developmentService';
import type { BusinessWorkspaceContext } from '../../../../services/businessWorkspaceService';
import type { DevelopmentCase, SampleBatch } from '../../../../types';

const live = vi.hoisted(() => ({ actorId:'staff-a' }));
vi.mock('../../../../services/authService', () => ({
  getAuthState:()=>({isAuthenticated:true,isLoading:false,user:{id:live.actorId}}),
  hasPermission:()=>true, subscribe:()=>()=>{},
}));
vi.mock('../../../../services/apiService', () => ({ apiService:{
  getStoredConfig:()=>({cloudEndpoint:'https://fixture.invalid'}), getAuthHeaders:()=>({Authorization:'Bearer fixture','Content-Type':'application/json'}),
  buildApiUrl:(path:string,endpoint='https://fixture.invalid')=>endpoint+path,
} }));

const caseRow: DevelopmentCase = {id:'case-a',code:'DEV-A',name:'Actual fabric',type:'fabric',stage:'developing',priority:'normal',currentRound:2,tags:[],createdAt:1,updatedAt:2,customerRelationId:'customer-a'};
const summary = (id='version-a',kind='major',parentVersionId:string|null=null) => ({kind:'development_version',id,versionLabel:id==='minor-a'?'R2-A-2.1':'R2-A-2',versionKind:kind,parentVersionId,factoryRelationId:'factory-a',factoryName:'Actual factory',roundId:'round-a'});
const summaries=[summary(),summary('minor-a','minor','version-a'),{...summary('version-b'),factoryRelationId:'factory-b'}];
const context = (caseId='case-a',versionId?:string):BusinessWorkspaceContext => ({
  schemaVersion:1,scope:versionId?{kind:'development_version',caseId,sampleVersionId:versionId}:{kind:'development_case',caseId},
  scopeFingerprint:'a'.repeat(64),contextFingerprint:'b'.repeat(64),
  overview:{id:caseId,...(versionId?{version:{id:versionId,versionKind:versionId==='minor-a'?'minor':'major'},physicalSampleVersionId:versionId==='minor-a'?'version-a':versionId}:{})},
  childSummaries:summaries,currentNodeIds:['confirmation'],nodes:[{id:'confirmation',label:'实际需求方确认',precedingIds:[],status:'current',hasHistory:false,canOpen:true,canContinue:false,blockedReasons:[],evidenceRefs:[]}],
} as BusinessWorkspaceContext);
const batch = {id:'batch-a',batchCode:'B-A',developmentCaseId:'case-a',supplierRelationId:'factory-a',sampleVersionId:'version-a',sampleType:'lab-dip',round:2,status:'making',returnedAt:3,createdAt:1,updatedAt:3,
  latestFormalQcReview:{id:'qc-a',sampleVersionId:'version-a',status:'reviewed',result:'pass',reviewSequence:1,versionIdentityStatus:'recorded_exact'},
} as SampleBatch;
const input:DevelopmentVersionConfirmationInput={requestKey:'original-confirmation-key',confirmerType:'customer',confirmerName:'Actual Emma',confirmerOrganization:'Actual customer',confirmedAt:'1700000000000',result:'approved',basis:'来源：线下会议\n需求方原文：please proceed',evidence:['https://fixture.invalid/evidence/a'],sampleBatchId:'batch-a'};
const receipt=(patch={})=>({...input,id:'confirmation-a',developmentCaseId:'case-a',sampleVersionId:'version-a',recordedBy:'staff-a',recordedAt:'1700000000100',...patch});
function response(body:unknown,status=200){return Promise.resolve({ok:status>=200&&status<300,status,json:async()=>body} as Response);}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

const runtimes:Array<ReturnType<typeof createDevelopmentRuntime>>=[];
function setup(overrides:Partial<DevelopmentRuntimeDependencies>={}){
  let authority:RuntimeAuthority={identity:'identity-a',actorId:'staff-a',authenticated:true,loading:false,canRead:true,canConfirm:true,endpoint:'https://fixture.invalid',headers:{Authorization:'Bearer fixture'}};
  const listeners=new Set<()=>void>();
  const service={
    getDevelopmentCase:vi.fn(async()=>caseRow),listDevelopmentSuppliers:vi.fn(async()=>[]),listSampleBatches:vi.fn(async()=>[batch]),
    listDevelopmentVersionConfirmations:vi.fn(async()=>[]),recordDevelopmentVersionConfirmation:vi.fn(async()=>receipt()),
  };
  const fetcher=vi.fn(async()=>response({ok:true,cases:[caseRow],total:3,limit:30,offset:0}));
  const workspace=vi.fn(async(scope:any)=>context(scope.caseId,scope.sampleVersionId));
  const runtime=createDevelopmentRuntime({authority:()=>authority,subscribeAuthority:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},fetch:fetcher,url:(path,endpoint)=>endpoint+path,service,workspace,...overrides});
  runtimes.push(runtime);
  return {runtime,service,fetcher,workspace,change:(patch:Partial<RuntimeAuthority>)=>{authority={...authority,...patch};listeners.forEach(fn=>fn());}};
}
beforeEach(()=>{live.actorId='staff-a';});
afterEach(()=>{runtimes.splice(0).forEach(runtime=>runtime.dispose());vi.unstubAllGlobals();});

describe('Mist native development runtime reads',()=>{
  it('reads real paginated totals and preserves the full original type/stage/object',async()=>{
    const {runtime,fetcher}=setup();const page=await runtime.list({search:'实际 & 布料'});
    expect(page).toMatchObject({items:[caseRow],total:3,limit:30,offset:0,hasMore:true});expect(page.items[0]).toBe(caseRow);
    const url=new URL(fetcher.mock.calls[0][0] as string);expect(url.searchParams.get('search')).toBe('实际 & 布料');expect(url.searchParams.get('limit')).toBe('30');
  });
  it('rejects malformed pagination and duplicate rows instead of claiming a complete list',async()=>{
    const {runtime,fetcher}=setup();fetcher.mockImplementationOnce(()=>response({ok:true,cases:[caseRow],total:3,limit:200,offset:0}));await expect(runtime.list()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
    fetcher.mockImplementationOnce(()=>response({ok:true,cases:[caseRow,caseRow],total:3,limit:30,offset:0}));await expect(runtime.list()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it('reads the exact case and separately identifies factory and minor versions',async()=>{
    const {runtime,service}=setup();const detail=await runtime.detail('case-a');expect(service.getDevelopmentCase).toHaveBeenCalledWith('case-a','https://fixture.invalid');
    expect(detail.item).toBe(caseRow);expect(detail.versions.map(version=>version.id)).toEqual(['version-a','minor-a','version-b']);
    expect(detail.versions[1]).toMatchObject({parentVersionId:'version-a',factoryId:'factory-a'});
    service.getDevelopmentCase.mockResolvedValueOnce({...caseRow,id:'other'});await expect(runtime.detail('case-a')).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it('does not inherit a parent or another factory QC report for a minor',async()=>{
    const {runtime}=setup();const minor=await runtime.version('case-a','minor-a');expect(minor.physicalVersionId).toBe('version-a');expect(minor.batches[0]).toBe(batch);expect(minor.qc.latest).toBeNull();expect(minor.qc.history).toEqual([]);
    const exact=exactVersionDecisions([{...batch,microVersions:[{versionId:'minor-a',versionLabel:'R2-A-2.1',latestFormalQcReview:{id:'qc-minor',sampleVersionId:'minor-a',status:'reviewed',result:'pass',versionIdentityStatus:'recorded_exact'}}]}],'minor-a');expect(exact.latest?.id).toBe('qc-minor');
  });
  it('aborts superseded and explicitly cancelled reads even when the underlying service cannot abort',async()=>{
    const old=deferred<DevelopmentCase>();const {runtime,service}=setup();service.getDevelopmentCase.mockImplementationOnce(()=>old.promise);
    const pending=runtime.detail('case-a');const rejection=expect(pending).rejects.toMatchObject({code:'SUPERSEDED'});await runtime.detail('case-a');old.resolve(caseRow);await rejection;
    const controller=new AbortController();controller.abort();await expect(runtime.version('case-a','version-a',{signal:controller.signal})).rejects.toMatchObject({code:'ABORTED'});
  });
  it('fences A→B→A authority changes, and checks permissions before any request',async()=>{
    const old=deferred<DevelopmentCase>();const {runtime,service,change,fetcher}=setup();service.getDevelopmentCase.mockImplementationOnce(()=>old.promise);
    const pending=runtime.detail('case-a');const rejection=expect(pending).rejects.toMatchObject({code:'STALE_CONTEXT'});change({identity:'identity-b'});change({identity:'identity-a'});old.resolve(caseRow);await rejection;
    change({canRead:false});await expect(runtime.list()).rejects.toMatchObject({code:'FORBIDDEN'});expect(fetcher).not.toHaveBeenCalled();
  });
  it('surfaces server read errors and never substitutes demonstration records',async()=>{
    const {runtime,fetcher}=setup();fetcher.mockImplementationOnce(()=>response({ok:false,error:{code:'FORBIDDEN',message:'当前数据范围不可见'}},403));await expect(runtime.list()).rejects.toMatchObject({code:'FORBIDDEN',status:403,message:'当前数据范围不可见'});
  });
});

describe('Mist requester confirmation command',()=>{
  it('records native facts without substituting the staff recorder for the actual confirmer',async()=>{
    const {runtime,service}=setup();expect(await runtime.confirm('case-a','version-a',input)).toEqual(receipt()); // mist-allow: domain confirmation method; no browser native dialog
    expect(service.recordDevelopmentVersionConfirmation).toHaveBeenCalledWith('case-a','version-a',input,'https://fixture.invalid');expect(runtime.pendingConfirmation('case-a','version-a')).toBeNull();
  });
  it('dispatches through the existing service to the actual native confirmation endpoint',async()=>{
    const fetcher=vi.fn(async()=>response({ok:true,item:receipt()}));vi.stubGlobal('fetch',fetcher);
    const base=setup();const runtime=createDevelopmentRuntime({authority:()=>({identity:'native-a',actorId:'staff-a',authenticated:true,loading:false,canRead:true,canConfirm:true,endpoint:'https://fixture.invalid',headers:{}}),subscribeAuthority:()=>()=>{},workspace:base.workspace,service:{...base.service,recordDevelopmentVersionConfirmation:developmentService.recordDevelopmentVersionConfirmation}});runtimes.push(runtime);
    await runtime.confirm('case-a','version-a',input);expect(fetcher.mock.calls[0][0]).toBe('https://fixture.invalid/v1/development/case-a/sample-versions/version-a/confirmations');expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(input);expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).not.toHaveProperty('recordedBy'); // mist-allow: domain confirmation method; no browser native dialog
  });
  it.each([{sampleVersionId:'version-b'},{recordedBy:'someone-else'},{confirmerOrganization:'other organization'},{sampleBatchId:'batch-b'},{evidence:[]}])('retains the original request after an inconsistent receipt %j',async patch=>{
    const {runtime,service}=setup();service.recordDevelopmentVersionConfirmation.mockResolvedValueOnce(receipt(patch));await expect(runtime.confirm('case-a','version-a',input)).rejects.toMatchObject({code:'CONFIRMATION_UNCERTAIN',outcome:'unknown'}); // mist-allow: domain confirmation method; no browser native dialog
    expect(runtime.pendingConfirmation('case-a','version-a')?.input).toEqual(input);
    await expect(runtime.confirm('case-a','version-a',{...input,requestKey:'another'})).rejects.toMatchObject({code:'UNRESOLVED_CONFIRMATION'});expect(service.recordDevelopmentVersionConfirmation).toHaveBeenCalledTimes(1); // mist-allow: domain confirmation method; no browser native dialog
  });
  it('requires the exact returned physical source and an available business confirmation node before POST',async()=>{
    const {runtime,service,workspace}=setup();await expect(runtime.confirm('case-a','version-a',{...input,sampleBatchId:'batch-b'})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(service.recordDevelopmentVersionConfirmation).not.toHaveBeenCalled(); // mist-allow: domain confirmation method; no browser native dialog
    workspace.mockImplementationOnce(async scope=>({...context(scope.caseId,scope.sampleVersionId),nodes:[{...context().nodes[0],canOpen:false,blockedReasons:[{code:'RETURN_REQUIRED',message:'缺少原返样实物'}]}]}));await expect(runtime.confirm('case-a','version-a',input)).rejects.toMatchObject({code:'BLOCKED'});expect(service.recordDevelopmentVersionConfirmation).not.toHaveBeenCalled(); // mist-allow: domain confirmation method; no browser native dialog
  });
  it('keeps a lost-response command and resolves it by readback without creating a new confirmation',async()=>{
    const {runtime,service}=setup();service.recordDevelopmentVersionConfirmation.mockRejectedValueOnce(new Error('connection lost'));await expect(runtime.confirm('case-a','version-a',input)).rejects.toMatchObject({outcome:'unknown',original:{input}}); // mist-allow: domain confirmation method; no browser native dialog
    expect(await runtime.recoverConfirmation('case-a','version-a')).toBeNull();expect(runtime.pendingConfirmation('case-a','version-a')).not.toBeNull();
    service.listDevelopmentVersionConfirmations.mockResolvedValueOnce([receipt()]);expect(await runtime.recoverConfirmation('case-a','version-a')).toEqual(receipt());expect(runtime.pendingConfirmation('case-a','version-a')).toBeNull();expect(service.recordDevelopmentVersionConfirmation).toHaveBeenCalledTimes(1);
  });
  it('does not report success for an aborted write whose server may still commit',async()=>{
    const response=deferred<ReturnType<typeof receipt>>();const {runtime,service}=setup();service.recordDevelopmentVersionConfirmation.mockImplementationOnce(()=>response.promise);
    const controller=new AbortController();const pending=runtime.confirm('case-a','version-a',input,{signal:controller.signal});await vi.waitFor(()=>expect(service.recordDevelopmentVersionConfirmation).toHaveBeenCalledTimes(1)); // mist-allow: domain confirmation method; no browser native dialog
    const rejection=expect(pending).rejects.toMatchObject({outcome:'unknown'});controller.abort();await rejection;response.resolve(receipt());expect(runtime.pendingConfirmation('case-a','version-a')?.input.requestKey).toBe(input.requestKey);
  });
  it('validates all three real outcomes and keeps the single basis text and evidence references',()=>{
    for(const result of ['approved','rejected','needs_adjustment'] as const)expect(normalizeDevelopmentConfirmation({...input,result}).result).toBe(result);
    expect(normalizeDevelopmentConfirmation({...input,confirmerName:' Actual Emma '})).toMatchObject({confirmerName:'Actual Emma',basis:input.basis,evidence:input.evidence});
    expect(()=>normalizeDevelopmentConfirmation({...input,basis:''})).toThrow();expect(()=>normalizeDevelopmentConfirmation({...input,confirmedAt:'2026-10-13'})).toThrow();
  });
});
