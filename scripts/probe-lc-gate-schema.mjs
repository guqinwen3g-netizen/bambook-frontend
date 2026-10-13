#!/usr/bin/env node
/**
 * probe-lc-gate-schema.mjs —— G-4 收尾的**只读影子复算**（R4-T4 复核指出"更该做的一条"）
 *
 * 为什么需要它：L/C 门禁的全部证据都来自 mock。本地 `LetterOfCredit` 实测 **0 行** ⇒
 * 「查询形状对不对得上真 schema」这件事**一次都没被执行过**。
 * 这正是本仓 G-2 那次 `deletedAt` 假绿的同一族缺陷：**替身接受、真库拒绝**（§9 B45）。
 *
 * 它只做两件事，且**一字不写**：
 *   ① 拿 `lcGate.ts` 里**逐字抄出来**的 where/select 形状去打真库（形状由源码派生，不另写一份 ⇒ 不会漂移）；
 *   ② 顺手重测三个"零存量"的说法（instrument 分布 / paymentTerms 含 L/C 的存活单 / Order 有无 CHECK 约束），
 *      因为文档里那些数必须是**这一支脚本**量出来的，不是复核转述的。
 *
 * 自证（G-3 那批的产物）：先打横幅说明"这次读数出自哪个 checkout、哪个库、后端是谁"，
 * 不信任任何来历不明的读数。
 *
 * 用法：`node scripts/probe-lc-gate-schema.mjs`（只连本机 `panda_hub_local`，远程/生产直接拒绝）
 */
import fs from 'node:fs';
import path from 'node:path';
import { dbTargetReasons, formatBanner, openLocalPrisma, REPO_ROOT, selfCheck } from './lib/acceptance-selfcheck.mjs';

const GATE_SRC = path.join(REPO_ROOT, 'server/src/customs/lcGate.ts');

/** 从源码里取 LC 表那次 findMany 的 where/select 键（**派生**，不是手抄第二份） */
function extractLcQueryShape(src) {
  const m = /letterOfCredit\.findMany\(\{\s*where:\s*\{([^}]*)\},\s*select:\s*\{([^}]*)\}/.exec(src);
  if (!m) throw new Error('在 lcGate.ts 里找不到 letterOfCredit.findMany 的 where/select（结构变了要同步本探针）');
  const whereKeys = m[1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
  const selectKeys = m[2].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
  return { whereKeys, selectKeys, raw: m[0] };
}

function buildSelect(selectKeys) {
  const out = {};
  for (const k of selectKeys) out[k] = true;
  return out;
}

async function main() {
  const sc = selfCheck();
  console.log(formatBanner(sc));
  // 本探针**只读、不经过后端** ⇒ 只卡"连的是哪个库"这一条判据（同一份实现，不另写一遍红线）。
  //   DIRTY_WORKTREE / ARTIFACT_MISMATCH 照样打在横幅里（透明），但不拦只读读数 ——
  //   它们拦的是"把验收结论署给某个 commit"，那是另一件事。
  const dbBad = dbTargetReasons(sc);
  if (dbBad.length) {
    console.error('★ 库来历不过 ⇒ 拒绝连库：\n  · ' + dbBad.join('\n  · '));
    process.exit(2);
  }

  const src = fs.readFileSync(GATE_SRC, 'utf8');
  const shape = extractLcQueryShape(src);
  console.log('\n— 判据源形状（从 lcGate.ts 派生，非手抄）—');
  console.log('  where:', shape.whereKeys.join(', '));
  console.log('  select:', shape.selectKeys.join(', '));

  const { prisma } = openLocalPrisma();
  const results = [];
  const record = (name, fn) => {
    // ★ 每一步都自己吞异常并记 FAIL：探针的结论必须能"红"，
    //   否则一条查询炸掉会让整支脚本走 catch 直接退出，读数一条都不剩。
    return Promise.resolve()
      .then(fn)
      .then((detail) => { results.push({ name, ok: true, detail }); console.log(`  OK   ${name}${detail ? ` —— ${detail}` : ''}`); })
      .catch((e) => { const detail = String(e?.message ?? e).slice(0, 300); results.push({ name, ok: false, detail }); console.log(`  FAIL ${name} —— ${detail}`); });
  };

  try {
    // ① 三条真实查询形状（只读）
    const live = await prisma.order.findMany({
      where: { deletedAt: null },
      select: { id: true, paymentInstrument: true, paymentTerms: true },
      take: 5000,   // 够覆盖本地全量存活单；被截断时下面会显式警告
    });
    const anchor = live[0] ?? null;

    await record('Order.findMany(deletedAt:null, select paymentInstrument/paymentTerms)',
      () => `存活 ${live.length} 单`);

    await record('确认侧门禁那次 order.findUnique 形状', async () => {
      if (!anchor) return '无存活订单 ⇒ 本步未执行（记 OK 但读数为空）';
      const row = await prisma.order.findUnique({ where: { id: anchor.id }, select: { paymentInstrument: true } });
      return `instrument=${JSON.stringify(row?.paymentInstrument)}`;
    });

    await record('letterOfCredit.findMany 形状（含 deletedAt 这个 G-2 栽过的键）', async () => {
      const lcWhere = {};
      for (const k of shape.whereKeys) lcWhere[k] = k === 'orderId' ? (anchor?.id ?? 'PROBE__NO_ORDER') : null;
      const rows = await prisma.letterOfCredit.findMany({ where: lcWhere, select: buildSelect(shape.selectKeys) });
      return `命中 ${rows.length} 行`;
    });

    await record('dr013ExceptionRequest.findMany 形状（例外那条腿读的表）', async () => {
      const rows = await prisma.dr013ExceptionRequest.findMany({ where: { deletedAt: null }, take: 5 });
      return `取回 ${rows.length} 行（上限 5）`;
    });

    // ② 三个"零存量"说法自己量一遍（文档里的数必须由这一支脚本量出来）
    await record('LetterOfCredit 全表行数（含软删）', async () => `${await prisma.letterOfCredit.count()} 行`);

    await record('Order 上的 CHECK 约束数（instrument 有没有 DB 护栏）', async () => {
      const rows = await prisma.$queryRaw`
        SELECT conname FROM pg_constraint WHERE conrelid = '"Order"'::regclass AND contype = 'c'`;
      return `${rows.length} 条`;
    });

    await record('存活订单 paymentInstrument 分布', () => {
      const dist = {};
      for (const o of live) { const k = o.paymentInstrument == null ? '(null)' : o.paymentInstrument; dist[k] = (dist[k] ?? 0) + 1; }
      return `${JSON.stringify(dist)}${live.length >= 5000 ? ' ⚠️ 被 take 截断，分布非全量' : '（未截断）'}`;
    });

    await record('paymentTerms 含 "L/C" 的存活订单数', () => {
      const n = live.filter((o) => /l\s*\/\s*c/i.test(o.paymentTerms ?? '')).length;
      return `${n} 单`;
    });

    console.log('\n— 判定 —');
    const bad = results.filter((r) => !r.ok);
    if (bad.length) {
      console.log(`FAIL ${bad.length} 处查询形状在真 schema 上被拒绝：${bad.map((b) => b.name).join(' / ')}`);
      process.exitCode = 2;
    } else {
      console.log(`PASS ${results.length} 处形状在真 schema 上全部可执行（只读，零写入）`);
      console.log('⚠️ 这只证明「SQL 形状对得上真库」，**不**证明门禁在生产上拦住了什么 —— 存量 0 ⇒ 行为面仍无真库证据。');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('探针自身失败（不静默放过）:', e?.stack ?? e);
  process.exit(2);
});
