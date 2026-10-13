/**
 * routeError — 路由 `catch` 分支的统一「安全错误响应」助手。
 *
 * ── 病灶（2026-09-17 量化）────────────────────────────────
 * 全仓 **277 处**（262×`status(500)` + 14×`status(400)` + 1×404）形如：
 * ```ts
 * res.status(500).json({ error: 'X_FAILED', message: String(e?.message ?? e) });
 * ```
 * 把**原始错误**（Prisma 原文 / SQL 片段 / 表名列名 / 内部路径）**直接返回给前端**。
 * 用户看到的是 `PrismaClientKnownRequestError: Invalid \`prisma.x.findMany()\` invocation…`。
 *
 * ── 语义（**保留业务错误的透传**，别把有意的文案也吞掉）────
 *   · **业务错误**：本仓约定「有意抛给用户的错误」=
 *     `throw Object.assign(new Error(msg), { code, statusCode })`
 *     （见 `finance/allocationMutationService` / `auth/permissionGuard` 等）
 *     → **原样透传**（含其 `statusCode`，避免「业务码兜成 500」那类老问题）
 *   · **未预期异常** → 返回**通用文案**，原始错误**只进日志**
 *
 * ★ **业务错误的认定与文案表已并入 `shared/errorCodes`，本函数是它的适配层**
 *   （S0-A Task 4）。判据（`isBusinessError`）与「码 → 状态 → 文案」表都只有注册表那一份，
 *   本文件不再自行判形状、也不再自备文案常量 —— 两处各一份真源迟早会改一处漏一处。
 *
 * ⚠️ 本助手**不记日志** —— 调用方原本就有 `logger.error('[tag] failed', { error })`，
 *    保持既有日志行为不变（不重复记、也不替调用方决定日志级别）。
 *
 * ⚠️ **响应体形状由调用方决定**：本仓有 flat `{ error, message }` 与
 *    nested `{ error: { code, message } }` **两种形状**，都是**前端契约**，不能统一改。
 *    本助手只返回 `{ status, code, message, passthrough, details? }`，由调用方组装。
 *
 * ── 用法 ─────────────────────────────────────────────────
 * ```ts
 * } catch (e: any) {
 *   logger.error('[entities/search] failed', { error: e?.message || String(e) });
 *   const r = safeRouteError(e, {
 *     fallbackCode: 'ENTITY_SEARCH_FAILED',
 *     fallbackMessage: '查询失败，请稍后重试',
 *   });
 *   return res.status(r.status).json({ error: r.code, message: r.message }); // ← flat 形状保持
 * }
 * ```
 *
 * ⚠️ **不要**用脚本对 277 处做机械替换 —— 很多站点写的是
 *    `e?.message || 'failed to X'`，其中 `e.message` **可能本身就是有意给用户的业务文案**
 *    （如「币种必填」），机械替换会**吞掉业务文案**。逐处核准后收敛。
 *    棘轮守卫（`shared/__tests__/routeError.test.ts`）冻结剩余处数，禁止新增。
 */

// 文案真源在 shared/errorCodes。本仓踩过的坑：`export { X } from './y'` **不会**把 X 带进
// 本文件作用域，故必须 import + export 两行写（routeError.test.ts 从 '../routeError' 引它）。
import { GENERIC_ROUTE_ERROR_MESSAGE, isBusinessError, resolveError } from './errorCodes';
export { GENERIC_ROUTE_ERROR_MESSAGE };

export interface SafeRouteError {
  status: number;
  code: string;
  message: string;
  /**
   * true = 本次响应的状态码是 4xx（对外是「客户端的问题」）。
   * ⚠️ S0-A Task 4 起它由 `status` **反推**，不再由「是否业务形状」直接给：
   *   · 业务码自带 5xx（如 `X_FAILED` + statusCode:500）→ false，但它仍是自己的文案；
   *   · 调用方显式给了 4xx 兜底 `status`（generate-document 那两处）→ true。
   * 全仓无任何路由读这个字段（只被守卫测试钉），故这只是**语义标注**收紧，不是行为变更。
   */
  passthrough: boolean;
  /**
   * 业务错误自带的明细（`details` 或 `gateDetails`，由 resolveError 归一到这一个键）。
   * 未预期异常恒为 undefined。既有调用点都不读它 ⇒ 响应体一字不变；
   * 收敛门禁类路由时才有用（出运 409 的明细是前端门禁面板的输入）。
   */
  details?: unknown;
}

export function safeRouteError(
  e: unknown,
  opts: { fallbackCode: string; fallbackMessage?: string; status?: number },
): SafeRouteError {
  const r = resolveError(e, opts.fallbackCode);
  // 判据只问一次（同一个 isBusinessError，不在本文件重抄形状判断）
  const business = isBusinessError(e);

  // 状态码优先级与收敛前一致（唯一差异就是本任务的目的：兜底码在注册表里时认表取状态），
  // 即：业务错误认它自己的 `statusCode`，`opts.status` 只是「未预期异常」那一支的兜底状态。
  // 两个 generate-document 调用点（paymentRequestRoute:317 / orders/routeV2:190）传的是
  // `status: notFound ? 404 : 500`，而 `notFound` 是**拿 e.message 含不含「不存在」猜出来的** ——
  // 若让它压过业务状态码，一个业务拒绝就会在这些点上被改写成 404（文案恰好含「不存在」时）
  // 或 500（其余），而收敛前它认的是业务码自带的状态。brief 的示例体是 `opts.status ?? r.status`，
  // 那正是本行要避免的行为变更，故按「保持既有调用点语义」这条硬约束改回分支写法。
  const status = business ? r.status : opts.status ?? r.status;
  // `fallbackMessage` 只在「未预期异常」那一支生效 ⇒ 业务错误**永远**透传自己的文案。
  // 不用 `r.code === opts.fallbackCode` 当条件：业务错误自带的码可能与兜底码同名
  // （全仓 116+ 处 `Object.assign(new Error(msg), { code, statusCode })`，码由产出方自取），
  // 那种巧合下按码名判会把有意的业务文案换成兜底文案 —— 按形状判没有这个洞。
  const message = business ? r.message : opts.fallbackMessage ?? r.message;
  return {
    status,
    code: r.code,
    message,
    passthrough: status < 500,
    ...(r.details === undefined ? {} : { details: r.details }),
  };
}
