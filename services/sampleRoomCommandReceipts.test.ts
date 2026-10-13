import {beforeEach,it,expect,vi} from 'vitest';
import {createHash,webcrypto} from 'node:crypto';
const state=vi.hoisted(()=>({identity:'CURRENT',actorId:'ACTUAL',response:null as any}));
vi.mock('./authService',()=>({getAuthState:()=>({user:{id:state.actorId}}),subscribe:()=>()=>{}}));
vi.mock('./dashboardTaskService',()=>({dashboardReadIdentity:()=>state.identity}));
vi.mock('./apiService',()=>({apiService:{getStoredConfig:()=>({cloudEndpoint:'https://synthetic.invalid'}),getAuthHeaders:()=>({}),buildApiUrl:(p:string)=>p}}));
import {sampleRoomService} from './sampleRoomService';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=(v:any,sort=true)=>createHash('sha256').update(JSON.stringify(sort?canonical(v):v)).digest('hex');
const input={shipQuantity:1,recipientName:'Customer',requestKey:'ORIGINAL'};
function receipt(){return {loan:{id:'LOAN',itemId:'CARD',loanType:'ship',loanQuantity:1,loanLength:null,borrowerName:'Customer',borrowerUserId:null,relationId:null,dueAt:null,operatorId:'ACTUAL',meterRequestKey:'ORIGINAL',meterCommandHash:digest({stockVersion:1,operation:'ship',itemId:'CARD',quantity:1,unit:'PC',name:'Customer',dueAt:null,relationId:null,borrowerUserId:null})},item:{id:'CARD',unit:'PC'}};}
beforeEach(()=>{state.identity='CURRENT';state.actorId='ACTUAL';state.response=receipt();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>state.response})));});
it('accepts an exact original counted shipment receipt independently of current stock',async()=>{
 state.response.item={...state.response.item,status:'shipped',availableQty:0,quantity:0};
 expect((await sampleRoomService.shipItem('CARD',input)).loan.id).toBe('LOAN');
});
it.each(['operatorId','meterRequestKey','meterCommandHash','itemId','loanType'])('retains uncertainty when successful HTTP receipt changes %s',async field=>{
 state.response.loan[field]='OTHER';await expect(sampleRoomService.shipItem('CARD',input)).rejects.toThrow('回执');
});
it('rejects a successful response from an earlier login context',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>{state.identity='OTHER';return {ok:true,json:async()=>state.response};}));
 await expect(sampleRoomService.shipItem('CARD',input)).rejects.toThrow('会话');
});
it('verifies the original metre quantity with its exact normalized command hash',async()=>{
 state.response={loan:{id:'LM',itemId:'CARD',loanType:'borrow',loanQuantity:0,loanLength:'0.125',borrowerName:'Actual',borrowerUserId:null,relationId:null,dueAt:1000,operatorId:'ACTUAL',meterRequestKey:'MKEY',meterCommandHash:digest({operation:'borrow',itemId:'CARD',length:'0.125',name:'Actual',dueAt:1000,relationId:null,borrowerUserId:null},false)},item:{id:'CARD',unit:'米'}};
 const body={loanType:'borrow' as const,loanLength:'0.1250',borrowerName:'Actual',dueAt:1000,requestKey:'MKEY'};
 expect((await sampleRoomService.createLoan('CARD',body)).loan.id).toBe('LM');
 state.response.loan.loanLength='0.25';await expect(sampleRoomService.createLoan('CARD',body)).rejects.toThrow('回执');
});
it('requires an exact original partial-return event before accepting current balance readback',async()=>{
 const body={returnQuantity:1,requestKey:'RETURN',conditionNote:'Good'};
 state.response={loan:{id:'LOAN',itemId:'CARD',countReturnHistory:[{requestKey:'RETURN',operatorId:'ACTUAL',quantity:1,conditionNote:'Good',commandHash:digest({loanId:'LOAN',returnQuantity:1,conditionNote:'Good'})}]},item:{id:'CARD'}};
 expect((await sampleRoomService.returnLoan('LOAN',body)).loan.id).toBe('LOAN');
 state.response.loan.countReturnHistory=[];await expect(sampleRoomService.returnLoan('LOAN',body)).rejects.toThrow('回执');
});
