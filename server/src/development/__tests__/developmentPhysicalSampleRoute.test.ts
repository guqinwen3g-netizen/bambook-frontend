import {beforeEach,expect,it,vi} from 'vitest';
import express from 'express';import request from 'supertest';
const m=vi.hoisted(()=>({incoming:vi.fn(),ship:vi.fn(),read:vi.fn(),list:vi.fn(),resolve:vi.fn(),resolution:vi.fn()}));
vi.mock('../developmentPhysicalSampleService',()=>({registerDevelopmentIncomingSample:m.incoming,shipDevelopmentSampleToFactory:m.ship,readDevelopmentPhysicalCommand:m.read,listDevelopmentPhysicalCommands:m.list,resolveDevelopmentPhysicalCommand:m.resolve,readDevelopmentPhysicalResolution:m.resolution}));
import {createDevelopmentPhysicalSampleRouter} from '../developmentPhysicalSampleRoute';
import {DevelopmentDomainError} from '../developmentOperationalGuard';
const events=vi.fn();
function app(permissions=['products:read','products:write','sample:room:write'],source='user-session',userId='sales'){
 const a=express();a.use(express.json());a.use((req:any,_res,next)=>{req.actor={userId,permissions,roles:[],departmentIds:[]};req.authSource=source;next();});a.use(createDevelopmentPhysicalSampleRouter({prisma:{},onDataChange:events}));return a;
}
beforeEach(()=>{vi.clearAllMocks();for(const fn of Object.values(m))fn.mockReset().mockResolvedValue({itemId:'same-card',replayed:false});});
it('requires real session and both development write and stock permissions',async()=>{
 expect((await request(app(undefined,'api-key')).post('/c/incoming-samples').send({})).status).toBe(401);
 expect((await request(app(['products:write'])).post('/c/incoming-samples').send({})).status).toBe(403);
 expect((await request(app(['sample:room:write'])).post('/c/factory-sample-shipments').send({})).status).toBe(403);
 expect(m.incoming).not.toHaveBeenCalled();expect(m.ship).not.toHaveBeenCalled();
});
it('uses trusted context/exact sources and emits same source events only after a new success',async()=>{
 const body={actorId:'spoof',requestKey:'original'};expect((await request(app()).post('/c/factory-sample-shipments').send(body)).status).toBe(200);
 expect(m.ship).toHaveBeenCalledWith(expect.objectContaining({actorId:'sales',trustedActor:expect.objectContaining({userId:'sales'})}),'c',body);
 expect(events.mock.calls.map(([e])=>e.entity)).toEqual(['development','samples']);events.mockClear();m.ship.mockResolvedValue({itemId:'same-card',replayed:true});await request(app()).post('/c/factory-sample-shipments').send(body);expect(events).not.toHaveBeenCalled();
 expect((await request(app(['products:read'])).get('/c/physical-sample-commands/factory/original')).status).toBe(200);expect(m.read).toHaveBeenCalledWith(expect.objectContaining({actorId:'sales'}),'c','factory','original');
});
it('preserves native lifecycle failures and hides storage internals without announcing a write',async()=>{
 m.incoming.mockRejectedValue(new DevelopmentDomainError('DEVELOPMENT_CLOSED','开发已结案'));expect((await request(app()).post('/c/incoming-samples').send({})).status).toBe(409);expect(events).not.toHaveBeenCalled();
 m.read.mockRejectedValue(Error('private SQL'));const r=await request(app()).get('/c/physical-sample-commands/incoming/key');expect(r.status).toBe(500);expect(JSON.stringify(r.body)).not.toContain('private SQL');
});

it('resolve uses current write permissions and never emits a new stock event for cancelled or prior success',async()=>{
 const path='/c/physical-sample-commands/incoming/original/resolve',input={requestKey:'original',name:''};expect((await request(app(['products:read'])).post(path).send({input})).status).toBe(403);m.resolve.mockResolvedValue({status:'cancelled',caseId:'c',kind:'incoming',requestKey:'original',actorId:'sales',replayed:false});expect((await request(app()).post(path).send({input})).status).toBe(200);expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({actorId:'sales'}),'c','incoming','original',input);expect(events).not.toHaveBeenCalled();m.resolve.mockResolvedValue({status:'succeeded',receipt:{itemId:'card',replayed:true}});await request(app()).post(path).send({input});expect(events).not.toHaveBeenCalled();
});

it('current read authority can GET terminal facts without resolve/write permissions or stock events',async()=>{
 m.resolution.mockResolvedValue({status:'cancelled',actorId:'sales',caseId:'c',kind:'incoming',requestKey:'original',replayed:true});const r=await request(app(['products:read'])).get('/c/physical-sample-commands/incoming/original/resolution');expect(r.status).toBe(200);expect(m.resolution).toHaveBeenCalledWith(expect.objectContaining({actorId:'sales'}),'c','incoming','original');expect(events).not.toHaveBeenCalled();
});
