import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const m=vi.hoisted(()=>({actor:'sales',identityError:false,token:'a',endpoint:'https://native.invalid',ceiling:'full',write:true,listeners:new Set<()=>void>(),post:vi.fn(),get:vi.fn(),list:vi.fn(),items:vi.fn(),versions:vi.fn(),warehouses:vi.fn(),item:vi.fn(),upload:vi.fn(),photo:vi.fn(),resolve:vi.fn()}));
vi.mock('./authService',()=>({getAuthState:()=>({isAuthenticated:true,isLoading:false,user:{id:m.actor}}),hasPermission:(p:string)=>p.endsWith(':read')||m.write,subscribe:(fn:()=>void)=>{m.listeners.add(fn);return()=>m.listeners.delete(fn)}}));
vi.mock('./dashboardTaskService',()=>({dashboardReadIdentity:()=>{if(m.identityError)throw Error('storage identity unavailable');return JSON.stringify([m.actor,m.token,m.endpoint,m.ceiling,m.write]);}}));
vi.mock('./apiService',()=>({apiService:{getStoredConfig:()=>({cloudEndpoint:m.endpoint}),buildApiUrl:(path:string,base:string)=>base.replace(/\/api$/,'')+'/api'+path,listWarehouses:(...a:any[])=>m.warehouses(...a)}}));
vi.mock('./developmentService',()=>({developmentService:{listSampleBatches:(...a:any[])=>m.versions(...a)}}));
vi.mock('./sampleRoomService',()=>({sampleRoomService:{listItems:(...a:any[])=>m.items(...a),getItem:(...a:any[])=>m.item(...a),uploadPhoto:(...a:any[])=>m.upload(...a),loadPrivatePhoto:(...a:any[])=>m.photo(...a)}}));
vi.mock('./developmentPhysicalSampleService',async original=>{const actual=await original<any>();return {...actual,developmentPhysicalSampleService:{registerIncoming:(...a:any[])=>m.post(...a),shipToFactory:(...a:any[])=>m.post(...a),readReceipt:(...a:any[])=>m.get(...a),listHistory:(...a:any[])=>m.list(...a),resolveCommand:(...a:any[])=>m.resolve(...a),readResolution:async(...a:any[])=>{const result=await m.get(...a);return result?.status?result:{status:'succeeded',receipt:result};}}}});
import { createDevelopmentPhysicalUiSession } from './developmentPhysicalSampleUiService';
const body={name:'Actual sample',cardType:'fabric',quantity:1,unit:'M',physicalLengthQty:'2.5000',receivedDate:'2026-10-01',form:'piece',sourceType:'customer_sample' as const,sourceName:'Customer'};
const ack=(input:any)=>({inputSnapshot:input,itemId:'card',itemCode:'SC-1',caseId:'c',auditId:'audit',replayed:false,command:{actorId:'sales',kind:'incoming',requestKey:input.requestKey,fingerprint:'a'.repeat(64)},incoming:{receivedDate:input.receivedDate,form:input.form,sourceType:input.sourceType,sourceName:input.sourceName},physical:{name:input.name,cardType:input.cardType,quantity:input.quantity,unit:input.unit,physicalLengthQty:'2.5'},photoUploadItemId:'card'});
const open=(canWrite=true)=>createDevelopmentPhysicalUiSession({caseId:'c',caseType:'fabric',canWrite});
let sessions:Array<ReturnType<typeof open>>=[];
const session=(canWrite=true)=>{const value=open(canWrite);sessions.push(value);return value;};
beforeEach(()=>{
 localStorage.clear();m.actor='sales';m.identityError=false;m.token='a';m.endpoint='https://native.invalid';m.ceiling='full';m.write=true;Object.values(m).filter(v=>typeof v==='function').forEach(v=>(v as any).mockReset());
 vi.stubGlobal('crypto',webcrypto);const queues=new Map<string,Promise<unknown>>();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(key:string,run:()=>unknown)=>{const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(run);queues.set(key,next);return next;}}});
 m.post.mockImplementation(async(_caseId:string,input:any)=>ack(input));m.warehouses.mockResolvedValue([]);m.item.mockResolvedValue({item:{id:'card',devCaseId:'c',photos:[]}});
});
afterEach(()=>{sessions.forEach(s=>s.dispose());sessions=[];vi.restoreAllMocks();});
it('persists frozen original intent before sending and clears only its fully verified acknowledgement',async()=>{
 const s=session();m.post.mockImplementation(async(_caseId,input)=>{const pending=await s.pending('incoming');expect(pending?.requestId).toBe(input.requestKey);expect(Object.isFrozen(pending?.payload.body)).toBe(true);return ack(input)});
 const draft={...body};const sent=s.submit('incoming',draft);draft.name='Changed';const result=await sent;expect(result.physical?.name).toBe('Actual sample');expect(await s.pending('incoming')).toBeNull();expect(m.post).toHaveBeenCalledTimes(1);
});
it('unknown failure preserves the same key; GET404 cannot clear or create another intent',async()=>{
 const s=session();m.post.mockRejectedValue(Error('network unknown'));await expect(s.submit('incoming',body)).rejects.toThrow('unknown');const first=await s.pending('incoming');m.get.mockRejectedValue(Error('404'));
 await expect(s.recover('incoming')).rejects.toThrow('404');expect((await s.pending('incoming'))?.requestId).toBe(first?.requestId);await expect(s.submit('incoming',{...body,name:'Another'})).rejects.toThrow('原请求');expect(m.post).toHaveBeenCalledTimes(1);
});
it('explicit retry reuses only the exact frozen body and key',async()=>{
 const s=session();m.post.mockRejectedValueOnce(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();const p=await s.pending('incoming');await s.retry('incoming');expect(m.post.mock.calls[1][1]).toEqual({...body,requestKey:p?.requestId});
});
it.each(['snapshot','length','actor'])('recovered GET rejects wrong %s proof and retains pending',async field=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();const p=await s.pending('incoming'),r:any=ack({...body,requestKey:p?.requestId});if(field==='snapshot')r.inputSnapshot.name='Other';if(field==='length')r.physical.physicalLengthQty='8';if(field==='actor')r.command.actorId='other';m.get.mockResolvedValue(r);
 await expect(s.recover('incoming')).rejects.toThrow('原');expect(await s.pending('incoming')).not.toBeNull();
});
it('closed read-only dialog can recover a confirmed original receipt without any POST',async()=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();const p=await s.pending('incoming');s.dispose();const read=session(false);m.get.mockResolvedValue(ack({...body,requestKey:p?.requestId}));await read.recover('incoming');expect(await read.pending('incoming')).toBeNull();expect(m.post).toHaveBeenCalledTimes(1);
});
it.each(['token','ceiling','endpoint'])('A-B-A %s while dialog is closed permanently prevents retry after reopen',async field=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();s.dispose();const before=m[field];m[field]='other';m.listeners.forEach(fn=>fn());m[field]=before;m.listeners.forEach(fn=>fn());const reopened=session();await expect(reopened.retry('incoming')).rejects.toThrow('原请求');expect(m.post).toHaveBeenCalledTimes(1);
});
it('two tabs serialize begin/send/clear so an unknown first intent cannot be overwritten',async()=>{
 const a=session(),b=session();m.post.mockRejectedValue(Error('unknown'));const results=await Promise.allSettled([a.submit('incoming',body),b.submit('incoming',{...body,name:'Other'})]);expect(results.every(r=>r.status==='rejected')).toBe(true);expect(m.post).toHaveBeenCalledTimes(1);expect((await a.pending('incoming'))?.payload.body).toEqual(body);
});
it('storage failure and unavailable Web Locks prevent POST',async()=>{
 const s=session();const set=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('denied')});await expect(s.submit('incoming',body)).rejects.toThrow();expect(m.post).not.toHaveBeenCalled();set.mockRestore();Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});await expect(s.submit('incoming',body)).rejects.toThrow('跨窗口锁');expect(m.post).not.toHaveBeenCalled();
});
it('uses exact trialTask stamp and source-scoped stock pagination; rejects unrelated objects',async()=>{
 const s=session();m.versions.mockResolvedValue([{developmentCaseId:'c',supplierRelationId:'f',supplierName:'Factory',round:2,versionLabel:'R2-A-1',updatedAt:'batch-wrong',trialTask:{id:'version',updatedAt:'11',factoryRequirements:'Actual requirement',referenceAttachments:[]}}]);expect(await s.versions()).toMatchObject([{id:'version',updatedAt:'11'}]);m.items.mockResolvedValue({items:[{id:'other',devCaseId:'elsewhere'}],total:1,pagination:{limit:10,offset:10}});await expect(s.items(10)).rejects.toThrow('来源');expect(m.items.mock.calls[0][0]).toMatchObject({devCaseId:'c',scope:'fabric',limit:10,offset:10});
});
it('photo upload failure leaves the registered card and blocks another upload until an actual new photo is read',async()=>{
 const s=session(),r=await s.submit('incoming',body),file=new File(['abc'],'sample.png',{type:'image/png'});m.upload.mockRejectedValue(Error('unknown'));await expect(s.uploadPhoto(r,file)).rejects.toThrow('unknown');expect(s.photoUnresolved('card')).toBe(true);await expect(s.uploadPhoto(r,file)).rejects.toThrow('核对照片');await expect(s.reconcilePhotos('card')).rejects.toThrow('尚未读取');expect(s.photoUnresolved('card')).toBe(true);expect(m.post).toHaveBeenCalledTimes(1);expect(m.upload).toHaveBeenCalledTimes(1);
 const photo={id:'photo',url:'https://native.invalid/api/v1/samples/room/items/card/photos/photo?sig=signature',signature:'signature',size:3,mimeType:'image/png',uploadedAt:'1'};m.item.mockResolvedValue({item:{id:'card',devCaseId:'c',photos:[photo]}});m.photo.mockResolvedValue(new Blob(['xyz'],{type:'image/png'}));await expect(s.reconcilePhotos('card')).rejects.toThrow('原文件字节');expect(s.photoUnresolved('card')).toBe(true);m.photo.mockResolvedValue(new Blob(['abc'],{type:'image/png'}));await s.reconcilePhotos('card');expect(s.photoUnresolved('card')).toBe(false);
});
it('rejects cross-item signed photos before loading bytes',async()=>{
 const s=session();await expect(s.loadPhoto('card',{id:'photo',url:'https://native.invalid/api/v1/samples/room/items/other/photos/photo?sig=s',signature:'s',size:3,mimeType:'image/png',uploadedAt:'1'})).rejects.toThrow('范围');expect(m.photo).not.toHaveBeenCalled();
});

it('effective backend aliases share one cross-tab command lock and cache namespace',async()=>{
 const a=createDevelopmentPhysicalUiSession({caseId:'c',caseType:'fabric',canWrite:true,endpoint:'https://native.invalid'}),b=createDevelopmentPhysicalUiSession({caseId:'c',caseType:'fabric',canWrite:true,endpoint:'https://native.invalid/api'});sessions.push(a,b);m.post.mockRejectedValue(Error('unknown'));await Promise.allSettled([a.submit('incoming',body),b.submit('incoming',{...body,name:'Other'})]);expect(m.post).toHaveBeenCalledTimes(1);expect((await b.pending('incoming'))?.payload.body).toEqual(body);
});
it('cancel network failure preserves original intent; only acknowledged terminal cancellation permits a new command',async()=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();const p=await s.pending('incoming');m.resolve.mockRejectedValueOnce(Error('network unknown'));await expect(s.resolve('incoming')).rejects.toThrow('unknown');expect((await s.pending('incoming'))?.requestId).toBe(p?.requestId);m.resolve.mockResolvedValue({status:'cancelled'});expect(await s.resolve('incoming')).toMatchObject({status:'cancelled'});expect(await s.pending('incoming')).toBeNull();expect(m.post).toHaveBeenCalledTimes(1);
});
it('closed operational gate blocks new or retry but current write authority can resolve original intent',async()=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();s.dispose();const closed=createDevelopmentPhysicalUiSession({caseId:'c',caseType:'fabric',canWrite:true,canOperate:false});sessions.push(closed);await expect(closed.retry('incoming')).rejects.toThrow('暂停或已结束');m.resolve.mockResolvedValue({status:'cancelled'});await closed.resolve('incoming');expect(await closed.pending('incoming')).toBeNull();expect(m.post).toHaveBeenCalledTimes(1);
});

it('storage identity failure cannot crash module import or enable a command',async()=>{
 m.identityError=true;vi.resetModules();const module=await import('./developmentPhysicalSampleUiService');expect(()=>module.createDevelopmentPhysicalUiSession({caseId:'c',caseType:'fabric',canWrite:true})).toThrow('storage identity unavailable');expect(m.post).not.toHaveBeenCalled();m.identityError=false;
});
it('reload rotates authority epoch: old intent is GET-only until exact success or native cancellation',async()=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();const p=await s.pending('incoming');s.dispose();vi.resetModules();const module=await import('./developmentPhysicalSampleUiService');const reopened=module.createDevelopmentPhysicalUiSession({caseId:'c',caseType:'fabric',canWrite:true});sessions.push(reopened);await expect(reopened.retry('incoming')).rejects.toThrow('原请求');m.get.mockResolvedValue(ack({...body,requestKey:p?.requestId}));await reopened.recover('incoming');expect(await reopened.pending('incoming')).toBeNull();expect(m.post).toHaveBeenCalledTimes(1);
});

it('read-only GET acknowledges an existing cancellation after its response was lost, without issuing resolve POST',async()=>{
 const s=session();m.post.mockRejectedValue(Error('unknown'));await expect(s.submit('incoming',body)).rejects.toThrow();s.dispose();const readonly=session(false);m.get.mockResolvedValue({status:'cancelled'});await readonly.recover('incoming');expect(await readonly.pending('incoming')).toBeNull();expect(m.resolve).not.toHaveBeenCalled();expect(m.post).toHaveBeenCalledTimes(1);
});
it('upload acknowledgement requires authorized matching bytes and retains marker across private fetch failure',async()=>{
 const s=session(),r=await s.submit('incoming',body),file=new File(['abc'],'sample.png',{type:'image/png'});const photo={id:'new',url:'https://native.invalid/api/v1/samples/room/items/card/photos/new?sig=s',signature:'s',size:3,mimeType:'image/png',uploadedAt:'1'};
 m.upload.mockResolvedValue({item:{id:'card',devCaseId:'c',photos:[photo]}});m.photo.mockResolvedValue(new Blob(['xyz'],{type:'image/png'}));await expect(s.uploadPhoto(r,file)).rejects.toThrow('原文件字节');expect(s.photoUnresolved('card')).toBe(true);
 m.item.mockResolvedValue({item:{id:'card',devCaseId:'c',photos:[photo]}});m.photo.mockRejectedValue(Error('private fetch failed'));await expect(s.reconcilePhotos('card')).rejects.toThrow('private fetch failed');expect(s.photoUnresolved('card')).toBe(true);
 m.photo.mockResolvedValue(new Blob(['abc'],{type:'image/png'}));await s.reconcilePhotos('card');expect(s.photoUnresolved('card')).toBe(false);
});
it('disposal during matching photo fetch preserves the exact unresolved marker',async()=>{
 const s=session(),r=await s.submit('incoming',body),file=new File(['abc'],'sample.png',{type:'image/png'});m.upload.mockRejectedValue(Error('unknown'));await expect(s.uploadPhoto(r,file)).rejects.toThrow('unknown');const key=Object.keys(localStorage).find(k=>k.includes(':photo:'))!,marker=localStorage.getItem(key);
 const photo={id:'new',url:'https://native.invalid/api/v1/samples/room/items/card/photos/new?sig=s',signature:'s',size:3,mimeType:'image/png',uploadedAt:'1'};m.item.mockResolvedValue({item:{id:'card',devCaseId:'c',photos:[photo]}});m.photo.mockImplementation(async()=>{s.dispose();return new Blob(['abc'],{type:'image/png'});});await expect(s.reconcilePhotos('card')).rejects.toThrow();expect(localStorage.getItem(key)).toBe(marker);
});
it('failure reading original file bytes prevents the photo POST',async()=>{
 const s=session(),r=await s.submit('incoming',body),file=new File(['abc'],'sample.png',{type:'image/png'});Object.defineProperty(file,'arrayBuffer',{value:()=>Promise.reject(Error('bytes unavailable'))});await expect(s.uploadPhoto(r,file)).rejects.toThrow('bytes unavailable');expect(m.upload).not.toHaveBeenCalled();expect(s.photoUnresolved('card')).toBe(false);
});
