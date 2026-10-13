// ★★ 端到端验证：删实体时引用是否真的被清掉（2026-09-18 · 根因修复的验收）
//
// 判据（**来源必须不同** ✗ —— 不能拿同一个来源自证 ✓）：
//   ① 造一个真实体（**映射内的**模型：DevelopmentCase ✓）
//   ② 插一条**指向它**的引用 + 一条**从它出发**的链接
//   ③ **删掉那个实体**（⇒ 触发中间件 ✓）
//   ④ 读**引用表**（与③不同来源 ✓），断言 = 0 ✓
//
// ★ 同时验两条路径：
//   · `delete`（单条）
//   · `deleteMany`（批量 ⇒ 必须先查 id 再删 ✗）
//
// 只碰演练数据（`E2E-PURGE-` 前缀 ✓）· 结束**无条件清理** ✓ · 独立复核 ✓
import { createRequire } from 'node:module';
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
const req = createRequire(SERVER_DIR + '/');
loadEnvForScript();
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

// ★ 把被测中间件**装到这个脚本的 prisma 上**（与服务端同一份代码 ✓）
// ★ 用命名空间导入（直接具名 import 在 tsx 的 CJS/ESM 互操作下会报"没有该导出" ✗）
import * as purgeMod from "../server/src/entities/entityRefPurgeMiddleware";
const installEntityRefPurge: (p: any, o?: any) => void =
  (purgeMod as any).installEntityRefPurge ?? (purgeMod as any).default?.installEntityRefPurge;
if (typeof installEntityRefPurge !== "function") {
  console.error("✗ 拿不到 installEntityRefPurge（导出名变了？）");
  process.exit(2);
}
installEntityRefPurge(prisma);

const MARK = `E2E-PURGE-${Date.now().toString().slice(-6)}`;
const results = [];
const pass = (n, d = '') => { results.push({ n, ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ n, ok: false }); console.log(`  ✗ ${n} — ${d}`); };

/** 造一个开发单 + 两条引用（一条"指向它"，一条"从它出发" ✓） */
async function seed(suffix) {
  const id = `DEV-${MARK}-${suffix}`;
  const nowMs = BigInt(Date.now());
  await prisma.developmentCase.create({
    data: {
      id, code: `${MARK}-${suffix}`, name: `${MARK}-${suffix}`, type: 'fabric', stage: 'developing',
      createdAt: nowMs, updatedAt: nowMs,
    },
  });
  const now = BigInt(Date.now());
  await prisma.entityReference.create({
    data: {
      id: `REF-IN-${id}`, ownerType: 'shipment', ownerId: `SHP-${MARK}`,
      fieldKey: 'orderId', targetType: 'development-case', targetId: id,
      status: 'active', createdAt: now, updatedAt: now,
    },
  });
  await prisma.entityReference.create({
    data: {
      id: `REF-OUT-${id}`, ownerType: 'development-case', ownerId: id,
      fieldKey: 'customerName', targetType: 'product', targetId: `PRD-${MARK}`,
      status: 'active', createdAt: now, updatedAt: now,
    },
  });
  await prisma.entityLink.create({
    data: {
      id: `LNK-${id}`, fromType: 'development-case', fromId: id,
      toType: 'product', toId: `PRD-${MARK}`, linkKind: 'developFor',
      createdAt: now, updatedAt: now,
    },
  });
  return id;
}
const refsOf = (id) => prisma.entityReference.count({ where: { OR: [{ targetId: id }, { ownerId: id }] } });
const linksOf = (id) => prisma.entityLink.count({ where: { OR: [{ fromId: id }, { toId: id }] } });

try {
  // ── 路径 1：delete（单条）──
  const a = await seed('A');
  const beforeA = { ref: await refsOf(a), lnk: await linksOf(a) };
  pass('① 造实体 + 引用/链接', `${a} · 引用=${beforeA.ref} 链接=${beforeA.lnk}`);
  if (beforeA.ref === 0 || beforeA.lnk === 0) fail('① 前置', '引用/链接没插进去 ⇒ 后续断言会恒真 ✗');

  await prisma.developmentCase.delete({ where: { id: a } });
  const afterA = { ref: await refsOf(a), lnk: await linksOf(a) };
  const goneA = await prisma.developmentCase.count({ where: { id: a } });
  if (goneA === 0) pass('② delete：实体已删 ✓'); else fail('② delete', '实体未删 ✗');
  if (afterA.ref === 0 && afterA.lnk === 0) pass('③ ★ delete 后引用/链接**已清** ✓', `引用=${afterA.ref} 链接=${afterA.lnk}`);
  else fail('③ ★ delete 后**仍有残留** ✗', `引用=${afterA.ref} 链接=${afterA.lnk}`);

  // ── 路径 2：deleteMany（批量 ⇒ 必须先查 id ✗）──
  const b = await seed('B1');
  const c = await seed('B2');
  const beforeB = (await refsOf(b)) + (await refsOf(c));
  pass('④ 再造两条 + 引用', `引用合计=${beforeB}`);
  const del = await prisma.developmentCase.deleteMany({ where: { id: { in: [b, c] } } });
  pass('⑤ deleteMany 执行', `删除 ${del.count} 条`);
  const afterB = (await refsOf(b)) + (await refsOf(c)) + (await linksOf(b)) + (await linksOf(c));
  if (afterB === 0) pass('⑥ ★ deleteMany 后引用/链接**已清** ✓');
  else fail('⑥ ★ deleteMany 后**仍有残留** ✗', `残留=${afterB} ⇒ 大概率是"先删后查"顺序反了 ✗`);
} catch (e) {
  fail('脚本异常', String(e).slice(0, 900));
} finally {
  try {
    await prisma.entityReference.deleteMany({ where: { OR: [{ id: { contains: MARK } }, { ownerId: { contains: MARK } }, { targetId: { contains: MARK } }] } });
    await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: { contains: MARK } }, { toId: { contains: MARK } }] } });
    await prisma.developmentCase.deleteMany({ where: { code: { contains: MARK } } });
    const r1 = await prisma.developmentCase.count({ where: { code: { contains: MARK } } });
    const r2 = await prisma.entityReference.count({ where: { OR: [{ id: { contains: MARK } }, { ownerId: { contains: MARK } }] } });
    if (r1 === 0 && r2 === 0) pass('清理：独立复核零残留 ✓'); else fail('清理：复核', `开发单=${r1} 引用=${r2}`);
  } catch (e) { fail('清理异常', String(e).slice(0, 160)); }
  await prisma.$disconnect();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) console.log('失败项：\n  - ' + bad.map((r) => r.n).join('\n  - '));
  process.exit(bad.length ? 1 : 0);
}
