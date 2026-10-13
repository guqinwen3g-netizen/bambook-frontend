/**
 * 阶段 P3c — 历史报价导入服务（PRD 16.1 P2）
 *
 * 口径：
 *   - 仅导入关键字段：报价号 / 客户 / 金额 / 日期（历史归档数据，无行明细，totalAmount 直写）
 *   - 两阶段：mode=preview 只校验返回错误明细（不写库）；mode=commit 合法行导入
 *   - 幂等：quotationNumber 已存在（含软删，DB 级 @unique 占位）→ skipped，不覆盖既有业务数据
 *   - 客户匹配：customerName 精确匹配 Relation.name（未删除），匹配失败 → 行错误
 *   - 部分成功（PRD 16.2：合法行先行导入）；汇总写一条审计日志
 *
 * 前端职责：xlsx 解析 Excel → 行 JSON 数组传本服务（后端不处理文件格式）。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';

export interface HistoricalQuotationRow {
  quotationNumber?: string;
  customerName?: string;
  amount?: number | string;
  currency?: string;
  issueDate?: string;
  validUntil?: string;
  status?: string;
  salesperson?: string;
  notes?: string;
}

export interface ImportRowError {
  row: number; // 1-based（对齐 Excel 行号语义，不含表头）
  field: string;
  message: string;
}

export interface QuotationImportResult {
  mode: 'preview' | 'commit';
  total: number;
  valid: number;
  created: number;
  skipped: number;
  errors: ImportRowError[];
}

const VALID_STATUSES = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 2000;

const now = (): bigint => BigInt(Date.now());

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createQuotationImportService(prisma: PrismaClient) {
  const db = prisma as any;

  async function importHistoricalQuotations(
    rows: HistoricalQuotationRow[],
    mode: 'preview' | 'commit',
    actorId: string,
  ): Promise<QuotationImportResult> {
    if (!Array.isArray(rows)) throw new Error('rows 须为数组');
    if (rows.length === 0) throw new Error('导入数据为空');
    if (rows.length > MAX_ROWS) throw new Error(`单次导入不可超过 ${MAX_ROWS} 行`);

    // 预取客户名录（未删除），name → id 精确匹配
    const relations = await db.relation.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
    });
    const relationIdByName = new Map<string, string>();
    for (const r of relations) {
      if (!relationIdByName.has(r.name)) relationIdByName.set(r.name, r.id);
    }

    // 预取已存在报价号（含软删，DB @unique 占位）
    const numbers = rows.map(r => String(r?.quotationNumber ?? '').trim()).filter(Boolean);
    const existing = await db.quotation.findMany({
      where: { quotationNumber: { in: numbers } },
      select: { quotationNumber: true },
    });
    const existingNumbers = new Set(existing.map((q: any) => q.quotationNumber));

    const errors: ImportRowError[] = [];
    const seenInPayload = new Set<string>();
    interface Prepared {
      rowIndex: number;
      data: any;
    }
    const prepared: Prepared[] = [];
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowIndex = i + 1;
      const row = rows[i] ?? {};
      const rowErrors: ImportRowError[] = [];

      const quotationNumber = String(row.quotationNumber ?? '').trim();
      if (!quotationNumber) rowErrors.push({ row: rowIndex, field: 'quotationNumber', message: '报价号必填' });
      else if (existingNumbers.has(quotationNumber)) {
        skipped++;
        continue; // 幂等跳过，不算错误
      } else if (seenInPayload.has(quotationNumber)) {
        skipped++;
        continue; // 同批重复，取首行
      }

      const customerName = String(row.customerName ?? '').trim();
      let customerRelationId: string | null = null;
      if (!customerName) {
        rowErrors.push({ row: rowIndex, field: 'customerName', message: '客户名称必填' });
      } else {
        customerRelationId = relationIdByName.get(customerName) ?? null;
        if (!customerRelationId) rowErrors.push({ row: rowIndex, field: 'customerName', message: `客户 ${customerName} 无法匹配客户档案` });
      }

      const issueDate = String(row.issueDate ?? '').trim();
      if (!issueDate) rowErrors.push({ row: rowIndex, field: 'issueDate', message: '报价日期必填' });
      else if (!DATE_RE.test(issueDate)) rowErrors.push({ row: rowIndex, field: 'issueDate', message: '报价日期格式须为 YYYY-MM-DD' });

      const validUntil = String(row.validUntil ?? '').trim();
      if (validUntil && !DATE_RE.test(validUntil)) rowErrors.push({ row: rowIndex, field: 'validUntil', message: '有效期格式须为 YYYY-MM-DD' });

      let amount: number | null = null;
      if (row.amount !== undefined && row.amount !== null && String(row.amount).trim() !== '') {
        const parsed = Number(row.amount);
        if (!Number.isFinite(parsed) || parsed < 0) rowErrors.push({ row: rowIndex, field: 'amount', message: '金额须为非负数字' });
        else amount = parsed;
      }

      const status = String(row.status ?? '').trim() || 'Sent';
      if (!VALID_STATUSES.includes(status)) rowErrors.push({ row: rowIndex, field: 'status', message: `非法报价状态: ${status}` });

      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      seenInPayload.add(quotationNumber);
      prepared.push({
        rowIndex,
        data: {
          quotationNumber,
          status,
          currency: String(row.currency ?? '').trim() || 'USD',
          totalAmount: amount != null ? new Prisma.Decimal(amount) : new Prisma.Decimal(0),
          baseCurrency: 'CNY',
          customerRelationId,
          customerName,
          issueDate,
          validUntil: validUntil || null,
          salesperson: String(row.salesperson ?? '').trim() || null,
          notes: String(row.notes ?? '').trim() || null,
        },
      });
    }

    let created = 0;
    if (mode === 'commit' && prepared.length > 0) {
      const ts = now();
      for (const p of prepared) {
        try {
          await db.quotation.create({
            data: {
              id: generateId('QT'),
              ...p.data,
              createdAt: ts,
              updatedAt: ts,
            },
          });
          created++;
        } catch (e: any) {
          // 并发下报价号被抢占（P2002 唯一冲突）→ 归 skipped，其余异常记行错误
          if (e?.code === 'P2002') {
            skipped++;
          } else {
            errors.push({ row: p.rowIndex, field: '_row', message: String(e?.message ?? e) });
          }
        }
      }
      await db.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'QUOTATION_IMPORT',
          actorId,
          targetType: 'Quotation',
          targetId: null,
          detail: { total: rows.length, created, skipped, errorCount: errors.length },
        },
      });
      logger.info('[QuotationImport] committed', { total: rows.length, created, skipped, errors: errors.length, actorId });
    }

    return {
      mode,
      total: rows.length,
      valid: prepared.length,
      created,
      skipped,
      errors,
    };
  }

  return { importHistoricalQuotations };
}
