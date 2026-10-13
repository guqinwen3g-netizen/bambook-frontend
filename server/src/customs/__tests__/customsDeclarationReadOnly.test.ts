import { describe, expect, it } from 'vitest';
import { createCustomsRouter } from '../customsRoute';
import { createCustomsV2Router } from '../customsRouteV2';
import { EXTERNAL_DECLARATION_REQUIRED } from '../externalDeclarationContract';
import { storage } from './ciCentralHttpStorage';

type Method = 'post' | 'put' | 'delete';

function findRoute(router: any, method: Method, routePath: string) {
  const layer = router.stack.find((candidate: any) => candidate.route?.path === routePath && candidate.route?.methods?.[method]);
  if (!layer) throw new Error(`Missing route: ${method} ${routePath}`);
  return layer;
}

async function invokeFinalHandler(layer: any) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const req: any = { params: { id: 'CD-OLD' }, body: { type: 'Export', toStatus: 'Released' }, query: {}, headers: {} };
  await layer.route.stack.at(-1).handle(req, res, () => {});
  return res;
}

describe('customs declarations are external-filing history only', () => {
  const blockedRoutes: Array<{ method: Method; path: string }> = [
    { method: 'post', path: '/declarations' },
    { method: 'put', path: '/declarations/:id' },
    { method: 'delete', path: '/declarations/:id' },
    { method: 'post', path: '/declarations/:id/transition' },
  ];

  it.each(['v1', 'v2'] as const)('%s retains protected legacy endpoints but refuses all local declaration mutations', async (version) => {
    const prisma = storage().db as any;
    const router = version === 'v1'
      ? createCustomsRouter({ prisma, requireAuth: false, apiKeys: new Set() })
      : createCustomsV2Router({ prisma, requireAuth: false, apiKeys: new Set() });

    for (const route of blockedRoutes) {
      const layer = findRoute(router, route.method, route.path);
      expect(layer.route.stack.length).toBeGreaterThan(1); // JWT + customs scope remain in front of the terminal guard.
      const response = await invokeFinalHandler(layer);
      expect(response.statusCode).toBe(410);
      expect(response.body).toEqual(EXTERNAL_DECLARATION_REQUIRED);
    }
  });

  it('keeps declaration history query routes available', () => {
    const v1 = createCustomsRouter({ prisma: storage().db as any, requireAuth: false, apiKeys: new Set() });
    const v2 = createCustomsV2Router({ prisma: storage().db as any, requireAuth: false, apiKeys: new Set() });
    expect(findRoute(v1, 'post', '/declarations')).toBeTruthy();
    expect(v1.stack.some((layer: any) => layer.route?.path === '/declarations' && layer.route?.methods?.get)).toBe(true);
    expect(v2.stack.some((layer: any) => layer.route?.path === '/declarations' && layer.route?.methods?.get)).toBe(true);
  });
});
