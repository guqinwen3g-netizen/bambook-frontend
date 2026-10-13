import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PRIVATE_FILES_DIR } from '../lib/privateFiles';
export const FACTORY_FILE_LIMIT = 20 * 1024 * 1024;
export function noticeFailure(code: string, message: string, status = 409): never { throw Object.assign(new Error(message), { code, status }); }
export function inspectFactoryFile(bytes: Buffer, originalName: string) {
 const name = path.basename(String(originalName).replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim();
 const extension = path.extname(name).toLowerCase();
 if (!name || name.length > 180 || !bytes.length || bytes.length > FACTORY_FILE_LIMIT) noticeFailure('INVALID_FILE', '请选择不超过20MiB的原文件及有效文件名', 400);
 if (!['.pdf','.png','.jpg','.jpeg','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.csv','.txt','.ods','.odt'].includes(extension)) noticeFailure('INVALID_FILE_TYPE', '附件格式不支持，请保留PDF、Office、图片或文本原文件', 400);
 const mimeType = extension === '.pdf' && bytes.subarray(0,5).toString() === '%PDF-' ? 'application/pdf' : extension === '.png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : ['.jpg','.jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : 'application/octet-stream';
 if (['.pdf','.png','.jpg','.jpeg'].includes(extension) && mimeType === 'application/octet-stream') noticeFailure('INVALID_FILE_TYPE', '原文件内容与扩展名不符',400);
 return { originalName: name, mimeType, previewSupported: mimeType !== 'application/octet-stream', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function createFactoryFiles(root = path.join(PRIVATE_FILES_DIR, 'development-factory-files')) {
 const location = (key: string) => { if (!/^[0-9a-f-]{36}\.bin$/.test(key)) noticeFailure('INVALID_FILE_KEY','原文件标识无效',500); return path.join(root,key); };
 return {
  async put(bytes: Buffer, name: string) { const metadata=inspectFactoryFile(bytes,name),storageKey=`${randomUUID()}.bin`; await fs.mkdir(root,{recursive:true,mode:0o700}); await fs.writeFile(location(storageKey),bytes,{flag:'wx',mode:0o600}); return {...metadata,storageKey}; },
  async read(file: any) { let bytes:Buffer;try { bytes=await fs.readFile(location(file.storageKey)); } catch(e:any) { if(e.code==='ENOENT') noticeFailure('FILE_MISSING','该版本附件原文件缺失，请核对后重试');throw e; } if(bytes.length!==file.byteSize || createHash('sha256').update(bytes).digest('hex')!==file.sha256)noticeFailure('FILE_CHANGED','该版本附件校验失败，请核对原文件'); return bytes; },
 };
}
/** ZIP entries retain original bytes and extensions; collision prefixes never overwrite a file. */
export async function factoryAttachmentZip(files: Array<{originalName:string;bytes:Buffer}>) {
 if(!files.length)noticeFailure('NO_ATTACHMENTS','所选通知版本没有附件');
 if(files.reduce((n,f)=>n+f.bytes.length,0)>100*1024*1024)noticeFailure('PACKAGE_TOO_LARGE','附件包超过100MiB，请分别下载');
 const zip=new JSZip(); files.forEach((file,index)=>zip.file(`${String(index+1).padStart(2,'0')}-${path.basename(file.originalName.replace(/\\/g,'/'))}`,file.bytes));
 return zip.generateAsync({type:'nodebuffer',compression:'STORE'});
}
