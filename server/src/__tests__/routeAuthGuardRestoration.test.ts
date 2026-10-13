/**
 * Route auth guard restoration source contract (task_mrcex1at)
 *
 * 验证 4 个模块（finance/shipping/development/email）的 auth guard 已恢复，
 * 且高风险路由有 requireRole 中间件。
 *
 * Source-level 契约断言，不连真实 DB。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

const FINANCE = read('finance/route.ts');
const SHIPPING = read('shipping/route.ts');
const DEVELOPMENT = read('development/route.ts');
const EMAIL = read('email/route.ts');
const INDEX = read('index.ts');

describe('Auth guard restoration · finance', () => {
  it('imports requirePermission scope guard from auth (legacy requireRole 已退役)', () => {
    // W-C 批三-E：财务域全面 scope 门化——requirePermission（permissionGuard）+
    // createModuleAuthGuard/requireJwtForWrite（moduleGuard），不再 import requireRole。
    expect(FINANCE).toContain("requirePermission");
    expect(FINANCE).toContain("from '../auth/permissionGuard'");
    expect(FINANCE).toContain("from '../auth/moduleGuard'");
    expect(FINANCE).toContain('createModuleAuthGuard');
  });

  it('destructures requireAuth + apiKeys from options (not silently dropped)', () => {
    expect(FINANCE).toContain('requireAuth');
    expect(FINANCE).toContain('apiKeys');
    expect(FINANCE).not.toMatch(/const \{ prisma, onDataChange \} = options/);
    expect(FINANCE).toContain('requireWrite');
  });

  it('uses shared createModuleAuthGuard (not inline copy)', () => {
    expect(FINANCE).toContain('createModuleAuthGuard');
    expect(FINANCE).toContain("requireAuth, apiKeys");
  });

  it('high-risk routes have requireRole: cancel invoice + delete invoice + delete voucher', () => {
    // W-C 批三-E（族 C）：财务写端点从 legacy requireRole(...HIGH_RISK_ROLES) 升级为矩阵 scope 门
    // requirePermission('invoices:write'/'vouchers:write')——写门禁仍存在且更细（FINANCE/owner/超管放行，
    // SALES/QC/LOGISTICS 403 由 permissionDenyPath.test.ts 锁定），字面 requireRole 写法已退役。
    expect(FINANCE).toContain("requirePermission('invoices:write')");
    expect(FINANCE).toContain("requirePermission('vouchers:write')");
    const cancelIdx = FINANCE.indexOf("router.post('/:id/cancel'");
    expect(FINANCE.slice(cancelIdx, cancelIdx + 100)).toContain('requireInvoicesWrite');
    const delIdx = FINANCE.indexOf("router.delete('/:id',");
    expect(FINANCE.slice(delIdx, delIdx + 100)).toContain('requireInvoicesWrite');
    const delVoucherIdx = FINANCE.indexOf("router.delete('/vouchers/:id',");
    expect(FINANCE.slice(delVoucherIdx, delVoucherIdx + 100)).toContain('requireVouchersWrite');
  });
});

describe('Auth guard restoration · shipping', () => {
  it('imports requireRole + destructures auth options', () => {
    expect(SHIPPING).toContain("requireRole");
    expect(SHIPPING).toContain('requireAuth');
    expect(SHIPPING).toContain('apiKeys');
  });

  it('uses shared createModuleAuthGuard (not inline copy)', () => {
    expect(SHIPPING).toContain('createModuleAuthGuard');
  });

  it('high-risk DELETE /:id has requireRole', () => {
    const delIdx = SHIPPING.indexOf("router.delete('/:id',");
    expect(delIdx).toBeGreaterThan(-1);
    expect(SHIPPING.slice(delIdx, delIdx + 100)).toContain('requireRole');
  });
});

describe('Auth guard restoration · development', () => {
  it('uses shared createModuleAuthGuard (not inline copy)', () => {
    expect(DEVELOPMENT).toContain('createModuleAuthGuard');
  });

  it('W-C 族 C：POST /:id/convert + DELETE /:id 收编矩阵 scope 门（products:write，legacy requireRole 退役）', () => {
    // SALES/SALES_MANAGER 持 products:write——开发转订单/删单是 S1 主链日常，
    // legacy HIGH_RISK(owner/admin/manager) 曾造成族 C 主链阻断
    expect(DEVELOPMENT).toContain("requirePermission('products:write')");
    const convertIdx = DEVELOPMENT.indexOf("router.post('/:id/convert',");
    expect(convertIdx).toBeGreaterThan(-1);
    expect(DEVELOPMENT.slice(convertIdx, convertIdx + 100)).toContain('requireDevWrite');
    expect(DEVELOPMENT.slice(convertIdx, convertIdx + 100)).not.toContain('requireRole');
    const delIdx = DEVELOPMENT.indexOf("router.delete('/:id',");
    expect(DEVELOPMENT.slice(delIdx, delIdx + 100)).toContain('requireDevWrite');
    expect(DEVELOPMENT.slice(delIdx, delIdx + 100)).not.toContain('requireRole');
  });
});

describe('Auth guard restoration · email', () => {
  it('factory signature accepts EmailRouterOptions (not bare prisma)', () => {
    expect(EMAIL).toContain('EmailRouterOptions');
    expect(EMAIL).toContain('requireAuth');
    expect(EMAIL).toContain('apiKeys');
    expect(EMAIL).not.toMatch(/createEmailRouter\(prisma:/);
  });

  it('uses shared createModuleAuthGuard (not inline copy)', () => {
    expect(EMAIL).toContain('createModuleAuthGuard');
  });

  it('high-risk POST /outbox/:id/send + POST /sync have write gate（W-C 批三-F：升级为 requirePermission emails:write）', () => {
    // W-C 批三-F（族 C）：S1 日常写端点从 legacy requireRole 升级为矩阵 scope 门
    // requirePermission('emails:write')（SALES/SALES_MANAGER 授权；写门禁仍存在且更细）。
    // 批量维护面端点（backfill-links/classify-backfill）仍保留 legacy requireRole。
    expect(EMAIL).toContain("requireRole(...HIGH_RISK_ROLES)");
    const sendIdx = EMAIL.indexOf("router.post('/outbox/:id/send',");
    expect(sendIdx).toBeGreaterThan(-1);
    expect(EMAIL.slice(sendIdx, sendIdx + 120)).toContain("requirePermission('emails:write')");
    const syncIdx = EMAIL.indexOf("router.post('/sync',");
    expect(syncIdx).toBeGreaterThan(-1);
    expect(EMAIL.slice(syncIdx, syncIdx + 120)).toContain("requirePermission('emails:write')");
    const backfillIdx = EMAIL.indexOf("router.post('/backfill-links',");
    expect(backfillIdx).toBeGreaterThan(-1);
    expect(EMAIL.slice(backfillIdx, backfillIdx + 120)).toContain('requireRole(...HIGH_RISK_ROLES)');
  });
});

describe('Auth guard restoration · index.ts mount', () => {
  it('email mount passes requireAuth + apiKeys (not bare prisma)', () => {
    expect(INDEX).toContain("createEmailRouter({");
    expect(INDEX).toMatch(/createEmailRouter\(\{[\s\S]*requireAuth/);
    expect(INDEX).toMatch(/createEmailRouter\(\{[\s\S]*apiKeys/);
  });
});
