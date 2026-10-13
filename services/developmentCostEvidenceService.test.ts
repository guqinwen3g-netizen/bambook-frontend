// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {developmentCostEvidenceService as service} from './developmentCostEvidenceService';
vi.mock('./apiService',()=>({apiService:{buildApiUrl:(p:string)=>p,getStoredConfig:()=>({cloudEndpoint:'local'}),getAuthHeaders:()=>({'Content-Type':'application/json',Authorization:'Bearer test'})}}));
afterEach(()=>vi.unstubAllGlobals());
it('上传保留会话认证，移除JSON类型让浏览器生成multipart边界，并保留幂等key',async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({evidence:{id:'e'}}),{status:200}));vi.stubGlobal('fetch',fetch);
 const file=new File(['%PDF-1.7'],'快递账单.pdf');await service.upload('d/1','c/1',{file,note:'账单',requestKey:'same-key'});
 const [url,options]=fetch.mock.calls[0] as any;
 expect(url).toBe('/v1/development/d%2F1/costs/c%2F1/evidence');expect(options.headers.has('Content-Type')).toBe(false);expect(options.headers.get('Authorization')).toBe('Bearer test');
 expect(options.body.get('requestKey')).toBe('same-key');expect(options.body.get('file').name).toBe('快递账单.pdf');expect(options.body.get('originalName')).toBe('快递账单.pdf');
});
it('权限与业务拒绝保留HTTP状态，不当作网络未知结果',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'已确认，不可覆盖'}}),{status:409})));
 await expect(service.revoke('d','c','e','更正')).rejects.toMatchObject({status:409,message:'已确认，不可覆盖'});
});
