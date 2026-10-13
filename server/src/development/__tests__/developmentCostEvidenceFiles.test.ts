import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCostEvidenceFiles,inspectCostEvidenceFile,COST_EVIDENCE_MAX_BYTES} from '../developmentCostEvidenceFiles';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
it('验证类型签名、空文件、超限及不允许的类型',()=>{
 expect(inspectCostEvidenceFile(Buffer.from('%PDF-1.7\n'),'bill.pdf').mimeType).toBe('application/pdf');
 expect(()=>inspectCostEvidenceFile(Buffer.from('<script>'),'bill.pdf')).toThrow();
 expect(()=>inspectCostEvidenceFile(Buffer.from('%PDF-1.7'),'bill.html')).toThrow();
 expect(()=>inspectCostEvidenceFile(Buffer.alloc(0),'bill.pdf')).toThrow();
 expect(()=>inspectCostEvidenceFile(Buffer.alloc(COST_EVIDENCE_MAX_BYTES+1),'bill.pdf')).toThrow();
 expect(inspectCostEvidenceFile(Buffer.from('%PDF-1.7'),'../../bill.pdf').originalName).toBe('bill.pdf');
});
it('同名文件不覆盖，读取核验内容，删除只针对未引用的指定文件',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bambook-evidence-'));roots.push(root);const files=createCostEvidenceFiles(root);
 const first=await files.put(Buffer.from('%PDF-1.7 first'),'bill.pdf'),second=await files.put(Buffer.from('%PDF-1.7 second'),'bill.pdf');
 expect(first.storageKey).not.toBe(second.storageKey);expect((await files.read(first)).toString()).toContain('first');
 await fs.writeFile(path.join(root,first.storageKey),'corrupted');await expect(files.read(first)).rejects.toMatchObject({code:'EVIDENCE_INTEGRITY_FAILED'});
 await files.removeUnreferenced(first.storageKey);await expect(files.read(first)).rejects.toMatchObject({code:'EVIDENCE_FILE_MISSING'});
 expect((await files.read(second)).toString()).toContain('second');
 await expect(files.read({...second,storageKey:'../../secret'})).rejects.toMatchObject({code:'INVALID_STORAGE_KEY'});
});
