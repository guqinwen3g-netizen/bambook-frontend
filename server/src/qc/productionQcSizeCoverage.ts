import { normalizeGarmentSizeBreakdown } from '../orders/garmentSizeBreakdown';
import { resolveCurrentProductionBatchFacts } from '../production/productionBatchFacts';
import { QcReportError } from './qcReportAuthority';
import { reportContentFingerprint } from './qcReportReadProjection';
import { resolveQcCoverage } from './qcPhysicalCoverage';
import { readProductionQcIssueProjection } from './productionQcIssueService';
import { isGarmentChainOrder } from './qcChainService';

export interface ProductionSizeCheck {
  size: string;
  inspectedUnits: number;
  result: 'pass' | 'fail';
  evidence: string[];
  note?: string;
}
export interface ProductionSizeChecks {
  schemaVersion: 1;
  actualSizes: string[];
  scopeComplete: boolean;
  basis: string;
  checks: ProductionSizeCheck[];
}
const invalid = (message: string): never => { throw new QcReportError('VALIDATION_FAILED', message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return invalid(`${label}须填写真实文本。`);
  return value.trim();
}
/** Only explicit QC observations are accepted. Plans and quantity tolerance
 * deliberately have no input slot in these quality facts. */
export function normalizeProductionSizeChecks(value: unknown): ProductionSizeChecks | null {
  if (value == null) return null;
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'actualSizes', 'scopeComplete', 'basis', 'checks'].includes(key))
    || value.schemaVersion !== 1 || typeof value.scopeComplete !== 'boolean'
    || !Array.isArray(value.actualSizes) || !value.actualSizes.length || value.actualSizes.length > 200
    || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 200) return invalid('生产尺码检验须明确实际尺码、范围完整性、依据和本次实测记录。');
  const actualSizes = value.actualSizes.map(size => text(size, '实际生产尺码', 80)).sort();
  if (new Set(actualSizes).size !== actualSizes.length) return invalid('实际生产尺码不能重复。');
  const seen = new Set<string>();
  const checks = value.checks.map((row): ProductionSizeCheck => {
    if (!object(row) || Object.keys(row).some(key => !['size', 'inspectedUnits', 'result', 'evidence', 'note'].includes(key))) return invalid('尺码检验记录包含未知字段。');
    const size = text(row.size, '已检尺码', 80);
    if (!actualSizes.includes(size) || seen.has(size)) return invalid('本次已检尺码须属于明确的实际生产尺码且不能重复。');
    seen.add(size);
    if (typeof row.inspectedUnits !== 'number' || !Number.isSafeInteger(row.inspectedUnits) || row.inspectedUnits < 1 || row.inspectedUnits > 2147483647) return invalid(`${size} 的实际检验件数须为正整数。`);
    if (row.result !== 'pass' && row.result !== 'fail') return invalid(`${size} 须明确 QC pass 或 fail。`);
    if (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > 50) return invalid(`${size} 须附实际检验的图片、文档或证据引用。`);
    const evidence = row.evidence.map(item => text(item, `${size} 检验证据`));
    if (new Set(evidence).size !== evidence.length) return invalid(`${size} 的检验证据不能重复。`);
    return { size, inspectedUnits: row.inspectedUnits, result: row.result, evidence,
      ...(row.note == null ? {} : { note: text(row.note, `${size} 检验说明`) }) };
  }).sort((a, b) => a.size.localeCompare(b.size));
  return { schemaVersion: 1, actualSizes, scopeComplete: value.scopeComplete, basis: text(value.basis, '实际生产尺码依据'), checks };
}

type SizeReport = { id: string; createdAt: string | number | bigint; result: string | null; productionSizeChecks?: unknown };
export interface ProductionQcSizeCoverage {
  applicable: boolean;
  available: boolean;
  satisfied: boolean;
  scopeComplete: boolean;
  actualSizes: string[];
  missingSizes: string[];
  failedSizes: string[];
  checks: Array<ProductionSizeCheck & { reportId: string }>;
  reason: string | null;
}
/** Caller supplies only exact current version/content-verified reports. This
 * projection accumulates visits, never fabricates observations from a plan. */
export function projectProductionQcSizeCoverage(input: { reports: SizeReport[]; completionSizes?: Record<string, number> | null }): ProductionQcSizeCoverage {
  const reports = [...input.reports].sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || a.id.localeCompare(b.id));
  const actual = new Set<string>(), latest = new Map<string, ProductionSizeCheck & { reportId: string }>();
  let complete: ProductionSizeChecks | null = null;
  for (const report of reports) {
    const facts = normalizeProductionSizeChecks(report.productionSizeChecks);
    if (!facts) continue;
    facts.actualSizes.forEach(size => actual.add(size));
    if (facts.scopeComplete) complete = facts;
    for (const check of facts.checks) latest.set(check.size, { ...check, reportId: report.id });
  }
  const completionSizes = input.completionSizes == null ? null : Object.keys(input.completionSizes).filter(size => input.completionSizes![size] > 0).sort();
  completionSizes?.forEach(size => actual.add(size));
  const actualSizes = [...actual].sort();
  let scopeComplete = !!complete && actualSizes.every(size => complete!.actualSizes.includes(size));
  if (completionSizes && (actualSizes.length !== completionSizes.length || actualSizes.some((size, index) => size !== completionSizes[index]))) scopeComplete = false;
  const missingSizes = actualSizes.filter(size => !latest.has(size));
  const failedSizes = actualSizes.filter(size => latest.get(size)?.result === 'fail');
  const satisfied = scopeComplete && actualSizes.length > 0 && !missingSizes.length && !failedSizes.length;
  const reason = !scopeComplete ? '实际生产尺码完整范围待 QC 明确核对，计划尺码不能代替实际检验。'
    : missingSizes.length ? `实际生产尺码缺少有效检验：${missingSizes.join('、')}。`
      : failedSizes.length ? `实际生产尺码尚未通过 QC：${failedSizes.join('、')}。` : null;
  return { applicable: true, available: true, satisfied, scopeComplete, actualSizes, missingSizes, failedSizes,
    checks: [...latest.values()].sort((a, b) => a.size.localeCompare(b.size)), reason };
}

export function assertProductionSizeRetest(failedValue: unknown, retestValue: unknown, garment: boolean) {
  if (!garment) return;
  const failed = normalizeProductionSizeChecks(failedValue), retest = normalizeProductionSizeChecks(retestValue);
  if (!retest) return invalid('成衣生产问题须有实际逐尺码复验和证据，不能用空报告解除。');
  if (retest.checks.some(row => row.result !== 'pass')) return invalid('仍有未通过的尺码检验，不能作为 pass 复验解除问题。');
  if (!failed && !retest.scopeComplete) return invalid('原失败报告未记录准确失败尺码，须明确完整实际生产尺码并逐码复验。');
  const failedChecks = failed?.checks.filter(row => row.result === 'fail') ?? [];
  const required = failedChecks.length ? failedChecks.map(row => row.size) : failed?.actualSizes ?? retest.actualSizes;
  const missing = required.filter(size => !retest.checks.some(row => row.size === size && row.result === 'pass'));
  if (missing.length) return invalid(`本次复验尚未覆盖原问题尺码：${missing.join('、')}。`);
}

/** Neutral source locks are owned by the caller. An unavailable native fact
 * blocks quality release; it is never translated to an empty size set. */
export async function readProductionQcSizeCoverage(tx: any, params: { orderId: string; productionBatchId: string; expectedBatchRevision?: number }): Promise<ProductionQcSizeCoverage> {
  const scope = await resolveQcCoverage(tx, params.orderId, { scopeType: 'production_batch', ...params });
  const batch = await tx.productionBatch.findUnique({ where: { id: params.productionBatchId } });
  const facts = await resolveCurrentProductionBatchFacts(tx, batch);
  if (!isGarmentChainOrder(facts.order)) return {
    applicable: false, available: true, satisfied: true, scopeComplete: false, actualSizes: [], missingSizes: [], failedSizes: [], checks: [], reason: null,
  };
  const unavailable = (reason: string): ProductionQcSizeCoverage => ({ applicable: true, available: false, satisfied: false,
    scopeComplete: false, actualSizes: [], missingSizes: [], failedSizes: [], checks: [], reason });
  if (!tx.inspectionReport?.findMany || !tx.productionBatchCompletion?.findUnique) return unavailable('生产尺码检验或完工事实暂不可读取。');
  const rows: any[] = await tx.inspectionReport.findMany({ where: { orderId: params.orderId, scopeType: 'production_batch',
    productionBatchId: batch.id, productionBatchRevision: batch.revision, scopeFingerprint: scope.scopeFingerprint },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const valid: SizeReport[] = [];
  for (const report of rows) {
    if (report.orderId !== params.orderId || report.productionBatchId !== batch.id || report.productionBatchRevision !== batch.revision
      || report.scopeType !== 'production_batch' || report.scopeFingerprint !== scope.scopeFingerprint) continue;
    if (report.productionSizeChecks == null) continue;
    if (!report.contentFingerprint || report.contentFingerprint !== await reportContentFingerprint(tx, report)) return unavailable('逐尺码检验内容或证据已变化，须重新核验。');
    try { normalizeProductionSizeChecks(report.productionSizeChecks); } catch { return unavailable('生产尺码检验记录格式不完整。'); }
    valid.push(report);
  }
  const completion = await tx.productionBatchCompletion.findUnique({ where: {
    productionBatchId_productionBatchRevision: { productionBatchId: batch.id, productionBatchRevision: batch.revision },
  } });
  let completionSizes: Record<string, number> | null = null;
  if (completion) {
    if (completion.orderId !== params.orderId || completion.orderLineId !== facts.line.id || completion.unit !== facts.line.unit
      || completion.lineFingerprint !== facts.lineFingerprint) return unavailable('实际完工依据与当前生产分支不一致。');
    if (completion.actualSizeBreakdown != null) {
      try { completionSizes = normalizeGarmentSizeBreakdown(completion.actualSizeBreakdown, String(completion.actualQuantity)); }
      catch { return unavailable('逐尺码实际完工数量无效，不能推断生产尺码。'); }
      if (!completionSizes) return unavailable('逐尺码实际完工数量为空，不能推断生产尺码。');
    }
  }
  return projectProductionQcSizeCoverage({ reports: valid, completionSizes });
}

/** Shared production/shipment consumer. A QC retest is distinct from the
 * business decision to continue; neither a complete matrix nor a pass alone
 * may silently clear an open or waiting-for-business issue. */
export async function readProductionQcReleaseCoverage(tx: any, params: { orderId: string; productionBatchId: string; expectedBatchRevision?: number }) {
  const sizeCoverage = await readProductionQcSizeCoverage(tx, params);
  const batch = await tx.productionBatch.findUnique({ where: { id: params.productionBatchId } });
  const issues = await readProductionQcIssueProjection(tx, { orderId: params.orderId, orderLineId: batch.orderLineId,
    productionBatchId: batch.id, productionBatchRevision: batch.revision });
  const failureReasons = [
    ...(!sizeCoverage.satisfied ? [sizeCoverage.reason || '实际生产尺码质量覆盖未完成。'] : []),
    ...(!issues.available ? [issues.error || '生产 QC 问题状态不可读取。'] : []),
    ...issues.issues.filter(issue => issue.status !== 'resumed').map(issue => issue.status === 'waiting_business_resume'
      ? `生产 QC 问题 ${issue.issueId} 复验已通过，等待业务明确恢复。`
      : `生产 QC 问题 ${issue.issueId} 尚未解除，当前工厂分支暂停。`),
  ];
  return { satisfied: !failureReasons.length, sizeCoverage, productionQcIssues: issues, failureReasons };
}
