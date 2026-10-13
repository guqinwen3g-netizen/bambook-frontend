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

const ownReceipt=(app:express.Express,f:Fixture,key:string,token=f.token)=>request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${token}`);
const noAttachment=(response:any)=>{expect(response.body.receipt).toBeUndefined();expect(response.body.attachment).toBeUndefined();};
const forgedRefusal=(message:string)=>Object.assign(Object.setPrototypeOf(Error(message),nativeAttachment.InvoiceAttachmentError.prototype),{code:'CONFLICT',statusCode:409});
describe('Current Invoice and all native parent authority for own immutable attachment receipts',()=>{
 it('R28 losing write alone still permits own native receipt recovery when current read and all parents stay visible',async()=>{const f=await fixture('lost-write-positive'),app=application(),key=randomUUID(),created=await uploadIntent(app,f,key);expect(created.status).toBe(201);await db.rolePermission.deleteMany({where:{roleId:f.roleId,permission:{scope:'invoices:write'}}});const before=await facts(f),r=await ownReceipt(app,f,key);expect(r.status).toBe(200);expect(r.body.receipt).toEqual(created.body.receipt);expect(await facts(f)).toEqual(before);expect((await download(app,f,created.body.attachment.fileId)).status).toBe(200);});
 it('R29 native uploaded receipt is private after direct parent transfer and to another actor or signed empty ceiling',async()=>{const f=await fixture('direct-parent-private'),other=await fixture('other-receipt-reader'),app=application(),key=randomUUID(),created=await uploadIntent(app,f,key);expect(created.status).toBe(201);expect((await ownReceipt(app,f,key,other.token)).status).toBe(404);const cap=await ownReceipt(app,f,key,createAuthService().signToken({...f.actor,permissionCeiling:[]}));expect(cap.status).toBe(403);noAttachment(cap);await db.order.update({where:{id:f.orderId},data:{ownerId:other.userId}});let auditReads=0;const client=db.$extends({query:{auditLog:{async findUnique({args,query}){auditReads++;return query(args);}}}}) as unknown as PrismaClient;const r=await ownReceipt(application(client),f,key);expect(r.status).toBe(404);noAttachment(r);expect(auditReads).toBe(0);expect(JSON.stringify(r.body)).not.toContain(created.body.attachment.sha256);});
 it('R30 every active IOA parent must stay currently visible while a deleted historical parent is not a live authority anchor',async()=>{const f=await fixture('ioa-current'),other=await fixture('ioa-new-owner'),app=application(),key=randomUUID();const id=f.id+'-second-order';await db.order.create({data:{id,code:id,customer:'Synthetic customer',product:'Synthetic fabric',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:1,ownerId:f.userId,updatedAt:BigInt(Date.now())}});const ioa=f.id+'-receipt-ioa';await db.invoiceOrderAllocation.create({data:{id:ioa,invoiceId:f.invoiceId,orderId:id,orderNumber:id,allocatedAmount:'10',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});const created=await uploadIntent(app,f,key);expect(created.status).toBe(201);await db.order.update({where:{id},data:{ownerId:other.userId}});const denied=await ownReceipt(app,f,key);expect(denied.status).toBe(404);noAttachment(denied);await db.invoiceOrderAllocation.update({where:{id:ioa},data:{deletedAt:BigInt(Date.now())}});const recovered=await ownReceipt(app,f,key);expect(recovered.status).toBe(200);expect(recovered.body.receipt).toEqual(created.body.receipt);});
 it('R31 ownership transfer during real audit lookup cannot release receipt attributes under the old Invoice or parent scope',async()=>{for(const kind of ['parent','invoice']){const f=await fixture('late-'+kind),other=await fixture('late-owner-'+kind),key=randomUUID(),created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);let reached=0;const client=db.$extends({query:{auditLog:{async findUnique({args,query}){const row=await query(args);if(row?.targetId===f.invoiceId&&row.action==='register_invoice_attachment'){reached++;if(kind==='parent')await db.order.update({where:{id:f.orderId},data:{ownerId:other.userId}});else await db.invoice.update({where:{id:f.invoiceId},data:{ownerId:other.userId}});}return row;}}}}) as unknown as PrismaClient;const r=await ownReceipt(application(client),f,key);expect(reached).toBe(1);expect(r.status).toBe(404);noAttachment(r);expect(JSON.stringify(r.body)).not.toContain(created.body.attachment.fileName);}});
 it('R32 a changed but still visible active parent set during audit lookup is a fixed409 and cannot publish a mixed-source receipt',async()=>{const f=await fixture('parent-stamp-change'),key=randomUUID(),created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);const id=f.id+'-new-parent';await db.order.create({data:{id,code:id,customer:'Synthetic customer',product:'Synthetic fabric',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:1,ownerId:f.userId,updatedAt:BigInt(Date.now())}});let reached=0;const client=db.$extends({query:{auditLog:{async findUnique({args,query}){const row=await query(args);if(row?.targetId===f.invoiceId){reached++;await db.invoiceOrderAllocation.create({data:{id:f.id+'-late-ioa',invoiceId:f.invoiceId,orderId:id,orderNumber:id,allocatedAmount:'1',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});}return row;}}}}) as unknown as PrismaClient;const r=await ownReceipt(application(client),f,key);expect(reached).toBe(1);expect(r.status).toBe(409);noAttachment(r);});
 it('R33 a real grant withdrawal during the last parent read must reject the receipt even after earlier authority was valid',async()=>{const f=await fixture('last-parent-revoke'),key=randomUUID(),created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);let parentReads=0,reached=0;const client=db.$extends({query:{order:{async findFirst({args,query}){const row=await query(args);if(args.where?.id===f.orderId&&++parentReads===2){reached++;await db.rolePermission.deleteMany({where:{roleId:f.roleId,permission:{scope:'invoices:read'}}});}return row;}}}}) as unknown as PrismaClient;const r=await ownReceipt(application(client),f,key);expect(reached).toBe(1);expect(r.status).toBe(403);noAttachment(r);});
});
describe('Actual native attachment leaf and index error origin, original refusal and safe logging',()=>{
 it('R34 a forged InvoiceAttachmentError prototype stays safe500 and a mutated real refusal preserves original403 tuple on native receipt GET',async()=>{for(const kind of ['forged','mutated']){const f=await fixture('receipt-error-'+kind),key=randomUUID(),created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);const err:any=kind==='forged'?forgedRefusal('PRIVATE SQL receipt prototype'):new nativeAttachment.InvoiceAttachmentError('FORBIDDEN','Original trusted attachment refusal',403);if(kind==='mutated')Object.assign(err,{code:'CONFLICT',statusCode:409,message:'PRIVATE SQL mutated tuple'});let reached=0;const client=db.$extends({query:{auditLog:{async findUnique({args,query}){reached++;throw err;}}}}) as unknown as PrismaClient;const r=await ownReceipt(application(client),f,key);expect(reached).toBe(1);expect(r.status).toBe(kind==='forged'?500:403);expect(r.body.error.code).toBe(kind==='forged'?'UPLOAD_FAILED':'FORBIDDEN');if(kind==='mutated')expect(r.body.error.message).toBe('Original trusted attachment refusal');expect(JSON.stringify(r.body)).not.toContain('PRIVATE SQL');noAttachment(r);}});
 it('R35 actual index native alias rejects forged prototype and uses original constructor tuple after mutable public fields change',async()=>{for(const kind of ['forged','mutated']){const f=await fixture('alias-error-'+kind),key=randomUUID(),created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);const audit=await db.auditLog.findUniqueOrThrow({where:{id:created.body.receipt.auditId}}),alias='/api/uploads/invoices/'+(audit.detail as any).filename;const err:any=kind==='forged'?forgedRefusal('PRIVATE SQL alias prototype'):new nativeAttachment.InvoiceAttachmentError('FORBIDDEN','Original trusted alias refusal',403);if(kind==='mutated')Object.assign(err,{code:'CONFLICT',statusCode:409,message:'PRIVATE SQL alias mutable'});let reached=0;const client=db.$extends({query:{auditLog:{async findMany({args,query}){if(args.where?.action==='register_invoice_attachment'){reached++;throw err;}return query(args);}}}}) as unknown as PrismaClient;const r=await request(application(client)).get(alias).set('Authorization',`Bearer ${f.token}`);expect(reached).toBe(1);expect(r.status).toBe(kind==='forged'?500:403);expect(r.body.error.code).toBe(kind==='forged'?'DOWNLOAD_FAILED':'FORBIDDEN');if(kind==='mutated')expect(r.body.error.message).toBe('Original trusted alias refusal');expect(JSON.stringify(r.body)).not.toContain('PRIVATE SQL');}});
 it('R36 a real native write delegate cyclic BigInt fault still returns safe JSON and rolls back; original typed multer refusal stays400',async()=>{const f=await fixture('cyclic-bigint-error'),before=await facts(f);const error:any=Error('PRIVATE SQL circular bigint');error.circular=error;error.large=BigInt('9007199254740993');let reached=0;const client=db.$extends({query:{invoice:{async update({args,query}){if(args.where.id===f.invoiceId){reached++;throw error;}return query(args);}}}}) as unknown as PrismaClient;const r=await uploadIntent(application(client),f,randomUUID());expect(reached).toBe(1);expect(r.status).toBe(500);expect(r.body.error.code).toBe('UPLOAD_FAILED');expect(JSON.stringify(r.body)).not.toContain('PRIVATE SQL');expect(await facts(f)).toEqual(before);const invalid=await request(application()).post(`/api/v1/finance/${f.invoiceId}/attachments`).set('Authorization',`Bearer ${f.token}`).set('X-Invoice-Attachment-Key',randomUUID()).attach('file',documentBytes,{filename:'unsupported.exe',contentType:'application/octet-stream'});expect(invalid.status).toBe(400);expect(invalid.body.error.code).toBe('INVALID_FILE');expect(await facts(f)).toEqual(before);});
});

it('R37 a genuinely constructor-minted refusal keeps original403/message on both actual receipt and index alias after all public tuple fields mutate',async()=>{const f=await fixture('actual-mint-mutation'),key=randomUUID(),created=await uploadIntent(application(),f,key);expect(created.status).toBe(201);const audit=await db.auditLog.findUniqueOrThrow({where:{id:created.body.receipt.auditId}}),alias='/api/uploads/invoices/'+(audit.detail as any).filename;const err:any=new nativeAttachment.InvoiceAttachmentError('FORBIDDEN','Original immutable actual refusal',403);Object.assign(err,{code:'CONFLICT',statusCode:409,message:'PRIVATE SQL real class mutable fields'});let reached=0;const client=db.$extends({query:{auditLog:{async findUnique({args,query}){reached++;throw err;},async findMany({args,query}){if(args.where?.action==='register_invoice_attachment'){reached++;throw err;}return query(args);}}}}) as unknown as PrismaClient;const app=application(client),a=await ownReceipt(app,f,key),b=await request(app).get(alias).set('Authorization',`Bearer ${f.token}`);expect(reached).toBe(2);expect([a.status,b.status]).toEqual([403,403]);for(const r of [a,b]){expect(r.body.error).toEqual({code:'FORBIDDEN',message:'Original immutable actual refusal'});expect(JSON.stringify(r.body)).not.toContain('PRIVATE SQL');}});
