/** Private PostgreSQL + actual signed read API only. Campaigns/leads below are
 * explicitly synthetic INITIAL observations, including Converted input rows.
 * They are not evidence of native lead conversion, attribution, payment receipt
 * or a complete marketing business cycle. No real company data or external action.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createMarketingV2Router } from '../src/marketing/marketingRouteV2';

const prefix = 'acceptance-marketing-roi-' + randomUUID();
let prisma: PrismaClient | undefined, token: string, sequence = 0;
const actorId = prefix + '-reader';
const db = (): PrismaClient => { if (!prisma) throw Error('Private marketing ROI PG identity not verified'); return prisma; };
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Independent acceptance sandbox required');
  const url = new URL(DATABASE_URL); expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe('/' + name); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres')); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: actorId, displayName: 'Synthetic marketing ROI reader', status: 'active' } });
  const roleId = prefix + '-role';
  await db().role.create({ data: { id: roleId, name: 'Synthetic exact marketing read', isSystem: false } });
  await db().userRole.create({ data: { id: prefix + '-assignment', userId: actorId, roleId } });
  const permission = await db().permission.upsert({ where: { scope: 'marketing:read' }, update: {}, create: { id: prefix + '-permission', scope: 'marketing:read' } });
  await db().rolePermission.create({ data: { id: prefix + '-grant', roleId, permissionId: permission.id } });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(actorId); expect(current).not.toBeNull();
  token = createAuthService().signToken({ userId: actorId, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    permissions: current!.scopes, departmentIds: current!.departmentIds, authorizationLoaded: true, permissionCeiling: ['marketing:read'] });
});
afterAll(async () => { await prisma?.$disconnect(); });
function app() {
  const result = express(); result.use(express.json());
  result.use(createAccountStatusGuard(db())); result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v2/marketing', createMarketingV2Router({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  return result;
}
const lead = (status: string, actualValue: string | null, deleted = false) => ({ status, actualValue, deleted });
const cases = [
  { id: 'MROI01', name: 'Converted null with known cost stays unknown', leads: [lead('Converted', null)], cost: '100', total: null, roi: null, converted: 1, live: 1 },
  { id: 'MROI02', name: 'mixed known and unknown Converted rows cannot make a certain sum', leads: [lead('Converted', '150'), lead('Converted', null)], cost: '100', total: null, roi: null, converted: 2, live: 2 },
  { id: 'MROI03', name: 'explicit Converted zero remains a real zero and negative ROI', leads: [lead('Converted', '0')], cost: '100', total: 0, roi: -1, converted: 1, live: 1 },
  { id: 'MROI04', name: 'empty lead collection remains a zero sum', leads: [], cost: '100', total: 0, roi: -1, converted: 0, live: 0 },
  { id: 'MROI05', name: 'non-Converted unknown and known revenue are excluded', leads: [lead('New', null), lead('Qualified', '999'), lead('Converted', '150')], cost: '100', total: 150, roi: 0.5, converted: 1, live: 3 },
  { id: 'MROI06', name: 'actual Decimal values retain the known revenue formula', leads: [lead('Converted', '100.25'), lead('Converted', '49.75')], cost: '100', total: 150, roi: 0.5, converted: 2, live: 2 },
  { id: 'MROI07', name: 'explicit zero cost preserves unknown ROI and known income', leads: [lead('Converted', '150')], cost: '0', total: 150, roi: null, converted: 1, live: 1 },
  { id: 'MROI08', name: 'nullable cost preserves unknown ROI and known income', leads: [lead('Converted', '150')], cost: null, total: 150, roi: null, converted: 1, live: 1 },
  { id: 'MROI09', name: 'soft-deleted unknown lead cannot invalidate the live revenue sum', leads: [lead('Converted', null, true), lead('Converted', '150')], cost: '100', total: 150, roi: 0.5, converted: 1, live: 1 },
];
describe('Marketing ROI nullable revenue actual private PG/read API', () => {
  it.each(cases)('$id $name', async scenario => {
    const id = prefix + '-' + (++sequence), now = BigInt(Date.now());
    await db().marketingCampaign.create({ data: { id, name: id, ownerId: actorId, actualCost: scenario.cost, createdAt: now, updatedAt: now } });
    for (let index = 0; index < scenario.leads.length; index++) {
      const row = scenario.leads[index];
      await db().marketingLead.create({ data: { id: id + '-lead-' + index, campaignId: id, status: row.status, actualValue: row.actualValue,
        estimatedValue: null, deletedAt: row.deleted ? now : null, createdAt: now, updatedAt: now } });
    }
    const before = await db().marketingLead.findMany({ where: { campaignId: id }, orderBy: { id: 'asc' } });
    const response = await request(app()).get(`/api/v2/marketing/campaigns/${id}/roi`).set('Authorization', 'Bearer ' + token);
    expect(response.status, json(response.body)).toBe(200); expect(response.body.ok).toBe(true);
    expect(response.body.totalActualValue).toBe(scenario.total); expect(response.body.roi).toBe(scenario.roi);
    expect(response.body.totalLeads).toBe(scenario.live); expect(response.body.convertedCount).toBe(scenario.converted);
    expect(response.body.conversionRate).toBe(scenario.live ? scenario.converted / scenario.live : 0);
    const list = await request(app()).get('/api/v2/marketing/campaigns').query({ search: id }).set('Authorization', 'Bearer ' + token);
    expect(list.status, json(list.body)).toBe(200); expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].leads).toHaveLength(scenario.live);
    // The actual list DTO consumed by the card retains null (and explicit zero).
    const expectedLive = scenario.leads.filter(row => !row.deleted).map(row => ({ status: row.status, actualValue: row.actualValue === null ? null : Number(row.actualValue) }));
    expect(list.body.items[0].leads.map((row: any) => ({ status: row.status, actualValue: row.actualValue })))
      .toEqual(expect.arrayContaining(expectedLive));
    expect(await db().marketingLead.findMany({ where: { campaignId: id }, orderBy: { id: 'asc' } })).toEqual(before);
  });
});
