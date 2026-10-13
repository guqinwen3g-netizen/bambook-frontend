import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { parseOrderPdf } from '../parseOrderPdf';
import { persistOrders } from '../persistOrders';
import { ParsedOrder } from '../types';

const DIR = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO';
const FIXTURES = [
  'PO#-4500159423-0001.pdf',
  'PO#-4500159154-0001.pdf',
  'PO#-4500159120-0001.pdf',
  'PO#-4500159027-0001.pdf',
  'PO#-4500158987-0001.pdf',
] as const;

const prisma = new PrismaClient();

async function loadFixtures(): Promise<ParsedOrder[]> {
  const orders: ParsedOrder[] = [];
  for (const f of FIXTURES) {
    const r = await parseOrderPdf(fs.readFileSync(`${DIR}/${f}`));
    if (!r.order) throw new Error(`fixture ${f} did not parse: ${r.error}`);
    orders.push(r.order);
  }
  return orders;
}

// Only wipe the 5 fixtures, not every pdf-import row — real migrated data
// (po_database.db → Postgres) shares the same source string.
const FIXTURE_PO_NUMBERS = [
  '4500159423',
  '4500159154',
  '4500159120',
  '4500159027',
  '4500158987',
];

async function wipeImported() {
  await prisma.orderLine.deleteMany({
    where: { order: { poNumber: { in: FIXTURE_PO_NUMBERS } } },
  });
  await prisma.order.deleteMany({
    where: { poNumber: { in: FIXTURE_PO_NUMBERS } },
  });
}

describe('persistOrders — Peerless 5 fixtures end-to-end', () => {
  beforeAll(async () => {
    // Fail fast and visibly if the env points at the cloud DB by accident.
    const url = process.env.DATABASE_URL ?? '';
    if (!/localhost|127\.0\.0\.1/.test(url)) {
      throw new Error(
        `Refusing to run persistence tests: DATABASE_URL is not localhost (got "${url.slice(0, 40)}…")`,
      );
    }
  });

  beforeEach(wipeImported);
  afterAll(async () => {
    await wipeImported();
    await prisma.$disconnect();
  });

  it('creates one Order + N OrderLine rows per PO on first import', async () => {
    const parsed = await loadFixtures();
    const results = await persistOrders(prisma, parsed);

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.action === 'created')).toBe(true);
    for (const r of results) {
      expect(r.linesSaved).toBeGreaterThan(0);
    }

    const orderRows = await prisma.order.findMany({
      where: { poNumber: { in: FIXTURE_PO_NUMBERS } },
      include: { lines: true },
    });
    expect(orderRows).toHaveLength(5);

    const byPo = new Map(orderRows.map((o) => [o.poNumber, o]));
    expect(byPo.get('4500159423')?.lines.length).toBe(4);
    expect(byPo.get('4500159154')?.lines.length).toBe(3);
    expect(byPo.get('4500159120')?.lines.length).toBe(1);
    expect(byPo.get('4500159027')?.lines.length).toBe(3);
    expect(byPo.get('4500158987')?.lines.length).toBe(2);

    // Header fields propagated.
    const sample = byPo.get('4500159423')!;
    expect(sample.customerCode).toBe('peerless');
    expect(sample.customer).toBe('Peerless');
    // 业务要求：订单主交期显示 Exmill（出厂日期），不是 delivery date。
    expect(sample.dueDate).toBe('2026/07/01');
    expect(sample.currency).toBeTruthy();
    // totalActual is stored as Decimal(18,4) — convert to Number for comparison.
    expect(Number(sample.totalActual)).toBeGreaterThan(0);
    expect(sample.source).toBe('pdf-import');
    expect(sample.id).toBe('PO-4500159423');
  });

  it('re-importing the same PDFs is idempotent (no duplicates, lines refreshed)', async () => {
    const parsed = await loadFixtures();

    const first = await persistOrders(prisma, parsed);
    expect(first.every((r) => r.action === 'created')).toBe(true);

    const second = await persistOrders(prisma, parsed);
    expect(second).toHaveLength(5);
    expect(second.every((r) => r.action === 'updated')).toBe(true);

    const totalOrders = await prisma.order.count({
      where: { poNumber: { in: FIXTURE_PO_NUMBERS } },
    });
    const totalLines = await prisma.orderLine.count({
      where: { order: { poNumber: { in: FIXTURE_PO_NUMBERS } } },
    });
    // Total lines for the 5 fixtures is 4+3+1+3+2 = 13.
    expect(totalOrders).toBe(5);
    expect(totalLines).toBe(13);
  });

  it('overwrite refreshes line set when source PDF has fewer lines', async () => {
    const parsed = await loadFixtures();
    await persistOrders(prisma, parsed);

    // Take the 4-line PO and pretend the next import has only 1 line.
    const target = parsed.find((p) => p.poNumber === '4500159423')!;
    const trimmed: ParsedOrder = { ...target, lines: target.lines.slice(0, 1) };

    const r = await persistOrders(prisma, [trimmed]);
    expect(r[0].action).toBe('updated');
    expect(r[0].linesSaved).toBe(1);

    const after = await prisma.orderLine.count({
      where: { orderId: 'PO-4500159423' },
    });
    expect(after).toBe(1);
  });

  it('overwriteExisting=false leaves existing PO untouched', async () => {
    const parsed = await loadFixtures();
    const first = await persistOrders(prisma, [parsed[0]]);
    expect(first[0].action).toBe('created');

    const trimmed = { ...parsed[0], lines: [] as typeof parsed[0]['lines'] };
    const r = await persistOrders(prisma, [trimmed], { overwriteExisting: false });
    expect(r[0].action).toBe('updated');
    expect(r[0].linesSaved).toBe(0);

    const lines = await prisma.orderLine.count({
      where: { orderId: first[0].orderId },
    });
    expect(lines).toBeGreaterThan(0);
  });
});
