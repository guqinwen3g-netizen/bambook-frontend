/**
 * §10.3-9 印章库·真库集成测试（schema 批次门禁：prisma migrate deploy 复核 + 真库集成）。
 * 连接本地 Postgres（与 dev 服务同库），测试后按名称前缀硬删，避免污染共享库。
 */
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createSealService } from '../sealService';

const prisma = new PrismaClient();
const PREFIX = `ITSEAL_${Date.now()}_`;

async function cleanup() {
  await prisma.seal.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeAll(async () => { await cleanup(); });
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('§10.3-9 Seal 真库集成', () => {
  it('create/list/resolve/soft-delete 端到端', async () => {
    const seals = createSealService(prisma);
    // auditLog.actorId 是 UserAccount 外键，须用库中真实存在的账号
    const actorUser = await prisma.userAccount.findFirst({ where: { status: 'active', deletedAt: null } });
    const actor = actorUser?.id ?? 'it-actor';

    const def = await seals.createSeal({ name: `${PREFIX}公司公章`, type: 'company_seal', imageDataUrl: PNG, isDefault: true }, actor);
    const roleSeal = await seals.createSeal({ name: `${PREFIX}主管章`, type: 'other', imageDataUrl: PNG, ownerRoleId: 'role-sales-manager' }, actor);
    const userSeal = await seals.createSeal({ name: `${PREFIX}老板私章`, type: 'legal_rep_seal', imageDataUrl: PNG, ownerUserId: 'it-user-1' }, actor);

    // 默认章全局唯一：新建默认应清除旧默认
    await seals.createSeal({ name: `${PREFIX}新默认`, type: 'company_seal', imageDataUrl: PNG, isDefault: true }, actor);
    const defReload = await seals.getSeal(def.id);
    expect(defReload.isDefault).toBe(false);

    // resolve 优先级
    expect((await seals.resolveSealForSigner({ userId: 'it-user-1' }))?.id).toBe(userSeal.id);
    expect((await seals.resolveSealForSigner({ roleId: 'role-sales-manager' }))?.id).toBe(roleSeal.id);
    expect((await seals.resolveSealForSigner({ roleId: 'role-qc' }))?.name).toContain('新默认');

    // 列表（不显式含非活跃）应可见刚建的 4 条
    const list = await seals.listSeals();
    expect(list.total).toBeGreaterThanOrEqual(4);

    // 软删后不可见
    await seals.deleteSeal(userSeal.id, actor);
    const got = await seals.getSeal(userSeal.id).catch(() => null);
    expect(got).toBeNull();
  });
});
