import {DevelopmentWorkError, developmentAssignee, fabricSearchEligibleTeams} from './developmentPersonnelService';
import {writeRouteAuditLog} from '../audit/routeAudit';
export const searchHandlerId=(task:any)=>task.status==='awaiting_confirmation'?task.requesterId:task.status==='completed'?null:task.assigneeId || task.responsibleHeadId;
export const searchActionLabel=(task:any)=>({unclaimed:'分配或认领寻样',pending:'接手寻样',in_progress:'查找面料并反馈',awaiting_confirmation:'确认寻样结果',completed:'查看最终结果'}[task.status as string] || '核对任务');
export async function transitionFabricSearch(tx:any, task:any, actor:any, action:string, input:any, include:any){
 if(!Number.isInteger(input.expectedRevision)||task.revision!==input.expectedRevision)throw new DevelopmentWorkError('REVISION_CONFLICT','任务已更新，请重新打开后操作。',409);
 const fail=()=>{throw new DevelopmentWorkError('INVALID_TRANSITION','当前状态或身份不能执行此操作。',409);};
 const data:any={};
 const note=typeof input.note==='string'?input.note.trim().slice(0,4000):'';
 if(action==='claim') {
  if(task.status!=='unclaimed'||task.assigneeId||!task.routingTeamId)fail();
  const teams=await fabricSearchEligibleTeams(tx,actor.id,actor.trustedActor);
  if(!teams.includes(task.routingTeamId))fail();
  await developmentAssignee(tx,actor.id,actor.id,'fabric',actor.trustedActor);
  data.assigneeId=actor.id;data.status='in_progress';
 }
 else if(action==='assign') {
  if(task.status!=='unclaimed'||task.assigneeId||actor.id!==task.responsibleHeadId)fail();
  const assignee=await developmentAssignee(tx,actor.id,input.assigneeId,'fabric',actor.trustedActor);
  if(!assignee.teams.some((team:any)=>team.id===task.routingTeamId))fail();
  data.assigneeId=assignee.id;data.status=assignee.id===actor.id?'in_progress':'pending';
 }
 else if(action==='accept') {if(task.status!=='pending'||actor.id!==task.assigneeId)fail();data.status='in_progress';}
 else if(action==='transfer') {if(!['pending','in_progress'].includes(task.status)||(actor.id!==task.assigneeId&&actor.id!==task.requesterId&&actor.id!==task.responsibleHeadId))fail();if(!note)throw new DevelopmentWorkError('REASON_REQUIRED','请填写转交原因。');await developmentAssignee(tx,actor.id,input.assigneeId,'fabric',actor.trustedActor);if(input.assigneeId===task.assigneeId)throw new DevelopmentWorkError('INVALID_ASSIGNEE','请选择另一位跟进人。');data.assigneeId=input.assigneeId;data.status='pending';}
 else if(action==='submit') {if(task.status!=='in_progress'||actor.id!==task.assigneeId)fail();if(!note)throw new DevelopmentWorkError('REASON_REQUIRED','请填写反馈说明。');if(!task.results.length&&input.noMatch!==true)throw new DevelopmentWorkError('NO_RESULTS','请添加候选档案，或明确选择暂无匹配。');if(task.results.some((r:any)=>r.asset.deletedAt!==null||r.asset.mainCategory!=='Fabric'))throw new DevelopmentWorkError('INVALID_ASSETS','部分候选档案已失效，请重新选择。');data.status='awaiting_confirmation';data.feedbackNote=note;}
 else if(action==='return') {if(task.status!=='awaiting_confirmation'||actor.id!==task.requesterId)fail();if(!note)throw new DevelopmentWorkError('REASON_REQUIRED','请填写需要补充或调整的要求。');data.status='in_progress';if(typeof input.requestText==='string'&&input.requestText.trim())data.requestText=input.requestText.trim().slice(0,4000);}
 else if(action==='confirm') {if(task.status!=='awaiting_confirmation'||actor.id!==task.requesterId)fail();data.status='completed';data.completedAt=new Date();data.completionNote=note||task.feedbackNote;}
 else fail();
 const history=Array.isArray(task.flowHistory)?task.flowHistory:[];
 data.flowHistory=[...history,{action,actorId:actor.id,actorName:actor.displayName,at:new Date().toISOString(),from:task.status,to:data.status,note,assigneeId:data.assigneeId||task.assigneeId}];
 const locked=await tx.fabricSearchTask.updateMany({where:{id:task.id,revision:task.revision,status:task.status,...(task.status==='unclaimed'?{assigneeId:null}:{})},data:{revision:{increment:1}}});if(!locked.count)throw new DevelopmentWorkError('REVISION_CONFLICT','任务已更新，请重新打开。',409);
 const updated=await tx.fabricSearchTask.update({where:{id:task.id},data,include});
 await writeRouteAuditLog({prisma:tx,actorId:actor.id,source:'user-session',operation:`fabric-search.${action}`,targetType:'fabric-search',targetId:task.id,before:{status:task.status,revision:task.revision},after:{status:updated.status,revision:updated.revision,note}});
 const receiver=updated.status==='completed'?task.assigneeId:searchHandlerId(updated);
 if(receiver&&receiver!==actor.id)await tx.notification.create({data:{userId:receiver,type:'fabric_search_flow',title:`面料寻样 · ${searchActionLabel(updated)}`,body:`${updated.name}${note?'：'+note:''}`,link:`/development?id=${task.id}&tab=fabric-search`}});
 return updated;
}
