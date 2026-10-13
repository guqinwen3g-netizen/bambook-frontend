import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, requireHttpSuccess, type BusinessFixtureActor,
  type BusinessFixtureActorName, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture;
const base = '/api/v1/development', root = `${base}/fabric-search`, enc = encodeURIComponent;
type Task = { id: string; requesterId: string; assigneeId: string; status: string; revision: number;
  requestText: string; feedbackNote: string | null; completionNote: string | null;
  flowHistory: Array<{ action: string; actorId: string }>; results: unknown[] };
function task(response: Awaited<ReturnType<GlobalBusinessHttpFixture['request']>>, label: string): Task {
  const value = requireHttpSuccess(response, label).data;
  if (!value || typeof value.id !== 'string' || !Number.isInteger(value.revision)
    || typeof value.status !== 'string' || !Array.isArray(value.flowHistory) || !Array.isArray(value.results)) {
    throw new Error(`${label}: native task DTO is incomplete.`);
  }
  return value;
}
async function limited(name: BusinessFixtureActorName, ceiling: string[]): Promise<BusinessFixtureActor> {
  const user = await loadUserWithRoles(prisma, f.actors[name].id);
  if (!user) throw new Error('Fixture account disappeared.');
  const actual = await buildLoadedAuthTokenPayload(prisma, user);
  expect(actual.permissions).toContain('products:write');
  return { ...f.actors[name], token: createAuthService().signToken({ ...actual, permissionCeiling: ceiling }) };
}
const createBody = (key: string) => ({ requestKey: `${f.prefix}-${key}`, name: '海军蓝面料寻样', initiator: 'internal',
  requestTeamId: f.teamIds.garment, assigneeId: f.actors.salesOwner.id, requestText: '400gsm羊毛斜纹；逐次反馈实际结果', targetDate: '2026-10-15' });
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: 'fabric-search-authority-native' });
}, 60000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

describe('Native fabric search signed ceiling and current authorization', () => {
  it('keeps a real requester/assignee return loop usable while every read and write rejects a narrower signed credential', async () => {
    const requesterRead = await limited('actualRequester', ['products:read']);
    const workerRead = await limited('salesOwner', ['products:read']);
    const workerWrite = await limited('salesOwner', ['products:write']);
    const body = createBody('return-loop');
    expect((await f.request(requesterRead, 'post', root, body)).status).toBe(403);
    let current = task(await f.request('actualRequester', 'post', root, body), 'create actual internal search');
    expect(current).toMatchObject({ requesterId: f.actors.actualRequester.id, assigneeId: f.actors.salesOwner.id, status: 'pending', revision: 0 });
    const id = current.id, url = `${root}/${enc(id)}`;
    expect(task(await f.request('actualRequester', 'post', root, body), 'recover original search create').id).toBe(id);
    expect(await prisma.fabricSearchTask.count({ where: { requesterId: f.actors.actualRequester.id, requestKey: body.requestKey } })).toBe(1);
    expect((await f.request('actualRequester', 'post', root, { ...body, requestText: '同键不同内容' })).status).toBe(409);
    for (const readUrl of [`${base}/personnel`, root, url]) expect((await f.request(workerWrite, 'get', readUrl)).status).toBe(403);
    expect((await f.request('salesOutsider', 'get', url)).status).toBe(404);
    requireHttpSuccess(await f.request(workerRead, 'get', root), 'read-only credential reads own list');
    expect((await f.request(workerRead, 'post', `${url}/actions/accept`, { expectedRevision: current.revision })).status).toBe(403);
    current = task(await f.request('salesOwner', 'post', `${url}/actions/accept`, { expectedRevision: current.revision }), 'actual assignee accepts');
    expect(current.status).toBe('in_progress');
    expect((await f.request(workerRead, 'patch', url, { expectedRevision: current.revision, name: '不得由只读凭据修改' })).status).toBe(403);
    current = task(await f.request('salesOwner', 'patch', url, { expectedRevision: current.revision, requestText: '根据实际找到的候选反馈，不造库存' }), 'actual assignee updates direction');
    expect((await f.request(workerRead, 'post', `${url}/actions/submit`, { expectedRevision: current.revision, noMatch: true, note: '暂未匹配' })).status).toBe(403);
    current = task(await f.request('salesOwner', 'post', `${url}/actions/submit`, { expectedRevision: current.revision, noMatch: true, note: '已查现有档案，暂无匹配' }), 'actual first feedback');
    expect(current.status).toBe('awaiting_confirmation');
    expect((await f.request(requesterRead, 'post', `${url}/actions/return`, { expectedRevision: current.revision, note: '补充300gsm方向' })).status).toBe(403);
    current = task(await f.request('actualRequester', 'post', `${url}/actions/return`, { expectedRevision: current.revision, requestText: '补充300gsm斜纹方向', note: '请按补充要求继续寻找' }), 'actual requester returns');
    expect(current).toMatchObject({ status: 'in_progress', requestText: '补充300gsm斜纹方向' });
    const transfer = { expectedRevision: current.revision, assigneeId: f.actors.manager.id, note: '明确转交给本面料组另一实际人员' };
    expect((await f.request(workerRead, 'post', `${url}/actions/transfer`, transfer)).status).toBe(403);
    current = task(await f.request('salesOwner', 'post', `${url}/actions/transfer`, transfer), 'actual worker transfers');
    expect(current).toMatchObject({ status: 'pending', assigneeId: f.actors.manager.id });
    current = task(await f.request('manager', 'post', `${url}/actions/accept`, { expectedRevision: current.revision }), 'new actual worker accepts');
    current = task(await f.request('manager', 'post', `${url}/actions/submit`, { expectedRevision: current.revision, noMatch: true, note: '补充方向仍无实际匹配，回报发起人' }), 'second actual feedback');
    expect((await f.request(requesterRead, 'post', `${url}/actions/confirm`, { expectedRevision: current.revision, note: '只读不可确认' })).status).toBe(403);
    current = task(await f.request('actualRequester', 'post', `${url}/actions/confirm`, { expectedRevision: current.revision, note: '确认实际寻样结果并结束本需求' }), 'actual requester confirms');
    expect(current).toMatchObject({ id, status: 'completed', completionNote: '确认实际寻样结果并结束本需求', results: [] });
    expect(current.flowHistory.map(row => [row.action, row.actorId])).toEqual([
      ['create', f.actors.actualRequester.id], ['accept', f.actors.salesOwner.id],
      ['submit', f.actors.salesOwner.id], ['return', f.actors.actualRequester.id], ['transfer', f.actors.salesOwner.id],
      ['accept', f.actors.manager.id], ['submit', f.actors.manager.id], ['confirm', f.actors.actualRequester.id],
    ]);
    expect(await prisma.auditLog.count({ where: { targetId: id, action: 'fabric-search.update' } })).toBe(1);
    expect((await f.request(requesterRead, 'post', `${url}/complete`, { expectedRevision: current.revision })).status).toBe(403);
    expect((await f.request('actualRequester', 'post', `${url}/complete`, { expectedRevision: current.revision })).status).toBe(409);
    const before = { row: await prisma.fabricSearchTask.findUniqueOrThrow({ where: { id } }),
      audit: await prisma.auditLog.count({ where: { targetId: id } }), notices: await prisma.notification.count() };
    expect(task(await f.request(requesterRead, 'get', url), 'read completed original history').id).toBe(id);
    requireHttpSuccess(await f.request('actualRequester', 'get', `${base}/personnel`), 'read actual personnel');
    expect({ row: await prisma.fabricSearchTask.findUniqueOrThrow({ where: { id } }),
      audit: await prisma.auditLog.count({ where: { targetId: id } }), notices: await prisma.notification.count() }).toEqual(before);

    const caseInput = { code: `${f.prefix}-limited-case`, name: '真实账号建案双门', type: 'fabric', ownerId: f.actors.salesOwner.id,
      initiator: 'internal', departmentId: (await prisma.userAccount.findUniqueOrThrow({ where: { id: f.actors.salesOwner.id } })).primaryDeptId };
    expect((await f.request(workerRead, 'post', base, caseInput)).status).toBe(403);
    const created = requireHttpSuccess(await f.request('salesOwner', 'post', base, caseInput), 'real case create passes exact actor', 201).case;
    expect((await f.request(workerRead, 'put', `${base}/${enc(created.id)}`, { notes: '只改备注也不可越权' })).status).toBe(403);
    requireHttpSuccess(await f.request('salesOwner', 'put', `${base}/${enc(created.id)}`, { notes: '实际账号正常编辑' }), 'real case update passes exact actor');
  }, 180000);

  it('denies original-key replay and reads after actual grants or account are withdrawn even when the old token ceiling is wildcard', async () => {
    const wildcard = await limited('actualRequester', ['*']), body = createBody(`withdrawal-${randomUUID().slice(0, 8)}`);
    const current = task(await f.request(wildcard, 'post', root, body), 'create search before actual withdrawal');
    const grants = await prisma.userRole.findMany({ where: { userId: wildcard.id } });
    const before = { row: await prisma.fabricSearchTask.findUniqueOrThrow({ where: { id: current.id } }),
      audits: await prisma.auditLog.count({ where: { targetId: current.id } }) };
    try {
      await prisma.userRole.deleteMany({ where: { userId: wildcard.id } });
      expect((await f.request(wildcard, 'get', root)).status).toBe(403);
      expect((await f.request(wildcard, 'get', `${root}/${enc(current.id)}`)).status).toBe(403);
      expect((await f.request(wildcard, 'get', `${base}/personnel`)).status).toBe(403);
      expect((await f.request(wildcard, 'post', root, body)).status).toBe(403);
    } finally { await prisma.userRole.createMany({ data: grants, skipDuplicates: true }); }
    try {
      await prisma.userAccount.update({ where: { id: wildcard.id }, data: { status: 'suspended' } });
      expect((await f.request(wildcard, 'get', root)).status).toBe(401);
      expect((await f.request(wildcard, 'post', root, body)).status).toBe(401);
    } finally { await prisma.userAccount.update({ where: { id: wildcard.id }, data: { status: 'active' } }); }
    expect({ row: await prisma.fabricSearchTask.findUniqueOrThrow({ where: { id: current.id } }),
      audits: await prisma.auditLog.count({ where: { targetId: current.id } }) }).toEqual(before);
    expect(task(await f.request(wildcard, 'post', root, body), 'recover same original key after legitimate restoration').id).toBe(current.id);
  }, 90000);
});
