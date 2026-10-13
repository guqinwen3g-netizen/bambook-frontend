// @vitest-environment jsdom
// Actual fetch HTTP transport + actual release client. Synthetic native envelopes, no DB/auth-producer claim.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { releaseService, type ReleaseScopeRow } from './releaseService';
let server:Server,endpoint:string,body:any,url:string,headers:any,responseBody:any,status:number;
const original:ReleaseScopeRow={id:'RS /original',orderId:'O1',orderLineId:'L1',productionBatchId:'PB-native',productionBatchRevision:null,
  classification:'historical',quantity:'10',unit:'PC',state:'ready',currentReleaseId:'PP-original',scopeRevision:1};
const input={productionBatchId:'PB-native',expectedScopeRevision:1,expectedBatchRevision:3,quantity:'99999999999999.9999',unit:'PC'};
const ack=(patch:any={})=>({ok:true,scope:{...original,classification:undefined,scopeRevision:2,state:'no_release',currentReleaseId:null,
  productionBatchRevision:3,quantity:input.quantity,unit:input.unit,...patch}});
beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  const bytes:Buffer[]=[];for await(const chunk of req)bytes.push(Buffer.from(chunk));body=JSON.parse(Buffer.concat(bytes).toString('utf8'));url=req.url!;headers=req.headers;
  if(decodeURIComponent(url.split('/release-scopes/')[1].split('/rebind')[0])!==original.id){res.statusCode=400;res.end(JSON.stringify({ok:false}));return;}
  res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(typeof responseBody==='string'?responseBody:JSON.stringify(responseBody));
 });await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('owned same-process transport bind failed');endpoint=`http://127.0.0.1:${address.port}/api`;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
beforeEach(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('bambook_auth_token','synthetic-transport-only');vi.stubEnv('VITE_API_BASE_URL','');body=null;responseBody=ack();status=200;});
it('RET01 original identity encoded, exact native decimal and both revisions pass through over actual HTTP',async()=>{
 const result=await releaseService.rebindScope(original,input,endpoint);expect(body).toEqual(input);expect(typeof body.quantity).toBe('string');expect(url).toContain(encodeURIComponent(original.id));expect(headers.authorization).toBe('Bearer synthetic-transport-only');
 expect(result.scope).toMatchObject({id:original.id,orderId:'O1',orderLineId:'L1',productionBatchId:'PB-native',scopeRevision:2,productionBatchRevision:3,quantity:input.quantity,state:'no_release',currentReleaseId:null});
});
it.each(['id','orderId','orderLineId','productionBatchId'])('RET02 foreign native ACK %s cannot confirm the original continuation',async field=>{
 responseBody=ack({[field]:'FOREIGN'});await expect(releaseService.rebindScope(original,input,endpoint)).rejects.toThrow('结果待核对');expect(body).toEqual(input);
});
it('RET03 unchanged revision is not an acknowledged new projection',async()=>{
 responseBody=ack({scopeRevision:1});await expect(releaseService.rebindScope(original,input,endpoint)).rejects.toThrow('结果待核对');
});
it('RET04 missing, malformed or contradictory native acknowledgement never confirms a write',async()=>{
 for(const value of [{},{ok:true},'not JSON',ack({state:'ready'}),ack({currentReleaseId:'PP-original'}),ack({currentReleaseId:undefined}),ack({productionBatchRevision:4}),ack({quantity:'99999999999999.9998'}),ack({unit:'KG'}),ack({scopeRevision:3}),ack({classification:'historical'})]){
  responseBody=value;await expect(releaseService.rebindScope(original,input,endpoint)).rejects.toThrow('结果待核对');
 }
});
it('RET05 native conflict explanation remains an explicit refusal, never a successful scope',async()=>{
 status=409;responseBody={ok:false,error:{code:'CONFLICT',message:'原范围修订已变化，请重读原范围。'}};await expect(releaseService.rebindScope(original,input,endpoint)).rejects.toThrow('原范围修订已变化');expect(body).toEqual(input);
});
