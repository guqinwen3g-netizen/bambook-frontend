import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('./apiService',()=>({apiService:{getStoredConfig:()=>({cloudEndpoint:'local'}),buildApiUrl:(p:string)=>p,getAuthHeaders:()=>({'Content-Type':'application/json'})}}));
import {developmentClosureService as service,ClosureError} from './developmentClosureService';
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));
describe('开发结案客户端',()=>{
 it('按案编码、保留核对版本和重试请求标识',async()=>{
  vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>({event:{id:'event'}})} as Response);
  const command={kind:'lifecycle' as const,body:{action:'close' as const,outcome:'completed' as const,reason:'已认可',expectedRevision:3,expectedFingerprint:'fp',requestKey:'stable'}};
  await service.execute('a/b',command);await service.execute('a/b',command);
  expect(vi.mocked(fetch).mock.calls[0]).toEqual(vi.mocked(fetch).mock.calls[1]);
  expect(fetch).toHaveBeenCalledWith('/v1/development/a%2Fb/lifecycle',expect.objectContaining({method:'POST',body:JSON.stringify(command.body)}));
 });
 it('冲突保留状态码，网络失败及不完整响应不误报成功',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:{message:'重新核对'}})} as Response);
  await expect(service.preview('d')).rejects.toMatchObject({status:409,message:'重新核对'});
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('网络断开'));await expect(service.preview('d')).rejects.toThrow('网络断开');
  vi.mocked(fetch).mockResolvedValueOnce({ok:true,json:async()=>{throw Error('bad json');}} as unknown as Response);
  await expect(service.expenses('d')).rejects.not.toBeInstanceOf(ClosureError);
 });
 it('核对沿现有workflow发送同一原命令，返回真实收费和交接事实',async()=>{
  const result={event:{id:'event',action:'verify',requestKey:'original-key'},billingItem:{id:'bill',status:'confirmed',developmentWorkflowState:'ready'},assignment:{id:'handoff',userId:'finance'}};
  vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>result} as Response);
  const command={action:'verify' as const,requestKey:'original-key',expectedVersion:4,note:'已核对'};
  expect(await service.workflow('case/a','bill/b',command)).toEqual(result);await service.workflow('case/a','bill/b',command);
  expect(vi.mocked(fetch).mock.calls[0]).toEqual(vi.mocked(fetch).mock.calls[1]);expect(fetch).toHaveBeenCalledWith('/v1/development/case%2Fa/billing-drafts/bill%2Fb/workflow',expect.objectContaining({method:'POST',body:JSON.stringify(command)}));
 });
});
