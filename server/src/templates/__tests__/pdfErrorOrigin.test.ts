import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
const pdf=vi.hoisted(()=>({fault:undefined as unknown,calls:0}));
vi.mock('playwright',()=>({chromium:{launch:async()=>{pdf.calls++;if(pdf.fault!==undefined)throw pdf.fault;return{close:async()=>{},newContext:async()=>({close:async()=>{},newPage:async()=>({setContent:async()=>{},close:async()=>{},pdf:async()=>Buffer.from('Synthetic private PDF')})})};}}}));
const loggers:Array<{close:()=>unknown}>=[];
afterEach(()=>{vi.restoreAllMocks();pdf.fault=undefined;pdf.calls=0;for(const log of loggers.splice(0))log.close();});
const generic='服务器内部错误，请稍后重试。',secret='SQL /private/template-error-origin';
async function modules(){vi.resetModules();const [route,render,auth,log]=await Promise.all([import('../route'),import('../render'),import('../../auth/service'),import('../../lib/logger')]);loggers.push(log.logger);return {...route,...render,...auth,...log};}
type M=Awaited<ReturnType<typeof modules>>;
const credential=(m:M)=>m.createAuthService().signToken({userId:'synthetic-template-actor',roles:['finance'],departmentIds:[],permissions:[],authorizationLoaded:true});
function app(m:M,db:any={}){const a=express();a.use(express.json());a.use('/api/templates',m.createTemplatesRouter({prisma:db,requireAuth:true,apiKeys:new Set()}));return a;}
const data={invoiceNumber:'SYNTHETIC-PDF',items:[]};
async function send(m:M,db:any={},body:any={data}){return request(app(m,db)).post('/api/templates/invoice.sample.pdas/render.pdf').set('Authorization',`Bearer ${credential(m)}`).send(body).timeout({deadline:1000});}
function genuine(m:M,kind:'missing'|'render'){try{m.renderTemplate(kind==='missing'?'synthetic-missing' as any:'invoice.sample.pdas',{items:{}});}catch(e){return e;}throw new Error('expected actual render producer refusal');}
describe('Template PDF private refusal consumer and diagnostic boundary',()=>{
 it.each(['plain','fake-render','fake-missing','getter','proxy','circular','bigint'] as const)('actual PDF unknown %s stays fixed500 rather than trust public shape or diagnostic serialization',async kind=>{
  const m=await modules();let fault:unknown=new Error(secret);
  if(kind==='fake-render')fault=Object.setPrototypeOf(new Error(secret),m.TemplateRenderError.prototype);
  if(kind==='fake-missing')fault=Object.setPrototypeOf(new Error(secret),m.TemplateNotFoundError.prototype);
  if(kind==='getter')fault=Object.defineProperty({},'message',{get(){throw new Error(secret);}});
  if(kind==='proxy')fault=new Proxy({}, {get(){throw new Error(secret);}});
  if(kind==='circular'){const circular:any={};circular.self=circular;fault=circular;}
  if(kind==='bigint')fault=1n;
  pdf.fault=fault;const res=await send(m);expect(res.status).toBe(500);expect(res.body).toEqual({error:'InternalError',message:generic});expect(JSON.stringify(res.body)).not.toContain(secret);expect(pdf.calls).toBe(1);
 });
 it('actual PDF diagnostic throw cannot replace a fixed failure or leave HTTP unanswered',async()=>{
  const m=await modules();pdf.fault=new Error(secret);vi.spyOn(m.logger,'error').mockImplementation(()=>{throw new Error('synthetic logger fault');});const res=await send(m);expect(res.status).toBe(500);expect(res.body).toEqual({error:'InternalError',message:generic});
 });
 it('actual render producer keeps safe422 and the existing unknown-template404 contract',async()=>{
  const m=await modules();const res=await send(m,{}, {data:{items:{}}});expect(res.status).toBe(422);expect(res.body).toEqual({error:'TemplateRenderFailed',message:generic});expect(pdf.calls).toBe(0);
  const missing=await request(app(m)).post('/api/templates/synthetic-missing/render.pdf').set('Authorization',`Bearer ${credential(m)}`).send({data});expect(missing.status).toBe(404);expect(missing.body).toEqual({error:'TemplateNotFound',id:'synthetic-missing'});
 });
 it.each(['missing','render'] as const)('actual %s private tuple remains immutable and the old string reader remains exact after public error mutation',async kind=>{
  const m=await modules();const error=genuine(m,kind) as any;const originalMessage=kind==='missing'?'Template not found: synthetic-missing':generic;
  expect(m.readTemplateRefusal(error)).toBe(originalMessage);const tuple=m.readTemplateRefusalTuple(error);expect(tuple).toEqual({code:kind==='missing'?'TemplateNotFound':'TemplateRenderFailed',statusCode:kind==='missing'?404:422,message:originalMessage});expect(Object.isFrozen(tuple)).toBe(true);
  Object.defineProperty(error,'message',{get(){throw new Error(secret);}});error.code='FORGED';error.statusCode=503;
  expect(m.readTemplateRefusalTuple(error)).toBe(tuple);expect(m.readTemplateRefusal(error)).toBe(originalMessage);expect(m.readTemplateRefusalTuple(new Proxy(error,{}))).toBeUndefined();expect(m.readTemplateRefusalTuple(new m.TemplateRenderError('invoice.sample.pdas',secret))).toBeUndefined();
 });
 it('actual PDF true minted refusal consumes its original snapshot even if public message is replaced by a throwing getter',async()=>{
  const m=await modules(),error=genuine(m,'render') as any;Object.defineProperty(error,'message',{get(){throw new Error(secret);}});pdf.fault=error;
  const res=await send(m);expect(res.status).toBe(422);expect(res.body).toEqual({error:'TemplateRenderFailed',message:generic});
 });
 it('actual PDF best-effort store logger failure preserves mandatory audit and unchanged success metadata',async()=>{
  const m=await modules(),db={renderedDoc:{create:vi.fn(async()=>{throw new Error(secret);})},auditLog:{create:vi.fn(async(_args:any)=>({}))}};
  vi.spyOn(m.logger,'error').mockImplementation(()=>{throw new Error('synthetic logger fault');});const html=m.renderTemplate('invoice.sample.pdas',data),res=await send(m,db);
  expect(res.status).toBe(200);expect(db.renderedDoc.create).toHaveBeenCalledTimes(1);expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  const after=db.auditLog.create.mock.calls[0]![0] as any;
  expect(after.data.detail.source).toBe('route:templates:renderPdf');expect(after.data.targetType).toBe('RenderedDoc');expect(after.data.targetId).toBe('invoice.sample.pdas');
  expect(res.body).toEqual({renderedDocId:null,templateId:html.templateId,schemaVersion:html.schemaVersion,htmlSha:html.sha,pdfSha:crypto.createHash('sha256').update(Buffer.from('Synthetic private PDF')).digest('hex').slice(0,16),pdfBytes:21,pdfBase64:Buffer.from('Synthetic private PDF').toString('base64'),format:'A4',landscape:false,generatedAt:expect.any(String)});expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(after.data.detail.after.htmlSha).toBe(res.body.htmlSha);expect(after.data.detail.after.pdfSha).toBe(res.body.pdfSha);
 });
 it('actual PDF mandatory audit failure remains safe500 even when its logger also throws',async()=>{
  const m=await modules(),db={renderedDoc:{create:vi.fn(async()=>({}))},auditLog:{create:vi.fn(async(_args:any)=>{throw new Error(secret);})}};vi.spyOn(m.logger,'error').mockImplementation(()=>{throw new Error('synthetic logger fault');});
  const res=await send(m,db);expect(db.auditLog.create).toHaveBeenCalledTimes(1);expect(res.status).toBe(500);expect(res.body).toEqual({error:'InternalError',message:generic});
 });
});
