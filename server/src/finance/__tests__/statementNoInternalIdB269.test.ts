/**
 * statementNoInternalIdB269.test.ts — 台账 §9 B269：客户对账单是**发出去的对外件**，
 * 任何一格都不许出现内部 relation id（形如 REL-1789419248190，客户拿去无法核对、
 * 还把系统主键暴露给对方）。
 *
 * 口径不另立：本仓另外两份对外模板早就定了那条规则（`docTemplates/quotation.ts` 的
 * `Code 客户编码`、`docTemplates/paymentRequest.ts` 的 `Code 编码`）——
 * **有业务编码才出行，没有就整行不出现**，绝不退回内部 id。
 *
 * ★ 阳性对照：业务编码存在时那一格确实印的是编码（不是我把整行删掉了蒙过去）。
 * ★ 反面对照：档案根本不存在（传进来一个不存在的 id）⇒ 只许没有这一行，不许凭空造编码。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCustomerStatement } from '../reportService';
import { renderStatementBody as renderStatementHtml } from '../../templates/docTemplates/statement';
import { renderStatementBody as renderStatementEmailText } from '../../agent/statementSendFlow';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_B269_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;

const EXPORTER = { nameEn: 'B269 Exporter Ltd', addressEn: 'B269 Road 1' };

let seq = 0;
const nextId = (p: string) => ctx.id(`${p}_${++seq}`);

async function makeRelation(opts: { id: string; name: string; code: string | null }) {
  return prisma.relation.create({
    data: {
      id: opts.id,
      code: opts.code,
      name: opts.name,
      chineseName: null,
      category: 'Customer',
      type: 'Customer',
      isOrganization: true,
      contactInfo: '',
      // 本树 prisma client 软链到另一棵树（B209），生成物里没有 A1 的 @default(now())
      createdAt: new Date(),
      lastInteraction: 0n,
    },
  });
}

const ID_CODED = nextId('REL_CODED');
const ID_NOCODE = nextId('REL_NOCODE');
const ID_MISSING = 'TEST_B269_REL_MISSING';
const CODE_CODED = 'CUS-TESTB269-A';

beforeAll(async () => {
  await makeRelation({ id: ID_CODED, name: 'B269 Coded Co', code: CODE_CODED });
  await makeRelation({ id: ID_NOCODE, name: 'B269 NoCode Co', code: null });
});

const RESIDUAL_SPEC = [
  { key: 'rel', model: 'relation', run: () => prisma.relation.count({ where: { id: { startsWith: ctx.mark } } }) },
];

async function cleanup() {
  await prisma.relation.deleteMany({ where: { id: { startsWith: ctx.mark } } });
}

afterAll(async () => {
  await cleanup();
  const got = await safeResidualCounts(RESIDUAL_SPEC);
  expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
  expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本文件建的行没清干净`).toEqual({ rel: 0 });
  await prisma.$disconnect();
});

const htmlFor = async (relationId: string) => {
  const stmt = await getCustomerStatement(prisma, { customerRelationId: relationId });
  return renderStatementHtml(stmt, EXPORTER);
};

describe('B269·A4 预览（客户拿到那份纸）：不许出现内部 relation id', () => {
  it('① 有业务编码的客户 ⇒ 印编码，不印内部 id', async () => {
    const html = await htmlFor(ID_CODED);
    expect(html, '★ 病灶：Account 那一格原本恒印 data.customerRelationId').not.toContain(ID_CODED);
    expect(html).toContain(CODE_CODED);
  });

  it('② 档案没有业务编码 ⇒ 那一整行不出现（照 quotation/paymentRequest 既有那条规则）', async () => {
    const html = await htmlFor(ID_NOCODE);
    expect(html, '★ 病灶：缺编码时若无条件退回内部 id，客户会看到一串 REL-…').not.toContain(ID_NOCODE);
    expect(html).not.toContain('Account 账户');
  });

  it('③ 无票客户（名字靠回读档案）⇒ 抬头也不许退到内部 id', async () => {
    const html = await htmlFor(ID_CODED);
    const docNo = html.slice(html.indexOf('doc-no'), html.indexOf('Period 期间'));
    expect(docNo, '★ 病灶：抬头 doc-no 原本是 customerName || customerRelationId').not.toContain(ID_CODED);
    expect(docNo).toContain('B269 Coded Co');
  });

  it('★ 反面对照：传进来的 id 在档案里根本不存在 ⇒ 抬头与那一行都不许把它顶上去，不许凭空造编码', async () => {
    const html = await htmlFor(ID_MISSING);
    const docNo = html.slice(html.indexOf('doc-no'), html.indexOf('Period 期间'));
    expect(docNo, '★ 病灶：名字取不到时 doc-no 会退成 customerRelationId').not.toContain(ID_MISSING);
    expect(html, '★ 病灶：Account 那一格原本恒印 customerRelationId').not.toContain(ID_MISSING);
    expect(html).not.toContain('Account 账户');
  });
});

describe('B269·投递正文（智能体发出的对账邮件文本）：同一族落点', () => {
  it('④ 正文的客户行不许退到内部 id', async () => {
    const stmt = await getCustomerStatement(prisma, { customerRelationId: ID_NOCODE });
    const text = renderStatementEmailText({
      customerName: stmt.customerName,
      from: stmt.from,
      to: stmt.to,
      snapshot: stmt,
    });
    expect(text, '★ 病灶：`客户：${customerName ?? snapshot.customerRelationId}`').not.toContain(ID_NOCODE);
    expect(text).toContain('B269 NoCode Co');
  });

  it('★ 阳性对照+反面对照：档案不存在（名字取不到）⇒ 正文只许空位，不许把内部 id 顶上去', async () => {
    const stmt = await getCustomerStatement(prisma, { customerRelationId: ID_MISSING });
    expect(stmt.customerName).toBeNull();
    const text = renderStatementEmailText({
      customerName: stmt.customerName,
      from: stmt.from,
      to: stmt.to,
      snapshot: stmt,
    });
    expect(text, '★ 病灶：这一格原本 `?? snapshot.customerRelationId`').not.toContain(ID_MISSING);
  });
});
