/**
 * statementNameFallbackB266.test.ts — 台账 §9 B266：对账单在"该对象当期没有单据"时，
 * 报告里的对象名不许是 null（null 会一路传到导出文件名，退化成内部 relation id）
 *
 * 判据取的是屏面已有的那条真源（`components/finance/RelationPickerCombobox.tsx` 的
 * `relationPickerDisplayName = chineseName || name`），不另立口径：
 *   票面快照名优先（有票时行为一字不变）→ 归属行名 → **回读 Relation 的显示名** → 才允许 null
 *
 * ★ 阳性对照：①有票时仍取票面名（证明我没把优先级改坏）；②关系不存在时不许凭空造名。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { getCustomerStatement, getSupplierStatement } from '../reportService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_B266_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;

let seq = 0;
const nextId = (p: string) => ctx.id(`${p}_${++seq}`);

async function makeRelation(opts: { id: string; name: string; chineseName?: string | null }) {
  return prisma.relation.create({
    data: {
      id: opts.id,
      name: opts.name,
      chineseName: opts.chineseName ?? null,
      category: 'Customer',
      type: 'Customer',
      isOrganization: true,
      contactInfo: '',
      // ★ 这里必须显式给 createdAt：本树的 prisma client 是从另一棵树的 node_modules 软链来的
      //   （B209 那条跨树漂移），那份生成物里没有 A1 补列的 @default(now()) ⇒ 不写就报缺字段。
      createdAt: new Date(),
      lastInteraction: 0n,
    },
  });
}

const relEmpty = () => nextId('REL_EMPTY');
const relWithInvoice = () => nextId('REL_INVOICED');
const relSupplier = () => nextId('REL_SUPPLIER');

let ID_EMPTY = '';
let ID_INVOICED = '';
let ID_SUPPLIER = '';
const createdInvoiceIds: string[] = [];

beforeAll(async () => {
  ID_EMPTY = relEmpty();
  ID_INVOICED = relWithInvoice();
  ID_SUPPLIER = relSupplier();
  await makeRelation({ id: ID_EMPTY, name: 'B266 Textile Ltd', chineseName: '测试恒溢织造（B266）' });
  await makeRelation({ id: ID_INVOICED, name: 'B266 Invoice Snapshot Co', chineseName: '测试票面优先（B266）' });
  await makeRelation({ id: ID_SUPPLIER, name: 'B266 Mill Supply', chineseName: '测试印染厂（B266）' });
  // 有票的那位：票面快照名与档案显示名**故意不同**，用来证明优先级没被改坏
  const invId = nextId('INV');
  createdInvoiceIds.push(invId);
  await prisma.invoice.create({
    // 字段形状照抄同目录那份真库测试（本树的 prisma client 软链到另一棵树的生成物 ⇒ 时间列是 BigInt 且必填）
    data: {
      id: invId, invoiceNumber: `TEST-B266-${++seq}`,
      type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal('1000'),
      currency: 'USD', issueDate: '2026-09-01', dueDate: '2026-10-01',
      customerRelationId: ID_INVOICED, customerName: '票面名-B266',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });

});

const RESIDUAL_SPEC = [
  { key: 'rel', model: 'relation', run: () => prisma.relation.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'inv', model: 'invoice', run: () => prisma.invoice.count({ where: { id: { startsWith: ctx.mark } } }) },
];

async function cleanup() {
  await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: { startsWith: ctx.mark } } });
  await prisma.invoice.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.relation.deleteMany({ where: { id: { startsWith: ctx.mark } } });
}

afterAll(async () => {
  await cleanup();
  const got = await safeResidualCounts(RESIDUAL_SPEC);
  expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
  expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本文件建的行没清干净`).toEqual({ rel: 0, inv: 0 });
  await prisma.$disconnect();
});

describe('B266：当期没有单据时，对账单的对象名回读档案显示名（与屏面同一规则）', () => {
  it('① 客户对账单：无票无款 ⇒ 名字取 Relation 的 chineseName，不是 null', async () => {
    const stmt = await getCustomerStatement(prisma, { customerRelationId: ID_EMPTY });
    expect(stmt.customerName, '★ 本条即 B266 的病灶：名字只从发票快照取 ⇒ 没票就没名').toBe('测试恒溢织造（B266）');
  });

  it('② 供应商对账单：同族同修 ⇒ 名字不许是 null', async () => {
    const stmt = await getSupplierStatement(prisma, { supplierRelationId: ID_SUPPLIER });
    expect(stmt.supplierName).toBe('测试印染厂（B266）');
  });

  it('★ 阳性对照：有票时仍取**票面快照名**（优先级不许被我改坏）', async () => {
    const stmt = await getCustomerStatement(prisma, { customerRelationId: ID_INVOICED });
    expect(stmt.customerName).toBe('票面名-B266');
  });

  it('★ 反面对照：关系根本不存在 ⇒ 只许 null，不许凭空造一个名字', async () => {
    const stmt = await getCustomerStatement(prisma, { customerRelationId: 'TEST_B266_DOES_NOT_EXIST' });
    expect(stmt.customerName).toBeNull();
  });

  it('③ 档案只有英文名（chineseName 为空）⇒ 退到 name，与屏面那条规则一致', async () => {
    const id = nextId('REL_NAMEONLY');
    await makeRelation({ id, name: 'B266 Name Only Co' });
    const stmt = await getCustomerStatement(prisma, { customerRelationId: id });
    expect(stmt.customerName).toBe('B266 Name Only Co');
  });
});
