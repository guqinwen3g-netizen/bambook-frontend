import {describe,it,expect,vi} from 'vitest';
import {assertDevelopmentFinanceTaskCurrentInTx,completeDevelopmentFinanceTaskInTx} from '../developmentFinanceTask';
function fixture(){
 const billing:any={id:'b',sourceId:'c',developmentExpenseReviewId:'r',amount:'80',waivedAmount:'10',offsetAmount:'0',currency:'USD',bearerRelationId:'customer',status:'invoiced',invoiceId:'inv'};
 const task:any={status:'assigned',metadata:{managedBy:'development_cost_closure',caseId:'c',billingItemId:'b',reviewId:'r',amount:'80.0000',waivedAmount:'10',offsetAmount:'0',currency:'USD',bearerRelationId:'customer'}};
 const tx:any={$queryRaw:vi.fn(async()=>[]),workAssignment:{findUnique:vi.fn(async()=>task),update:vi.fn(async()=>task)},auditLog:{create:vi.fn(async()=>({}))}};
 return {billing,task,tx};
}
describe('财务交接依据与结算结果一致',()=>{
 it('金额格式不同但数值相同可完成',async()=>{const f=fixture();await completeDevelopmentFinanceTaskInTx(f.tx,f.billing,'u');expect(f.tx.workAssignment.update).toHaveBeenCalledOnce();});
 it.each(['amount','waivedAmount','offsetAmount','currency','bearerRelationId','sourceId','developmentExpenseReviewId'])('%s改变不能沿用旧交接',async key=>{
  const f=fixture();f.billing[key]=['amount','waivedAmount','offsetAmount'].includes(key)?'20':'different';
  await expect(completeDevelopmentFinanceTaskInTx(f.tx,f.billing,'u')).rejects.toMatchObject({code:'HANDOFF_CONFLICT'});expect(f.tx.workAssignment.update).not.toHaveBeenCalled();
 });
 it('已取消任务不能被改为完成',async()=>{const f=fixture();f.task.status='cancelled';await expect(assertDevelopmentFinanceTaskCurrentInTx(f.tx,f.billing)).rejects.toMatchObject({code:'HANDOFF_CONFLICT'});});
 it('损坏金额依据拒绝处理',async()=>{const f=fixture();f.task.metadata.amount='invalid';await expect(assertDevelopmentFinanceTaskCurrentInTx(f.tx,f.billing)).rejects.toMatchObject({code:'HANDOFF_CONFLICT'});});
 it('完成重试必须仍然对应同一应收结果',async()=>{const f=fixture();f.task.status='completed';f.task.metadata.result={invoiceId:'other',noReceivable:false};await expect(completeDevelopmentFinanceTaskInTx(f.tx,f.billing,'u')).rejects.toMatchObject({code:'HANDOFF_CONFLICT'});});
});
