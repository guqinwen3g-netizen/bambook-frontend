import { apiService } from './apiService';
import { getAuthApiBase,getAuthState } from './authService';
import type { WorkflowAcknowledgement,WorkflowInstance,WorkflowStepCommand,WorkflowRequestResult } from '../types';

type Action='create'|'approve'|'reject'|'cancel';
export interface PendingWorkflowCommand {
  schemaVersion: 1;
  actorId: string;
  endpoint: string;
  action: Action;
  target: string;
  clientRequestId: string;
  command: Record<string,unknown>;
  retirement?: { clientRequestId: string; reason: string };
}
const PREFIX='bambook_workflow_request_v1:';
const current=() => {
  const actorId=getAuthState().user?.id;
  if(!actorId) throw Error('请先登录后再办理工作流');
  return { actorId,endpoint: getAuthApiBase() };
};
const key=(p: Pick<PendingWorkflowCommand,'actorId'|'endpoint'|'target'>) => PREFIX+JSON.stringify([p.endpoint,p.actorId,p.target]);
const canonical=(value: unknown): unknown => Array.isArray(value)? value.map(canonical)
  :value&&typeof value==='object'? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a<b? -1:a>b? 1:0).map(([k,v]) => [k,canonical(v)])):value;
async function hash(value: unknown): Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(bytes),byte => byte.toString(16).padStart(2,'0')).join('');
}
export function pendingWorkflowCommands(): PendingWorkflowCommand[] {
  const session=current(),result: PendingWorkflowCommand[]=[];
  for(let i=0;i<sessionStorage.length;i++) {
    const name=sessionStorage.key(i);
    if(!name?.startsWith(PREFIX)) continue;
    let row: PendingWorkflowCommand;
    try { row=JSON.parse(sessionStorage.getItem(name)!); } catch { throw Error('未完成请求记录无法读取，请核对工作流历史后再办理'); }
    if(row.actorId!==session.actorId||row.endpoint!==session.endpoint) continue;
    if(row.schemaVersion!==1||!['create','approve','reject','cancel'].includes(row.action)||!row.clientRequestId||!row.command||key(row)!==name
      ||(row.retirement&&(!row.retirement.clientRequestId||typeof row.retirement.reason!=='string'||!row.retirement.reason.trim()))) throw Error('未完成请求记录不完整，请核对工作流历史后再办理');
    result.push(row);
  }
  return result;
}
export function prepareWorkflowCommand(action: Action,target: string,command: Record<string,unknown>): PendingWorkflowCommand {
  const session=current();
  const existing=pendingWorkflowCommands().find(row => row.target===target);
  if(existing) throw Error('此来源有结果尚未确认的请求，请先重试原请求');
  const row: PendingWorkflowCommand={ schemaVersion: 1,...session,action,target,command,clientRequestId: crypto.randomUUID() };
  // A recoverable original request is a session cache, never a business fact.
  sessionStorage.setItem(key(row),JSON.stringify(row));
  return row;
}
export function workflowStepCommand(instance: WorkflowInstance): WorkflowStepCommand {
  if(instance.schemaVersion!==1||!instance.currentStepId||!instance.sourceFingerprint) throw Error('当前流程缺少可核对的审批依据，请刷新后核对历史');
  return { clientRequestId: '',expectedStepId: instance.currentStepId,expectedStepIndex: instance.currentStepIndex,sourceFingerprint: instance.sourceFingerprint };
}
export async function submitWorkflowCommand(row: PendingWorkflowCommand): Promise<WorkflowInstance> {
  const session=current();
  if(session.actorId!==row.actorId||session.endpoint!==row.endpoint) throw Error('账号或数据中心已变化，请回原账号核对这笔请求');
  const saved=pendingWorkflowCommands().find(p => p.target===row.target);
  if(!saved||JSON.stringify(saved)!==JSON.stringify(row)) throw Error('原请求记录已变化，请重新核对');
  if(row.retirement) throw Error('这笔请求正在结束，请先核对或重试结束请求');
  const expectedHash=await hash(row.command),c=row.command;
  const auditId='WFR_'+await hash({ actorId: row.actorId,parent: row.action==='create'? row.target:`instance:${row.target}`,clientRequestId: row.clientRequestId });
  let result: WorkflowInstance;
  if(row.action==='create') result=await apiService.createWorkflowInstance({
    clientRequestId: row.clientRequestId,
    definitionId: String(c.definitionId),entityType: String(c.entityType),entityId: String(c.entityId),title: String(c.title),endpoint: row.endpoint
  });
  else {
    const step: WorkflowStepCommand & { confirmedReviewedContent?: boolean; rejectionReason?: string; requestedChanges?: string } = {
      clientRequestId: row.clientRequestId,expectedStepId: String(c.expectedStepId),expectedStepIndex: Number(c.expectedStepIndex),sourceFingerprint: String(c.sourceFingerprint),
      ...(Object.prototype.hasOwnProperty.call(c, 'confirmedReviewedContent') ? { confirmedReviewedContent: c.confirmedReviewedContent as boolean } : {}),
      ...(Object.prototype.hasOwnProperty.call(c, 'rejectionReason') ? { rejectionReason: String(c.rejectionReason) } : {}),
      ...(Object.prototype.hasOwnProperty.call(c, 'requestedChanges') ? { requestedChanges: String(c.requestedChanges) } : {}),
    };
    if ((row.action === 'approve' || row.action === 'reject') && Object.prototype.hasOwnProperty.call(c, 'confirmedReviewedContent') && c.confirmedReviewedContent !== true)
      throw Error('原审批请求未记录审阅确认标记，请核对历史后结束旧请求');
    if (row.action === 'reject' && Object.prototype.hasOwnProperty.call(c, 'confirmedReviewedContent')
      && (!step.rejectionReason?.trim() || !step.requestedChanges?.trim())) throw Error('原驳回请求缺少原因或修改要求，请核对历史后结束旧请求');
    if(row.action==='cancel') result=await apiService.cancelWorkflowInstance(String(c.instanceId),String(c.reason),step,row.endpoint);
    else result=await apiService[row.action==='approve'? 'approveWorkflowStep':'rejectWorkflowStep'](String(c.instanceId),String(c.note),step,row.endpoint);
  }
  const now=current(),ack=result?.acknowledgement;
  if(now.actorId!==session.actorId||now.endpoint!==session.endpoint) throw Error('账号或数据中心已变化，请回原账号核对办理结果');
  if(!ack||ack.schemaVersion!==1||ack.action!==row.action||ack.clientRequestId!==row.clientRequestId||ack.actorId!==row.actorId
    ||ack.parameterHash!==expectedHash||ack.instanceId!==result.id||ack.auditId!==auditId||!/^[a-f0-9]{64}$/.test(ack.sourceFingerprint)
    ||!Number.isInteger(ack.currentStepIndex)||ack.currentStepIndex<0
    ||(row.action==='approve'? !['running','approved'].includes(ack.status):ack.status!==(row.action==='create'? 'running':row.action==='reject'? 'rejected':'cancelled'))
    ||result.schemaVersion!==1||result.decisionScope!=='workflow_only'||result.nativeBusinessApplied!==false
    ||(row.action==='create'? result.entityType!==c.entityType||result.entityId!==c.entityId||result.definitionId!==c.definitionId
      :ack.instanceId!==c.instanceId||ack.stepId!==c.expectedStepId||ack.sourceFingerprint!==c.sourceFingerprint)) throw Error('工作流回执与原请求不一致，请保留原请求并重试核对');
  // A replay acknowledgement describes its original fact; the current DTO may
  // already have advanced further. Never require replay to restore old state.
  sessionStorage.removeItem(key(row));
  return result;
}

function originalContext(row: PendingWorkflowCommand,allowRetirementChange=false): PendingWorkflowCommand {
  const session=current();
  if(session.actorId!==row.actorId||session.endpoint!==row.endpoint) throw Error('账号或数据中心已变化，请回原账号核对这笔请求');
  const saved=pendingWorkflowCommands().find(p => p.target===row.target);
  const original=(value: PendingWorkflowCommand) => { const { retirement: _,...rest }=value; return JSON.stringify(rest); };
  if(!saved||(allowRetirementChange? original(saved)!==original(row):JSON.stringify(saved)!==JSON.stringify(row))) throw Error('原请求记录已变化，请重新核对');
  return saved;
}
async function requestAuditId(row: PendingWorkflowCommand): Promise<string> {
  return 'WFR_'+await hash({ actorId: row.actorId,parent: row.action==='create'? row.target:`instance:${row.target}`,clientRequestId: row.clientRequestId });
}
function checkedAcknowledgement(row: PendingWorkflowCommand,ack: WorkflowAcknowledgement|undefined,parameterHash: string,auditId: string): boolean {
  const c=row.command;
  return !!ack&&ack.schemaVersion===1&&ack.action===row.action&&ack.clientRequestId===row.clientRequestId&&ack.actorId===row.actorId
    &&ack.parameterHash===parameterHash&&ack.auditId===auditId&&typeof ack.instanceId==='string'&&!!ack.instanceId
    &&/^[a-f0-9]{64}$/.test(ack.sourceFingerprint)&&Number.isInteger(ack.currentStepIndex)&&ack.currentStepIndex>=0
    &&(row.action==='approve'? ['running','approved'].includes(ack.status):ack.status===(row.action==='create'? 'running':row.action==='reject'? 'rejected':'cancelled'))
    &&(row.action==='create'? ack.stepId===null:ack.instanceId===c.instanceId&&ack.stepId===c.expectedStepId&&ack.sourceFingerprint===c.sourceFingerprint);
}
async function acceptRequestResult(row: PendingWorkflowCommand,result: WorkflowRequestResult): Promise<WorkflowRequestResult> {
  originalContext(row);
  const parameterHash=await hash(row.command),auditId=await requestAuditId(row),c=row.command,parent=result?.parent;
  const invalid=() => Error('工作流核对回执与原请求不一致，请保留原请求继续核对');
  if(result?.schemaVersion!==1||result.decisionScope!=='workflow_only'||result.nativeBusinessApplied!==false||result.actorId!==row.actorId
    ||result.action!==row.action||result.originalClientRequestId!==row.clientRequestId||result.originalParameterHash!==parameterHash
    ||!parent||!['Order','Invoice','DevelopmentCase'].includes(parent.entityType)||typeof parent.entityId!=='string'||!parent.entityId
    ||(row.action==='create'? parent.entityType!==c.entityType||parent.entityId!==c.entityId||parent.instanceId!==null:parent.instanceId!==c.instanceId)) throw invalid();
  if(result.state==='not_applied_at_check') {
    // Absence now cannot prove that an in-flight original will never commit.
    if(result.acknowledgement||result.retirement) throw invalid();
    return result;
  }
  if(result.state==='applied') {
    if(result.retirement||!checkedAcknowledgement(row,result.acknowledgement,parameterHash,auditId)) throw invalid();
  } else if(result.state==='retired') {
    const r=result.retirement;
    if(result.acknowledgement||!r||r.schemaVersion!==1||r.actorId!==row.actorId||r.action!==row.action
      ||r.originalClientRequestId!==row.clientRequestId||r.originalParameterHash!==parameterHash||r.fenceAuditId!==auditId
      ||JSON.stringify(canonical(r.parent))!==JSON.stringify(canonical(parent))||typeof r.retirementClientRequestId!=='string'||!r.retirementClientRequestId
      ||typeof r.reason!=='string'||!r.reason.trim()||typeof r.retiredAt!=='string'||!Number.isFinite(Date.parse(r.retiredAt))
      ||(row.retirement&&(r.retirementClientRequestId!==row.retirement.clientRequestId||r.reason!==row.retirement.reason))) throw invalid();
    const expected=await hash({ action: row.action,actorId: row.actorId,parent,originalClientRequestId: row.clientRequestId,
      originalParameterHash: parameterHash,retirementClientRequestId: r.retirementClientRequestId,reason: r.reason });
    if(r.retirementParameterHash!==expected) throw invalid();
  } else throw invalid();
  originalContext(row); // A late receipt must not clear a newer request or another session.
  sessionStorage.removeItem(key(row));
  return result;
}
export async function queryWorkflowCommand(row: PendingWorkflowCommand): Promise<WorkflowRequestResult> {
  originalContext(row);
  const result=await apiService.queryWorkflowRequest({ action: row.action,originalClientRequestId: row.clientRequestId,originalPayload: row.command },row.endpoint);
  return acceptRequestResult(row,result);
}
export async function retireWorkflowCommand(row: PendingWorkflowCommand,reason: string): Promise<WorkflowRequestResult> {
  const saved=originalContext(row,true),text=reason.trim();
  if(!text||text.length>2000) throw Error('请填写结束请求的说明（不超过2000字）');
  if(saved.retirement&&saved.retirement.reason!==text) throw Error('已有结果尚未确认的结束请求，请使用原说明重试');
  const request=saved.retirement? saved:{ ...saved,retirement: { clientRequestId: crypto.randomUUID(),reason: text } };
  // Save the exact retirement intent before HTTP; failures cannot silently
  // replace either its ID/reason or the original business command.
  sessionStorage.setItem(key(request),JSON.stringify(request));
  const result=await apiService.retireWorkflowRequest({ action: request.action,originalClientRequestId: request.clientRequestId,originalPayload: request.command,
    retirementClientRequestId: request.retirement!.clientRequestId,reason: request.retirement!.reason },request.endpoint);
  return acceptRequestResult(request,result);
}
