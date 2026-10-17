import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it,vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMistRouter } from './route';
import { MistRepository } from './repository';
import { MistPrivateFiles } from './files';
import { MemoryMistDatabase, testAuthority, testActor, testContract } from './__tests__/support';
import {createMistLocalRuntime} from './local';
import {createMistServer} from './server';
let root: string, app: express.Express, auth: ReturnType<typeof testAuthority>;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mist-http-')); auth = testAuthority();
  const repo = new MistRepository(new MemoryMistDatabase(), testContract, new MistPrivateFiles(root), auth.authorize);
  app = express(); app.use(express.json());
  app.use('/api/mist', createMistRouter({ repository: repo, authenticate: (req, res, next) => {
    const id = req.headers['x-test-user']; if (typeof id !== 'string') { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    (req as any).actor = testActor(id); next();
  } }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('Mist workspace HTTP contracts', () => {
  it('protects the dedicated quote advisor with real workspace authorization and rejects forged identity',async()=>{
    await request(app).post('/api/mist/workspaces/foreign/quotation-cost-advisor').send({}).expect(401);
    const workspace=(await request(app).get('/api/mist/workspaces/default').set('x-test-user','owner').expect(200)).body.workspace;
    await request(app).post(`/api/mist/workspaces/${workspace.id}/quotation-cost-advisor`).set('x-test-user','other').send({}).expect(403);
    auth.users.get('owner')!.permissions.push('ai:chat','quotations:read');
    await request(app).post(`/api/mist/workspaces/${workspace.id}/quotation-cost-advisor`).set('x-test-user','owner').send({ownerId:'owner',actor:{userId:'owner'}}).expect(400);
    const after=(await request(app).get(`/api/mist/workspaces/${workspace.id}`).set('x-test-user','owner').expect(200)).body.workspace;expect(after).toEqual(workspace);
  });
  it('preserves independent local JSON business records and attachment bytes across archive and restore',async()=>{vi.stubEnv('MIST_LOCAL_WORKSPACE','1');vi.stubEnv('NODE_ENV','test');try{const local=createMistLocalRuntime({directory:path.join(root,'isolated-local')});await local.ready;const client=request.agent(createMistServer(undefined,{local}));await client.get('/api/mist/session').expect(200);const original=(await client.get('/api/mist/workspaces/default').expect(200)).body.workspace;const bytes=Buffer.from([0,255,128,1,2,3]);const upload=await client.post(`/api/mist/workspaces/${original.id}/files`).field('requestId','original-file').field('expectedRevision','0').attach('file',bytes,{filename:'original.bin',contentType:'application/octet-stream'}).expect(201);const saved=upload.body.workspace,file=saved.state.files.at(-1);const archived=await client.post(`/api/mist/workspaces/${original.id}/archive`).send({requestId:'local-archive',expectedRevision:1}).expect(200);expect(archived.body.workspace.id).not.toBe(original.id);await client.get(`/api/mist/workspaces/${original.id}`).expect(404);const restored=await client.post(`/api/mist/workspaces/${original.id}/restore`).send({requestId:'local-restore',expectedRevision:2}).expect(200);expect(restored.body.workspace.state.orders).toEqual(saved.state.orders);expect(restored.body.workspace.state.orderLines).toEqual(saved.state.orderLines);expect(restored.body.workspace.state.files).toEqual(saved.state.files);expect(restored.body.workspace.state.platform).toEqual(saved.state.platform);const download=await client.get(`/api/mist/workspaces/${original.id}/files/${file.id}`).expect(200);expect(download.body).toEqual(bytes);}finally{vi.unstubAllEnvs();}});
  it('archives and restores through owner-only idempotent routes without deleting business state',async()=>{const original=(await request(app).get('/api/mist/workspaces/default').set('x-test-user','owner')).body.workspace;const body={requestId:'archive-http',expectedRevision:0};const saved=await request(app).post(`/api/mist/workspaces/${original.id}/archive`).set('x-test-user','owner').send(body).expect(200);expect(saved.body.workspace.id).not.toBe(original.id);await request(app).get(`/api/mist/workspaces/${original.id}`).set('x-test-user','owner').expect(404);const trash=await request(app).get('/api/mist/workspaces/archived').set('x-test-user','owner').expect(200);expect(trash.body.workspaces.map((row:any)=>row.id)).toContain(original.id);const defaults=await request(app).get('/api/mist/workspaces/default').set('x-test-user','owner').expect(200);expect(defaults.body.workspace.id).toBe(saved.body.workspace.id);const replay=await request(app).post(`/api/mist/workspaces/${original.id}/archive`).set('x-test-user','owner').send(body).expect(200);expect(replay.body.receipt).toEqual(saved.body.receipt);await request(app).post(`/api/mist/workspaces/${original.id}/restore`).set('x-test-user','other').send({requestId:'foreign-restore',expectedRevision:1}).expect(404);const restored=await request(app).post(`/api/mist/workspaces/${original.id}/restore`).set('x-test-user','owner').send({requestId:'restore-http',expectedRevision:1}).expect(200);expect(restored.body.workspace.id).toBe(original.id);expect(restored.body.workspace.state.money).toEqual(original.state.money);expect(restored.body.workspace.state.workspaceArchive).toBeUndefined();});
  it('serves the lightweight revision head only to the owner or authorized members', async () => {
    const workspace = (await request(app).get('/api/mist/workspaces/default').set('x-test-user', 'owner').expect(200)).body.workspace;
    expect((await request(app).get(`/api/mist/workspaces/${workspace.id}/revision`).set('x-test-user', 'owner').expect(200)).body).toEqual({ id: workspace.id, revision: workspace.revision });
    await request(app).get(`/api/mist/workspaces/${workspace.id}/revision`).set('x-test-user', 'other').expect(404);
    await request(app).get('/api/mist/workspaces/not-a-uuid/revision').set('x-test-user', 'owner').expect(400);
  });
  it('default middleware rejects absent, invalid and API-key credentials before repository access', async () => {
    const productionGuard = express(); productionGuard.use(express.json());
    productionGuard.use('/api/mist', createMistRouter({ repository: {} as MistRepository }));
    expect((await request(productionGuard).get('/api/mist/workspaces/default')).status).toBe(401);
    expect((await request(productionGuard).get('/api/mist/workspaces/default').set('Authorization', 'Bearer invalid')).status).toBe(401);
    expect((await request(productionGuard).get('/api/mist/workspaces/default').set('X-Bambook-API-Key', 'test-key')).status).toBe(401);
    expect((await request(productionGuard).post('/api/mist/workspaces').send({ ownerId: 'owner', actor: { userId: 'owner' }, name: 'Forged' })).status).toBe(401);
  });
  it('requires a real authenticated subject and rejects client-supplied owner or actor', async () => {
    expect((await request(app).get('/api/mist/workspaces/default')).status).toBe(401);
    expect((await request(app).post('/api/mist/workspaces').set('x-test-user', 'owner').send({ name: 'x', ownerId: 'other' })).status).toBe(400);
    const workspace = (await request(app).get('/api/mist/workspaces/default').set('x-test-user', 'owner')).body.workspace;
    expect((await request(app).post(`/api/mist/workspaces/${workspace.id}/commands`).set('x-test-user', 'owner').send({ requestId: 'a', expectedRevision: 0, actor: { userId: 'other' }, command: { type: 'notes.add', payload: { text: 'x' } } })).status).toBe(400);
    expect((await request(app).get(`/api/mist/workspaces/${workspace.id}`).set('x-test-user', 'other')).status).toBe(404);
    auth.users.get('owner')!.active = false;
    expect((await request(app).get(`/api/mist/workspaces/${workspace.id}`).set('x-test-user', 'owner')).status).toBe(401);
  });
  it('does not treat a filename field as an uploaded file and leaves the workspace unchanged', async () => {
    const workspace = (await request(app).get('/api/mist/workspaces/default').set('x-test-user', 'owner')).body.workspace;
    const response = await request(app).post(`/api/mist/workspaces/${workspace.id}/files`).set('x-test-user', 'owner').field('requestId', 'name-only').field('expectedRevision', '0');
    expect(response.status).toBe(400); expect(response.body.error.code).toBe('FILE_REQUIRED');
    const current = (await request(app).get(`/api/mist/workspaces/${workspace.id}`).set('x-test-user', 'owner')).body.workspace;
    expect(current.revision).toBe(0); expect(current.state.files).toEqual([]);
  });
  it('uploads actual multipart bytes, downloads only within the owner workspace and replays the same request', async () => {
    const workspace = (await request(app).get('/api/mist/workspaces/default').set('x-test-user', 'owner')).body.workspace;
    const bytes = Buffer.from('real attachment contents');
    const upload = () => request(app).post(`/api/mist/workspaces/${workspace.id}/files`).set('x-test-user', 'owner').field('requestId', 'file-upload').field('expectedRevision', '0').attach('file', bytes, 'brief.txt');
    const created = await upload(); expect(created.status).toBe(201); expect(created.body.workspace.revision).toBe(1);
    const file = created.body.workspace.state.files[0]; expect(file.size).toBe(bytes.length); expect(file.name).toBe('brief.txt');
    const response = await request(app).get(`/api/mist/workspaces/${workspace.id}/files/${file.id}`).set('x-test-user', 'owner');
    expect(response.status).toBe(200); expect(response.body).toEqual(bytes); expect(response.headers['cache-control']).toBe('private, no-store');
    expect((await upload()).body.replayed).toBe(true);
    expect((await request(app).get(`/api/mist/workspaces/${workspace.id}/files/${file.id}`).set('x-test-user', 'other')).status).toBe(404);
    const receipt = await request(app).get(`/api/mist/workspaces/${workspace.id}/receipts/file-upload`).set('x-test-user', 'owner');
    expect(receipt.body.receipt.revision).toBe(1);
  });
});

it.each(['全链路模拟PO.pdf','café.pdf','brief.txt'])('preserves the multipart UTF-8 filename %s',async name=>{
  const workspace=(await request(app).get('/api/mist/workspaces/default').set('x-test-user','owner')).body.workspace;
  const bytes=Buffer.from('isolated upload bytes');
  const upload=()=>request(app).post(`/api/mist/workspaces/${workspace.id}/files`).set('x-test-user','owner').field('requestId','unicode-file').field('expectedRevision','0').attach('file',bytes,{filename:name,contentType:'application/pdf'});
  const saved=await upload().expect(201);
  expect((await upload()).body.replayed).toBe(true);
  expect(saved.body.workspace.state.files[0].name).toBe(name);
  const download=await request(app).get(`/api/mist/workspaces/${workspace.id}/files/${saved.body.workspace.state.files[0].id}`).set('x-test-user','owner').expect(200);
  expect(download.body).toEqual(bytes);
  expect(download.headers['content-disposition']).toContain(encodeURIComponent(name));
});

it('keeps a legacy Latin-1 multipart filename when its bytes are not UTF-8',async()=>{
  const workspace=(await request(app).get('/api/mist/workspaces/default').set('x-test-user','owner')).body.workspace;
  const boundary='legacy-name-boundary',bytes=Buffer.from('legacy file bytes');
  const fields=`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\nlegacy-name\r\n--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="café.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  const body=Buffer.concat([Buffer.from(fields,'latin1'),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const saved=await request(app).post(`/api/mist/workspaces/${workspace.id}/files`).set('x-test-user','owner').set('Content-Type',`multipart/form-data; boundary=${boundary}`).send(body).expect(201);
  expect(saved.body.workspace.state.files[0].name).toBe('café.pdf');
});
