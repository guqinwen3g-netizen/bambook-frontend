import {webcrypto,createHash} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({actor:'sales',token:'actual',ceiling:'full',endpoint:'https://native.invalid',listeners:new Set<()=>void>()}));
vi.mock('./authService',()=>({getAuthState:()=>({isAuthenticated:true,isLoading:false,user:{id:m.actor,permissionCeiling:[m.ceiling]}}),hasPermission:()=>true,subscribe:(fn:()=>void)=>{m.listeners.add(fn);return()=>m.listeners.delete(fn)}}));
vi.mock('./apiService',()=>({apiService:{getStoredConfig:()=>({cloudEndpoint:m.endpoint}),getAuthHeaders:()=>({Authorization:'Bearer '+m.token}),buildApiUrl:(path:string,endpoint:string)=>endpoint+path}}));
import {developmentPhysicalSampleService,verifyDevelopmentPhysicalReceipt} from './developmentPhysicalSampleService';
const input={requestKey:'original',sampleVersionId:'v-a',expectedVersionUpdatedAt:'10',itemId:'same-card',quantity:'1.2500',unit:'M',sentDate:'2026-10-01',recipientName:'Receiver',recipientAddress:'Address',courier:'Courier',trackingNumber:'TRACK',shippingFee:'18.5000',shippingCurrency:'CNY'};
const receipt=()=>({inputSnapshot:{...input},itemId:'same-card',itemCode:'SC-1',caseId:'c',auditId:'audit-1',replayed:false,command:{kind:'factory',actorId:'sales',requestKey:'original',fingerprint:'a'.repeat(64)},task:{sampleVersionId:'v-a',updatedAt:'10',factoryId:'f',factoryName:'Factory',roundId:'round',versionLabel:'R1-A-1'},physical:{unit:'M',physicalLengthQty:'3.25'},stockBefore:{quantity:'3.25',available:'2.25'},stock:{itemId:'same-card',loanId:'loan',eventId:'development-factory:c:sales:original',quantity:'1.25',unit:'米',quantityAfter:'2',availableAfter:'1',archived:false},shipping:{...input}});
beforeEach(()=>{m.actor='sales';m.token='actual';m.ceiling='full';m.endpoint='https://native.invalid';m.listeners.clear();vi.unstubAllGlobals();});
it('sends the exact original task/physical/logistics command without inventing currency and accepts its readback',async()=>{
 const fetch=vi.fn(async(_url:any,_init:any)=>new Response(JSON.stringify({item:receipt()}),{status:200}));vi.stubGlobal('fetch',fetch);
 expect(await developmentPhysicalSampleService.shipToFactory('c',input)).toMatchObject({itemId:'same-card',shipping:{shippingFee:'18.5000',shippingCurrency:'CNY'}});
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
});
it.each(['request','actor','version','item','address','fee'])('rejects a mismatched %s success acknowledgement',async field=>{
 const r:any=receipt();if(field==='request')r.command.requestKey='other';if(field==='actor')r.command.actorId='other';if(field==='version')r.task.sampleVersionId='other';if(field==='item')r.stock.itemId='other';if(field==='address')r.shipping.recipientAddress='Other';if(field==='fee')r.shipping.shippingFee='0';
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({item:r}),{status:200})));
 await expect(developmentPhysicalSampleService.shipToFactory('c',input)).rejects.toThrow('原');
});
it('exact receipt lookup checks the requested original key and returns native failure text',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({item:receipt()}),{status:200})));
 await expect(developmentPhysicalSampleService.readReceipt('c','factory','other-key')).rejects.toThrow('回执');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'开发已暂停'}}),{status:409})));
 await expect(developmentPhysicalSampleService.shipToFactory('c',input)).rejects.toThrow('开发已暂停');
});
it('reads actual case history with explicit pagination and rejects an unrelated receipt',async()=>{
 const fetch=vi.fn(async(_url:any,_init:any)=>new Response(JSON.stringify({item:{items:[receipt()],total:2,limit:1,offset:1}}),{status:200}));vi.stubGlobal('fetch',fetch);
 expect(await developmentPhysicalSampleService.listHistory('c',{kind:'factory',limit:1,offset:1})).toMatchObject({total:2,offset:1});expect(fetch.mock.calls[0][0]).toContain('kind=factory&limit=1&offset=1');
 fetch.mockResolvedValue(new Response(JSON.stringify({item:{items:[{...receipt(),caseId:'other'}],total:2,limit:1,offset:1}}),{status:200}));await expect(developmentPhysicalSampleService.listHistory('c')).rejects.toThrow('来源');
});

it.each(['actor','token'])('permanently invalidates an A-B-A %s change and sends only once',async field=>{
 let resolve!:()=>void;const waiting=new Promise<void>(r=>resolve=r);const fetch=vi.fn(async()=>{await waiting;return new Response(JSON.stringify({item:receipt()}),{status:200})});vi.stubGlobal('fetch',fetch);
 const pending=developmentPhysicalSampleService.shipToFactory('c',input);const original=m[field];m[field]='other';m.listeners.forEach(fn=>fn());m[field]=original;m.listeners.forEach(fn=>fn());resolve();
 await expect(pending).rejects.toThrow('原请求编号');expect(fetch).toHaveBeenCalledTimes(1);expect(m.listeners.size).toBe(0);
});
it('freezes both command and expected facts while caller edits the form',async()=>{
 let resolve!:()=>void;const waiting=new Promise<void>(r=>resolve=r);const fetch=vi.fn(async(_url:any,_init:any)=>{await waiting;return new Response(JSON.stringify({item:receipt()}),{status:200})});vi.stubGlobal('fetch',fetch);
 const form={...input};const pending=developmentPhysicalSampleService.shipToFactory('c',form);form.requestKey='changed';form.recipientAddress='changed';resolve();await expect(pending).resolves.toMatchObject({command:{requestKey:'original'}});expect(JSON.parse(fetch.mock.calls[0][1].body).requestKey).toBe('original');
});
it.each(['updatedAt','quantity','loan','event','balance','unit'])('rejects incomplete or altered %s inventory proof',async field=>{
 const r:any=receipt();if(field==='updatedAt')r.task.updatedAt='11';if(field==='quantity')r.stock.quantity='2';if(field==='loan')delete r.stock.loanId;if(field==='event')r.stock.eventId='other';if(field==='balance')r.stock.availableAfter='3';if(field==='unit')r.physical.unit='PC';vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({item:r}),{status:200})));await expect(developmentPhysicalSampleService.shipToFactory('c',input)).rejects.toThrow('原');
});
it.each(['name','cardType','quantity','unit','physicalLengthQty'])('checks incoming original %s facts',async field=>{
 const incoming={requestKey:'original',name:'Reference',cardType:'fabric',quantity:1,unit:'M',physicalLengthQty:'1.2500',receivedDate:'2026-10-01',form:'piece',sourceType:'customer_sample' as const,sourceName:'Customer'};
 const r:any={...receipt(),inputSnapshot:{...incoming},command:{...receipt().command,kind:'incoming'},incoming:{receivedDate:incoming.receivedDate,form:incoming.form,sourceType:incoming.sourceType,sourceName:incoming.sourceName},photoUploadItemId:'same-card',physical:{name:'Reference',cardType:'fabric',quantity:1,unit:'M',physicalLengthQty:'1.25'}};
 r.physical[field]=field==='quantity'?2:'other';vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({item:r}),{status:200})));
 await expect(developmentPhysicalSampleService.registerIncoming('c',incoming)).rejects.toThrow('原');
});
it('history invalidation survives a token A-B-A storage event and freezes pagination',async()=>{
 let resolve!:()=>void;const waiting=new Promise<void>(r=>resolve=r);const fetch=vi.fn(async()=>{await waiting;return new Response(JSON.stringify({item:{items:[receipt()],total:1,limit:1,offset:0}}),{status:200})});vi.stubGlobal('fetch',fetch);
 const options={limit:1,offset:0};const pending=developmentPhysicalSampleService.listHistory('c',options);options.limit=2;m.token='other';window.dispatchEvent(new Event('storage'));m.token='actual';window.dispatchEvent(new Event('focus'));resolve();await expect(pending).rejects.toThrow('原请求编号');expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['ceiling','endpoint'])('permanently invalidates %s A-B-A config and focus events',async field=>{
 let resolve!:()=>void;const wait=new Promise<void>(r=>resolve=r);vi.stubGlobal('fetch',vi.fn(async()=>{await wait;return new Response(JSON.stringify({item:receipt()}),{status:200})}));
 const pending=developmentPhysicalSampleService.shipToFactory('c',input),original=m[field];m[field]='other';window.dispatchEvent(new Event('bambook:email-context-changed'));m[field]=original;window.dispatchEvent(new Event('focus'));resolve();await expect(pending).rejects.toThrow('原请求编号');
});

it.each(['actor','case','kind','key','fingerprint','audit','replayed'])('cancel %s proof mismatch never becomes a terminal acknowledgement',async field=>{
 vi.stubGlobal('crypto',webcrypto);const expectedHash=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key=>[key,(input as any)[key]])))).digest('hex');const ack:any={status:'cancelled',caseId:'c',actorId:'sales',kind:'factory',requestKey:'original',inputFingerprint:expectedHash,auditId:'cancel-audit',replayed:false};if(field==='actor')ack.actorId='other';if(field==='case')ack.caseId='other';if(field==='kind')ack.kind='incoming';if(field==='key')ack.requestKey='other';if(field==='fingerprint')ack.inputFingerprint='b'.repeat(64);if(field==='audit')delete ack.auditId;if(field==='replayed')ack.replayed='yes';vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({item:ack}),{status:200})));await expect(developmentPhysicalSampleService.resolveCommand('c','factory',input)).rejects.toThrow('原');
});
it('accepts only exact raw-body cancellation or an already fully verified original success',async()=>{
 vi.stubGlobal('crypto',webcrypto);const inputFingerprint=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key=>[key,(input as any)[key]])))).digest('hex');const fetch=vi.fn(async()=>new Response(JSON.stringify({item:{status:'cancelled',caseId:'c',actorId:'sales',kind:'factory',requestKey:'original',inputFingerprint,auditId:'cancel-audit',replayed:false}}),{status:200}));vi.stubGlobal('fetch',fetch);await expect(developmentPhysicalSampleService.resolveCommand('c','factory',input)).resolves.toMatchObject({status:'cancelled'});const original:any=receipt();original.stock.quantity='9';fetch.mockResolvedValue(new Response(JSON.stringify({item:{status:'succeeded',receipt:original}}),{status:200}));await expect(developmentPhysicalSampleService.resolveCommand('c','factory',input)).rejects.toThrow('原');
});

it('readonly terminal GET verifies the same raw cancellation proof and never POSTs',async()=>{
 vi.stubGlobal('crypto',webcrypto);const inputFingerprint=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(input).sort().map(key=>[key,(input as any)[key]])))).digest('hex');const fetch=vi.fn(async(_url:any,_init:any)=>new Response(JSON.stringify({item:{status:'cancelled',caseId:'c',actorId:'sales',kind:'factory',requestKey:'original',inputFingerprint,auditId:'cancel-audit',replayed:true}}),{status:200}));vi.stubGlobal('fetch',fetch);await expect(developmentPhysicalSampleService.readResolution('c','factory',input)).resolves.toMatchObject({status:'cancelled'});expect(fetch.mock.calls[0][0]).toContain('/original/resolution');expect(fetch.mock.calls[0][1].method).toBeUndefined();
});

it('preserves the same paid shipping expense for initial and recovered success without another POST',async()=>{
 vi.stubGlobal('crypto',webcrypto);
 const paid:any={...receipt(),shippingCost:{status:'registered',amount:'18.5000',currency:'CNY',incurredAt:'2026-10-01',sourceFingerprint:'c'.repeat(64),costRecordId:'cost-1',recordNo:'COST-1'}};
 paid.task.referenceAttachments=['private-ref-one','private-ref-two'];paid.task.factoryRequirements='Actual requirements';
 const snapshot={caseId:'c',actorId:paid.command.actorId,requestKey:paid.command.requestKey,commandFingerprint:paid.command.fingerprint,itemId:paid.itemId,itemCode:paid.itemCode,task:paid.task,physical:paid.physical,stock:paid.stock,shipping:paid.shipping};const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;paid.shippingCost.sourceFingerprint=createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
 const fetch=vi.fn(async(_url:any,_init:any)=>new Response(JSON.stringify({item:{status:'succeeded',receipt:paid}}),{status:200}));vi.stubGlobal('fetch',fetch);
 expect(verifyDevelopmentPhysicalReceipt('c','factory','sales',input,paid).shippingCost).toEqual(paid.shippingCost);
 await expect(developmentPhysicalSampleService.readResolution('c','factory',input)).resolves.toMatchObject({status:'succeeded',receipt:{shippingCost:{costRecordId:'cost-1'}}});expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][1].method).toBeUndefined();
});
it.each(['POST','recovered','history'])('never accepts another shipping source fingerprint via %s',async path=>{
 vi.stubGlobal('crypto',webcrypto);const r:any={...receipt(),shippingCost:{status:'registered',amount:'18.5000',currency:'CNY',incurredAt:'2026-10-01',sourceFingerprint:'c'.repeat(64),costRecordId:'cost-1',recordNo:'COST-1'}};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({item:path==='recovered'?{status:'succeeded',receipt:r}:path==='history'?{items:[r],total:1,limit:1,offset:0}:r}),{status:200})));
 await expect(path==='POST'?developmentPhysicalSampleService.shipToFactory('c',input):path==='recovered'?developmentPhysicalSampleService.readResolution('c','factory',input):developmentPhysicalSampleService.listHistory('c',{limit:1,offset:0})).rejects.toThrow('费用来源');
});
it('accepts exact free shipping without a cost row and keeps old immutable receipts distinguishable',()=>{
 const zero={...input,shippingFee:'0.0000'},free:any={...receipt(),inputSnapshot:zero,shipping:{...zero},shippingCost:{status:'free',amount:'0',currency:'CNY',incurredAt:'2026-10-01',sourceFingerprint:'c'.repeat(64)}};
 expect(verifyDevelopmentPhysicalReceipt('c','factory','sales',zero,free).shippingCost?.status).toBe('free');
 expect(verifyDevelopmentPhysicalReceipt('c','factory','sales',input,receipt() as any).shippingCost).toBeUndefined();
});
it.each(['amount','currency','date','status','id','number','source','null'])('rejects a corrupted shipping expense %s acknowledgement',field=>{
 const r:any={...receipt(),shippingCost:{status:'registered',amount:'18.5000',currency:'CNY',incurredAt:'2026-10-01',sourceFingerprint:'c'.repeat(64),costRecordId:'cost-1',recordNo:'COST-1'}};
 if(field==='amount')r.shippingCost.amount='0';if(field==='currency')r.shippingCost.currency='USD';if(field==='date')r.shippingCost.incurredAt='2026-10-02';if(field==='status')r.shippingCost.status='free';if(field==='id')delete r.shippingCost.costRecordId;if(field==='number')delete r.shippingCost.recordNo;if(field==='source')r.shippingCost.sourceFingerprint='unknown';if(field==='null')r.shippingCost=null;
 expect(()=>verifyDevelopmentPhysicalReceipt('c','factory','sales',input,r)).toThrow('费用回执');
});
it('rejects a cost row attached to a zero fee and retains a four-decimal nonzero expense',()=>{
 const zero={...input,shippingFee:'0'},r:any={...receipt(),inputSnapshot:zero,shipping:{...zero},shippingCost:{status:'free',amount:'0',currency:'CNY',incurredAt:'2026-10-01',sourceFingerprint:'c'.repeat(64),costRecordId:'cost-1'}};
 expect(()=>verifyDevelopmentPhysicalReceipt('c','factory','sales',zero,r)).toThrow('费用回执');
 const tiny={...input,shippingFee:'0.0001'};r.inputSnapshot=tiny;r.shipping={...tiny};r.shippingCost={...r.shippingCost,status:'registered',amount:'0.0001',recordNo:'COST-1'};
 expect(verifyDevelopmentPhysicalReceipt('c','factory','sales',tiny,r).shippingCost?.status).toBe('registered');
});
