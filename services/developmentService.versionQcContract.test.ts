// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {developmentService,developmentVersionQcPassed} from './developmentService';
vi.mock('./authService',()=>({getAuthState:()=>({user:{id:'business'}}),subscribe:()=>()=>{}}));
vi.mock('./apiService',()=>({apiService:{getStoredConfig:()=>({cloudEndpoint:'http://fixture'}),buildApiUrl:(path:string,base='http://fixture')=>base+path,getAuthHeaders:()=>({Authorization:'fixture'})}}));
afterEach(()=>vi.unstubAllGlobals());
const report=(result:string,opinion?:string)=>({latestFormalQcReview:{id:'report',sampleVersionId:'V',versionIdentityStatus:'recorded_exact' as const,status:'reviewed',result,opinion}});
it('conditions pass only with the exact version and mandatory opinion; historical adjustment never passes',()=>{
 expect(developmentVersionQcPassed('V',report('pass'))).toBe(true);
 expect(developmentVersionQcPassed('V',report('conditional_pass','Follow these conditions'))).toBe(true);
 for(const value of [report('conditional_pass'),report('conditional_pass',' '),report('needs_adjustment','Old adjustment'),report('fail','Failed')]) expect(developmentVersionQcPassed('V',value)).toBe(false);
 expect(developmentVersionQcPassed('OTHER',report('conditional_pass','Conditions'))).toBe(false);
});
it('uses the case-scoped personnel data envelope for real QC team choices',async()=>{
 const teams=[{id:'Q1',name:'成衣QC',family:'garment',configuredHeadId:'head',headId:'head',headName:'负责人'}];
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,data:{qcRoutingTeams:teams}})});vi.stubGlobal('fetch',fetcher);
 expect(await developmentService.listDevelopmentQcRoutingTeams('case 1')).toEqual(teams);
 expect(fetcher.mock.calls[0][0]).toBe('http://fixture/v1/development/personnel?caseId=case%201');
});
it('posts and verifies the selected routing team with the exact sample version',async()=>{
 const command={requestKey:'REQ',sampleVersionId:'V',routingTeamId:'Q2'};
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({ok:true,item:{id:'R',...command,status:'queued'}})});vi.stubGlobal('fetch',fetcher);
 await developmentService.initiateDevelopmentBatchQcReview('C','B',command);
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(command);
 fetcher.mockResolvedValue({ok:true,json:async()=>({ok:true,item:{id:'R',...command,routingTeamId:'Q1'}})});
 await expect(developmentService.initiateDevelopmentBatchQcReview('C','B',command)).rejects.toThrow('准确版本');
});
