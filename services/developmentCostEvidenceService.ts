import {apiService} from './apiService';
export interface CostEvidence {id:string;costRecordId?:string;originalName:string;mimeType:string;byteSize:number;sha256:string;note:string;createdBy:string;createdAt:string;revokedAt?:string|null;revokeReason?:string|null}
export class EvidenceError extends Error{constructor(message:string,public status:number){super(message);}}
function url(path:string){return apiService.buildApiUrl(`/v1/development/${path}`,apiService.getStoredConfig().cloudEndpoint);}
const segment=encodeURIComponent;
const base=(caseId:string,costId:string)=>`${segment(caseId)}/costs/${segment(costId)}/evidence`;
async function checked(response:Response){if(!response.ok){const body=await response.json().catch(()=>null);throw new EvidenceError(body?.error?.message||'凭据处理失败，请重试',response.status);}return response;}
async function download(path:string,name:string){
 const response=await checked(await fetch(url(path),{headers:apiService.getAuthHeaders()}));const blob=await response.blob();const href=URL.createObjectURL(blob);
 const a=document.createElement('a');a.href=href;a.download=name;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);
}
export const developmentCostEvidenceService={
 async upload(caseId:string,costId:string,command:{file:File;note:string;requestKey:string}):Promise<{evidence:CostEvidence}>{
  const form=new FormData();form.append('file',command.file);form.append('note',command.note);form.append('requestKey',command.requestKey);form.append('originalName',command.file.name);
  const headers=new Headers(apiService.getAuthHeaders());headers.delete('Content-Type');
  return (await checked(await fetch(url(base(caseId,costId)),{method:'POST',headers,body:form}))).json();
 },
 async revoke(caseId:string,costId:string,evidenceId:string,reason:string):Promise<{evidence:CostEvidence}>{
  return (await checked(await fetch(url(`${base(caseId,costId)}/${segment(evidenceId)}/revoke`),{method:'POST',headers:apiService.getAuthHeaders(),body:JSON.stringify({reason})}))).json();
 },
 download:(caseId:string,costId:string,evidence:CostEvidence)=>download(`${base(caseId,costId)}/${segment(evidence.id)}/download`,evidence.originalName),
 financeDownload:(taskId:string,costId:string,evidence:CostEvidence)=>download(`finance-tasks/${segment(taskId)}/costs/${segment(costId)}/evidence/${segment(evidence.id)}/download`,evidence.originalName),
};
