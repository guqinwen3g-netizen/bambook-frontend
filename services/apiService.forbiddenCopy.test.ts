/**
 * 走查·403 文案：权限被拦时屏面到底给不给人话（#59 的第二半）
 *
 * 一手依据（本批读齐，不是推测）：
 *   服务端 `permissionGuard.ts:128` 的 403 体是
 *     { error:'FORBIDDEN', message:'INSUFFICIENT_SCOPE: need one of [crm:write].' }
 *   而客户端 `services/apiService.ts` 的 requestJson 在 `!response.ok` 分支里
 *   把 serverMessage **原样**塞进抛出的 Error.message ⇒ 财务/业务在屏面上看到的是
 *   一行内部权限码，而不是"我少了什么、该找谁开通"。
 *   ★ 同一份文件里已经有正面先例：`exportEntityAuditLogsCsv`（:1247）对 403 给的是
 *   「当前角色无权限导出该条记录的变更史」⇒ 本件把同一条规则收到共用出口上。
 *
 * ⚠️ 刻意**保留权限码**（只把它包进可执行的一句话）：
 *   "内部码到底能不能上屏"是 §9 B286 那条待拍的口径，我不在这里替使用方决定；
 *   等拍期间用户至少要知道"缺哪一格、找谁"，这比现在的裸码只多不少。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { describeForbiddenHttpError, apiService } from './apiService';

const ENDPOINT = 'http://127.0.0.1:8090';

afterEach(() => vi.unstubAllGlobals());

describe('describeForbiddenHttpError（403 → 人话，其余状态不动）', () => {
  it('403 + 权限码 ⇒ 说清"缺权限 + 缺哪一格 + 找谁"，且权限码仍在句里', () => {
    const out = describeForbiddenHttpError(403, 'INSUFFICIENT_SCOPE: need one of [crm:write].');
    expect(out).toContain('当前账号没有这一步需要的权限');
    expect(out).toContain('crm:write');
    expect(out).toContain('管理员');
    expect(out).not.toContain('INSUFFICIENT_SCOPE');
  });

  it('★ 多个候选 scope 全部列出（不许只报第一个，否则用户照着求错权限）', () => {
    const out = describeForbiddenHttpError(403, 'INSUFFICIENT_SCOPE: need one of [orders:write, orders:delete].');
    expect(out).toContain('orders:write');
    expect(out).toContain('orders:delete');
  });

  it('403 + 中间件那句英文旧文案（Insufficient role.）也要翻成人话', () => {
    const out = describeForbiddenHttpError(403, 'Insufficient role.');
    expect(out).toContain('当前账号没有这一步需要的权限');
  });

  it('★ 后端已经给了人话 ⇒ 一个字不改（不许覆盖 DE-6 审批提示等既有解释）', () => {
    const human = '该操作已发起审批单 APR-2026-0928-001，请至审批中心处理';
    expect(describeForbiddenHttpError(403, human)).toBeNull();
  });

  it('非 403（400/404/500）不动文案，交回原有链路', () => {
    for (const st of [400, 401, 404, 409, 500]) {
      expect(describeForbiddenHttpError(st, 'INSUFFICIENT_SCOPE: need one of [x:write].')).toBeNull();
    }
  });

  it('★ 反面对照：只有裸码没有候选清单时也要给人话（不能因为解析不到就退回裸码）', () => {
    const out = describeForbiddenHttpError(403, 'INSUFFICIENT_SCOPE orders:write');
    expect(out).toContain('当前账号没有这一步需要的权限');
    expect(out).toContain('orders:write');
  });
});

/**
 * ★ 活路径证人：光测纯函数证不了"共用出口真的接上了"（本仓吃过教训：
 * 函数绿、调用点没接＝用户还是看裸码）。这里 stub 一枚 403 响应，
 * 走 `apiService` 那条真实请求链路，断言**抛给屏面的 Error.message 已是人话**，
 * 同时 status 仍在（调用方靠它区分 401/403，见 :428 那条注释的来历）。
 */
describe('requestJson 这条共用出口真的把 403 换成人话（活路径）', () => {
  it('403 裸权限码 → 抛出的 message 已是可执行的一句话，且 status=403 保留', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ error: 'FORBIDDEN', message: 'INSUFFICIENT_SCOPE: need one of [emails:read].' }),
    })));

    const err: any = await apiService.listEmailSignatures(undefined, ENDPOINT).then(() => null).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('当前账号没有这一步需要的权限');
    expect(err.message).toContain('emails:read');
    expect(err.message).not.toContain('INSUFFICIENT_SCOPE');
    expect(err.status).toBe(403);
  });

  it('★ 正面对照：后端给的是人话（含"已发起审批单"那类）时，链路不许改它', async () => {
    const human = '该单据需主管审批，已发起审批单，请至审批中心处理';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ error: 'FORBIDDEN', message: human }),
    })));
    const err: any = await apiService.listEmailSignatures(undefined, ENDPOINT).then(() => null).catch((e: any) => e);
    expect(err.message).toContain(human);
  });
});

// Flat registered workflow errors must retain their machine code for safe retry.
it('requestJson keeps a flat workflow conflict code alongside human copy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, headers: { get: () => null }, json: async () => ({ error: 'CONFLICT', message: '当前步骤已变化，请刷新后重试' }) })));
  const err = await apiService.getWorkflowInstance('WF', ENDPOINT).catch(e => e);
  expect(err.code).toBe('CONFLICT');
  expect(err.status).toBe(409);
  expect(err.message).toBe('当前步骤已变化，请刷新后重试');
});
