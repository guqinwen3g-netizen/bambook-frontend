/**
 * v3.110 证人（一次性，不入库）：B218 + 主联系人降级留痕，跑在**真 Prisma / 真库**上。
 * 替身证不了查询形状 ⇒ 三件事必须在真引擎上量：
 *   W1 resolveAuditActorId 的 userAccount.count 真跑得通、两分支判定对
 *   W2  hazards：拿"非空但库里没这个人"的 id 直接写 AuditLog → 是否真的外键违约（B218 的因）
 *   W3 端到端：真 tx 里设主联系人 ⇒ 被顶掉的那位**有没有**留下 isPrimary 痕；改/删同理
 * 自建自清：只删本次记下的 id。
 */
const fs = require('fs');
const path = require('path');
const envFile = path.join('/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server', '.env.local');
for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { PrismaClient } = require('@prisma/client');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS' } });
const { resolveAuditActorId } = require('../src/audit/routeAudit.ts');
const { createCrmService } = require('../src/crm/crmService.ts');

const prisma = new PrismaClient();
const stamp = Date.now();
const mine = { audit: [], contact: [], relation: [] };
const ok = (label, cond, extra) => console.log(`${cond ? 'PASS' : 'FAIL'} | ${label}${extra ? ' | ' + extra : ''}`);

(async () => {
  // ── W1 身份闸门 ──
  const sysRow = await prisma.userAccount.findFirst({ where: { id: 'system' }, select: { id: true } });
  ok('W1a 前提：seed 里有 id=system 的账号（B58 的地基）', !!sysRow);
  const g1 = await resolveAuditActorId(prisma, 'ghost-not-a-real-user-zz');
  ok('W1b 未知身份 ⇒ 降级到 system 并报出原值', g1.actorId === 'system' && g1.unknownClaim === 'ghost-not-a-real-user-zz', JSON.stringify(g1));
  const g2 = await resolveAuditActorId(prisma, 'system');
  ok('W1c 已知身份 ⇒ 原样信任', g2.actorId === 'system' && g2.unknownClaim === null);
  const g3 = await resolveAuditActorId(prisma, '');
  ok('W1d 空身份 ⇒ 落哨兵且不算降级（不写 note）', g3.actorId === 'system' && g3.unknownClaim === null);

  // ── W2 B218 的因：未知身份直接进审计位会不会炸 ──
  let fkErr = null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: { id: `alog_zz_probe_${stamp}`, actorId: 'ghost-not-a-real-user-zz', action: 'zz_probe', targetType: 'Order', targetId: 'ZZ-PROBE-NONE' },
      });
      throw new Error('ROLLBACK_PROBE'); // 不留残行：这条只测引擎受不受
    });
  } catch (e) { fkErr = e; }
  const code = String(fkErr?.code || fkErr?.meta?.target || '');
  ok('W2 未知 actorId 写 AuditLog ⇒ 引擎拒绝（P2003/外键），整笔事务连带回滚',
    fkErr && /P2003|foreign key/i.test(String(fkErr.message) + code),
    fkErr ? String(fkErr.message).split('\n')[0].slice(0, 90) : '竟然写成功了');

  // ── W2b 把**修前那个写法**照搬到真引擎上跑一遍（证明"整笔回滚"不是我推的，是量出来的）──
  {
    const rel0 = await prisma.relation.create({
      data: { id: `REL_ZZ0_${stamp}`, name: `证人组织0 ${stamp}`, isOrganization: true, category: 'Customer', type: 'Customer', contactInfo: '', lastInteraction: BigInt(stamp) },
    });
    mine.relation.push(rel0.id);
    const c0 = await prisma.contact.create({
      data: { id: `CTC_ZZ0_${stamp}`, relationId: rel0.id, name: '丙', status: 'Active', isPrimary: false, isDecisionMaker: false, tags: [], createdAt: BigInt(stamp), updatedAt: BigInt(stamp) },
    });
    mine.contact.push(c0.id);
    let oldShapeThrew = null;
    try {
      // 修前 crmService 的形状：同一个 tx 里 先改行 → 再拿 actorId 原值写审计（无存在性闸门）
      await prisma.$transaction(async (tx) => {
        await tx.contact.update({ where: { id: c0.id }, data: { title: '旧形状试图留下的改动' } });
        await tx.auditLog.create({
          data: { id: `alog_zz_old_${stamp}`, actorId: 'ghost-not-a-real-user-zz', action: 'update_contact', targetType: 'Contact', targetId: c0.id, detail: { source: 'probe' } },
        });
      });
    } catch (e) { oldShapeThrew = e; }
    const stillEmpty = await prisma.contact.findUnique({ where: { id: c0.id }, select: { title: true } });
    ok('W2b 修前形状：未知身份 ⇒ 整笔回滚（业务改动没留下，界面只会看到"数据库错误"）',
      String(oldShapeThrew?.code) === 'P2003' && stillEmpty?.title == null,
      `错码=${String(oldShapeThrew?.code)} 约束=${String(oldShapeThrew?.meta?.target)} 改后 title=${String(stillEmpty?.title)}`);
    await prisma.auditLog.deleteMany({ where: { id: `alog_zz_old_${stamp}` } });
  }

  // ── W3 端到端：真库上的降级留痕 ──
  const rel = await prisma.relation.create({
    data: { id: `REL_ZZ_${stamp}`, name: `证人组织 ${stamp}`, isOrganization: true, category: 'Customer', type: 'Customer', contactInfo: '', lastInteraction: BigInt(stamp) },
  });
  mine.relation.push(rel.id);
  const svc = createCrmService(prisma);
  const a = await svc.createContact(rel.id, { name: '甲', isPrimary: true }, 'system');
  const b = await svc.createContact(rel.id, { name: '乙', isPrimary: false }, 'system');
  mine.contact.push(a.id, b.id);
  await prisma.auditLog.deleteMany({ where: { targetId: { in: [a.id, b.id] }, targetType: 'Contact' } }); // 清掉 create 那两笔，只看后面的

  await svc.updateContact(b.id, { isPrimary: true }, 'system');   // 升乙 ⇒ 甲被顶掉
  const demote = await prisma.auditLog.findMany({ where: { targetType: 'Contact', targetId: a.id, fieldPath: 'isPrimary' } });
  ok('W3a 被顶掉的那位留下 1 条 isPrimary 痕（true→false）', demote.length === 1 && demote[0].beforeValue === true && demote[0].afterValue === false,
    `行数=${demote.length} 值=${JSON.stringify(demote.map(d => [d.beforeValue, d.afterValue]))}`);
  const selfRows = await prisma.auditLog.findMany({ where: { targetType: 'Contact', targetId: b.id, fieldPath: 'isPrimary' } });
  ok('W3b 升上来的那位也有痕（false→true）', selfRows.length === 1 && selfRows[0].beforeValue === false, `行数=${selfRows.length}`);

  await svc.updateContact(a.id, { title: '证人职位' }, 'ghost-not-a-real-user-zz'); // B218 那一刀
  const afterGhost = await prisma.contact.findUnique({ where: { id: a.id }, select: { title: true } });
  const ghostRows = await prisma.auditLog.findMany({ where: { targetType: 'Contact', targetId: a.id, action: 'update_contact', fieldPath: 'title' } });
  ok('W3c 未知身份：业务写入**成功**（此前是整笔 500 回滚）', afterGhost?.title === '证人职位', String(afterGhost?.title));
  ok('W3d 且审计照写、身份落 system、note 里带着声称的原值',
    ghostRows.length > 0 && ghostRows.every(r => r.actorId === 'system' && /ghost-not-a-real-user-zz/.test(String(r.detail?.note))),
    `只取本次那一格(fieldPath=title)：行数=${ghostRows.length} actorId=${ghostRows[0]?.actorId} note=${String(ghostRows[0]?.detail?.note).slice(0, 70)}`);

  await svc.deleteContact(a.id, 'system');
  const del = await prisma.auditLog.findMany({ where: { targetType: 'Contact', targetId: a.id, action: 'delete_contact' } });
  ok('W3e 删除留痕，整行 before 里 BigInt 已折成字符串（Json 列吃得下）',
    del.length === 1 && typeof del[0].detail?.before?.createdAt === 'string', `行数=${del.length}`);

  // ── 清理：只删自己记下的 ──
  const ids = await prisma.auditLog.findMany({ where: { targetId: { in: [a.id, b.id, rel.id, 'ZZ-PROBE-NONE'] } }, select: { id: true } });
  mine.audit.push(...ids.map(r => r.id));
  const delA = await prisma.auditLog.deleteMany({ where: { id: { in: mine.audit } } });
  const delC = await prisma.contact.deleteMany({ where: { id: { in: mine.contact } } });
  const delR = await prisma.relation.deleteMany({ where: { id: { in: mine.relation } } });
  console.log(`CLEANUP 审计=${delA.count} 联系人=${delC.count} 组织=${delR.count}（全部按本次记下的 id 删）`);
  const residue = await prisma.auditLog.count({ where: { targetId: { in: [a.id, b.id, rel.id] } } });
  ok('清理彻底：本次写入的审计 0 残留', residue === 0, `残留=${residue}`);
})()
  .catch((e) => { console.error('SCRIPT ERROR', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
