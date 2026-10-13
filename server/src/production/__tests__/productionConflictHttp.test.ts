/** Real HTTP guards around retired whole-order writers. Storage/auth loaders
 * are substituted; exact current PostgreSQL roles are covered by acceptance. */
import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
import { createAuthService } from '../../auth/service';

const seams = vi.hoisted(() => ({ advance: vi.fn(), user: vi.fn(), actor: vi.fn(), visible: vi.fn() }));
vi.mock('../stageService', async original => ({ ...(await original<any>()), advanceStage: seams.advance }));
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: seams.user, buildLoadedAuthTokenPayload: seams.actor }));
vi.mock('../../auth/orderVisibility', async original => ({ ...(await original<any>()), resolveVisibleOrderIds: seams.visible }));
import { createProductionRouter } from '../route';
import { createProductionV2Router } from '../routeV2';

const actor = { userId: 'current-business-owner', roles: [], permissions: ['production:write'], authorizationLoaded: true };
beforeEach(() => {
  vi.clearAllMocks(); seams.user.mockResolvedValue({ id: actor.userId, status: 'active', deletedAt: null });
  seams.actor.mockImplementation(async () => ({ ...actor })); seams.visible.mockResolvedValue(['owned-order']);
});

function fixture(factory: typeof createProductionRouter, ceiling = ['production:write']) {
  const changed = vi.fn(), write = vi.fn(() => { throw new Error('retired writer touched storage'); });
  const prisma: any = { $transaction: write, $executeRaw: write, productionStage: { update: write, upsert: write } };
  const app = express(); app.use(express.json());
  app.use('/production', factory({ prisma, requireAuth: true, apiKeys: new Set(), onDataChange: changed }));
  const token = createAuthService().signToken({ ...actor, permissionCeiling: ceiling });
  const post = (path: string) => request(app).post(`/production/${path}`).set('Authorization', `Bearer ${token}`).send({});
  return { post, write, changed, prisma };
}

it.each([['v1', createProductionRouter], ['v2', createProductionV2Router]] as const)(
  '%s retires an owned whole-order writer before stages, QC or notifications can change', async (_version, factory) => {
    const f = fixture(factory);
    for (const command of ['advance/manufacturing', 'block/manufacturing', 'sign/qc', 'checklist', 'inspection']) {
      const response = await f.post(`owned-order/${command}`);
      expect(response.status).toBe(409); expect(response.body.error.code).toBe('EXACT_PRODUCTION_COMMAND_REQUIRED');
    }
    expect(seams.visible).toHaveBeenCalledWith(f.prisma, expect.objectContaining({ userId: actor.userId }), { fresh: true, strict: true });
    expect(seams.advance).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled();
  },
);

it.each([['v1', createProductionRouter], ['v2', createProductionV2Router]] as const)(
  '%s conceals another order and rechecks revoked grants and credential ceilings', async (_version, factory) => {
    const f = fixture(factory);
    expect((await f.post('foreign-order/advance/manufacturing')).status).toBe(404);
    seams.actor.mockResolvedValue({ ...actor, permissions: [] });
    expect((await f.post('owned-order/advance/manufacturing')).status).toBe(403);
    seams.actor.mockImplementation(async () => ({ ...actor }));
    const capped = fixture(factory, []);
    expect((await capped.post('owned-order/advance/manufacturing')).status).toBe(403);
    expect(seams.advance).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); expect(capped.write).not.toHaveBeenCalled();
  },
);

it.each([['v1', createProductionRouter], ['v2', createProductionV2Router]] as const)(
  '%s rejects a previously valid session after account disablement', async (_version, factory) => {
    const f = fixture(factory); seams.user.mockResolvedValue({ id: actor.userId, status: 'disabled', deletedAt: null });
    const response = await f.post('owned-order/advance/manufacturing');
    expect(response.status).toBe(401); expect(response.body.error).toBe('ACCOUNT_DISABLED');
    expect(seams.visible).not.toHaveBeenCalled(); expect(seams.advance).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled();
  },
);
