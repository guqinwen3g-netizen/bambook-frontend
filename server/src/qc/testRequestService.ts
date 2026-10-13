/**
 * testRequestService.ts — REQ2-04 第三方测试管理：测试委托（订单级合规证据链）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/QcWorkbench-QC质检中心/第三方测试管理.md
 *
 * 质量域三轨分工（避免双轨）：
 *   - qcChainService 样品评审 = 过程质量控制（既有）
 *   - InspectionReport = 出货前实物验货 AQL（既有）
 *   - TestRequest（本模块）= 第三方实验室送样检测（理化/合规指标）
 *
 * 核心闭环：
 *   登记委托（项目/机构/送样日）→ 报告 PDF 归档 → 结论 pending→pass/fail（终态）
 *   → fail 强制挂整改（failItems 非空 + ≥1 条 open 整改，服务端 400 门禁）
 *   → 整改 open→closed 闭环
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

/** 测试项目枚举（面料外贸常见理化/合规检测项） */
export const TEST_ITEMS = [
  'color_fastness', // 色牢度
  'shrinkage',      // 缩水率
  'tensile',        // 强力
  'ph',             // pH 值
  'formaldehyde',   // 甲醛
  'azo',            // 偶氮（禁用芳香胺）
  'gsm',            // 克重实测
  'width',          // 幅宽实测
  'other',          // 其他
] as const;

export const TEST_ITEM_LABELS: Record<string, string> = {
  color_fastness: '色牢度',
  shrinkage: '缩水率',
  tensile: '强力',
  ph: 'pH 值',
  formaldehyde: '甲醛',
  azo: '偶氮',
  gsm: '克重',
  width: '幅宽',
  other: '其他',
};

/** 委托机构枚举 */
export const TEST_AGENCIES = ['sgs', 'its', 'bv', 'other'] as const;
export const TEST_AGENCY_LABELS: Record<string, string> = { sgs: 'SGS', its: 'ITS', bv: 'BV', other: '其他机构' };

export const TEST_RESULTS = ['pending', 'pass', 'fail'] as const;
export const TEST_RESULT_LABELS: Record<string, string> = { pending: '待报告', pass: '通过', fail: '不合格' };

/** 判别联合（与 colorBatchService 范式一致） */
export type TestRequestResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): TestRequestResult<never> =>
  ({ ok: false, error: { code, message, status } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertYmd(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!DATE_RE.test(s)) throw Object.assign(new Error(`${field} 须为 YYYY-MM-DD`), { code: 'INVALID_DATE' });
  return s;
}

/** 测试项目数组清洗：枚举校验 + 去重 + 非空 */
function sanitizeTestItems(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw Object.assign(new Error('testItems 必填且至少一项'), { code: 'TEST_ITEMS_REQUIRED' });
  }
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).trim();
    if (!s) continue;
    if (!(TEST_ITEMS as readonly string[]).includes(s)) {
      throw Object.assign(new Error(`非法测试项目：${s}（允许 ${TEST_ITEMS.join(' | ')}）`), { code: 'INVALID_TEST_ITEM' });
    }
    if (!out.includes(s)) out.push(s);
  }
  if (out.length === 0) throw Object.assign(new Error('testItems 必填且至少一项'), { code: 'TEST_ITEMS_REQUIRED' });
  return out;
}

function sanitizeAgency(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!(TEST_AGENCIES as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`agency 须为 ${TEST_AGENCIES.join(' | ')}`), { code: 'INVALID_AGENCY' });
  }
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createTestRequestService(prisma: PrismaClient) {
  const db = prisma as any;

  async function nextTrNo(): Promise<string> {
    const prefix = `TR-${todayLocalKey().replace(/-/g, '')}`;
    const count = await db.testRequest.count({ where: { trNo: { startsWith: prefix } } });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** 宿主订单存在性（fail-closed） */
  async function assertOrder(orderId: string): Promise<void> {
    const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
    if (!order) throw Object.assign(new Error(`订单 ${orderId} 不存在`), { code: 'ORDER_NOT_FOUND' });
  }

  // ── 登记委托 ──
  async function createTestRequest(input: {
    orderId: string;
    testItems: unknown;
    agency: unknown;
    sentDate?: unknown;
    expectedDate?: unknown;
    notes?: unknown;
  }): Promise<TestRequestResult<{ request: any }>> {
    try {
      const orderId = String(input.orderId ?? '').trim();
      if (!orderId) return fail('ORDER_REQUIRED', 'orderId 必填');
      await assertOrder(orderId);
      const testItems = sanitizeTestItems(input.testItems);
      const agency = sanitizeAgency(input.agency);
      const sentDate = assertYmd(input.sentDate, 'sentDate');
      const expectedDate = assertYmd(input.expectedDate, 'expectedDate');

      const ts = Date.now();
      const created = await db.testRequest.create({
        data: {
          id: `TR__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          trNo: await nextTrNo(),
          orderId,
          testItems,
          agency,
          sentDate,
          expectedDate,
          notes: input.notes != null ? String(input.notes).trim() || null : null,
          result: 'pending',
          failItems: [],
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
        },
      });
      logger.info('[TestRequest] created', { id: created.id, trNo: created.trNo, orderId, agency });
      return { ok: true, data: { request: created } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'ORDER_NOT_FOUND' ? 404 : 400);
      logger.error('[TestRequest] create failed', { error: e?.message });
      return fail('CREATE_FAILED', e?.message || '登记失败');
    }
  }

  // ── 订单维度全景（3 击数据源：含附件 + 整改 + summary） ──
  async function listTestRequests(orderId: string): Promise<TestRequestResult<{ items: any[]; summary: any }>> {
    const oid = String(orderId ?? '').trim();
    if (!oid) return fail('ORDER_REQUIRED', 'orderId 必填');
    const items = await db.testRequest.findMany({
      where: { orderId: oid, deletedAt: null },
      include: {
        files: { where: { deletedAt: null }, orderBy: { uploadedAt: 'desc' } },
        correctiveActions: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const summary = {
      total: items.length,
      pass: items.filter((r: any) => r.result === 'pass').length,
      fail: items.filter((r: any) => r.result === 'fail').length,
      pending: items.filter((r: any) => r.result === 'pending').length,
      openCorrectiveActions: items.reduce(
        (n: number, r: any) => n + r.correctiveActions.filter((c: any) => c.status === 'open').length, 0),
    };
    return { ok: true, data: { items, summary } };
  }

  // ── 结论登记 / 委托修正（fail 门禁：failItems 非空 ⊆ testItems + ≥1 open 整改） ──
  async function updateTestRequest(id: string, patch: {
    result?: unknown;
    reportNo?: unknown;
    reportDate?: unknown;
    failItems?: unknown;
    notes?: unknown;
    sentDate?: unknown;
    expectedDate?: unknown;
    correctiveAction?: { failItem?: unknown; action?: unknown; owner?: unknown; dueDate?: unknown };
  }): Promise<TestRequestResult<{ request: any }>> {
    try {
      const existing = await db.testRequest.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `测试委托 ${id} 不存在`, 404);

      const data: any = { updatedAt: BigInt(Date.now()) };

      // 委托内容修正（pending 态限定）
      const contentKeys = ['sentDate', 'expectedDate', 'notes'] as const;
      if (contentKeys.some(k => patch[k] !== undefined)) {
        if (existing.result !== 'pending') {
          return fail('RESULT_FINAL', '结论已终态（pass/fail），委托内容不可修改；重测请新建委托单', 409);
        }
        if (patch.sentDate !== undefined) data.sentDate = assertYmd(patch.sentDate, 'sentDate');
        if (patch.expectedDate !== undefined) data.expectedDate = assertYmd(patch.expectedDate, 'expectedDate');
        if (patch.notes !== undefined) data.notes = String(patch.notes ?? '').trim() || null;
      }

      // 报告元数据（任一终态可补登）
      if (patch.reportNo !== undefined) data.reportNo = String(patch.reportNo ?? '').trim() || null;
      if (patch.reportDate !== undefined) data.reportDate = assertYmd(patch.reportDate, 'reportDate');

      // 结论状态机：pending → pass/fail 单向
      let correctiveActionData: { failItem: string; action: string; owner: string | null; dueDate: string | null } | null = null;
      if (patch.result !== undefined && patch.result !== null && patch.result !== '') {
        const result = String(patch.result);
        if (!(TEST_RESULTS as readonly string[]).includes(result)) {
          return fail('INVALID_RESULT', `result 须为 ${TEST_RESULTS.join(' | ')}`);
        }
        if (result === existing.result) {
          return fail('RESULT_UNCHANGED', `结论已是 ${result}，无需重复登记`);
        }
        if (existing.result !== 'pending') {
          return fail('RESULT_FINAL', '结论已终态，不可回退；重测请新建委托单', 409);
        }

        if (result === 'fail') {
          // 失败项校验：非空且 ⊆ testItems
          const failItems = Array.isArray(patch.failItems)
            ? [...new Set((patch.failItems as unknown[]).map(String).map(s => s.trim()).filter(Boolean))]
            : [];
          if (failItems.length === 0) return fail('FAIL_ITEMS_REQUIRED', 'fail 结论必须登记失败项（failItems）');
          const invalid = failItems.filter(f => !(existing.testItems as string[]).includes(f));
          if (invalid.length > 0) return fail('INVALID_FAIL_ITEM', `失败项不在委托项目内：${invalid.join(' | ')}`);
          data.failItems = failItems;

          // 整改门禁：同步传入一条 或 已存在 open 整改（100% 跟踪闭环验收锚点）
          const openCount = await db.testCorrectiveAction.count({
            where: { testRequestId: id, status: 'open' },
          });
          if (patch.correctiveAction) {
            const ca = patch.correctiveAction;
            const failItem = String(ca.failItem ?? '').trim();
            const action = String(ca.action ?? '').trim();
            if (!failItem) return fail('CA_FAIL_ITEM_REQUIRED', '整改记录必须挂失败项 failItem');
            if (!failItems.includes(failItem)) return fail('INVALID_CA_FAIL_ITEM', `整改挂载的失败项 ${failItem} 不在本次登记的 failItems 内`);
            if (!action) return fail('CA_ACTION_REQUIRED', '整改措施 action 必填');
            correctiveActionData = {
              failItem,
              action,
              owner: ca.owner != null ? String(ca.owner).trim() || null : null,
              dueDate: assertYmd(ca.dueDate, 'dueDate'),
            };
          } else if (openCount === 0) {
            return fail('CA_REQUIRED', 'fail 结论必须同步登记整改措施（correctiveAction）或已有未闭环整改记录');
          }
          data.result = 'fail';
        } else {
          // pass：无失败项
          data.result = 'pass';
          data.failItems = [];
        }
      }

      const request = await db.testRequest.update({ where: { id }, data });

      // 整改记录同步创建（结论落库后追加，同 id 事务外 best-effort 由调用方补偿——
      // 简化：创建失败时结论已落，补救通道为 POST corrective-actions 追加）
      if (correctiveActionData) {
        const ts = Date.now();
        await db.testCorrectiveAction.create({
          data: {
            id: `TCA__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            testRequestId: id,
            ...correctiveActionData,
            status: 'open',
            createdAt: BigInt(ts),
            updatedAt: BigInt(ts),
          },
        });
      }

      logger.info('[TestRequest] updated', { id, result: request.result, actorPatch: Object.keys(data) });
      return { ok: true, data: { request } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'NOT_FOUND' ? 404 : 400);
      logger.error('[TestRequest] update failed', { error: e?.message });
      return fail('UPDATE_FAILED', e?.message || '更新失败');
    }
  }

  // ── 软删（仅 pending；终态单归档保留） ──
  async function deleteTestRequest(id: string): Promise<TestRequestResult<{ id: string }>> {
    const existing = await db.testRequest.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return fail('NOT_FOUND', `测试委托 ${id} 不存在`, 404);
    if (existing.result !== 'pending') {
      return fail('RESULT_FINAL', '已出结论的委托单归档保留，不可删除', 409);
    }
    await db.testRequest.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
    logger.info('[TestRequest] soft-deleted', { id });
    return { ok: true, data: { id } };
  }

  // ── 报告 PDF 附件登记（route 层 multer 落盘后调用） ──
  async function attachFiles(id: string, files: Array<{ filePath: string; fileName: string; mimeType: string; fileSize: number }>)
    : Promise<TestRequestResult<{ files: any[] }>> {
    if (!Array.isArray(files) || files.length === 0) return fail('NO_FILES', '未收到文件');
    const existing = await db.testRequest.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return fail('NOT_FOUND', `测试委托 ${id} 不存在`, 404);
    const ts = Date.now();
    const created: any[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      created.push(await db.testReportFile.create({
        data: {
          id: `TRF__${ts.toString(36).toUpperCase()}${i}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
          testRequestId: id,
          filePath: f.filePath,
          fileName: f.fileName,
          mimeType: f.mimeType,
          fileSize: f.fileSize,
          uploadedAt: BigInt(ts),
        },
      }));
    }
    await db.testRequest.update({ where: { id }, data: { updatedAt: BigInt(ts) } });
    logger.info('[TestRequest] files attached', { id, count: created.length });
    return { ok: true, data: { files: created } };
  }

  // ── 附件软删 ──
  async function deleteFile(fileId: string): Promise<TestRequestResult<{ fileId: string }>> {
    const existing = await db.testReportFile.findFirst({ where: { id: fileId, deletedAt: null } });
    if (!existing) return fail('FILE_NOT_FOUND', `附件 ${fileId} 不存在`, 404);
    await db.testReportFile.update({ where: { id: fileId }, data: { deletedAt: BigInt(Date.now()) } });
    return { ok: true, data: { fileId } };
  }

  // ── 追加整改记录（fail 单） ──
  async function addCorrectiveAction(id: string, input: {
    failItem?: unknown; action?: unknown; owner?: unknown; dueDate?: unknown;
  }): Promise<TestRequestResult<{ correctiveAction: any }>> {
    try {
      const existing = await db.testRequest.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `测试委托 ${id} 不存在`, 404);
      if (existing.result !== 'fail') return fail('NOT_FAIL', '仅 fail 结论的委托单可追加整改记录', 409);
      const failItem = String(input.failItem ?? '').trim();
      if (!failItem) return fail('CA_FAIL_ITEM_REQUIRED', 'failItem 必填');
      if (!(existing.failItems as string[]).includes(failItem)) {
        return fail('INVALID_CA_FAIL_ITEM', `失败项 ${failItem} 不在该委托单登记的 failItems 内`);
      }
      const action = String(input.action ?? '').trim();
      if (!action) return fail('CA_ACTION_REQUIRED', '整改措施 action 必填');
      const ts = Date.now();
      const correctiveAction = await db.testCorrectiveAction.create({
        data: {
          id: `TCA__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          testRequestId: id,
          failItem,
          action,
          owner: input.owner != null ? String(input.owner).trim() || null : null,
          dueDate: assertYmd(input.dueDate, 'dueDate'),
          status: 'open',
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
        },
      });
      logger.info('[TestRequest] corrective action added', { id, failItem });
      return { ok: true, data: { correctiveAction } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[TestRequest] add corrective action failed', { error: e?.message });
      return fail('CA_CREATE_FAILED', e?.message || '整改登记失败');
    }
  }

  // ── 整改闭环（open→closed） ──
  async function closeCorrectiveAction(caId: string, closeNote?: unknown): Promise<TestRequestResult<{ correctiveAction: any }>> {
    const existing = await db.testCorrectiveAction.findUnique({ where: { id: caId } });
    if (!existing) return fail('CA_NOT_FOUND', `整改记录 ${caId} 不存在`, 404);
    if (existing.status !== 'open') return fail('CA_CLOSED', '该整改记录已闭环', 409);
    const ts = Date.now();
    const correctiveAction = await db.testCorrectiveAction.update({
      where: { id: caId },
      data: {
        status: 'closed',
        closedAt: BigInt(ts),
        closeNote: closeNote != null ? String(closeNote).trim() || null : null,
        updatedAt: BigInt(ts),
      },
    });
    logger.info('[TestRequest] corrective action closed', { caId });
    return { ok: true, data: { correctiveAction } };
  }

  return {
    createTestRequest,
    listTestRequests,
    updateTestRequest,
    deleteTestRequest,
    attachFiles,
    deleteFile,
    addCorrectiveAction,
    closeCorrectiveAction,
  };
}
