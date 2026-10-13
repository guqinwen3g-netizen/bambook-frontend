import { apiService } from './apiService';
export type FactoryNoticeTarget={kind:'version'|'trim';targetId:string};
export type FactoryNoticeFile={id?:string;reference:string;originalName:string;available:boolean;previewSupported?:boolean};
export type FactoryNoticeSnapshot={id:string;title:string;versionLabel:string;createdAt:string;sourceUpdatedAt:string;attachments:FactoryNoticeFile[]};
export type FactoryNoticeContext={target:FactoryNoticeTarget;caseCode:string;caseName:string;versionLabel:string|null;updatedAt:string;contactName:string|null;contactPhone:string|null;attachments:FactoryNoticeFile[];notices:FactoryNoticeSnapshot[]};
function url(caseId:string,path:string){return apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/${path}`,apiService.getStoredConfig().cloudEndpoint);}
async function response(caseId:string,path:string,method='GET',body?:any){const headers=apiService.getAuthHeaders();if(body instanceof FormData){for(const key of Object.keys(headers))if(key.toLowerCase()==='content-type')delete headers[key];}
 const result=await fetch(url(caseId,path),{method,headers,...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});if(!result.ok){const data=await result.json().catch(()=>null);throw Error(data?.error?.message||'工厂资料操作未完成，请核对后重试');}return result;}
const query=(target:FactoryNoticeTarget)=>new URLSearchParams(target).toString();
export const developmentFactoryNoticeService={
 read:async(caseId:string,target:FactoryNoticeTarget):Promise<FactoryNoticeContext>=>(await response(caseId,`factory-notices?${query(target)}`)).json(),
 save:async(caseId:string,target:FactoryNoticeTarget,input:{requestKey:string;expectedUpdatedAt:string;contactName?:string|null;contactPhone?:string|null}):Promise<FactoryNoticeSnapshot>=>(await response(caseId,'factory-notices','POST',{...target,...input})).json(),
 upload:async(caseId:string,target:FactoryNoticeTarget,input:{file:File;requestKey:string;expectedUpdatedAt:string;replaceReference?:string})=>{const form=new FormData();form.set('file',input.file);form.set('kind',target.kind);form.set('targetId',target.targetId);form.set('requestKey',input.requestKey);form.set('expectedUpdatedAt',input.expectedUpdatedAt);if(input.replaceReference)form.set('replaceReference',input.replaceReference);return(await response(caseId,'factory-notice-files','POST',form)).json();},
 download:async(caseId:string,id:string,zip=false)=>{const res=await response(caseId,`factory-notices/${encodeURIComponent(id)}/${zip?'attachments.zip':'notice'}`);return{blob:await res.blob(),name:zip?'附件包.zip':'通知单.html'};},
 original:async(caseId:string,target:FactoryNoticeTarget,id:string,preview=false)=>{const res=await response(caseId,`factory-notice-files/${encodeURIComponent(id)}?${query(target)}${preview?'&preview=1':''}`);return res.blob();},
};
