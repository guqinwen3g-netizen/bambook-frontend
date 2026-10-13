import {createHash} from 'node:crypto';
import {renderHtmlToPdf,type PdfRenderResult} from '../templates/pdf';
import {renderCreditNoteHtml} from '../templates/creditNote';
import {MistCommandError,type MistContext,type MistState} from '../shared/mistWorkspace';
import {assertCreditSourceVersions,canonicalCreditDocument,createCreditPrintSnapshot,creditDocumentFingerprint,type MistCreditPrintSnapshot,type MistCreditPrintVersion,type MistCreditDocumentIssue} from '../shared/mistCreditDocuments';
import type {MistStoredFile,MistFileInput} from './files';

export {prepareCreditDocumentSnapshot,assertCreditIssuePayload,assertCreditDocumentIssue} from '../shared/mistCreditDocuments';
export type {MistCreditDocumentIssue} from '../shared/mistCreditDocuments';
export type PreparedCreditIssueArchive={creditId:string;versionId:string;snapshot:MistCreditPrintSnapshot;snapshotFingerprint:string;file:MistFileInput;sha256:string;bytes:number};
type IssueContext=Pick<MistContext,'now'|'actorName'|'actorId'>;
const fail=(message:string):never=>{throw new MistCommandError('CREDIT_DOCUMENT_PRECONDITION',message,422);};
export async function buildIssueArchive(snapshot:MistCreditPrintSnapshot,options:{draft?:boolean;renderPdf?:(html:string)=>Promise<PdfRenderResult>}={}):Promise<PreparedCreditIssueArchive>{
 const result=await(options.renderPdf||((html:string)=>renderHtmlToPdf(html,{format:'A4'})))(renderCreditNoteHtml(snapshot,{draft:options.draft}));const bytes=Buffer.from(result.pdf);if(bytes.length<10||bytes.subarray(0,5).toString()!=='%PDF-'||!bytes.subarray(Math.max(0,bytes.length-1024)).toString('ascii').includes('%%EOF'))return fail('PDF渲染未返回有效原件');const sha=createHash('sha256').update(bytes).digest('hex');if(result.sha!==sha||result.bytes!==bytes.length)return fail('PDF原件哈希或大小不一致');return{creditId:snapshot.creditId,versionId:snapshot.sourceVersionId,snapshot:structuredClone(snapshot),snapshotFingerprint:creditDocumentFingerprint(snapshot),file:{bytes,name:snapshot.code+'-v'+snapshot.sourceVersion+(options.draft?'-DRAFT':'')+'.pdf',mimeType:'application/pdf'},sha256:sha,bytes:bytes.length};
}
export function bindIssueArchive(prepared:PreparedCreditIssueArchive,file:MistStoredFile,context:{id:()=>string;workspaceId:string;requestId:string}):MistCreditDocumentIssue{
 if(prepared.file.name.includes('-DRAFT')||file.mimeType!=='application/pdf'||file.size!==prepared.bytes||file.name!==prepared.file.name||file.storageKey!==context.workspaceId+'/'+file.id||!context.requestId)return fail('正式CN原件未按当前工作区安全归档');if(createHash('sha256').update(Buffer.from(prepared.file.bytes)).digest('hex')!==prepared.sha256)return fail('待归档PDF字节已变化');const s=prepared.snapshot;
 return{creditId:prepared.creditId,versionId:prepared.versionId,requestId:context.requestId,file:structuredClone(file),printVersion:{id:context.id(),version:s.sourceVersion,sourceVersionId:s.sourceVersionId,sourceFingerprint:s.sourceFingerprint,templateId:s.templateId,templateVersion:s.templateVersion,snapshot:structuredClone(s),snapshotFingerprint:prepared.snapshotFingerprint,issuedAt:s.issuedAt,issuedById:s.issuedById,issuedBy:s.issuedBy,fileId:file.id,fileName:file.name,sha256:prepared.sha256,bytes:prepared.bytes}};
}
export function assertIssuedCreditArchive(version:MistCreditPrintVersion,bytes:Buffer|Uint8Array){const body=Buffer.from(bytes);if(version.snapshotFingerprint!==creditDocumentFingerprint(version.snapshot)||version.sourceFingerprint!==version.snapshot.sourceFingerprint||version.sourceVersionId!==version.snapshot.sourceVersionId||version.version!==version.snapshot.sourceVersion||version.templateId!==version.snapshot.templateId||version.templateVersion!==version.snapshot.templateVersion||body.length!==version.bytes||createHash('sha256').update(body).digest('hex')!==version.sha256)fail('正式CN归档原件校验失败');return body;}
