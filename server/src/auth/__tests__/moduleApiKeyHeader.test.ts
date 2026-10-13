/**
 * 认证头一致性回归测试
 *
 * 背景：前端 apiService 统一发送 X-Bambook-API-Key 头，但 6 个历史模块路由
 * （procurement/crm/quotations/bom/mes/inventory）的手写 authenticate 只认
 * x-api-key 头，导致带正确 API key 的客户端收到 401 'authentication required'。
 *
 * 本测试锁定契约：这 6 个路由必须接受标准 X-Bambook-API-Key 头（兼容旧 x-api-key）。
 * 认证在 prisma 之前执行，因此带 key 的请求绝不应返回 401（后续业务错误允许）。
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createProcurementRouter } from '../../procurement/procurementRoute';
import { createCrmRouter } from '../../crm/crmRoute';
import { createQuotationRouter } from '../../quotations/quotationRoute';
import { createBOMRouter } from '../../bom/bomRoute';
import { createMesRouter } from '../../mes/mesRoute';
import { createInventoryRouter } from '../../inventory/inventoryRoute';
import { setDefaultAgentApiKeyActors } from '../agentPrincipal';

const TEST_KEY = 'test-api-key-0123456789abcdef';
/** 绑定到该 key 的主体（§10.4.1）：owner 级，覆盖各模块读 scope */
const TEST_PRINCIPAL = {
  userId: 'usr_test_principal',
  displayName: 'Test Principal',
  roles: ['owner'],
  permissions: [] as string[],
  departmentIds: ['company'],
} as any;

/** 通用 prisma 桩：任何模型访问都返回空结果（认证先于业务执行，业务深浅不影响断言） */
const modelStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'count') return async () => 0;
    if (prop === 'findUnique' || prop === 'findFirst') return async () => null;
    return async () => [];
  },
});
const prismaStub = new Proxy({}, { get: () => modelStub }) as any;

const ROUTERS: Array<{ name: string; listPath: string; create: (opts: any) => express.Router; readScope?: boolean }> = [
  { name: 'procurement', listPath: '/', create: createProcurementRouter, readScope: true },
  { name: 'crm', listPath: '/REL__1/contacts', create: createCrmRouter },
  { name: 'quotations', listPath: '/', create: createQuotationRouter },
  { name: 'bom', listPath: '/', create: createBOMRouter, readScope: true },
  { name: 'mes', listPath: '/plans', create: createMesRouter },
  { name: 'inventory', listPath: '/items', create: createInventoryRouter },
];

/**
 * §10.4.1（2026-09-12）：API Key 只是凭据，不是身份。采购/BOM 读端点自本批起
 * 挂 procurement:read / bom:read（§10.7 B-5），因此「有效 key + 已绑定主体」才能读，
 * 裸 key（无主体）走 scope 门 401——与 products/emails 既有口径一致。
 *
 * 模块路由签名不接 apiKeyActors（25+ 个路由），主体走**进程级默认映射**
 * （auth/agentPrincipal.setDefaultAgentApiKeyActors），故测试也通过该通道注入。
 */
function makeApp(create: (opts: any) => express.Router, withPrincipal = true) {
  setDefaultAgentApiKeyActors(withPrincipal ? new Map([[TEST_KEY, TEST_PRINCIPAL]]) : new Map());
  const app = express();
  app.use(express.json());
  app.use('/', create({ prisma: prismaStub, requireAuth: true, apiKeys: new Set([TEST_KEY]) }));
  return app;
}

describe('module routers accept canonical X-Bambook-API-Key header', () => {
  for (const { name, listPath, create, readScope } of ROUTERS) {
    it(`${name}: rejects request without credentials`, async () => {
      const res = await request(makeApp(create)).get(listPath);
      expect(res.status).toBe(401);
    });

    it(`${name}: accepts X-Bambook-API-Key header (frontend apiService contract)`, async () => {
      const res = await request(makeApp(create)).get(listPath).set('X-Bambook-API-Key', TEST_KEY);
      expect(res.status).not.toBe(401);
    });

    it(`${name}: still accepts legacy x-api-key header (backward compat)`, async () => {
      const res = await request(makeApp(create)).get(listPath).set('x-api-key', TEST_KEY);
      expect(res.status).not.toBe(401);
    });

    // 仅对已挂读 scope 门的模块（procurement/bom）成立：无主体 → scope 门 401。
    // 未挂门的模块读面仍是无 scope 的旧契约，不在本批收口范围。
    if (readScope) {
      it(`${name}: 有效 key 但未绑定主体 → 401（§10.4.1 API Key 不是身份）`, async () => {
        const res = await request(makeApp(create, false)).get(listPath).set('X-Bambook-API-Key', TEST_KEY);
        expect(res.status).toBe(401);
      });
    }

    it(`${name}: rejects wrong API key`, async () => {
      const res = await request(makeApp(create)).get(listPath).set('X-Bambook-API-Key', 'wrong-key');
      expect(res.status).toBe(401);
    });
  }
});
