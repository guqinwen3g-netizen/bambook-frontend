import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,mistCommandPermission,type MistContext,type MistCommand} from './mistWorkspace';

function fixture(){
  let id=0;const ctx={id:()=>`crm-${++id}`,now:'2026-10-14T02:00:00Z',actorId:'sales',actorName:'顾言'} as MistContext;
  let state=createMistState(ctx,'demo');
  const run=(command:MistCommand)=>{const result=applyMistCommand(state,command,ctx);state=result.state;return result.result as {id:string};};
  const customer=state.customers[0],order=state.orders.find(o=>o.customerId===customer.id)!,other=state.orders.find(o=>o.customerId!==customer.id);
  return {run,customer,order,other,get state(){return state;}};
}
const opp=(customerId:string,patch={})=>({customerId,title:'春夏大衣补单',domain:'garment' as const,amount:'48000.00',currency:'usd',expectedDate:'2026-12-01',owner:'顾言',note:'',devIds:[],quotationIds:[],orderIds:[],...patch});

describe('客户关系：跟进与商机',()=>{
  it('空白空间为空切片，命令需要关系写权限',()=>{
    expect(createMistState({id:()=>'x',now:'2026-10-14T02:00:00Z',actorName:'a'} as MistContext,'empty').crm).toEqual({followUps:[],opportunities:[]});
    expect(mistCommandPermission({type:'crm.opportunity.stage',payload:{id:'x',stage:'won',note:''}})).toBe('relations:write');
  });
  it('跟进须为已发生时间；下次跟进日生成待办；关联对象须属于同一客户',()=>{
    const f=fixture();
    expect(()=>f.run({type:'crm.followUp.save',payload:{customerId:f.customer.id,method:'call',content:'确认交期',at:'2026-10-15T08:00:00Z',nextDate:'',link:null}})).toThrow('已发生');
    if(f.other)expect(()=>f.run({type:'crm.followUp.save',payload:{customerId:f.customer.id,method:'call',content:'确认交期',at:'2026-10-14T01:00:00Z',nextDate:'',link:{kind:'order',id:f.other.id}}})).toThrow('不属于该客户');
    f.run({type:'crm.followUp.save',payload:{customerId:f.customer.id,method:'meeting',content:'确认交期与 PI',at:'2026-10-14T01:00:00Z',nextDate:'2026-10-20',link:{kind:'order',id:f.order.id}}});
    const row=f.state.crm.followUps[0];
    expect(row).toMatchObject({method:'meeting',nextDate:'2026-10-20',actor:'顾言'});
    expect(f.state.tasks.find(t=>t.id===row.nextTaskId)).toMatchObject({kind:'crm-follow-up',due:'2026-10-20'});
  });
  it('商机按原币种保存；下单须关联实际订单；流失须写原因且结束后不可修改',()=>{
    const f=fixture();
    const {id}=f.run({type:'crm.opportunity.save',payload:{input:opp(f.customer.id)}});
    expect(f.state.crm.opportunities[0]).toMatchObject({stage:'intent',currency:'USD',amount:'48000.00'});
    expect(()=>f.run({type:'crm.opportunity.stage',payload:{id,stage:'won',note:''}})).toThrow('关联实际订单');
    expect(()=>f.run({type:'crm.opportunity.stage',payload:{id,stage:'lost',note:''}})).toThrow('流失原因');
    f.run({type:'crm.opportunity.stage',payload:{id,stage:'sampling',note:'寄首样'}});
    f.run({type:'crm.opportunity.save',payload:{id,input:opp(f.customer.id,{orderIds:[f.order.id]})}});
    f.run({type:'crm.opportunity.stage',payload:{id,stage:'won',note:'客户下 PO'}});
    const row=f.state.crm.opportunities[0];
    expect(row.history.map(h=>h.to)).toEqual(['intent','sampling','won']);
    expect(()=>f.run({type:'crm.opportunity.save',payload:{id,input:opp(f.customer.id)}})).toThrow('已结束');
  });
});
