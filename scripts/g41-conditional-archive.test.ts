/** Source-only conditional continuation proof, not native HTTP/PG authorization. */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { classifyGuardArg, enumerateWriteRoutes } from './lib/writeRouteSurface.mjs';
const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const root=join(repo,'server/src');
const filename=join(root,'customs/customsRoute.ts');
const source=readFileSync(filename,'utf8');
const context=()=>({root,filename,dependencies:new Set<string>()});
const classify=(text=source,name='batchDocumentAccess',ctx=context())=>classifyGuardArg(name,{},text,ctx);
const change=(before:string,after:string,start=0)=>{expect(source.slice(start)).toContain(before);const at=source.indexOf(before,start);return source.slice(0,at)+after+source.slice(at+before.length);};
const temporary:string[]=[];
afterEach(()=>{for(const p of temporary.splice(0))rmSync(p,{recursive:true,force:true});});
describe('G41 conditional native archive continuation',()=>{
 it('actual read-only archived CI and JWT/customs-write fallback are permission evidence while retaining source dependencies',()=>{
  const ctx=context();expect(classify(source,'batchDocumentAccess',ctx)).toBe('permission');
  expect([...ctx.dependencies].map(p=>p.slice(root.length+1))).toEqual(expect.arrayContaining(['customs/tradeDocumentLifecycleService.ts','shipping/shipmentDocumentSource.ts','auth/tokenHelpers.ts','auth/permissionService.ts']));
 });
 it('actual route keeps its registered POST denominator and ceases to be authn-only; this is source evidence only',()=>{
  const route=enumerateWriteRoutes(repo).routes.find(r=>r.file.endsWith('customsRoute.ts')&&String(r.pathKey).includes('batch-download'));
  expect(route).toMatchObject({method:'POST',permissionCoveredAllLayers:true});
  expect(route?.guards[0]).toMatchObject({cls:'permission',readScopeKnown:false});
 });
 it('renaming the middleware alone earns no privilege and the same bound shape still qualifies',()=>{
  expect(classify(source.replaceAll('batchDocumentAccess','reviewedArchiveGate'),'reviewedArchiveGate')).toBe('permission');
 });
 it.each([
  ['unawaited validator','for (const doc of docs) await assertCiTradeDocumentArchive','for (const doc of docs) assertCiTradeDocumentArchive'],
  ['only first record','for (const doc of docs) await','for (const doc of docs.slice(0,1)) await'],
  ['incomplete id set','docs.length === ids.length && docs.length > 0','docs.length > 0'],
  ['missing archive accepted',"doc.type === 'CommercialInvoice' && doc.filePath", "doc.type === 'CommercialInvoice'"],
  ['early next','for (const doc of docs) await assertCiTradeDocumentArchive','return next(); for (const doc of docs) await assertCiTradeDocumentArchive'],
  ['fallback write removed','return requireWrite(req, res, () => requireCustomsWrite(req, res, next));','return next();'],
  ['write scope changed',"const requireCustomsWrite = requirePermission('customs:write');","const requireCustomsWrite = requirePermission('customs:read');"],
  ['JWT gate removed','const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });','const requireWrite = (req: Request,res: Response,next: NextFunction) => next();'],
  ['catch continues','return res.status(safe.status).json({ error: safe.code, message: safe.message });','return next();'],
  ['readonly regeneration allowed',"if (ciArchiveReads.has(req)) throw businessError('CONFLICT', '归档文件在读取时变化；本次历史读取不能生成新文件。');",''],
  ['marker deletion', 'ciArchiveReads.add(req); return next();','ciArchiveReads.add(req); ciArchiveReads.delete(req); return next();'],
  ['forged body actor', 'return request.actor ?? extractActorFromRequest(req);','return req.body.actor;'],
  ['actor default side effect', 'write = false', 'write = (req.actor = req.body.actor, false)'],
 ] as const)('withdrawal: %s cannot be classified as an authorized continuation',(_label,before,after)=>{
  expect(classify(change(before,after,(_label==='forged body actor'||_label==='actor default side effect')?source.indexOf('const ciActor ='):0))).toBe('unknown');
 });
 it.each([
  ['current scope check', 'shipping/shipmentDocumentSource.ts', "for (const scope of scopes) if (!hasScope(actor, scope)) throw businessError('FORBIDDEN', '当前账号没有来源单据权限。');"],
  ['signed ceiling copy', 'shipping/shipmentDocumentSource.ts', 'if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];'],
  ['native archive scope await', 'customs/tradeDocumentLifecycleService.ts', "await currentDocumentActor(tx, trustedActor, ['customs:read']);"],
 ] as const)('imported %s withdrawal cannot borrow a native export spelling',(_label,file,removed)=>{
  const p=mkdtempSync(join(tmpdir(),'bambook-archive-evidence-negative-'));temporary.push(p);
  for(const relative of ['customs/customsRoute.ts','customs/tradeDocumentLifecycleService.ts','customs/ciInvoiceSource.ts','shipping/shipmentDocumentSource.ts','auth/tokenHelpers.ts','auth/permissionService.ts','auth/middleware.ts','shared/routeError.ts']){
   const to=join(p,relative);mkdirSync(dirname(to),{recursive:true});let text=readFileSync(join(root,relative),'utf8');
      writeFileSync(to,text);
  }
  const ctx={root:p,filename:join(p,'customs/customsRoute.ts'),dependencies:new Set<string>()};
  expect(classify(source,'batchDocumentAccess',ctx)).toBe('permission');
  const actual=join(p,file),body=readFileSync(actual,'utf8');
  expect(body).toContain(removed);writeFileSync(actual,body.replace(removed,''));
  expect(classify(source,'batchDocumentAccess',ctx)).toBe('unknown');
 });
});
