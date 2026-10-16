/**
 * marketQuoteRoute.ts —— 羊毛 / 亚麻「人工录入」报价的读写端点
 *
 * ── 为什么需要这个路由 ──────────────────────────────────────────────
 * 羊毛是**拍卖市场**（业界基准 AWEX EMI 是**周度**指数，AWEX 官网明示实时数据需付费），
 * 亚麻全球无公开连续报价 —— 两者**物理上没有实时价**。
 * 所以 `marketQuoteService` 把它们做成「读系统配置」的人工录入值，
 * 但此前**没有任何写入通道**（`systemConfigRoute` 只有一个专用 PUT，只服务公司抬头）
 * ⇒ 只能由开发写 SQL。本路由补上这个缺口，让业务方能自助维护。
 *
 * ── 真源 ────────────────────────────────────────────────────────────
 * 配置键 `global::market.wool` / `global::market.linen`，值 = `{ price, asOf, note }`。
 * 写操作经 `systemConfigService.set`：首次创建落 `SystemConfig` 行（updatedBy + version）；
 * **后续修改**额外落 `SystemConfigHistory`（versionFrom/To + actorId + reason），可追溯。
 * ⚠️ actor 必须用 `extractActorFromRequest`（本仓登录态在 Bearer/cookie 里，
 *    读 `req.user` 会拿到 undefined ⇒ 丢留痕）。
 *
 * ── 权限 ────────────────────────────────────────────────────────────
 * 与 `systemConfigRoute`（公司档案）保持一致：**读 = 登录即可；写 = 仅超管/管理员**。
 * 理由：这是**经营参考参数**，写错会让全公司的行情卡显示错值，属于管理动作。
 *
 * ── 端点（挂载点 /api/v1/market）────────────────────────────────────
 *   GET  /quotes/manual           — 读当前人工报价（含合法区间，供界面校验）
 *   PUT  /quotes/manual/:key      — 写入 { price, asOf?, note?, reason? }
 *
 * ── 错误语义（对齐 systemConfigRoute / moqRoute 既有格式）──────────
 *   401 { error:'UNAUTHORIZED' }        — 未登录
 *   403 { error:'FORBIDDEN' }           — 非超管/管理员
 *   400 { error:'VALIDATION_FAILED', details:[...] } — 参数不合法（含越界 / 未来日期）
 *   404 { error:'UNKNOWN_QUOTE_KEY' }   — key 不是 wool|linen
 */

import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requireAuth, extractActorFromRequest } from '../auth/middleware';
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { requirePermission } from '../auth/permissionGuard';
import { logger } from '../lib/logger';
import { getSystemConfigService } from '../config/systemConfigService';
import { safeRouteError } from '../shared/routeError';
import { todayLocalKey } from '../shared/localDate';
import { runAutoQuoteSync } from './autoQuoteSources';
import {
  MANUAL_QUOTE_KEYS,
  MANUAL_QUOTE_RANGES,
  manualQuoteConfigKey,
  type ManualQuoteKey,
} from './marketQuoteService';

export interface MarketQuoteRouterOptions {
  prisma: PrismaClient;
  requireAuth?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 120;

export function isManualQuoteKey(v: string): v is ManualQuoteKey {
  return (MANUAL_QUOTE_KEYS as readonly string[]).includes(v);
}

/** 纯函数：校验录入值。返回错误列表（空数组 = 通过）。抽出来是为了能直接做守卫测试。 */
export function validateManualQuote(
  body: unknown,
  todayIso: string,
): { errors: string[]; value?: { price: number; asOf: string | null; note: string | null } } {
  const errors: string[] = [];
  const b = (body || {}) as Record<string, unknown>;

  const price = Number(b.price);
  if (b.price === undefined || b.price === null || b.price === '') {
    errors.push('price 必填');
  } else if (!Number.isFinite(price)) {
    errors.push('price 必须是数字');
  } else if (price <= 0) {
    errors.push('price 必须大于 0');
  }

  let asOf: string | null = null;
  if (b.asOf !== undefined && b.asOf !== null && b.asOf !== '') {
    if (typeof b.asOf !== 'string' || !DATE_RE.test(b.asOf)) {
      errors.push('asOf 必须是 YYYY-MM-DD 格式');
    } else if (b.asOf > todayIso) {
      // 未来日期 = 录入笔误（或改系统时间），必须挡住：否则界面会显示"未来的行情"
      errors.push('asOf 不能晚于今天');
    } else {
      asOf = b.asOf;
    }
  }

  let note: string | null = null;
  if (b.note !== undefined && b.note !== null && b.note !== '') {
    if (typeof b.note !== 'string') {
      errors.push('note 必须是字符串');
    } else if (b.note.trim().length > NOTE_MAX) {
      errors.push(`note 不能超过 ${NOTE_MAX} 个字符`);
    } else {
      note = b.note.trim() || null;
    }
  }

  if (errors.length) return { errors };
  return { errors, value: { price, asOf, note } };
}

/** 纯函数：区间校验（区间真源在 marketQuoteService，读写共用一套） */
export function checkQuoteRange(key: ManualQuoteKey, price: number): string | null {
  const [lo, hi] = MANUAL_QUOTE_RANGES[key];
  if (price < lo || price > hi) {
    return `price 疑似异常：${key} 的合理区间是 ${lo}~${hi} CNY/吨（当前 ${price}）。确认无误请改到区间内。`;
  }
  return null;
}

export function createMarketQuoteRouter(options: MarketQuoteRouterOptions): Router {
  const { prisma, requireAuth: requireAuthEnabled = true } = options;
  const router = Router();
  const authMw = requireAuthEnabled ? [requireAuth] : [];
  // System configuration uses the current SystemSettings.write module contract,
  // plus the existing owner/admin rule; requireAuth=false affects reads only.
  const writeMw = [createCurrentWriteActor(prisma), requirePermission('dictionary:write')];
  const svc = () => getSystemConfigService(prisma);

  // ── 读当前报价（自动同步值 + 来源/时间 + 应急覆盖标记）──
  const readAll = async () => {
    const s = svc();
    const out: Record<string, unknown> = {};
    for (const key of MANUAL_QUOTE_KEYS) {
      const row = await s.get(manualQuoteConfigKey(key));
      const v = (row?.value || {}) as Record<string, unknown>;
      const price = Number(v.price);
      out[key] = {
        key,
        price: Number.isFinite(price) && price > 0 ? price : null,
        asOf: typeof v.asOf === 'string' ? v.asOf : null,
        note: typeof v.note === 'string' ? v.note : null,
        /** ★ true ⇒ 该值由外部源自动同步写入（人工应急覆盖则为 false/缺省） */
        auto: v.auto === true,
        cadence: v.cadence === 'monthly' || v.cadence === 'quarterly' ? v.cadence : null,
        // ⚠️ 必须显式判 null/undefined：`Number(null) === 0` 且 isFinite ⇒ 会把「无环比」显示成 0%
        nativePrice: v.nativePrice != null && Number.isFinite(Number(v.nativePrice)) ? Number(v.nativePrice) : null,
        nativeUnit: typeof v.nativeUnit === 'string' ? v.nativeUnit : null,
        nativeChangePct: v.nativeChangePct != null && Number.isFinite(Number(v.nativeChangePct)) ? Number(v.nativeChangePct) : null,
        sourceUrl: typeof v.sourceUrl === 'string' ? v.sourceUrl : null,
        fetchedAt: typeof v.fetchedAt === 'string' ? v.fetchedAt : null,
        range: MANUAL_QUOTE_RANGES[key],
        updatedAt: row?.row?.updatedAt != null ? String(row.row.updatedAt) : null,
        updatedBy: row?.row?.updatedBy ?? null,
      };
    }
    return out;
  };

  router.get('/quotes/manual', ...authMw, async (_req: Request, res: Response) => {
    try {
      res.json({ status: 'success', quotes: await readAll() });
    } catch (e: any) {
      logger.error('[MarketQuote] read failed', { error: e?.message });
      const safe = safeRouteError(e, { fallbackCode: 'READ_FAILED', fallbackMessage: '读取市场行情失败' });
      res.status(safe.status).json({ status: 'error', error: safe.code, message: safe.message });
    }
  });

  // ── 立即同步（不等每日 09:10 的调度）──
  // ★ 「行情对不对」的现场核查手段：改完代码 / 怀疑源挂了，点一下即同步并回显结果。
  router.post('/quotes/refresh', ...writeMw, async (_req: Request, res: Response) => {
    try {
      const report = await runAutoQuoteSync(prisma, svc());
      logger.info('[MarketQuote] manual refresh', { ok: report.ok, failed: report.failed });
      res.json({ status: 'success', report, quotes: await readAll() });
    } catch (e: any) {
      logger.error('[MarketQuote] refresh failed', { error: e?.message });
      const safe = safeRouteError(e, { fallbackCode: 'REFRESH_FAILED', fallbackMessage: '行情同步失败' });
      res.status(safe.status).json({ status: 'error', error: safe.code, message: safe.message });
    }
  });

  // ── 应急覆盖：人工写入（**默认不使用**；自动同步才是主通道）──
  // 保留这条通路是为了「外部源整体挂掉 / 临时需要按谈定口径展示」时的兜底，
  // 它写的是同一个配置键，但**不带 auto 标记**（前端会显示「手工 · 日期」以示区别）。
  router.put('/quotes/manual/:key', ...writeMw, async (req: Request, res: Response) => {
    const key = String(req.params.key || '').toLowerCase();
    if (!isManualQuoteKey(key)) {
      return res.status(404).json({ status: 'error', error: 'UNKNOWN_QUOTE_KEY', allowed: [...MANUAL_QUOTE_KEYS] });
    }

    // ⚠️ 用「业务日」（本地时区）。若用 UTC 日，本地 00:00–08:00 会把今天当成"未来"而拒收
    const todayIso = todayLocalKey();
    const { errors, value } = validateManualQuote(req.body, todayIso);
    if (errors.length || !value) {
      return res.status(400).json({ status: 'error', error: 'VALIDATION_FAILED', details: errors });
    }

    const rangeError = checkQuoteRange(key, value.price);
    if (rangeError) {
      return res.status(400).json({ status: 'error', error: 'VALIDATION_FAILED', details: [rangeError] });
    }

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : `市场行情人工录入（${key}）`;

    try {
      // ★ 用既有真源提取 actor：不要读 `req.user` / `req.auth` —— 本仓的登录态在
      //   Bearer header / cookie 里，`extractActorFromRequest` 才是唯一正确的解析口
      //   （实测：直接读 req.user 会拿到 undefined ⇒ updatedBy 空 ⇒ 丢留痕）
      const actorId = extractActorFromRequest(req)?.userId ?? null;
      const result = await svc().set(
        manualQuoteConfigKey(key),
        { price: value.price, asOf: value.asOf, note: value.note },
        {
          group: 'custom',
          label: key === 'wool' ? '羊毛行情（人工录入）' : '亚麻行情（人工录入）',
          valueType: 'json',
          description: '市场上无实时价（羊毛为拍卖市场 / 亚麻无公开源）⇒ 人工维护，界面会标注更新日期',
          actorId,
          reason,
        },
      );
      logger.info('[MarketQuote] manual quote saved', { key, price: value.price, asOf: value.asOf, actorId });
      res.json({
        status: 'success',
        quote: {
          key,
          price: value.price,
          asOf: value.asOf,
          note: value.note,
          range: MANUAL_QUOTE_RANGES[key],
          version: result.row?.version ?? null,
        },
      });
    } catch (e: any) {
      logger.error('[MarketQuote] write failed', { key, error: e?.message });
      const safe = safeRouteError(e, { fallbackCode: 'WRITE_FAILED', fallbackMessage: '写入行情失败' });
      res.status(safe.status).json({ status: 'error', error: safe.code, message: safe.message });
    }
  });

  return router;
}
