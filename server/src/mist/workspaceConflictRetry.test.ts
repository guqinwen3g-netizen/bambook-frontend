import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as contract from '../shared/mistWorkspace';
import { MIST_READ_SECTIONS } from './access';
import { MistPrivateFiles } from './files';
import { MistLocalDatabase } from './local';
import { MIST_MAX_REBASE_GAP, MIST_MAX_SAVE_ATTEMPTS, MistRepository, mistChangeKeys, type MistContract } from './repository';
import { MemoryMistDatabase, requestReceiptCount, testActor, testAuthority, testContract } from './__tests__/support';

/** 业务门禁与需重新确认的命令：只用于本回归，验证自动合并在最新状态上重新执行规则。 */
const gatedContract: MistContract = {
  ...testContract,
  applyMistCommand: (state: any, command: any, context: any) => {
    if (command.type === 'settings.lock') { state.settings.locked = true; return { state, result: {} }; }
    if (command.type === 'notes.confirm') { Object.assign(state.notes.find((note: any) => note.id === command.payload.id), { confirmed: true, confirmedBy: context.actorId }); return { state, result: {} }; }
    if (command.type === 'notes.add' && state.settings.locked) throw Object.assign(new Error('空间已锁定，不能新增'), { code: 'LOCKED', status: 409 });
    return testContract.applyMistCommand(state, command, context);
  },
};
/** 让前若干次事务在提交前失败（模拟 PostgreSQL 可串行化冲突 P2034）；可选在失败前让他人先提交。 */
class FlakyDatabase extends MemoryMistDatabase {
  failures = 0; attempts = 0; beforeFailure?: () => Promise<void>;
  /** 默认 P2034；行锁原生查询（FOR UPDATE）遇到可串行化失败时 Prisma 报 P2010 + SQLSTATE 40001。 */
  failure: () => Error = () => Object.assign(new Error('could not serialize access due to concurrent update'), { code: 'P2034' });
  async $transaction<T>(run: (tx: any) => Promise<T>) {
    let wrote = false;
    try {
      return await super.$transaction(async tx => {
        this.attempts++;
        const update = tx.mistWorkspace.update; tx.mistWorkspace.update = (args: any) => { wrote = true; return update(args); };
        const result = await run(tx);
        if (wrote && this.failures > 0) { this.failures--; throw this.failure(); }
        return result;
      });
    } catch (error) { const competitor = this.beforeFailure; this.beforeFailure = undefined; if (competitor) await competitor(); throw error; }
  }
}
let root: string, db: MemoryMistDatabase, auth: ReturnType<typeof testAuthority>, files: MistPrivateFiles;
const owner = testActor('owner'), other = testActor('other');
const repoFor = (database: any, rules: MistContract = gatedContract) => new MistRepository(database, rules, files, auth.authorize);
const note = (requestId: string, expectedRevision: number, text = requestId) => ({ requestId, expectedRevision, command: { type: 'notes.add', payload: { text } } });
const money = (requestId: string, expectedRevision: number, cents: number) => ({ requestId, expectedRevision, command: { type: 'money.add', payload: { cents } } });
async function sharedWorkspace(repo: MistRepository, database: MemoryMistDatabase = db) {
  const workspace = await repo.create(owner, { name: '并发保存', seed: 'empty' });
  database.workspaces.get(workspace.id).state.memberIds = ['other'];
  return workspace.id;
}
const stored = async (id: string) => readdir(path.join(root, id)).catch(() => [] as string[]);
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'mist-conflict-retry-')); db = new MemoryMistDatabase(); auth = testAuthority(); files = new MistPrivateFiles(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('多人保存冲突自动重试：只在最新状态上重新执行可证明互不覆盖的命令', () => {
  it('两人基于同一版本各自新增记录，两条都保留，回执保持各自原始请求', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    const first = await repo.execute(owner, id, note('owner-note', 0, '甲'));
    const second = await repo.execute(other, id, note('other-note', 0, '乙'));
    expect(first.receipt.revision).toBe(1); expect(second.receipt.revision).toBe(2); expect(second.replayed).toBe(false);
    expect(db.workspaces.get(id).state.notes.map((item: any) => item.text)).toEqual(['甲', '乙']);
    expect(db.receipts.get(`${id}:other-note`)).toMatchObject({ actorId: 'other', expectedRevision: 0, result: { revision: 2 } });
    expect(requestReceiptCount(db)).toBe(3); // 含创建空间回执
  });

  it('真实业务规则：两人同时给不同客户保存联系人，两条联系人和两条动态都保留', async () => {
    const all = [...new Set(MIST_READ_SECTIONS.flatMap(section => section.permissions)), 'relations:write'];
    auth.users.get('owner')!.permissions = all; auth.users.get('other')!.permissions = all;
    const repo = repoFor(db, contract), workspace = await repo.create(owner, { name: '真实规则', seed: 'demo' });
    db.workspaces.get(workspace.id).state.memberIds = ['other'];
    const customers = db.workspaces.get(workspace.id).state.customers.map((item: any) => item.id), base = workspace.revision, events = db.workspaces.get(workspace.id).state.events.length;
    const save = (requestId: string, customerId: string, name: string, payloadId?: string) => ({ requestId, expectedRevision: base, command: { type: 'contact.save', payload: { ...(payloadId ? { id: payloadId } : {}), customerId, name, role: '', email: '', phone: '' } } as any });
    const first = await repo.execute(owner, workspace.id, save('a', customers[0], '甲方联系人'));
    await repo.execute(other, workspace.id, save('b', customers[1], '乙方联系人'));
    const state = db.workspaces.get(workspace.id).state;
    expect(state.contacts.map((item: any) => item.name)).toEqual(expect.arrayContaining(['甲方联系人', '乙方联系人']));
    expect(state.events).toHaveLength(events + 2);
    // 同一联系人被两人基于旧版本改写：后到者被拒，不吞掉先到者的修改。
    const contactId = first.receipt.result.id, now = db.workspaces.get(workspace.id).revision;
    await repo.execute(owner, workspace.id, { ...save('c', customers[0], '甲改名', contactId), expectedRevision: now });
    await expect(repo.execute(other, workspace.id, { ...save('d', customers[0], '乙改名', contactId), expectedRevision: now })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
    expect(db.workspaces.get(workspace.id).state.contacts.find((item: any) => item.id === contactId).name).toBe('甲改名');
  });

  it('同一请求重放只执行一次并返回原回执；同编号不同内容、伪造版本标记编号均被拒绝', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    await repo.execute(owner, id, note('owner-note', 0));
    const original = await repo.execute(other, id, note('retry-me', 0, '乙'));
    await repo.execute(owner, id, note('owner-later', 2));
    const replay = await repo.execute(other, id, note('retry-me', 0, '乙'));
    expect(replay).toMatchObject({ replayed: true, receipt: original.receipt });
    expect(db.workspaces.get(id).state.notes.filter((item: any) => item.text === '乙')).toHaveLength(1);
    await expect(repo.execute(other, id, note('retry-me', 0, '丙'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
    await expect(repo.execute(other, id, note('retry-me', 1, '乙'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
    await expect(repo.execute(other, id, note('mist-revision:9', 3))).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    await expect(repo.receipt(owner, id, 'mist-revision:1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requestReceiptCount(db)).toBe(4); expect(db.workspaces.get(id).revision).toBe(3);
  });

  it('同一字段的覆盖式修改不自动合并，明确冲突且保留对方的更新', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    await repo.execute(owner, id, money('first', 0, 5));
    await expect(repo.execute(owner, id, money('second', 0, 7))).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409, message: expect.stringContaining('同一记录') });
    expect(db.workspaces.get(id)).toMatchObject({ revision: 1, state: { money: { cents: 5 } } });
    expect(db.receipts.has(`${id}:second`)).toBe(false);
  });

  it('重试时重新核验账号、成员与权限：被撤销后不再写入', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    await repo.execute(owner, id, note('owner-note', 0));
    auth.users.get('other')!.permissions = [];
    await expect(repo.execute(other, id, note('denied', 0))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    auth.users.get('other')!.permissions = ['products:write']; db.workspaces.get(id).state.memberIds = [];
    await expect(repo.execute(other, id, note('removed', 0))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    db.workspaces.get(id).state.memberIds = ['other']; auth.users.get('other')!.active = false;
    await expect(repo.execute(other, id, note('disabled', 0))).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED', status: 401 });
    expect(db.workspaces.get(id).revision).toBe(1); expect(requestReceiptCount(db)).toBe(2);
  });

  it('业务条件被他人改变时按最新状态重新判断并拒绝；确认类命令只在所办理记录未被改动时合并；正式单据不自动合并', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    const added = await repo.execute(owner, id, note('seed', 0));
    await repo.execute(owner, id, { requestId: 'lock', expectedRevision: 1, command: { type: 'settings.lock', payload: {} } });
    await expect(repo.execute(other, id, note('late', 1))).rejects.toMatchObject({ code: 'LOCKED' });
    // 期间他人只改了别的位置（空间设置）：确认这条记录在最新状态上执行。
    await expect(repo.execute(owner, id, { requestId: 'confirm', expectedRevision: 1, command: { type: 'notes.confirm', payload: { id: added.receipt.result.id } } })).resolves.toMatchObject({ replayed: false, receipt: { revision: 3 } });
    expect(db.workspaces.get(id).state.notes[0].confirmed).toBe(true);
    // 同一记录已被他人改过：基于旧版本的确认被拒，要求刷新核对。
    await expect(repo.execute(other, id, { requestId: 'confirm-again', expectedRevision: 2, command: { type: 'notes.confirm', payload: { id: added.receipt.result.id } } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining('同一记录') });
    await expect(repo.execute(owner, id, { requestId: 'notice', expectedRevision: 1, command: { type: 'development.notice.generate', payload: {} } } as any)).rejects.toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining('重新确认') });
    await expect(repo.execute(owner, id, { requestId: 'doc', expectedRevision: 1, command: { type: 'market.quotation.document', payload: {} } } as any)).rejects.toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining('重新确认') });
    expect(db.workspaces.get(id).revision).toBe(3);
  });

  it('无法证明安全的落后版本照旧拒绝：缺少写入记录（成员变更）或落后过多', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    db.workspaces.get(id).revision = 1; // 模拟一个未记录写入位置的旧版本（例如成员授权、审批决定）
    await expect(repo.execute(owner, id, note('unknown', 0))).rejects.toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining('无法确认') });
    for (let value = 1; value <= MIST_MAX_REBASE_GAP + 1; value++) await repo.execute(owner, id, note('n' + value, value));
    await expect(repo.execute(other, id, note('too-far', 1))).rejects.toMatchObject({ code: 'REVISION_CONFLICT', message: expect.stringContaining('较多更新') });
    await expect(repo.execute(other, id, note('near', 2))).resolves.toMatchObject({ replayed: false });
  });

  it('可串行化冲突时用新事务重试：对方先提交的安全修改与本次修改都保留', async () => {
    const flaky = new FlakyDatabase(), repo = repoFor(flaky), id = await sharedWorkspace(repo, flaky);
    flaky.failures = 1; flaky.attempts = 0;
    // 竞争者是另一个服务进程（另一个连接池）：不走本进程的写入队列，直接在库里抢先提交。
    const competitor = repoFor(new Proxy(flaky, {}));
    flaky.beforeFailure = async () => { await competitor.execute(other, id, note('competitor', 0, '乙')); };
    const result = await repo.execute(owner, id, note('mine', 0, '甲'));
    expect(result).toMatchObject({ replayed: false, receipt: { revision: 2 } });
    expect(flaky.workspaces.get(id).state.notes.map((item: any) => item.text)).toEqual(['乙', '甲']);
    expect(requestReceiptCount(flaky)).toBe(3);
    flaky.failures = 1; flaky.failure = () => Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '40001' } });
    await expect(repo.execute(owner, id, note('raw-lock', 2))).resolves.toMatchObject({ replayed: false, receipt: { revision: 3 } });
    flaky.failures = 1; flaky.failure = () => Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '23505' } });
    await expect(repo.execute(owner, id, note('not-retried', 3))).rejects.toMatchObject({ code: 'P2010' });
    expect(flaky.workspaces.get(id).revision).toBe(3);
  });

  it('重试有上限：持续冲突时给出明确错误，不留下回执或文件', async () => {
    const flaky = new FlakyDatabase(), repo = repoFor(flaky), id = await sharedWorkspace(repo, flaky);
    flaky.failures = 100; flaky.attempts = 0;
    await expect(repo.execute(owner, id, note('busy', 0))).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409, message: expect.stringContaining(`重试${MIST_MAX_SAVE_ATTEMPTS}次`) });
    const executeAttempts = flaky.attempts;
    flaky.attempts = 0;
    await expect(repo.upload(owner, id, { requestId: 'busy-file', expectedRevision: 0 }, { name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a') })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    // 每次尝试 = 1 笔写事务 + 1 笔回执核对事务。
    expect(executeAttempts).toBe(MIST_MAX_SAVE_ATTEMPTS * 2); expect(flaky.attempts).toBe(MIST_MAX_SAVE_ATTEMPTS * 2);
    expect(flaky.workspaces.get(id).revision).toBe(0); expect(requestReceiptCount(flaky)).toBe(1); expect(flaky.receipts.size).toBe(1); expect(await stored(id)).toEqual([]);
  });

  it('附件上传落后版本时合并一次，失败或重放不重复生成文件', async () => {
    const repo = repoFor(db), id = await sharedWorkspace(repo);
    await repo.execute(other, id, note('other-note', 0));
    const file = { name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('hello') };
    const uploaded = await repo.upload(owner, id, { requestId: 'file', expectedRevision: 0 }, file);
    const replay = await repo.upload(owner, id, { requestId: 'file', expectedRevision: 0 }, file);
    expect(replay).toMatchObject({ replayed: true, receipt: uploaded.receipt });
    expect(db.workspaces.get(id).state.files).toHaveLength(1); expect(await stored(id)).toHaveLength(1);
    db.workspaces.get(id).revision = 9; // 无写入记录的版本：拒绝且删除本次已写入的文件
    await expect(repo.upload(owner, id, { requestId: 'file-2', expectedRevision: 2 }, file)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await stored(id)).toHaveLength(1); expect(requestReceiptCount(db)).toBe(3);
  });

  it('相同上传请求竞争时清理回滚尝试的文件，只保留成功回执引用的一个文件', async () => {
    const flaky = new FlakyDatabase(), repo = repoFor(flaky), id = await sharedWorkspace(repo, flaky);
    const input = { requestId: 'same-upload', expectedRevision: 0 };
    const file = { name: 'same.txt', mimeType: 'text/plain', bytes: Buffer.from('same content') };
    let winner: Awaited<ReturnType<MistRepository['upload']>> | undefined;
    flaky.failures = 1;
    // 同一个请求属于同一个身份；竞争者使用同一账号模拟另一个连接。
    const competitor = repoFor(new Proxy(flaky, {}));
    flaky.beforeFailure = async () => { winner = await competitor.upload(owner, id, input, file); };
    const replay = await repo.upload(owner, id, input, file);
    expect(replay).toMatchObject({ replayed: true, receipt: winner!.receipt });
    expect(flaky.workspaces.get(id).state.files).toHaveLength(1);
    expect(await stored(id)).toEqual([winner!.receipt.result.id]);
    expect(requestReceiptCount(flaky)).toBe(2);
  });

  it('本地运行时使用同一套合并与重放规则，并在重启后保留', async () => {
    const local = new MistLocalDatabase(path.join(root, 'local-store')); await local.ready;
    const repo = repoFor(local), workspace = await repo.create(owner, { name: '本地并发', seed: 'empty' });
    await repo.execute(owner, workspace.id, note('a', 0, '甲'));
    const merged = await repo.execute(owner, workspace.id, note('b', 0, '乙'));
    await expect(repo.execute(owner, workspace.id, money('m1', 2, 1)).then(() => repo.execute(owner, workspace.id, money('m2', 2, 1)))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const restarted = repoFor(new MistLocalDatabase(path.join(root, 'local-store')));
    expect((await restarted.get(owner, workspace.id)).state.notes.map((item: any) => item.text)).toEqual(['甲', '乙']);
    expect(await restarted.execute(owner, workspace.id, note('b', 0, '乙'))).toMatchObject({ replayed: true, receipt: merged.receipt });
  });

  it('写入位置按记录比较：同一数组里不同记录互不冲突，同一记录或无编号数组整体冲突', () => {
    expect(mistChangeKeys({ list: [{ id: 'a', v: 1 }] }, { list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] })).toEqual([['k:list', 'i:b']]);
    expect(mistChangeKeys({ list: [{ id: 'a', v: 1 }] }, { list: [{ id: 'a', v: 2 }] })).toEqual([['k:list', 'i:a']]);
    expect(mistChangeKeys({ tags: ['x'] }, { tags: ['x', 'y'] })).toEqual([['k:tags']]);
    expect(mistChangeKeys({ reviewerIds: ['a'], s: { n: 1 } }, { reviewerIds: ['b'], s: { n: 2 } })).toEqual([['k:s', 'k:n']]);
    expect(mistChangeKeys({}, { list: Array.from({ length: 2001 }, (_, i) => ({ id: String(i) })) })).toEqual([['k:list']]);
    expect(mistChangeKeys({ list: [] }, { list: Array.from({ length: 2001 }, (_, i) => ({ id: String(i) })) })).toBeNull();
  });
});
