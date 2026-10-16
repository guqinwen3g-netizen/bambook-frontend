import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MistPrivateFiles, MIST_FILE_MAX_BYTES } from './files';
import { MistRepository } from './repository';
import { MemoryMistDatabase, requestReceiptCount, testActor, testAuthority, testContract } from './__tests__/support';
let root: string, db: MemoryMistDatabase, auth: ReturnType<typeof testAuthority>, repo: MistRepository;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'mist-repo-')); db = new MemoryMistDatabase(); auth = testAuthority(); repo = new MistRepository(db, testContract, new MistPrivateFiles(root), auth.authorize); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const command = (requestId: string, expectedRevision: number, cents = 5) => ({ requestId, expectedRevision, command: { type: 'money.add', payload: { cents } } });
describe('Mist transactional workspace', () => {
  it('archives without deleting records or original files, then restores the exact data',async()=>{const first=await repo.create(testActor(),{name:'Original',seed:'empty'});const upload=await repo.upload(testActor(),first.id,{requestId:'attach-original',expectedRevision:0},{bytes:Buffer.from('original bytes'),name:'original.txt',mimeType:'text/plain'});const file=upload.workspace.state.files[0];const second=await repo.create(testActor(),{name:'Other active',seed:'empty'});const result=await repo.changeArchive(testActor(),first.id,{requestId:'archive-first',expectedRevision:1},'archive');expect(result.workspace.id).toBe(second.id);expect((await repo.list(testActor())).map(row=>row.id)).not.toContain(first.id);expect((await repo.listArchived(testActor())).map(row=>row.id)).toContain(first.id);await expect(repo.get(testActor(),first.id)).rejects.toMatchObject({status:404});const restored=await repo.changeArchive(testActor(),first.id,{requestId:'restore-first',expectedRevision:2},'restore');expect(restored.workspace.id).toBe(first.id);expect(restored.workspace.state.files).toEqual(upload.workspace.state.files);expect((await repo.download(testActor(),first.id,file.id)).bytes).toEqual(Buffer.from('original bytes'));expect(restored.workspace.state.workspaceArchive).toBeUndefined();});
  it('atomically creates an empty continuation if the last active workspace is archived',async()=>{const first=await repo.create(testActor(),{name:'Only',seed:'demo'},true);const result=await repo.changeArchive(testActor(),first.id,{requestId:'archive-only',expectedRevision:0},'archive');expect(result.workspace.id).not.toBe(first.id);expect(result.workspace.state.money.cents).toBe(0);expect((await repo.create(testActor(),{name:'Default',seed:'demo'},true)).id).toBe(result.workspace.id);expect(db.workspaces.size).toBe(2);});
  it('reuses a named workspace and its empty archive continuation when no default slug exists',async()=>{
    const named=await repo.create(testActor(),{name:'Named only',slug:'named-only',seed:'empty'});
    const selected=await repo.create(testActor(),{name:'Default',seed:'demo'},true);
    expect(selected.id).toBe(named.id);expect(db.workspaces.size).toBe(1);
    const result=await repo.changeArchive(testActor(),named.id,{requestId:'archive-named',expectedRevision:0},'archive');
    const resumed=await repo.create(testActor(),{name:'Default',seed:'demo'},true);
    expect(resumed.id).toBe(result.workspace.id);expect(resumed.state.money.cents).toBe(0);
    expect(db.workspaces.size).toBe(2);expect([...db.workspaces.values()].some(row=>row.slug==='default')).toBe(false);
  });
  it('retains the requested initial seed when a first default lookup has no existing workspace',async()=>{
    const first=await repo.create(testActor(),{name:'First default',seed:'demo'},true);
    expect(first.state.money.cents).toBe(100);expect(db.workspaces.size).toBe(1);
    expect([...db.workspaces.values()][0].slug).toBe('default');
  });
  it('replays lifecycle receipts once and refuses another owner or a stale revision',async()=>{const first=await repo.create(testActor(),{name:'One'});const command={requestId:'archive-once',expectedRevision:0};const result=await repo.changeArchive(testActor(),first.id,command,'archive');const replay=await repo.changeArchive(testActor(),first.id,command,'archive');expect(replay.replayed).toBe(true);expect(replay.receipt).toEqual(result.receipt);expect(db.workspaces.size).toBe(2);await expect(repo.changeArchive(testActor('other'),first.id,{requestId:'foreign-restore',expectedRevision:1},'restore')).rejects.toMatchObject({status:404});await expect(repo.changeArchive(testActor(),first.id,{requestId:'stale-restore',expectedRevision:0},'restore')).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(await repo.receipt(testActor(),first.id,command.requestId)).toEqual(result.receipt);});
  it('blocks archive with pending approvals and never exposes archived reviews',async()=>{const contract={...testContract,getMistReviewTasks:()=>[{id:'review-one',status:'pending',reviewerIds:['owner'],requiredPermission:'products:write'}] as any};const guarded=new MistRepository(db,contract,new MistPrivateFiles(root),auth.authorize);const first=await guarded.create(testActor(),{name:'Pending'});await expect(guarded.changeArchive(testActor(),first.id,{requestId:'blocked-archive',expectedRevision:0},'archive')).rejects.toMatchObject({code:'PENDING_REVIEWS'});expect((await guarded.get(testActor(),first.id)).state.workspaceArchive).toBeUndefined();db.workspaces.get(first.id).state.workspaceArchive={at:new Date().toISOString(),actorId:'owner'};expect(await guarded.listReviews(testActor())).toEqual([]);await expect(guarded.decideReview(testActor(),first.id,'review-one',{requestId:'blocked-decision',expectedRevision:0,decision:'approved',note:'not allowed'})).rejects.toMatchObject({status:404});});
  it('rolls back lifecycle metadata and continuation creation when its receipt cannot commit',async()=>{const first=await repo.create(testActor(),{name:'Atomic archive'},true);db.failReceipt=true;await expect(repo.changeArchive(testActor(),first.id,{requestId:'failed-archive',expectedRevision:0},'archive')).rejects.toThrow('transaction failed');db.failReceipt=false;expect(db.workspaces.size).toBe(1);expect((await repo.get(testActor(),first.id)).state.workspaceArchive).toBeUndefined();});
  it('commits one creation and its receipt for concurrent identical slugs', async () => {
    const input = { name: 'Recoverable', slug: 'same-create', seed: 'empty' as const };
    const result = await Promise.all(Array.from({ length: 4 }, () => repo.create(testActor(), input)));
    expect(new Set(result.map(item => item.id)).size).toBe(1); expect(db.workspaces.size).toBe(1); expect(db.receipts.size).toBe(1);
    expect(result.every(item => item.revision === 0 && item.state.money.cents === 0)).toBe(true);
    expect(await repo.receipt(testActor(), result[0].id, 'create:same-create')).toEqual({ requestId: 'create:same-create', revision: 0, result: { workspaceId: result[0].id } });
  });
  it('rejects altered creation input while allowing the same key for another owner', async () => {
    const input = { name: 'Original', slug: 'identity', seed: 'empty' as const };
    const original = await repo.create(testActor(), input);
    await expect(repo.create(testActor(), { ...input, name: 'Changed' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
    await expect(repo.create(testActor(), { ...input, seed: 'demo' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
    const other = await repo.create(testActor('other'), { ...input, name: 'Other owner' });
    expect(other.id).not.toBe(original.id); expect(db.workspaces.size).toBe(2); expect(db.receipts.size).toBe(2);
  });
  it('replays the original creation after subsequent workspace edits without resetting its state', async () => {
    const input = { name: 'Created once', slug: 'edited-after-create', seed: 'empty' as const };
    const original = await repo.create(testActor(), input); await repo.execute(testActor(), original.id, command('later-edit', 0, 125));
    const replay = await repo.create(testActor(), input);
    expect(replay.id).toBe(original.id); expect(replay.revision).toBe(1); expect(replay.state.money.cents).toBe(125);
    expect((await repo.receipt(testActor(), original.id, 'create:edited-after-create')).revision).toBe(0);
  });
  it('rolls back a creation if its receipt cannot persist or authorization changes before commit', async () => {
    db.failReceipt = true;
    await expect(repo.create(testActor(), { name: 'Atomic', slug: 'atomic' })).rejects.toThrow('transaction failed');
    expect(db.workspaces.size).toBe(0); expect(db.receipts.size).toBe(0); db.failReceipt = false;
    const contract = { ...testContract, createMistState: (...args: Parameters<typeof testContract.createMistState>) => { const value = testContract.createMistState(...args); auth.users.get('owner')!.active = false; return value; } };
    const guarded = new MistRepository(db, contract, new MistPrivateFiles(root), auth.authorize);
    await expect(guarded.create(testActor(), { name: 'Revoked', slug: 'revoked-create' })).rejects.toMatchObject({ status: 401 });
    expect(db.workspaces.size).toBe(0); expect(db.receipts.size).toBe(0);
  });
  it.each(['P2002', 'P2034'])('resolves a competing committed creation after %s', async code => {
    let conflict = true;
    const concurrent = { $transaction: async (run: (tx: any) => Promise<any>) => { const result = await db.$transaction(run); if (conflict) { conflict = false; throw Object.assign(new Error('competing transaction'), { code }); } return result; } };
    const guarded = new MistRepository(concurrent, testContract, new MistPrivateFiles(root), auth.authorize);
    const result = await guarded.create(testActor(), { name: 'Winner', slug: 'winner', seed: 'empty' });
    expect(result.id).toBe([...db.workspaces.keys()][0]); expect(db.workspaces.size).toBe(1); expect(db.receipts.size).toBe(1);
  });
  it('keeps default creation independent of named creation receipts', async () => {
    const a = await repo.create(testActor(), { name: 'Default', seed: 'empty' }, true);
    const again = await repo.create(testActor(), { name: 'Changed default name', seed: 'demo' }, true);
    expect(again.id).toBe(a.id); expect(again.name).toBe('Default'); expect(db.receipts.size).toBe(0);
  });
  it('can retrieve the creation receipt for the full supported slug length', async () => {
    const slug = 's'.repeat(120), created = await repo.create(testActor(), { name: 'Long key', slug });
    expect((await repo.receipt(testActor(), created.id, 'create:' + slug)).result.workspaceId).toBe(created.id);
  });
  it('creates one default per owner and isolates read/write/receipt access', async () => {
    const actor = testActor(), a = await repo.create(actor, { name: 'One' }, true), again = await repo.create(actor, { name: 'One' }, true);
    expect(again.id).toBe(a.id); expect(await repo.list(testActor('other'))).toEqual([]);
    await expect(repo.get(testActor('other'), a.id)).rejects.toMatchObject({ status: 404 });
    await expect(repo.execute(testActor('other'), a.id, command('foreign', 0))).rejects.toMatchObject({ status: 403 });
    await expect(repo.receipt(testActor('other'), a.id, 'foreign')).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks live account and grants, including credential permission ceiling', async () => {
    const a = await repo.create(testActor(), { name: 'One' }); auth.users.get('owner')!.active = false;
    await expect(repo.get(testActor(), a.id)).rejects.toMatchObject({ status: 401 }); auth.users.get('owner')!.active = true;
    auth.users.get('owner')!.permissions = ['products:write'];
    await expect(repo.execute(testActor(), a.id, command('revoked', 0))).rejects.toMatchObject({ status: 403 });
    auth.users.get('owner')!.permissions.push('finance:write');
    await expect(repo.execute({ ...testActor(), permissionCeiling: ['products:write'] }, a.id, command('ceiling', 0))).rejects.toMatchObject({ status: 403 });
    expect((await repo.get(testActor(), a.id)).revision).toBe(0);
  });
  it('commits the exact amount and receipt once, replays identical input, rejects request reuse and stale revisions', async () => {
    const a = await repo.create(testActor(), { name: 'One', seed: 'empty' });
    const first = await repo.execute(testActor(), a.id, command('one', 0, 125));
    expect(first.workspace.state.money.cents).toBe(125); expect(first.receipt.revision).toBe(1);
    const replay = await repo.execute(testActor(), a.id, command('one', 0, 125)); expect(replay.replayed).toBe(true);
    expect(replay.workspace.state.money.cents).toBe(125); expect(await repo.receipt(testActor(), a.id, 'one')).toEqual(first.receipt);
    await expect(repo.execute(testActor(), a.id, command('one', 0, 126))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(repo.execute(testActor(), a.id, command('two', 0))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('serializes two commands from the same revision so only one can change the balance', async () => {
    const a = await repo.create(testActor(), { name: 'One', seed: 'empty' });
    const results = await Promise.allSettled([repo.execute(testActor(), a.id, command('a', 0, 1)), repo.execute(testActor(), a.id, command('b', 0, 2))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect((await repo.get(testActor(), a.id)).revision).toBe(1); expect(requestReceiptCount(db)).toBe(2);
  });
  it('rolls back both state and receipt if the account loses authorization before commit', async () => {
    const contract = { ...testContract, applyMistCommand: (...args: Parameters<typeof testContract.applyMistCommand>) => {
      const result = testContract.applyMistCommand(...args); auth.users.get('owner')!.active = false; return result;
    } };
    const guarded = new MistRepository(db, contract, new MistPrivateFiles(root), auth.authorize);
    const a = await guarded.create(testActor(), { name: 'One', seed: 'empty' });
    await expect(guarded.execute(testActor(), a.id, command('revoked-during-transaction', 0, 100))).rejects.toMatchObject({ status: 401 });
    auth.users.get('owner')!.active = true;
    expect((await guarded.get(testActor(), a.id)).state.money.cents).toBe(0); expect(db.receipts.size).toBe(1);
  });
  it('rolls back amount/state when receipt persistence fails', async () => {
    const a = await repo.create(testActor(), { name: 'One', seed: 'empty' }); db.failReceipt = true;
    await expect(repo.execute(testActor(), a.id, command('fail', 0, 100))).rejects.toThrow('transaction failed');
    expect((await repo.get(testActor(), a.id)).state.money.cents).toBe(0); expect(db.receipts.size).toBe(1);
  });
  it('rejects unknown commands and forged file registration without writes', async () => {
    const a = await repo.create(testActor(), { name: 'One' });
    await expect(repo.execute(testActor(), a.id, { requestId: 'unknown', expectedRevision: 0, command: { type: 'anything', payload: {} } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(repo.execute(testActor(), a.id, { requestId: 'fake-file', expectedRevision: 0, command: { type: 'files.add', payload: { file: { name: 'not-uploaded.pdf' } } } })).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    expect((await repo.get(testActor(), a.id)).revision).toBe(0);
  });
  it('stores real bytes, replays uploads without duplicate files and cleans confirmed rollback blobs', async () => {
    const a = await repo.create(testActor(), { name: 'One' }); const bytes = Buffer.from('%PDF-real-payload');
    const result = await repo.upload(testActor(), a.id, { requestId: 'file', expectedRevision: 0 }, { bytes, name: '../spec.pdf', mimeType: 'application/pdf' });
    const file = result.workspace.state.files[0]; expect(file.name).toBe('spec.pdf'); expect((await repo.download(testActor(), a.id, file.id)).bytes).toEqual(bytes);
    expect((await repo.upload(testActor(), a.id, { requestId: 'file', expectedRevision: 0 }, { bytes, name: '../spec.pdf', mimeType: 'application/pdf' })).replayed).toBe(true);
    expect(await readdir(path.join(root, a.id))).toHaveLength(1);
    await expect(repo.upload(testActor(), a.id, { requestId: 'file', expectedRevision: 0 }, { bytes: Buffer.from('different'), name: 'spec.pdf', mimeType: 'application/pdf' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    db.failReceipt = true;
    await expect(repo.upload(testActor(), a.id, { requestId: 'broken', expectedRevision: 1 }, { bytes, name: 'second.pdf', mimeType: 'application/pdf' })).rejects.toThrow();
    expect(await readdir(path.join(root, a.id))).toHaveLength(1);
  });
  it('accepts actual attachments above the old 20MiB limit up to the new 50MiB contract', async () => {
    expect(MIST_FILE_MAX_BYTES).toBe(50 * 1024 * 1024);
    const files = new MistPrivateFiles(root), workspaceId = randomUUID();
    const bytes = Buffer.alloc(21 * 1024 * 1024, 9);
    const file = await files.write(workspaceId, { bytes, name: 'large.dat', mimeType: 'application/octet-stream' }, new Date().toISOString());
    expect(file.size).toBe(bytes.length); expect((await files.read(workspaceId, file)).equals(bytes)).toBe(true);
  });
  it('blocks oversized bytes, traversal storage keys and symlink escape', async () => {
    const files = new MistPrivateFiles(root), id = randomUUID();
    await expect(files.write('../escape', { bytes: Buffer.from('x'), name: 'x', mimeType: 'text/plain' }, new Date().toISOString())).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' });
    await expect(files.write(id, { bytes: Buffer.alloc(50 * 1024 * 1024 + 1), name: 'x', mimeType: 'text/plain' }, new Date().toISOString())).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(files.read(id, { id: randomUUID(), name: 'x', size: 1, mimeType: 'text/plain', createdAt: '', storageKey: '../x' })).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' });
    const outside = path.join(root, 'outside'); await mkdir(outside); await symlink(outside, path.join(root, id));
    await expect(files.write(id, { bytes: Buffer.from('x'), name: 'x', mimeType: 'text/plain' }, '')).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' });
  });
});
