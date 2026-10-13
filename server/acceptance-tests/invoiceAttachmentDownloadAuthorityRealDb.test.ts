/** Successor command transport: actual index middleware/static closure, native finance handlers, independent private PG and synthetic private files. Original readonly diagnosis remains separately byte-frozen. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createRequestTimingMiddleware } from '../src/lib/requestTiming';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { getMeloPrewarmStatus } from '../src/ai/tts';
import { createFinanceRouter } from '../src/finance/route';
import { globalErrorHandler } from '../src/lib/asyncHandler';
import { createUploadsGuard } from '../src/lib/uploadsGuard';
import { safeRouteError } from '../src/shared/routeError';
import { createProformaInvoiceService } from '../src/finance/proformaInvoiceService';
let nativeAttachment:any;

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const prefix = `invoice-attachments-diagnosis-${randomUUID()}`;
const key = `${prefix}-bound-key`;
const evidence = process.env.BAMBOOK_ATTACHMENT_READONLY_EVIDENCE;
const sourcePath = path.resolve(__dirname, '../src/index.ts');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const receipts: unknown[] = [];
let seq = 0;
function save(name: string, value: unknown) { if (evidence) fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n'); }
db.$on('query',event=>{if(evidence)fs.appendFileSync(path.join(evidence,'actual-pg-queries.jsonl'),JSON.stringify(event)+'\n');});
beforeAll(async()=>{
 if(fs.existsSync(path.resolve(__dirname,'../src/finance/invoiceAttachmentService.ts')))nativeAttachment=await import('../src/finance/invoiceAttachmentService');

 const [identity] = await db.$queryRawUnsafe<Array<{name:string;directory:string;port:number}>>("SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port");
 expect(process.env.BAMBOOK_ACCEPTANCE_DB_NAME).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
 expect(identity).toEqual({name:process.env.BAMBOOK_ACCEPTANCE_DB_NAME,directory:process.env.BAMBOOK_ACCEPTANCE_DB_DIR,port:Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT)});save('native-identity.json',identity);
});
afterAll(async()=>{save('http-read-receipts.json',receipts);await db.$disconnect();});
function variableName(statement: ts.Statement): string | undefined {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    && ts.isIdentifier(statement.declarationList.declarations[0].name)
    ? statement.declarationList.declarations[0].name.text : undefined;
}
function appCall(statement: ts.Statement, method: string, first?: string): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === 'app' && call.expression.name.text === method
    && (first === undefined || (ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === first));
}
/** Compile the actual contiguous middleware block, with original function bodies,
 * registrations and order. The root's app statement and public health registration
 * are also copied as exact AST spans. Root startup directories/schedulers/routes
 * outside these declared spans are deliberately not executed.
 */
function compileActualRoot(client: PrismaClient, actors: Map<string, TokenPayload>): express.Express {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = Array.from(file.statements);
  const app = statements.find(statement => variableName(statement) === 'app');
  const first = statements.findIndex(statement => variableName(statement) === 'ALLOWED_ORIGINS');
  const end = statements.findIndex(statement => appCall(statement, 'use', '/api/uploads')
    && statement.getText(file).includes('express.static')) + 1;
  const health = statements.find(statement => appCall(statement, 'get', '/api/health'));
  const build = statements.find(statement => variableName(statement) === 'BUILD_SHA');
  const resolveBuild = statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'resolveBuildSha');
  if (!app || !health || !build || !resolveBuild || first < 0 || end <= first) throw Error('Actual index composition anchors missing');
  const selected = statements.slice(first, end);
  if (selected.some(statement => variableName(statement) !== 'ALLOWED_ORIGINS'
    && variableName(statement) !== 'corsWithCredentials' && !appCall(statement, 'use') && !appCall(statement,'get','/api/uploads/invoices/:filename'))) {
    throw Error('Unexpected executable statement in actual middleware closure');
  }
  const text = (statement: ts.Statement) => source.slice(statement.getStart(file), statement.end);
  const middleware = source.slice(selected[0].getStart(file), selected[selected.length - 1].end);
  if (!middleware.includes('createAccountStatusGuard(prisma)')
    || !middleware.includes('createAuthorizationSnapshotGuard')
    || !middleware.includes("req.url.slice('/bambook'.length)")
    || !middleware.includes('createRequestTimingMiddleware()')) throw Error('Actual composition coverage missing');
  const closure = `(function () {\n${text(app)}\n${middleware}\n${text(resolveBuild)}\n${text(build)}\n${text(health)}\nreturn app;\n})()`;
  const compiled = ts.transpileModule(closure, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, strict: true }, reportDiagnostics: true });
  if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error('Actual composition compile error');
  const executable = ts.createSourceFile('actual-index-closure.js', compiled.outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const locals = new Set<string>();
  function declared(node: ts.Node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name) {
      const collect = (name: ts.BindingName | ts.Identifier) => {
        if (ts.isIdentifier(name)) locals.add(name.text);
        else name.elements.forEach(element => { if (ts.isBindingElement(element)) collect(element.name); });
      };
      collect(node.name);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) locals.add(node.variableDeclaration.name.text);
    ts.forEachChild(node, declared);
  }
  declared(executable);
  const bindings = { express, cors, cookieParser, createAccountStatusGuard, createAuthorizationSnapshotGuard, createUploadsGuard, UPLOAD_DIR: process.env.BAMBOOK_UPLOAD_DIR,
    createRequestTimingMiddleware, prisma: client, SDK_CONFIG: { requireAuth: true, apiKeys: new Set([key]) },
    AGENT_API_KEY_ACTORS: actors, getMeloPrewarmStatus, InvoiceAttachmentError:nativeAttachment?.InvoiceAttachmentError,readLegacyInvoiceAttachment:nativeAttachment?.readLegacyInvoiceAttachment,safeRouteError,encodeURIComponent,Error, process, require: createRequire(__filename) };
  const permitted = new Set([...Object.keys(bindings), ...locals, 'Set', 'Date', 'String', 'undefined']);
  const unexpected = new Set<string>();
  function check(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!property && !permitted.has(node.text)) unexpected.add(node.text);
    }
    ts.forEachChild(node, check);
  }
  check(executable);
  if (unexpected.size) throw Error(`Unbound actual composition closure: ${Array.from(unexpected).sort().join(',')}`);
  const spans = [app, ...selected, resolveBuild, build, health].map(statement => ({
    start: statement.getStart(file), end: statement.end,
    line: file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1,
    endLine: file.getLineAndCharacterOfPosition(statement.end).line + 1,
    sha256: sha(text(statement)), source: text(statement),
  }));
  save('actual-index-composition.json', { sourcePath, sourceSha256: sha(source), closureSha256: sha(closure),
    compiledSha256: sha(compiled.outputText), bindings: Object.keys(bindings), unbound: [], spans,
    excluded: 'startup/schedulers/filesystem initialization and unrelated business routes; no hand-written middlewares',
    claim: 'actual composition refresh and original static upload registrations; original finance handler separately mounted; no startup/scheduler or unrelated endpoint claims' });
  const compiledApp = vm.runInNewContext(compiled.outputText, bindings, { filename: 'actual-index-composition.js', timeout: 1000 });
  if (typeof compiledApp !== 'function' || typeof compiledApp.use !== 'function') throw Error('Actual root did not produce Express app');
  return compiledApp;
}


const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR!;
const documentBytes = Buffer.from('%PDF-1.4\n% invoice attachment synthetic authorization probe\n%%EOF');
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(label:string, scopes=['invoices:read','invoices:write','orders:read']) {
 const id=`${prefix}-${++seq}-${label}`,userId=`${id}-user`,roleId=`${id}-role`,orderId=`${id}-order`,invoiceId=`${id}-invoice`,now=BigInt(Date.now());
 await db.userAccount.create({data:{id:userId,displayName:'Synthetic invoice clerk',status:'active'}});
 await db.role.create({data:{id:roleId,name:'Synthetic current scoped clerk',isSystem:false}});
 await db.userRole.create({data:{id:`${id}-ur`,userId,roleId}});
 for(const scope of scopes){const permission=await db.permission.upsert({where:{scope},update:{},create:{id:`${id}-perm-${scope}`,scope}});await db.rolePermission.create({data:{id:`${id}-rp-${scope}`,roleId,permissionId:permission.id}});}
 await db.order.create({data:{id:orderId,code:id,poNumber:`PO-${id}`,customer:'Synthetic customer',product:'Synthetic fabric',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:100,ownerId:userId,updatedAt:now}});
 await db.invoice.create({data:{id:invoiceId,invoiceNumber:id,type:'Receivable',status:'Issued',amount:'100',currency:'USD',issueDate:'2026-10-03',orderId,ownerId:userId,customerName:'Synthetic customer',createdAt:now,updatedAt:now,attachments:[]}});
 const actor=await buildLoadedAuthTokenPayload(db,await loadUserWithRoles(db,userId));return {id,userId,roleId,orderId,invoiceId,actor,token:createAuthService().signToken(actor)};
}
function application(client:PrismaClient=db){const app=compileActualRoot(client,new Map());app.use('/api/v1/finance',createFinanceRouter({prisma:client,requireAuth:true,apiKeys:new Set([key])}));app.use(globalErrorHandler);return app;}
const files=()=>fs.existsSync(path.join(process.env.BAMBOOK_PRIVATE_FILES_DIR!,'invoices'))?fs.readdirSync(path.join(process.env.BAMBOOK_PRIVATE_FILES_DIR!,'invoices')).sort():[];
async function facts(f:Fixture){return {files:files(),invoice:await db.invoice.findUnique({where:{id:f.invoiceId}}),audits:await db.auditLog.findMany({where:{targetId:f.invoiceId},orderBy:{id:'asc'}})};}
const upload=(app:express.Express,f:Fixture,token=f.token,invoiceId=f.invoiceId)=>request(app).post(`/api/v1/finance/${invoiceId}/attachments`).set('Authorization',`Bearer ${token}`).set('X-Invoice-Attachment-Key',randomUUID()).attach('file',documentBytes,{filename:'synthetic-real-invoice.pdf',contentType:'application/pdf'});
async function observe(label:string,f:Fixture,app:express.Express,token=f.token,invoiceId=f.invoiceId){const before=await facts(f),response=await upload(app,f,token,invoiceId),after=await facts(f);const row={label,status:response.status,body:response.body,before,after};receipts.push(row);save('attachment-observations.json',receipts);return row;}
const uploadIntent=(app:express.Express,f:Fixture,requestKey:string,bytes=documentBytes,invoiceId=f.invoiceId)=>request(app).post(`/api/v1/finance/${invoiceId}/attachments`).set('Authorization',`Bearer ${f.token}`).set('X-Invoice-Attachment-Key',requestKey).attach('file',bytes,{filename:'synthetic-real-invoice.pdf',contentType:'application/pdf'});
const download=(app:express.Express,f:Fixture,fileId:string,invoiceId=f.invoiceId)=>request(app).get(`/api/v1/finance/${invoiceId}/attachments/${fileId}/download`).set('Authorization',`Bearer ${f.token}`);


async function registered(label:string,ioa=false){const f=await fixture(label),key=randomUUID(),other=await fixture(label+'-other');let parentId=f.orderId;if(ioa){parentId=f.id+'-ioa-order';await db.order.create({data:{id:parentId,code:parentId,customer:'Synthetic customer',product:'Synthetic fabric',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:1,ownerId:f.userId,updatedAt:BigInt(Date.now())}});await db.invoiceOrderAllocation.create({data:{id:f.id+'-source-ioa',invoiceId:f.invoiceId,orderId:parentId,orderNumber:parentId,allocatedAmount:'10',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});}const created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);const audit=await db.auditLog.findUniqueOrThrow({where:{id:created.body.receipt.auditId}});return {f,other,parentId,created,audit,alias:'/api/uploads/invoices/'+(audit.detail as any).filename};}
const noBytes=(r:any)=>{expect(r.body instanceof Buffer).toBe(false);expect(r.body.attachment).toBeUndefined();expect(r.body.receipt).toBeUndefined();expect(JSON.stringify(r.body)).not.toContain('%PDF');};
async function atLastNativeFile(label:string,mutation:(x:Awaited<ReturnType<typeof registered>>)=>Promise<void>,ioa=false){const rows=[];for(const channel of ['scoped','alias']){const x=await registered(label+'-'+channel,ioa);let reads=0,reached=0;const client=db.$extends({query:{auditLog:{async findUnique({args,query}){const row=await query(args);if(args.where.id===x.audit.id&&++reads===2){reached++;await mutation(x);}return row;}}}}) as unknown as PrismaClient;const app=application(client),r=await request(app).get(channel==='alias'?x.alias:x.created.body.attachment.url).set('Authorization',`Bearer ${x.f.token}`);expect(reached).toBe(1);rows.push(r);receipts.push({label,channel,status:r.status,bodySha256:sha(r.body instanceof Buffer?r.body:JSON.stringify(r.body)),expectedPrivatePdfSha256:sha(documentBytes)});}return rows;}
describe('Actual native download last receipt/conversion read current authority',()=>{
 it('D01 grant withdrawal during the final native receipt query cannot release bytes through scoped or actual index alias GET',async()=>{const rows=await atLastNativeFile('last-native-read-grant',async x=>{await db.rolePermission.deleteMany({where:{roleId:x.f.roleId,permission:{scope:'invoices:read'}}});});expect(rows.map(r=>r.status)).toEqual([403,403]);rows.forEach(noBytes);});
 it('D02 direct Order L2 transfer during the final native receipt query cannot release bytes through scoped or actual index alias GET',async()=>{const rows=await atLastNativeFile('last-native-read-parent',async x=>{await db.order.update({where:{id:x.parentId},data:{ownerId:x.other.userId}});});expect(rows.map(r=>r.status)).toEqual([404,404]);rows.forEach(noBytes);});
 it('D03 a foreign current active IOA parent after final file verification denies both existing download paths without attributes',async()=>{const rows=await atLastNativeFile('last-native-read-ioa',async x=>{await db.order.update({where:{id:x.parentId},data:{ownerId:x.other.userId}});},true);expect(rows.map(r=>r.status)).toEqual([404,404]);rows.forEach(noBytes);});
 it('D04 a still-visible source-set change during terminal receipt lookup rejects the mixed-source download with409',async()=>{const rows=await atLastNativeFile('last-native-read-source-stamp',async x=>{const id=x.f.id+'-added-parent';await db.order.create({data:{id,code:id,customer:'Synthetic customer',product:'Synthetic fabric',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:1,ownerId:x.f.userId,updatedAt:BigInt(Date.now())}});await db.invoiceOrderAllocation.create({data:{id:x.f.id+'-added-ioa',invoiceId:x.f.invoiceId,orderId:id,orderNumber:id,allocatedAmount:'1',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});});expect(rows.map(r=>r.status)).toEqual([409,409]);rows.forEach(noBytes);});
 it('D05 a genuine audited PI conversion cannot release copied original blob bytes when read permission is withdrawn in its last conversion-proof query',async()=>{const f=await fixture('last-conversion-proof'),now=BigInt(Date.now()),q=f.id+'-quotation';await db.quotation.create({data:{id:q,quotationNumber:q,status:'Accepted',currency:'USD',totalAmount:'100',customerName:'Synthetic customer',convertedOrderId:f.orderId,issueDate:'2026-10-03',ownerId:f.userId,createdAt:now,updatedAt:now,lines:{create:{id:q+'-line',lineNumber:1,description:'Synthetic actual source',quantity:'1',unit:'M',unitPrice:'100',amount:'100',createdAt:now}}}});const service=createProformaInvoiceService(db),generated=await service.generateFromQuotation({quotationId:q},f.userId,null,f.actor);expect(generated.ok).toBe(true);const pi=generated.data as any,created=await uploadIntent(application(),f,randomUUID(),documentBytes,pi.id);expect(created.status).toBe(201);const converted=await service.convertToReceivable(pi.id,{},f.userId,null,f.actor);expect(converted.ok).toBe(true);const invoice=converted.data as any;let reads=0,reached=0;const client=db.$extends({query:{auditLog:{async findMany({args,query}){const rows=await query(args);if(args.where?.targetId===invoice.id&&args.where?.action==='convert_proforma_to_receivable'&&++reads===2){reached++;await db.rolePermission.deleteMany({where:{roleId:f.roleId,permission:{scope:'invoices:read'}}});}return rows;}}}}) as unknown as PrismaClient;const r=await download(application(client),f,created.body.attachment.fileId,invoice.id);expect(reached).toBe(1);expect(r.status).toBe(403);noBytes(r);});
 it('D06 current read-only signed ceiling and lost-write principal retain exact native blob bytes through both authorized paths without mutation',async()=>{const x=await registered('current-positive-read-only');await db.rolePermission.deleteMany({where:{roleId:x.f.roleId,permission:{scope:'invoices:write'}}});const before=await facts(x.f),token=createAuthService().signToken({...x.f.actor,permissionCeiling:['invoices:read']}),app=application();for(const url of [x.created.body.attachment.url,x.alias]){const r=await request(app).get(url).set('Authorization',`Bearer ${token}`);expect(r.status).toBe(200);expect(sha(r.body)).toBe(sha(documentBytes));}expect(await facts(x.f)).toEqual(before);});
});
