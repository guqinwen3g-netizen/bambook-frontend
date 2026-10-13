import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import cp, { type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

// Pre-constructor guard: this suite never consults any company .env or URL.
const sandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
const markerPath = process.env.BAMBOOK_STATS_DB_MARKER!;
assert(sandbox && sandbox.startsWith('/private/tmp/bambook-shipping-stats-native-'));
assert(markerPath === path.join(sandbox, 'PRIVATE-PG-MARKER.json'));
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
const u = new URL(process.env.DATABASE_URL!);
assert.equal(process.env.DB_ENV, 'acceptance-private'); assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.BAMBOOK_NO_SCHEDULER, '1');
assert(marker.authorized && marker.root === sandbox && fs.realpathSync(sandbox) === sandbox);
assert.equal(marker.directory, sandbox + '/postgres'); assert.equal(fs.realpathSync(marker.directory), marker.directory);
assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.username, 'acceptance'); assert.equal(u.password, '');
assert.equal(u.port, String(marker.port)); assert.equal(u.pathname, '/' + marker.name); assert(/^bambook_acceptance_[a-f0-9]{12}$/.test(marker.name));
assert.equal(process.env.BAMBOOK_ACCEPTANCE_DB_PORT, String(marker.port)); assert.equal(process.env.BAMBOOK_ACCEPTANCE_UI_API_PORT, String(marker.apiPort));
const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
const db = new PrismaClient();
const controlsFile = sandbox + '/stats-controls.json';
const journalFile = sandbox + '/stats-query-journal.jsonl';
const observations: any[] = [];
const paths = ['/api/v1/shipping/stats/on-time', '/api/v1/shipping/stats/by-method'];
const origin = 'http://127.0.0.1:' + marker.apiPort;
const secret = process.env.JWT_SECRET!;
const signed = (who = 'stats-finance', ceiling?: string[]) => jwt.sign({userId:who,roles:['owner'],roleIds:['role-super-admin'],permissions:['orders:read','shipments:read'],departmentIds:['company'],...(ceiling === undefined ? {} : {permissionCeiling:ceiling})},secret,{expiresIn:'1h'});
let api: ChildProcess | undefined;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const readJournal = () => fs.existsSync(journalFile) ? fs.readFileSync(journalFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)) : [];
const configure = (value: any) => fs.writeFileSync(controlsFile, JSON.stringify(value));
async function get(p: string, token?: string) {
  const response = await fetch(origin + p,{headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(5000)});
  const text = await response.text(); const body = JSON.parse(text);
  observations.push({path:p,status:response.status,body,queryJournal:readJournal()});
  expect(text).not.toMatch(/SELECT secret|native-fault-SQL/);
  return {status:response.status,body};
}
async function protectedFacts() {
  return JSON.stringify({orders:await db.order.findMany({orderBy:{id:'asc'}}),shipments:await db.shipment.findMany({orderBy:{id:'asc'}}),allocations:await db.shipmentOrderAllocation.findMany({orderBy:{id:'asc'}}),auditCount:await db.auditLog.count()},(_,v)=>typeof v==='bigint'?String(v):v);
}
async function both(token: string, expected: number) {const before=await protectedFacts();const statuses=[];for(const p of paths)statuses.push((await get(p,token)).status);expect(await protectedFacts()).toBe(before);expect(statuses).toEqual([expected,expected]);}

beforeAll(async () => {
  const [identity] = await db.$transaction(async tx => { await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY'); return tx.$queryRawUnsafe<any[]>('SELECT current_database() AS name, inet_server_port() AS port, current_setting(\'data_directory\') AS directory'); });
  expect(identity).toEqual({name:marker.name,port:marker.port,directory:marker.directory});
  fs.writeFileSync(sandbox+'/stats-native-identity.json',JSON.stringify(identity));
  const preload = sandbox + '/stats-before-prisma.cjs';
  // Real index keeps all production middleware/order. Only real delegate faults
  // and mid-read coordination are instrumented, never actor/grant/L2 substitutes.
  fs.writeFileSync(preload, `const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict'),Module=require('module');
const marker=${JSON.stringify(markerPath)},m=JSON.parse(fs.readFileSync(marker));const u=new URL(process.env.DATABASE_URL);assert.equal(process.env.DB_ENV,'acceptance-private');assert.equal(process.env.BAMBOOK_NO_SCHEDULER,'1');assert.equal(process.env.BAMBOOK_REQUIRE_AUTH,'true');assert.equal(process.env.BAMBOOK_ACCEPTANCE_SANDBOX,m.root);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'acceptance');assert.equal(u.password,'');assert.equal(u.port,String(m.port));assert.equal(u.pathname,'/'+m.name);assert.equal(process.env.PORT,String(m.apiPort));assert.equal(fs.realpathSync(m.directory),m.directory);const got=cp.execFileSync(m.pg+'/psql',['-h','127.0.0.1','-p',String(m.port),'-U','acceptance','-d',m.name,'-X','-Atq','-c',"BEGIN READ ONLY; SELECT current_database()||'|'||inet_server_port()||'|'||current_setting('data_directory'); COMMIT;"],{encoding:'utf8'}).trim();assert.equal(got,m.name+'|'+m.port+'|'+m.directory);
const file=m.root+'/stats-controls.json',journal=m.root+'/stats-query-journal.jsonl',load=Module._load,wrapped=new WeakMap();
Module._load=function(id,parent,isMain){const exports=load.apply(this,arguments);if(id!=='@prisma/client'||!exports.PrismaClient)return exports;if(wrapped.has(exports))return wrapped.get(exports);const Base=exports.PrismaClient;class Instrumented extends Base{constructor(...args){super(...args);return new Proxy(this,{get(target,key){const value=Reflect.get(target,key,target);if(!['order','shipment','shipmentOrderAllocation','teamMember'].includes(key))return typeof value==='function'?value.bind(target):value;return new Proxy(value,{get(delegate,method){const fn=Reflect.get(delegate,method);if(method!=='findMany')return typeof fn==='function'?fn.bind(delegate):fn;return async (query)=>{let c=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};fs.appendFileSync(journal,JSON.stringify({model:key,method,query})+'\\n');if(c.fault===key)throw new Error('native-fault-SQL SELECT secret');const rows=await fn.call(delegate,query);if(c.pause&&key==='shipment'&&query.select?.ata){c.pause=false;fs.writeFileSync(file,JSON.stringify(c));fs.writeFileSync(m.root+'/stats-paused','ready');for(let i=0;i<400;i++){if(fs.existsSync(m.root+'/stats-resume'))break;await new Promise(r=>setTimeout(r,5));}assert(fs.existsSync(m.root+'/stats-resume'),'private coordination not resumed');}return rows;};}});}});}}
const result={...exports,PrismaClient:Instrumented};wrapped.set(exports,result);return result;};`);
  configure({}); const log = fs.openSync(sandbox+'/actual-index.log','w');
  api = cp.spawn(process.execPath,[path.resolve('dist/index.js')],{cwd:process.cwd(),env:{...process.env,BAMBOOK_REQUIRE_AUTH:'true',BAMBOOK_DEV_PANEL:'false',PORT:String(marker.apiPort),BUILD_SHA:'41fe6501957f0e7d63f71facc87055cc21eb8ea2',BAMBOOK_UPLOAD_DIR:sandbox+'/uploads',BAMBOOK_PRIVATE_FILES_DIR:sandbox+'/private-files',BAMBOOK_LOG_DIR:sandbox+'/logs',NODE_OPTIONS:'--require='+preload+' --require='+path.resolve('../scripts/acceptance-network-guard.cjs')},stdio:['ignore',log,log]});fs.closeSync(log);
  let healthy=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(300)});if(r.ok){const b:any=await r.json();expect(b.database).toBe('ok');expect(b.authRequired).toBe(true);healthy=true;break;}}catch{}await wait(50);}expect(healthy).toBe(true);
});

beforeEach(async () => {
  configure({});for(const name of ['stats-paused','stats-resume'])if(fs.existsSync(sandbox+'/'+name))fs.unlinkSync(sandbox+'/'+name);
  await db.shipmentOrderAllocation.deleteMany();await db.shipment.deleteMany();await db.order.deleteMany();
  for(const role of ['role-finance','role-sales'])await db.role.upsert({where:{id:role},create:{id:role,name:role,isSystem:true},update:{}});
  for(const [id,role] of [['stats-finance','role-finance'],['stats-sales','role-sales']]) {
    await db.userAccount.upsert({where:{id},create:{id,displayName:id,status:'active'},update:{status:'active',deletedAt:null}});
    await db.userRole.deleteMany({where:{userId:id}});await db.userRole.create({data:{id:'UR-'+id,userId:id,roleId:role}});
  }
  for(const role of ['role-finance','role-sales'])for(const scope of ['orders:read','shipments:read']) {
    const permission=await db.permission.upsert({where:{scope},create:{id:'P-'+scope,scope},update:{}});
    await db.rolePermission.upsert({where:{roleId_permissionId:{roleId:role,permissionId:permission.id}},create:{id:'RP-'+role+'-'+scope,roleId:role,permissionId:permission.id},update:{}});
  }
  for(const [id,ownerId] of [['O-own','stats-sales'],['O-foreign','someone-else']])await db.order.create({data:{id,ownerId,customer:'Synthetic',product:'Synthetic',type:'Fabric',quantity:200,status:'Shipping',dueDate:'2026-10-15',quoteAmount:'200'}});
  for(const [id,orderId,ata] of [['S-first','O-own','2026-10-10'],['S-last','O-own',null],['S-foreign','O-foreign','2026-10-11'],['S-standalone',null,null]])await db.shipment.create({data:{id:id!,shipmentNumber:id!,orderId,status:'Shipped',type:'Export',shippingMethod:'Sea',eta:'2026-10-15',etd:'2026-10-01',ata,createdAt:BigInt(1),updatedAt:BigInt(1)}});
  await db.shipmentOrderAllocation.createMany({data:[{id:'A-first',shipmentId:'S-first',orderId:'O-own',status:'Fulfilled',createdAt:BigInt(1),updatedAt:BigInt(1)},{id:'A-last',shipmentId:'S-last',orderId:'O-own',status:'Fulfilled',createdAt:BigInt(1),updatedAt:BigInt(1)},{id:'A-merged',shipmentId:'S-foreign',orderId:'O-own',status:'Fulfilled',createdAt:BigInt(1),updatedAt:BigInt(1)}]});
  fs.writeFileSync(journalFile,'');
});
afterAll(async () => {
  configure({});fs.writeFileSync(sandbox+'/stats-resume','release');
  if(api){api.kill('SIGTERM');for(let i=0;i<30&&api.exitCode===null&&api.signalCode===null;i++)await wait(50);expect(api.exitCode!==null||api.signalCode!==null).toBe(true);}
  await db.$disconnect();fs.writeFileSync(sandbox+'/stats-observations.json',JSON.stringify({observations,indexStopped:!api||api.exitCode!==null||api.signalCode!==null},null,2));
});

describe('actual index / private PostgreSQL shipment statistics', () => {
  it('SSN01 anonymous denied; actual current Finance reads complete company and standalone statistics without writes', async()=>{
    for(const p of paths)expect((await get(p)).status).toBe(401);
    await both(signed(),200);const a=await get(paths[0],signed());expect(a.body.order.total).toBe(2);const b=await get(paths[1],signed());expect(b.body.methods[0].total).toBe(4);
  });
  it('SSN02 signed empty ceiling denies both statistics before business projection', async()=>{await both(signed('stats-finance',[]),403);expect(readJournal().filter(x=>x.model==='order'||x.model==='shipment')).toHaveLength(0);});
  it('SSN03 actual stored shipments:read withdrawal beats stale owner/permission JWT', async()=>{await db.rolePermission.delete({where:{roleId_permissionId:{roleId:'role-finance',permissionId:'P-shipments:read'}}});await both(signed(),403);});
  it('SSN04 actual stored orders:read withdrawal also denies both endpoints', async()=>{await db.rolePermission.delete({where:{roleId_permissionId:{roleId:'role-finance',permissionId:'P-orders:read'}}});await both(signed(),403);});
  it('SSN05 canonical current Sales L2 includes non-primary merged ticket but excludes foreign-only and standalone', async()=>{
    await db.shipment.create({data:{id:'S-foreign-only',shipmentNumber:'S-foreign-only',orderId:'O-foreign',status:'Shipped',type:'Export',shippingMethod:'Air',eta:'2026-10-15',ata:'2026-10-11',createdAt:BigInt(1),updatedAt:BigInt(1)}});
    const before=await protectedFacts();const a=await get(paths[0],signed('stats-sales'));expect(a.status).toBe(200);expect(a.body.order.total).toBe(1);const b=await get(paths[1],signed('stats-sales'));expect(b.status).toBe(200);expect(b.body.methods).toHaveLength(1);expect(b.body.methods[0].total).toBe(3);expect(await protectedFacts()).toBe(before);
  });
  it('SSN06 first actual arrival keeps split order pending; last arrival uses maximum; cancelled ticket is excluded', async()=>{
    const a=await get(paths[0],signed());expect(a.body.order).toEqual({total:2,onTime:1,late:0,pending:1,rate:1});
    await db.shipment.update({where:{id:'S-last'},data:{ata:'2026-10-16'}});const b=await get(paths[0],signed());expect(b.body.order).toEqual({total:2,onTime:1,late:1,pending:0,rate:0.5});
    await db.shipment.update({where:{id:'S-last'},data:{ata:null,status:'Cancelled'}});expect((await get(paths[0],signed())).body.order).toEqual({total:2,onTime:2,late:0,pending:0,rate:1});
  });
  it('SSN07 actual team/SOA delegate faults fail closed as safe 503, never empty or all-company aggregates', async()=>{for(const fault of ['teamMember','shipmentOrderAllocation']){configure({fault});await both(signed('stats-sales'),503);configure({});}});
  it('SSN08 after first projection a separate connection revokes current grant before return; no stale response', async()=>{
    configure({pause:true});const pending=get(paths[0],signed());for(let i=0;i<200&&!fs.existsSync(sandbox+'/stats-paused');i++)await wait(5);expect(fs.existsSync(sandbox+'/stats-paused')).toBe(true);
    await db.rolePermission.delete({where:{roleId_permissionId:{roleId:'role-finance',permissionId:'P-shipments:read'}}});fs.writeFileSync(sandbox+'/stats-resume','ok');expect((await pending).status).toBe(403);
  });
  it('SSN09 after first projection a separate connection transfers the visible parent; no previous L2 aggregate leaves', async()=>{
    configure({pause:true});const pending=get(paths[1],signed('stats-sales'));for(let i=0;i<200&&!fs.existsSync(sandbox+'/stats-paused');i++)await wait(5);expect(fs.existsSync(sandbox+'/stats-paused')).toBe(true);
    await db.order.update({where:{id:'O-own'},data:{ownerId:'someone-else'}});fs.writeFileSync(sandbox+'/stats-resume','ok');expect((await pending).status).toBe(503);
  });
});
