#!/usr/bin/env node
// 船样（S/S）单一真源迁移：旧表 FabricShipmentSample → 新表 Sample(type='ship', sourceOrderId)
// （Kevin 2026-09-30 拍板「旧端点下线 + 旧数据迁到新表」）
//
// ★ 纪律：
//   1. 全程走**真实 HTTP 接口**（不裸写库）⇒ 状态机、审计、通知一并生效；
//   2. **不洗状态**：旧表 pending（已寄未确认）⇒ 只推进到 submit（已寄），**不 confirm**
//      ⇒ 出运门禁仍会拦（这正是业务事实：客户还没确认）；approved ⇒ 走完整 confirm + approve；
//   3. 旧表**不删**（历史留痕），只由端点侧停止写入；
//   4. 幂等：同 orderId 若新表已有 ship 样品则跳过。
//
// 用法：node scripts/migrate-fss-to-sample.mjs [--dry]

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const BASE = 'http://localhost:8081';
const DRY = process.argv.includes('--dry');

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jason.shen@bambook.local', password: 'Bambook@2026' }),
  });
  const j = await r.json();
  return j.token || j.data?.token;
}

(async () => {
  const T = await login();
  if (!T) { console.error('登录失败'); process.exit(1); }
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` };
  const api = async (m, p, b) => {
    const r = await fetch(BASE + p, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch {}
    return { status: r.status, t, j };
  };

  const rows = await prisma.fabricShipmentSample.findMany({
    where: { deletedAt: null },
    select: {
      id: true, orderId: true, sampleCode: true, customerStatus: true,
      sentDate: true, courier: true, trackingNumber: true, sampleQuantity: true, sampleUnit: true, notes: true,
    },
    orderBy: { orderId: 'asc' },
  });
  console.log(`旧表船样 ${rows.length} 条${DRY ? '（演练，不写库）' : ''}`);

  let migrated = 0, skipped = 0, failed = 0;
  const errs = [];

  for (const r of rows) {
    const oid = r.orderId;
    if (!oid) { skipped++; continue; }
    // 幂等：新表已有该订单的 ship 样品 ⇒ 跳过
    const already = await prisma.sample.findFirst({
      where: { sourceOrderId: oid, type: 'ship', deletedAt: null },
      select: { id: true },
    });
    if (already) { skipped++; continue; }

    const approved = String(r.customerStatus || '') === 'approved';
    if (DRY) {
      console.log(`  ${oid} → ${approved ? 'approved(完整)' : 'pending(只到已寄)'}`);
      migrated++;
      continue;
    }

    try {
      const s = await api('POST', '/api/v1/samples', {
        type: 'ship',
        sourceOrderId: oid,
        name: `船样(S/S) ${r.sampleCode || ''}`.trim(),
        notes: `由旧表迁移 FSS=${r.id}；原取样 ${r.sampleQuantity ?? '-'}${r.sampleUnit || ''}${r.notes ? '；' + r.notes : ''}`,
      });
      const sid = s.j?.sample?.id || s.j?.id;
      if (!sid) { failed++; errs.push(`${oid}: 建样品失败 ${s.status} ${s.t.slice(0, 100)}`); continue; }

      const stage = async (action, extra = {}) => api('PATCH', `/api/v1/samples/${encodeURIComponent(sid)}/stage`, { action, ...extra });
      await stage('start');
      await stage('qc');
      await stage('submit', {
        sentDate: r.sentDate || undefined,
        courier: r.courier || undefined,
        trackingNumber: r.trackingNumber || undefined,
      });
      if (approved) {
        await stage('confirm', { customerStatus: 'approved', feedback: '迁移自旧表（客户已确认）', feedbackDate: r.sentDate || undefined });
        await stage('approve');
      }
      migrated++;
      console.log(`  ✓ ${oid} → ${approved ? '已确认' : '已寄未确认（保持拦截）'}`);
    } catch (e) {
      failed++;
      errs.push(`${oid}: ${e.message}`);
    }
  }

  console.log(`\n迁移完成：成功 ${migrated} · 跳过(已有) ${skipped} · 失败 ${failed}`);
  if (errs.length) console.log(errs.slice(0, 8).join('\n'));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('异常:', e.message); await prisma.$disconnect(); process.exit(1); });
