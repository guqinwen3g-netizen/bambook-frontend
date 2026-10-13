import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PRIVATE_FILES_DIR,isInsideDir} from '../lib/privateFiles';
export const COST_EVIDENCE_MAX_BYTES=10*1024*1024;
function fail(code:string,message:string,status=400):never{throw Object.assign(Error(message),{code,status,httpStatus:status});}
export function inspectCostEvidenceFile(bytes:Buffer,originalName:string){
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>COST_EVIDENCE_MAX_BYTES)fail('INVALID_FILE_SIZE','凭据文件为空或超过10MiB');
 const name=path.basename(String(originalName).replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'').trim();
 if(!name||name.length>180)fail('INVALID_FILE_NAME','凭据文件名无效或过长');
 const ext=path.extname(name).toLowerCase();
 const pdf=bytes.subarray(0,5).equals(Buffer.from('%PDF-'));
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const mimeType=ext==='.pdf'&&pdf?'application/pdf':ext==='.png'&&png?'image/png':['.jpg','.jpeg'].includes(ext)&&jpeg?'image/jpeg':null;
 if(!mimeType)fail('INVALID_FILE_TYPE','凭据仅支持内容与扩展名一致的PDF、PNG或JPEG');
 return {originalName:name,mimeType,byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
/** Files are never rendered or published under the anonymous uploads root. */
export function createCostEvidenceFiles(root=path.join(PRIVATE_FILES_DIR,'development-cost-evidence')){
 function location(key:string){
  if(!/^[0-9a-f-]{36}\.bin$/.test(key))fail('INVALID_STORAGE_KEY','凭据存储标识无效',500);
  const file=path.resolve(root,key);
  if(!isInsideDir(root,file))fail('INVALID_STORAGE_KEY','凭据存储标识无效',500);
  return file;
 }
 return {
  async put(bytes:Buffer,originalName:string){
   const metadata=inspectCostEvidenceFile(bytes,originalName);const storageKey=`${randomUUID()}.bin`;
   await fs.mkdir(root,{recursive:true,mode:0o700});await fs.writeFile(location(storageKey),bytes,{flag:'wx',mode:0o600});
   return {...metadata,storageKey};
  },
  async read(row:{storageKey:string;sha256:string;byteSize:number}){
   let bytes:Buffer;
   try{bytes=await fs.readFile(location(row.storageKey));}catch(error:any){if(error.code==='ENOENT')fail('EVIDENCE_FILE_MISSING','凭据原文件缺失，请联系负责人核查',409);throw error;}
   if(bytes.length!==row.byteSize||createHash('sha256').update(bytes).digest('hex')!==row.sha256)fail('EVIDENCE_INTEGRITY_FAILED','凭据原文件校验失败，请联系负责人核查',409);
   return bytes;
  },
  async removeUnreferenced(key:string){await fs.unlink(location(key)).catch(error=>{if(error.code!=='ENOENT')throw error;});},
 };
}
