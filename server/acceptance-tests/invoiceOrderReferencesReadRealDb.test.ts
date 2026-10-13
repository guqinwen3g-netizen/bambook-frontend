/** Real private PG + actual index middleware AST closure + actual finance router.
 * Synthetic read snapshots only; no writer/workflow/row-scope qualification. */
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
import { InvoiceAttachmentError, readLegacyInvoiceAttachment } from '../src/finance/invoiceAttachmentService';
import { safeRouteError } from '../src/shared/routeError';
const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const prefix = `invoice-refs-${randomUUID()}`;
const key = `${prefix}-bound-key`;
const evidence = process.env.BAMBOOK_FINANCE_REFS_EVIDENCE_DIR;
const sourcePath = path.resolve(__dirname, '../src/index.ts');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const receipts: unknown[] = [];
let seq = 0;
function save(name: string, value: unknown) { if (evidence) fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n'); }
db.$on('query',event=>{if(evidence)fs.appendFileSync(path.join(evidence,'actual-pg-queries.jsonl'),JSON.stringify(event)+'\n');});
beforeAll(async()=>{
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
    && statement.getText(file).includes('createUploadsGuard'));
  const health = statements.find(statement => appCall(statement, 'get', '/api/health'));
  const build = statements.find(statement => variableName(statement) === 'BUILD_SHA');
  const resolveBuild = statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'resolveBuildSha');
  if (!app || !health || !build || !resolveBuild || first < 0 || end <= first) throw Error('Actual index composition anchors missing');
  const selected = statements.slice(first, end);
  const aliases = selected.filter(statement => appCall(statement, 'get', '/api/uploads/invoices/:filename'));
  if (aliases.length !== 1) throw Error('Exact actual invoice attachment GET alias span missing or duplicated');
  for (const [name, modulePath] of [['InvoiceAttachmentError', './finance/invoiceAttachmentService'],
    ['readLegacyInvoiceAttachment', './finance/invoiceAttachmentService'], ['safeRouteError', './shared/routeError']]) {
    const imports = statements.filter(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === modulePath && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(element => element.name.text === name && (!element.propertyName || element.propertyName.text === name)));
    if (imports.length !== 1) throw Error('Actual invoice alias production dependency import does not match: ' + name);
  }
  if (selected.some(statement => variableName(statement) !== 'ALLOWED_ORIGINS'
    && variableName(statement) !== 'corsWithCredentials' && !appCall(statement, 'use')
    && !appCall(statement, 'get', '/api/uploads/invoices/:filename'))) {
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
  const bindings = { express, cors, cookieParser, createAccountStatusGuard, createAuthorizationSnapshotGuard,
    createRequestTimingMiddleware, prisma: client, SDK_CONFIG: { requireAuth: true, apiKeys: new Set([key]) },
    AGENT_API_KEY_ACTORS: actors, getMeloPrewarmStatus, InvoiceAttachmentError, readLegacyInvoiceAttachment, safeRouteError, encodeURIComponent, Error, process, require: createRequire(__filename) };
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
    claim: 'composition refresh plus original public health contract, not all real business endpoints' });
  const compiledApp = vm.runInNewContext(compiled.outputText, bindings, { filename: 'actual-index-composition.js', timeout: 1000 });
  if (typeof compiledApp !== 'function' || typeof compiledApp.use !== 'function') throw Error('Actual root did not produce Express app');
  return compiledApp;
}

async function fixture(label:string, refs:Array<{order:string;batch?:boolean;deleted?:boolean}> = [], direct?:string) {
 const id=`${prefix}-${++seq}-${label}`,userId=`${id}-user`,roleId=`${id}-role`,now=BigInt(Date.now());
 await db.userAccount.create({data:{id:userId,displayName:'Private actual finance reader',status:'active'}});
 await db.role.create({data:{id:roleId,name:roleId,isSystem:false}});
 await db.userRole.create({data:{id:`${id}-ur`,userId,roleId}});
 const permission=await db.permission.upsert({where:{scope:'invoices:read'},update:{},create:{id:`${id}-perm`,scope:'invoices:read'}});
 await db.rolePermission.create({data:{id:`${id}-rp`,roleId,permissionId:permission.id}});
 const orders=[...new Set([...refs.map(r=>r.order),...(direct?[direct]:[])])];
 for(const order of orders) await db.order.create({data:{id:`${id}-${order}`,code:`LIVE-${id}-${order}`,poNumber:`LIVE-PO-${id}-${order}`,customer:'Synthetic customer',product:'Synthetic fabric',type:'fabric',quantity:1,status:'Pending',dueDate:'2099-01-01',quoteAmount:100,ownerId:userId,updatedAt:now}});
 const invoiceId=`${id}-invoice`;
 await db.invoice.create({data:{id:invoiceId,invoiceNumber:id,type:'Receivable',status:'Issued',amount:'2500.0001',currency:'USD',issueDate:'2026-10-03',orderId:direct?`${id}-${direct}`:null,ownerId:userId,customerName:'Synthetic customer',createdAt:now,updatedAt:now}});
 for(const [i,ref] of refs.entries()) {
  const orderId=`${id}-${ref.order}`,batchId=ref.batch?`${id}-batch-${i}`:null;
  if(batchId)await db.orderShipmentBatch.create({data:{id:batchId,orderId,batchNo:1,currency:'USD',status:'shipped',amount:'2500.0001',createdAt:now,updatedAt:now}});
  await db.invoiceOrderAllocation.create({data:{id:`${id}-ioa-${i}`,invoiceId,orderId,orderNumber:`SAVED-${ref.order}`,poNumber:`SAVED-PO-${ref.order}`,allocatedAmount:'1250.0001',batchId,note:'Persisted allocation note',createdAt:now,updatedAt:now,deletedAt:ref.deleted?now:null}});
 }
 const payload=await buildLoadedAuthTokenPayload(db,await loadUserWithRoles(db,userId));
 return {id,userId,roleId,invoiceId,payload,token:createAuthService().signToken(payload),orders:orders.map(o=>`${id}-${o}`)};
}
function application(fault?:'current'|'ioa') {
 const queries:{delegate:string;args:unknown}[]=[];
 const client=db.$extends({query:{userAccount:{async findFirst({args,query}){queries.push({delegate:'current',args});if(fault==='current')throw Error('secret current SELECT fixture');return query(args);}},invoiceOrderAllocation:{async findMany({args,query}){queries.push({delegate:'ioa',args});if(fault==='ioa')throw Error('secret IOA SELECT fixture');return query(args);}},order:{async findMany({args,query}){queries.push({delegate:'order',args});return query(args);}},invoice:{async findMany({args,query}){queries.push({delegate:'invoice',args});return query(args);},async findUnique({args,query}){queries.push({delegate:'invoice',args});return query(args);}}}}) as unknown as PrismaClient;
 const app=compileActualRoot(client,new Map());
 app.use('/api/v1/finance',createFinanceRouter({prisma:client,requireAuth:true,apiKeys:new Set([key])}));app.use(globalErrorHandler);
 return {app,queries};
}
async function read(label:string,f:Awaited<ReturnType<typeof fixture>>,h:ReturnType<typeof application>,suffix:string,query:Record<string,string>={},token=f.token) {
 const before={invoice:await db.invoice.count(),ioa:await db.invoiceOrderAllocation.count(),audit:await db.auditLog.count(),outbound:await db.stockMovement.count({where:{type:'Outbound'}}),payments:await db.paymentVoucher.count()};
 const start=h.queries.length;
 const r=await request(h.app).get(`/api/v1/finance${suffix}`).query(query).set('Authorization',`Bearer ${token}`);
 const after={invoice:await db.invoice.count(),ioa:await db.invoiceOrderAllocation.count(),audit:await db.auditLog.count(),outbound:await db.stockMovement.count({where:{type:'Outbound'}}),payments:await db.paymentVoucher.count()};
 receipts.push({label,invoiceId:f.invoiceId,status:r.status,body:r.body,before,after,queries:h.queries.slice(start)});save('http-read-receipts.json',receipts);
 expect(after).toEqual(before);expect(JSON.stringify(r.body)).not.toMatch(/secret .*SELECT fixture|PrismaClient|P2010|SELECT .*FROM/);return r;
}
async function pair(label:string,f:Awaited<ReturnType<typeof fixture>>,h:ReturnType<typeof application>) {
 const list=await read(label+'-list',f,h,'',{search:f.id});const detail=await read(label+'-detail',f,h,'/'+f.invoiceId);
 expect(list.status).toBe(200);expect(detail.status).toBe(200);expect(list.body.items).toHaveLength(1);
 expect(list.body.items[0].orderReferences).toEqual(detail.body.orderReferences);
 return {row:list.body.items[0],detail:detail.body};
}
describe('canonical active invoice order union with actual index authorization',()=>{
 it('IR01 direct-only is a known singleton with full source ID, without invented Order labels',async()=>{
  const f=await fixture('direct',[],'D1');const h=application();const {row}=await pair('direct',f,h);
  expect(row.orderReferences).toEqual([{orderId:f.orders[0],orderNumber:null,poNumber:null,direct:true,allocationId:null,batchId:null,allocatedAmount:null,note:null}]);
  expect(h.queries.filter(q=>q.delegate==='order').every(q=>JSON.stringify((q.args as any).select)==JSON.stringify({id:true,businessLine:true}))).toBe(true);
 });
 it('IR02 IOA-only without a batch preserves saved labels and exact allocation amount in list and detail',async()=>{
  const f=await fixture('nonbatch',[{order:'A1'}]);const {row}=await pair('nonbatch',f,application());
  expect(row.orderId).toBeNull();expect(row.batchAnchors).toEqual([]);expect(row.orderReferences).toEqual([{orderId:f.orders[0],orderNumber:'SAVED-A1',poNumber:'SAVED-PO-A1',direct:false,allocationId:`${f.id}-ioa-0`,batchId:null,allocatedAmount:'1250.0001',note:'Persisted allocation note'}]);
 });
 it('IR03 direct plus same-order IOA is one association and does not rewrite old orderId',async()=>{
  const f=await fixture('duplicate',[{order:'A1',batch:true}],'A1');const {row}=await pair('duplicate',f,application());
  expect(row.orderReferences).toHaveLength(1);expect(row.orderReferences[0]).toMatchObject({orderId:f.orders[0],direct:true,allocationId:`${f.id}-ioa-0`});expect(row.orderId).toBe(f.orders[0]);expect(row.batchAnchors).toHaveLength(1);
 });
 it('IR04 multi-order union excludes deleted IOA and reads labels only from saved IOA snapshots',async()=>{
  const f=await fixture('multi',[{order:'A1'},{order:'A2',batch:true},{order:'DELETED',deleted:true}],'D1');const h=application();const {row}=await pair('multi',f,h);
  expect(row.orderReferences.map((r:any)=>r.orderId).sort()).toEqual([`${f.id}-A1`,`${f.id}-A2`,`${f.id}-D1`].sort());expect(row.orderReferences).toHaveLength(3);
  expect(JSON.stringify(row.orderReferences)).not.toContain('LIVE-');expect(h.queries.filter(q=>q.delegate==='ioa')).toHaveLength(3);
 });
 it('IR05 complete actual empty source is distinct from a missing association ACK',async()=>{
  const f=await fixture('empty');const {row}=await pair('empty',f,application());expect(row.orderReferences).toEqual([]);expect(row.orderId).toBeNull();
 });
 it('IR06 orderId query unions direct and active IOA, retaining search/type/status/count filters',async()=>{
  const direct=await fixture('filter-direct',[],'A1');const ioa=await fixture('filter-ioa',[{order:'A1'}]);const removed=await fixture('filter-removed',[{order:'A1',deleted:true}]);
  // A shared persisted source ID, never inferred from display strings.
  const shared=direct.orders[0];
  await db.invoiceOrderAllocation.update({where:{id:`${ioa.id}-ioa-0`},data:{orderId:shared}});
  await db.invoiceOrderAllocation.update({where:{id:`${removed.id}-ioa-0`},data:{orderId:shared}});
  const h=application();const r=await read('filter-union',direct,h,'',{orderId:shared,type:'Receivable',status:'Issued'});
  expect(r.status).toBe(200);expect(r.body.total).toBe(2);expect(r.body.items.map((i:any)=>i.id).sort()).toEqual([direct.invoiceId,ioa.invoiceId].sort());
  const searched=await read('filter-search',direct,h,'',{orderId:shared,search:ioa.id});expect(searched.body.total).toBe(1);expect(searched.body.items[0].id).toBe(ioa.invoiceId);
 });
 it('IR07 actual current revoked role denies old valid JWT before any invoice/IOA read',async()=>{
  const f=await fixture('revoked',[{order:'A1'}]);await db.rolePermission.deleteMany({where:{roleId:f.roleId}});const h=application();
  for(const suffix of ['', '/'+f.invoiceId])expect((await read('revoked'+suffix,f,h,suffix,{search:f.id})).status).toBe(403);
  expect(h.queries.filter(q=>q.delegate==='ioa'||q.delegate==='invoice')).toEqual([]);
 });
 it('IR08 false old owner JWT cannot replace actual stored role with no current invoice grant',async()=>{
  const f=await fixture('false-owner');await db.rolePermission.deleteMany({where:{roleId:f.roleId}});const token=createAuthService().signToken({...f.payload,roles:['owner'],permissions:['invoices:read']});const h=application();
  expect((await read('false-owner',f,h,'/'+f.invoiceId,{},token)).status).toBe(403);expect(h.queries.filter(q=>q.delegate==='ioa')).toEqual([]);
 });
 it('IR09 empty signed ceiling denies even when current storage permits invoices read',async()=>{
  const f=await fixture('ceiling');const token=createAuthService().signToken({...f.payload,permissionCeiling:[]});const h=application();
  expect((await read('ceiling',f,h,'/'+f.invoiceId,{},token)).status).toBe(403);expect(h.queries.filter(q=>q.delegate==='ioa')).toEqual([]);
 });
 it('IR10 actual current loader fault is safe 503 and never restores stale JWT grant',async()=>{
  const f=await fixture('current-fault');const h=application('current');expect((await read('current-fault',f,h,'/'+f.invoiceId)).status).toBe(503);expect(h.queries.filter(q=>q.delegate==='ioa')).toEqual([]);
 });
 it('IR11 actual IOA query failure is safe 500, not a fabricated empty successful association',async()=>{
  const f=await fixture('ioa-fault',[{order:'A1'}]);const h=application('ioa');const r=await read('ioa-fault',f,h,'',{search:f.id});expect(r.status).toBe(500);expect(r.body.items).toBeUndefined();expect(h.queries.filter(q=>q.delegate==='ioa')).toHaveLength(1);
 });
});
