/**
 * B216（v3.108）：联系人的**修改 / 删除**必须留痕
 *
 * 修之前：`updateContact` / `deleteContact` 的事务里**没有任何 `auditLog.create`**（只有 `createContact` 写 `create_contact`）
 * ⇒ 变更史里永远只有"创建"那一笔，界面上与"确实没改过"长得一模一样（实测：两次 PUT 都 200、审计 0 行）。
 *
 * 本文件钉八件事：
 *   ① 改一个字段 ⇒ **恰好一条**字段级审计（fieldPath / before / after 都对）；
 *   ② 一次改两个字段 ⇒ 两条（逐字段）；**没改** ⇒ 零条（反面对照：不许把"碰过"记成"改过"）；
 *   ③ 删除 ⇒ 一条 delete 审计（带整行 before 快照）；
 *   ④ 空 actorId ⇒ 落 `'system'` 哨兵（B58）；
 *   ⑤ 追踪面收着：系统列（时间戳）变了也不产出审计行；
 *   ⑥ ★ v3.110：设主联系人时**被顶掉的那几位**也要各留一条 isPrimary 痕（此前只 updateMany、零痕）；
 *   ⑦ ★ v3.110（B218）：actorId 非空但库里没这个人 ⇒ 业务写入**照旧成功**、审计落 'system'
 *      且 `detail.note` 带上"它声称是谁"（不静默降级；此前这一刀会让整笔 PUT 因外键 P2003 回滚）；
 *   ⑧ ★ v3.111（复核 #27 第 1③ 条）：前值快照必须取自**事务内**那一次读 —— 让事务内外各读到不同的行，
 *      断言留痕的 before 是事务内那份（读回事务外立刻红）。
 *
 * ⓘ `auditScalar` 只承担一件事：`Contact` 的 createdAt/updatedAt 是 **BigInt** 列，
 *   而 ③ 那条 delete 写的是**整行** before 快照 —— `JSON.stringify(BigInt)` 直接抛，绕不过去。
 *   字段级那条路径上 trackedFields 先把这些列滤掉了，所以 ①②⑤ 与折叠无关（旧注释写成
 *   "Date/BigInt 都会炸"是实的另一半、虚的一半：`Contact` 里一个 DateTime 列都没有）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createCrmService } from '../crmService';

const CONTACT = {
  id: 'CTC-1',
  relationId: 'REL-1',
  name: 'Emily Carter',
  title: 'Purchasing Manager',
  department: null,
  email: 'emily@example.com',
  phone: '+1-20-555-0100',
  mobile: null,
  wechat: null,
  whatsapp: null,
  isPrimary: true,
  isDecisionMaker: false,
  birthday: null,
  personalNote: null,
  tags: [],
  status: 'Active',
  createdAt: BigInt(1780909200000), // ★ BigInt：真实 Prisma 行就是 BigInt
  updatedAt: BigInt(1780909200000),
  deletedAt: null,
};

function makeFake(rowover: Record<string, unknown> = {}, opts: { actorExists?: boolean; demotedPeers?: string[]; txRow?: Record<string, unknown> } = {}) {
  const row = { ...CONTACT, ...rowover };
  // ★ ⑧ 用：让"事务里读到的那一行"与"事务外读到的那一行"**不一样**，才能问出前值到底取自哪一边
  const txSeen = opts.txRow ? { ...row, ...opts.txRow } : row;
  const audited: any[] = [];
  const tx = {
    contact: {
      findFirst: vi.fn(async () => txSeen),
      update: vi.fn(async ({ data }: any) => ({ ...txSeen, ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      // 设主联系人时被"顶掉"的那几位（⑥ 用 opts.demotedPeers 喂）
      findMany: vi.fn(async () => (opts.demotedPeers ?? []).map((id) => ({ id }))),
    },
    // ★ B218：resolveAuditActorId 写审计前先查身份在不在（默认"在"＝沿用既有断言）
    userAccount: { count: vi.fn(async () => (opts.actorExists === false ? 0 : 1)) },
    relation: { update: vi.fn(async () => ({})) },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audited.push(data);
        return data;
      }),
    },
  };
  const prisma: any = {
    // ★ ⑧ 要用一把**独立**的事务外 spy：写路径的前值快照必须走 tx，不走根（否则并发下留痕会错）
    contact: { findFirst: vi.fn(async () => row) },
    relation: { update: tx.relation.update },
    $transaction: async (fn: any) => fn(tx),
  };
  return { prisma, audited, tx, rootFindFirst: prisma.contact.findFirst };
}

describe('B216 · 联系人修改/删除留痕', () => {
  it('① 改一个字段 ⇒ 恰好一条字段级审计，before/after 都对', async () => {
    const { prisma, audited } = makeFake();
    const svc: any = createCrmService(prisma);
    await svc.updateContact('CTC-1', { phone: '+1-20-555-0199' }, 'u-9');

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      targetType: 'Contact',
      targetId: 'CTC-1',
      action: 'update_contact',
      operationType: 'update',
      fieldPath: 'phone',
      beforeValue: '+1-20-555-0100',
      afterValue: '+1-20-555-0199',
      actorId: 'u-9',
    });
  });

  it('② 改两个字段 ⇒ 两条；**没改**（同一个值）⇒ 零条（不许把"碰过"记成"改过"）', async () => {
    const a = makeFake();
    const svcA: any = createCrmService(a.prisma);
    await svcA.updateContact('CTC-1', { phone: '+1-20-555-0199', title: 'Head of Purchasing' }, 'u-9');
    expect(a.audited.map((r) => r.fieldPath).sort()).toEqual(['phone', 'title']);

    const b = makeFake();
    const svcB: any = createCrmService(b.prisma);
    await svcB.updateContact('CTC-1', { phone: '+1-20-555-0100' }, 'u-9'); // 原值
    expect(b.audited, '值没变却写了审计 ⇒ 变更史会被噪声淹没').toHaveLength(0);
  });

  it('③ 删除 ⇒ 一条 delete 审计，带整行 before 快照', async () => {
    const { prisma, audited } = makeFake();
    const svc: any = createCrmService(prisma);
    await svc.deleteContact('CTC-1', 'u-9');

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      targetType: 'Contact',
      targetId: 'CTC-1',
      action: 'delete_contact',
      operationType: 'delete',
      actorId: 'u-9',
    });
    expect(audited[0].detail?.before?.name).toBe('Emily Carter');
  });

  it('④ 身份兜底：actorId 空 ⇒ 落 system 哨兵（否则外键违约整笔回滚）', async () => {
    const { prisma, audited } = makeFake();
    const svc: any = createCrmService(prisma);
    await expect(svc.updateContact('CTC-1', { title: 'X' }, '')).resolves.toBeTruthy();
    expect(audited[0].actorId, 'B58：身份位落 system 哨兵（否则外键违约整笔回滚）').toBe('system');
  });

  it('⑥ 设主联系人 ⇒ **被顶掉的那几位**各留一条 isPrimary 痕（此前零痕）', async () => {
    const { prisma, audited } = makeFake({}, { demotedPeers: ['CTC-PEER-A', 'CTC-PEER-B'] });
    const svc: any = createCrmService(prisma);
    await svc.updateContact('CTC-1', { isPrimary: true }, 'u-9');

    const demoteRows = audited.filter((r) => r.targetType === 'Contact' && r.fieldPath === 'isPrimary' && r.targetId !== 'CTC-1');
    expect(demoteRows.map((r) => r.targetId).sort()).toEqual(['CTC-PEER-A', 'CTC-PEER-B']);
    for (const r of demoteRows) {
      expect(r).toMatchObject({ action: 'update_contact', beforeValue: true, afterValue: false });
    }
    // 反面对照：库里确实没有别人是主联系人 ⇒ 不许凭空造降级痕
    const clean = makeFake();
    const svcClean: any = createCrmService(clean.prisma);
    await svcClean.updateContact('CTC-1', { isPrimary: true }, 'u-9');
    expect(clean.audited.filter((r) => r.targetId !== 'CTC-1'), '没人被顶掉却写了降级痕').toHaveLength(0);
  });

  it('⑦ actorId 非空但库里没这个人（遗留 token）⇒ 业务写入照旧成功，审计落 system 且 note 带上声称的身份', async () => {
    const { prisma, audited } = makeFake({}, { actorExists: false });
    const svc: any = createCrmService(prisma);
    // 修之前：这一刀是 P2003 ⇒ 整笔 PUT 回滚 500（界面上是"数据库错误"，真相是审计身份位）
    await expect(svc.updateContact('CTC-1', { title: 'X' }, 'ghost-not-in-db')).resolves.toBeTruthy();
    expect(audited.length, '降级之后审计行也不写了 ⇒ 等于把痕吞掉').toBeGreaterThan(0);
    for (const r of audited) {
      expect(r.actorId).toBe('system');
      expect(String(r.detail?.note)).toContain('ghost-not-in-db');
    }
    // 反面对照：身份存在 ⇒ 不许带降级 note
    const ok = makeFake();
    const svcOk: any = createCrmService(ok.prisma);
    await svcOk.updateContact('CTC-1', { title: 'X' }, 'u-9');
    expect(ok.audited[0].detail?.note, '身份合法却写了降级说明').toBeUndefined();
    expect(ok.audited[0].actorId).toBe('u-9');
  });

  it('⑧ 前值快照取自**事务内**那一次读（并发下变更史才不会记错）', async () => {
    // 事务外读到 title='事务外·旧版本'，事务内读到 '事务内·已提交版本' ⇒ 留痕的 before 必须是后者。
    // 把 findFirst 挪回事务外（v3.110 及以前的写法）这条立刻红。
    const { prisma, audited, rootFindFirst, tx } = makeFake({}, { txRow: { title: '事务内·已提交版本' } });
    const svc: any = createCrmService(prisma);
    await svc.updateContact('CTC-1', { title: '本次改的新值' }, 'u-9');

    const row = audited.find((r) => r.fieldPath === 'title');
    // ★ 行为断言排在调用形状断言之前：判据要判的是"留痕里那个前值对不对"，不是"调了哪把 spy"
    expect(row?.beforeValue, '前值取自事务外 ⇒ 变更史会记成一条没发生过的变更').toBe('事务内·已提交版本');
    expect(row?.afterValue).toBe('本次改的新值');
    expect(rootFindFirst, 'updateContact 不该再用事务外那次读当权威前值').not.toHaveBeenCalled();
    expect(tx.contact.findFirst).toHaveBeenCalled();
  });

  it('⑤ 追踪面就是"业务字段"：时间戳/删除标记那类列变了也**不许**产出审计行（否则变更史被系统列淹没）', async () => {
    const { prisma, audited } = makeFake();
    const svc: any = createCrmService(prisma);
    // 服务自己会更新 updatedAt（每次都会变）——但它不在 trackFields 里 ⇒ 不该有行；
    // 同时真改一个业务字段 ⇒ 恰好一行。两条一起，才说明"追踪面"是收着的。
    await svc.updateContact('CTC-1', { title: 'Head of Purchasing' }, 'u-9');
    expect(audited.map((r) => r.fieldPath)).toEqual(['title']);
  });
});
