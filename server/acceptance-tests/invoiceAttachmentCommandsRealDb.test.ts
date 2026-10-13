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
describe('READONLY actual native invoice attachment upload and static negative controls',()=>{
 it('ATT01 an actual current read-only principal must not append or land a file',async()=>{const f=await fixture('read-only',['invoices:read']);const r=await observe('read-only',f,application());expect(r.status).toBe(403);expect(r.after).toEqual(r.before);});
 it('ATT02 an explicitly empty signed ceiling must not append or land a file',async()=>{const f=await fixture('empty-ceiling');const token=createAuthService().signToken({...f.actor,permissionCeiling:[]});const r=await observe('empty-ceiling',f,application(),token);expect(r.status).toBe(403);expect(r.after).toEqual(r.before);});
 it('ATT03 an owned invoice with a foreign active IOA parent must not be writable through attachment upload',async()=>{const f=await fixture('ioa-parent'),other=await fixture('other-parent');await db.invoiceOrderAllocation.create({data:{id:`${f.id}-ioa`,invoiceId:f.invoiceId,orderId:other.orderId,orderNumber:'FOREIGN',allocatedAmount:'10',createdAt:BigInt(Date.now()),updatedAt:BigInt(Date.now())}});const r=await observe('foreign-ioa-parent',f,application());expect(r.status).toBe(404);expect(r.after).toEqual(r.before);});
 it('ATT04 a missing invoice must not leave the uploaded private synthetic file behind',async()=>{const f=await fixture('missing');const r=await observe('missing-invoice',f,application(),f.token,`${f.invoiceId}-missing`);expect(r.status).toBe(404);expect(r.after.files).toEqual(r.before.files);expect(r.after.invoice).toEqual(r.before.invoice);});
 it('ATT05 a real storage delegate update failure must not leave an orphan attachment',async()=>{const f=await fixture('update-fault');const client=db.$extends({query:{invoice:{async update({args,query}){if(args.where.id===f.invoiceId)throw Error('private SQL storage-update probe');return query(args);}}}}) as unknown as PrismaClient;const r=await observe('storage-update-fault',f,application(client));expect(r.status).toBe(500);expect(JSON.stringify(r.body)).not.toContain('SQL');expect(r.after).toEqual(r.before);});
 it('ATT06 two actual concurrent appends must preserve both registered attachments and their files',async()=>{const f=await fixture('concurrent');let reached=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const client=db.$extends({query:{invoice:{async findUnique({args,query}){const result=await query(args);if(args.where.id===f.invoiceId){if(++reached===2)release();await gate;}return result;}}}}) as unknown as PrismaClient;const before=await facts(f);const responses=await Promise.all([upload(application(client),f),upload(application(client),f)]);const after=await facts(f);receipts.push({label:'concurrent-real-native-appends',status:responses.map(r=>r.status),body:responses.map(r=>r.body),before,after,actualReadBarrierReached:reached});save('attachment-observations.json',receipts);expect(responses.map(r=>r.status)).toEqual([201,201]);expect(reached).toBe(2);expect(after.invoice?.attachments).toHaveLength(2);expect(after.files.length-before.files.length).toBe(2);});
 it('ATT07 grant withdrawal after original upload read must reject before database append',async()=>{const f=await fixture('late-revoke');let reached=false;const client=db.$extends({query:{invoice:{async findUnique({args,query}){const result=await query(args);if(args.where.id===f.invoiceId&&!reached){reached=true;await db.rolePermission.deleteMany({where:{roleId:f.roleId}});}return result;}}}}) as unknown as PrismaClient;const r=await observe('late-current-revoke',f,application(client));expect(reached).toBe(true);expect(r.status).toBe(403);expect(r.after).toEqual(r.before);});
 it('ATT08 actual stored PI quotation snapshot metadata must survive attachment append',async()=>{const f=await fixture('pi-metadata'),metadata={quotationId:'synthetic-quoted-source',quotationNumber:'SYNTHETIC-QT',lines:[{product:'Synthetic fabric',quantity:'1',unit:'m',price:'100'}]};await db.invoice.update({where:{id:f.invoiceId},data:{type:'Proforma',attachments:metadata}});const r=await observe('native-pi-json-snapshot',f,application());expect(r.status).toBe(201);expect(r.after.invoice?.attachments).toMatchObject(metadata);});
 it('ATT09 current registered scoped download URLs require authentication; normalized legacy static aliases are independently privacy404',async()=>{const f=await fixture('anonymous-static'),app=application();const created=await observe('legitimate-writer-for-static-probe',f,app);expect(created.status).toBe(201);const url=created.body.attachment.url;const urls=[url,url.replace('/invoices/','//invoices/'),url.replace('/invoices/','/invoices%2F')];const responses=[];for(const path of urls){const r=await request(app).get(path);responses.push({url:path,status:r.status,bytesSha256:sha(r.body instanceof Buffer?r.body:r.text??''),headers:r.headers});}receipts.push({label:'anonymous-static-read',registeredInvoice:f.invoiceId,registeredUrl:url,responses});save('attachment-observations.json',receipts);expect(responses.map(r=>r.status)).toEqual([401,401,401]);});
 it('ATT10 a successful attachment registration must have a mandatory native audit bound to the invoice',async()=>{const f=await fixture('mandatory-audit');const r=await observe('mandatory-upload-audit',f,application());expect(r.status).toBe(201);expect(r.after.audits.length-r.before.audits.length).toBeGreaterThan(0);});
 it('ATT11 a foreign finance-owned invoice must not accept an attachment just by exact ID',async()=>{const f=await fixture('foreign-finance'),owner=await fixture('invoice-owner');await db.invoice.update({where:{id:f.invoiceId},data:{ownerId:owner.userId}});const r=await observe('foreign-finance-object',f,application());expect(r.status).toBe(404);expect(r.after).toEqual(r.before);});
 it('ATT12 an unknown native storage error carrying a fake business shape must remain safe500 without SQL text',async()=>{const f=await fixture('fake-business-shape');const client=db.$extends({query:{invoice:{async update({args,query}){if(args.where.id===f.invoiceId)throw Object.assign(Error('private SQL SELECT fake-business-shape probe'),{code:'CONFLICT',statusCode:409});return query(args);}}}}) as unknown as PrismaClient;const r=await observe('unknown-storage-fake-business-shape',f,application(client));expect(r.status).toBe(500);expect(JSON.stringify(r.body)).not.toContain('SQL SELECT');expect(r.after).toEqual(r.before);});
});

const uploadIntent=(app:express.Express,f:Fixture,requestKey:string,bytes=documentBytes,invoiceId=f.invoiceId)=>request(app).post(`/api/v1/finance/${invoiceId}/attachments`).set('Authorization',`Bearer ${f.token}`).set('X-Invoice-Attachment-Key',requestKey).attach('file',bytes,{filename:'synthetic-real-invoice.pdf',contentType:'application/pdf'});
const download=(app:express.Express,f:Fixture,fileId:string,invoiceId=f.invoiceId)=>request(app).get(`/api/v1/finance/${invoiceId}/attachments/${fileId}/download`).set('Authorization',`Bearer ${f.token}`);
describe('Native immutable invoice attachment commands and controlled download',()=>{
 it('N13 same native key replays exactly one audit and blob; altered bytes conflict and leave no extra stage',async()=>{const f=await fixture('key-replay'),app=application(),key=randomUUID(),before=await facts(f),a=await uploadIntent(app,f,key),b=await uploadIntent(app,f,key),c=await uploadIntent(app,f,key,Buffer.from('different'));expect(a.status).toBe(201);expect(b.status).toBe(200);expect(b.body.receipt).toEqual(a.body.receipt);expect(b.body.replayed).toBe(true);expect(c.status).toBe(409);const after=await facts(f);expect(after.files.length-before.files.length).toBe(1);expect(after.audits.length-before.audits.length).toBe(1);expect(after.invoice?.attachments).toHaveLength(1);const receipt=await request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${f.token}`);expect(receipt.status).toBe(200);expect(receipt.body.receipt).toEqual(a.body.receipt);});
 it('N14 scoped and native alias downloads return exact bytes only to current allowed Invoice parents; static variants never serve anonymous bytes',async()=>{const f=await fixture('download'),app=application(),created=await uploadIntent(app,f,randomUUID());expect(created.status).toBe(201);const a=created.body.attachment,r=await download(app,f,a.fileId);expect(r.status).toBe(200);expect(sha(r.body)).toBe(sha(documentBytes));const audit=await db.auditLog.findUniqueOrThrow({where:{id:a.receiptId}}),filename=(audit.detail as any).filename;const alias='/api/uploads/invoices/'+filename;expect((await request(app).get(alias).set('Authorization',`Bearer ${f.token}`)).status).toBe(200);for(const u of [alias,alias.replace('/invoices/','//invoices/'),alias.replace('/invoices/','/invoices%2F')])expect((await request(app).get(u)).status).toBe(404);expect((await request(app).get(a.url)).status).toBe(401);expect((await download(app,f,randomUUID())).status).toBe(404);await db.rolePermission.deleteMany({where:{roleId:f.roleId}});expect((await download(app,f,a.fileId)).status).toBe(403);});
 it('N15 mandatory native audit failure rolls back JSON and removes only this unregistered stage',async()=>{const f=await fixture('audit-failure'),before=await facts(f);let reached=0;const client=db.$extends({query:{auditLog:{async create({args,query}){if(args.data.action==='register_invoice_attachment'&&args.data.targetId===f.invoiceId){reached++;return query({...args,data:{...args.data,actorId:prefix+'-nonexistent'}});}return query(args);}}}}) as unknown as PrismaClient;const r=await uploadIntent(application(client),f,randomUUID());expect(reached).toBe(1);expect(r.status).toBe(500);expect(await facts(f)).toEqual(before);});
 it('N16 own immutable receipt does not disclose attributes after current Order L2 transfer; another actor remains private',async()=>{const f=await fixture('lost-parent'),other=await fixture('other-reader'),app=application(),key=randomUUID(),a=await uploadIntent(app,f,key);expect(a.status).toBe(201);await db.order.update({where:{id:f.orderId},data:{ownerId:other.userId}});expect((await download(app,f,a.body.attachment.fileId)).status).toBe(404);const own=await request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${f.token}`);expect(own.status).toBe(404);expect(own.body.receipt).toBeUndefined();expect(own.body.attachment).toBeUndefined();expect(own.body.order).toBeUndefined();expect((await request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${other.token}`)).status).toBe(404);});
 it('N17 tampered audit or blob cannot become a valid download; legacy references remain untouched and unadopted',async()=>{const f=await fixture('tamper'),app=application(),a=await uploadIntent(app,f,randomUUID());expect(a.status).toBe(201);expect(a.body.receipt?.auditId).toBeTruthy();const audit=await db.auditLog.findUniqueOrThrow({where:{id:a.body.receipt.auditId}}),filename=(audit.detail as any).filename;const file=path.join(process.env.BAMBOOK_PRIVATE_FILES_DIR!,'invoices',filename);fs.writeFileSync(file,Buffer.from('corrupted'));expect((await download(app,f,a.body.attachment.fileId)).status).toBe(409);fs.writeFileSync(file,documentBytes);const original=audit.detail as any;await db.auditLog.update({where:{id:audit.id},data:{detail:{...original,receipt:{...original.receipt,actorId:'forged'}}}});expect((await download(app,f,a.body.attachment.fileId)).status).toBe(409);await db.auditLog.update({where:{id:audit.id},data:{detail:original}});const legacy=[{fileName:'legacy.pdf',url:'/api/uploads/invoices/legacy.pdf'}];await db.invoice.update({where:{id:f.invoiceId},data:{attachments:legacy}});fs.mkdirSync(path.join(uploadRoot,'invoices'),{recursive:true});fs.writeFileSync(path.join(uploadRoot,'invoices','legacy.pdf'),documentBytes);expect((await request(app).get('/api/uploads/invoices/legacy.pdf').set('Authorization',`Bearer ${f.token}`)).status).toBe(404);expect((await db.invoice.findUniqueOrThrow({where:{id:f.invoiceId}})).attachments).toEqual(legacy);expect(fs.readFileSync(path.join(uploadRoot,'invoices','legacy.pdf'))).toEqual(documentBytes);});
 it('N18 the original canonical body cannot forge, remove or rebind registered files, while notes-only preserves them',async()=>{const f=await fixture('canonical-ledger'),app=application(),a=await uploadIntent(app,f,randomUUID());expect(a.status).toBe(201);const before=await facts(f);const remove=await request(app).patch(`/api/v1/finance/${f.invoiceId}`).set('Authorization',`Bearer ${f.token}`).send({attachments:[]});expect(remove.status).toBe(409);expect(await facts(f)).toEqual(before);const create=await request(app).post('/api/v1/finance').set('Authorization',`Bearer ${f.token}`).send({invoiceNumber:prefix+'-forged-file',type:'Receivable',status:'Draft',amount:'1',currency:'USD',issueDate:'2026-10-03',attachments:[a.body.attachment]});expect(create.status).toBe(409);const notes=await request(app).patch(`/api/v1/finance/${f.invoiceId}`).set('Authorization',`Bearer ${f.token}`).send({notes:'actual existing note update'});expect(notes.status).toBe(200);expect((await db.invoice.findUniqueOrThrow({where:{id:f.invoiceId}})).attachments).toEqual(before.invoice?.attachments);});
 it('N19 an actual PI producer snapshot, native upload and audited conversion preserve business metadata and authorized original blob bytes',async()=>{const f=await fixture('real-pi'),now=BigInt(Date.now()),q=f.id+'-quotation';await db.quotation.create({data:{id:q,quotationNumber:q,status:'Accepted',currency:'USD',totalAmount:'100',customerName:'Synthetic customer',convertedOrderId:f.orderId,issueDate:'2026-10-03',ownerId:f.userId,createdAt:now,updatedAt:now,lines:{create:{id:q+'-line',lineNumber:1,description:'Synthetic native quote',quantity:'1',unit:'M',unitPrice:'100',amount:'100',createdAt:now}}}});const service=createProformaInvoiceService(db),generated=await service.generateFromQuotation({quotationId:q},f.userId,null,f.actor);expect(generated.ok).toBe(true);const pi=generated.data as any;expect(pi?.id).toBeTruthy();const metadata=pi.attachments;const app=application(),a=await uploadIntent(app,f,randomUUID(),documentBytes,pi.id);expect(a.status).toBe(201);const appended=await db.invoice.findUniqueOrThrow({where:{id:pi.id}});expect(appended.attachments).toMatchObject(metadata);const converted=await service.convertToReceivable(pi.id,{},f.userId,null,f.actor);expect(converted.ok).toBe(true);const invoice=converted.data as any;expect(invoice?.id).toBeTruthy();const fresh=await db.invoice.findUniqueOrThrow({where:{id:invoice.id}});expect(fresh.attachments).toMatchObject({...metadata,proformaInvoiceId:pi.id});const r=await download(app,f,a.body.attachment.fileId,invoice.id);expect(r.status).toBe(200);expect(sha(r.body)).toBe(sha(documentBytes));expect((await db.invoice.findUniqueOrThrow({where:{id:pi.id}})).status).toBe('Cancelled');});
 it('N20 symlink escapes, arbitrary bare paths and untrusted body roles cannot obtain file bytes',async()=>{const f=await fixture('symlink'),other=await fixture('body-forgery',['invoices:read']),app=application(),a=await uploadIntent(app,f,randomUUID());expect(a.status).toBe(201);expect(a.body.receipt?.auditId).toBeTruthy();const audit=await db.auditLog.findUniqueOrThrow({where:{id:a.body.receipt.auditId}}),file=path.join(process.env.BAMBOOK_PRIVATE_FILES_DIR!,'invoices',(audit.detail as any).filename),outside=path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!,'outside-probe');fs.writeFileSync(outside,documentBytes);fs.unlinkSync(file);fs.symlinkSync(outside,file);expect((await download(app,f,a.body.attachment.fileId)).status).not.toBe(200);expect((await request(app).get('/api/uploads/invoices/../outside-probe').set('Authorization',`Bearer ${f.token}`)).status).not.toBe(200);expect((await request(app).post(`/api/v1/finance/${f.invoiceId}/attachments`).set('Authorization',`Bearer ${other.token}`).set('X-Invoice-Attachment-Key',randomUUID()).field('actorId',f.userId).field('roles','owner').attach('file',documentBytes,{filename:'synthetic-real-invoice.pdf',contentType:'application/pdf'})).status).toBe(403);});
});

function transactionClient(hook:(work:any,options:any)=>Promise<any>):PrismaClient {
 return new Proxy(db,{get(target,property){if(property==='$transaction')return hook;const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}}) as PrismaClient;
}
describe('Native attachment interrupted ACK, current authority and actual two-connection controls',()=>{
 it('N21 lost commit ACK preserves the registered blob and immutable receipt; explicit same-key replay creates no new file or audit',async()=>{
  const f=await fixture('lost-commit-ack'),before=await facts(f),key=randomUUID();let reached=0;
  const client=transactionClient(async(work,options)=>{const result=await db.$transaction(work,options);reached++;throw Error('synthetic transport lost after actual native commit');});
  const lost=await uploadIntent(application(client),f,key);expect(reached).toBe(1);expect(lost.status).toBe(500);expect(JSON.stringify(lost.body)).not.toContain('synthetic transport');
  const committed=await facts(f);expect(committed.files.length-before.files.length).toBe(1);expect(committed.audits.length-before.audits.length).toBe(1);expect(committed.invoice?.attachments).toHaveLength(1);
  const app=application(),own=await request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${f.token}`);expect(own.status).toBe(200);
  const retry=await uploadIntent(app,f,key);expect(retry.status).toBe(200);expect(retry.body.receipt).toEqual(own.body.receipt);expect(await facts(f)).toEqual(committed);
 });
 it('N22 current grant withdrawal after the real Invoice update rolls the transaction back before mandatory audit and cleans only its stage',async()=>{
  const f=await fixture('post-write-revoke'),before=await facts(f);let reached=0;
  const client=db.$extends({query:{invoice:{async update({args,query}){const result=await query(args);if(args.where.id===f.invoiceId){reached++;await db.rolePermission.deleteMany({where:{roleId:f.roleId}});}return result;}}}}) as unknown as PrismaClient;
  const result=await uploadIntent(application(client),f,randomUUID());expect(reached).toBe(1);expect(result.status).toBe(403);expect(await facts(f)).toEqual(before);
 });
 it('N23 signed write-only ceiling may register but cannot download or read own receipt; signed read-only ceiling never lands a file',async()=>{
  const f=await fixture('ceiling-boundary'),app=application(),key=randomUUID(),token=createAuthService().signToken({...f.actor,permissionCeiling:['invoices:write']});
  const created=await request(app).post(`/api/v1/finance/${f.invoiceId}/attachments`).set('Authorization',`Bearer ${token}`).set('X-Invoice-Attachment-Key',key).attach('file',documentBytes,{filename:'synthetic-real-invoice.pdf',contentType:'application/pdf'});expect(created.status).toBe(201);
  expect((await request(app).get(created.body.attachment.url).set('Authorization',`Bearer ${token}`)).status).toBe(403);
  expect((await request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${token}`)).status).toBe(403);
  const before=await facts(f),readOnly=createAuthService().signToken({...f.actor,permissionCeiling:['invoices:read']});expect((await upload(app,f,readOnly)).status).toBe(403);expect(await facts(f)).toEqual(before);
 });
 it('N24 grant withdrawal after file read is checked again and cannot release bytes',async()=>{
  const f=await fixture('download-late-revoke'),created=await uploadIntent(application(),f,randomUUID());expect(created.status).toBe(201);let reads=0,reached=0;
  const client=db.$extends({query:{invoice:{async findFirst({args,query}){const row=await query(args);if(args.where?.id===f.invoiceId&&!args.select&&++reads===2){reached++;await db.rolePermission.deleteMany({where:{roleId:f.roleId}});}return row;}}}}) as unknown as PrismaClient;
  const result=await download(application(client),f,created.body.attachment.fileId);expect(reached).toBe(1);expect(result.status).toBe(403);expect(result.body instanceof Buffer).toBe(false);expect(JSON.stringify(result.body)).not.toContain('%PDF');
 });
 it('N25 actual two distinct native PG connections serialize concurrent appends and bind each audit to both original attachment states',async()=>{
  const f=await fixture('two-pg-connections'),before=await facts(f);let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;}),pids:number[]=[];
  const client=transactionClient((work,options)=>db.$transaction(async tx=>{const [row]=await tx.$queryRawUnsafe<Array<{pid:number}>>('SELECT pg_backend_pid() AS pid');pids.push(row.pid);if(pids.length===2)release();await barrier;return work(tx);},options));
  const app=application(client),responses=await Promise.all([uploadIntent(app,f,randomUUID()),uploadIntent(app,f,randomUUID())]);expect(responses.map(r=>r.status)).toEqual([201,201]);expect(new Set(pids).size).toBe(2);
  const after=await facts(f);expect(after.files.length-before.files.length).toBe(2);expect(after.invoice?.attachments).toHaveLength(2);expect(after.audits.length-before.audits.length).toBe(2);
  const audits=after.audits.filter(a=>a.action==='register_invoice_attachment');expect(audits.map(a=>(a.beforeValue as any[]).length).sort()).toEqual([0,1]);expect(audits.map(a=>(a.afterValue as any[]).length).sort()).toEqual([1,2]);
  save('actual-two-connection-receipt.json',{invoiceId:f.invoiceId,pids,statuses:responses.map(r=>r.status),auditIds:audits.map(a=>a.id)});
 });
 it('N26 damaged command hash is rejected without bytes and cannot masquerade as a valid immutable registration',async()=>{
  const f=await fixture('command-hash-damage'),app=application(),key=randomUUID(),created=await uploadIntent(app,f,key);expect(created.status).toBe(201);expect(created.body.receipt?.auditId).toBeTruthy();const audit=await db.auditLog.findUniqueOrThrow({where:{id:created.body.receipt.auditId}}),detail=audit.detail as any;
  await db.auditLog.update({where:{id:audit.id},data:{detail:{...detail,receipt:{...detail.receipt,commandHash:'0'.repeat(64)}}}});
  expect((await download(app,f,created.body.attachment.fileId)).status).toBe(409);expect((await request(app).get(`/api/v1/finance/${f.invoiceId}/attachments/receipts/${key}`).set('Authorization',`Bearer ${f.token}`)).status).toBe(409);
 });

 it('N27 damaged native receipt does not expose a foreign Invoice through the legacy alias; only its authorized owner receives the fixed409 review state',async()=>{
  const f=await fixture('foreign-damaged-receipt'),other=await fixture('foreign-alias-reader'),app=application(),created=await uploadIntent(app,f,randomUUID());expect(created.status).toBe(201);expect(created.body.receipt?.auditId).toBeTruthy();
  const audit=await db.auditLog.findUniqueOrThrow({where:{id:created.body.receipt.auditId}}),detail=audit.detail as any;await db.auditLog.update({where:{id:audit.id},data:{detail:{...detail,receipt:{...detail.receipt,commandHash:'0'.repeat(64)}}}});
  const alias='/api/uploads/invoices/'+detail.filename;const unauthorized=await request(app).get(alias).set('Authorization',`Bearer ${other.token}`);expect(unauthorized.status).toBe(404);expect(JSON.stringify(unauthorized.body)).not.toContain(detail.filename);expect(JSON.stringify(unauthorized.body)).not.toContain(created.body.attachment.sha256);
  expect((await request(app).get(alias).set('Authorization',`Bearer ${f.token}`)).status).toBe(409);
 });
});
