/**
 * systemConfigRoute.ts — W7 设置域：公司档案（exporterProfile）服务端化
 *
 * 设计真源：docs/design/04-模块设计/08-设置与后台/Settings-设置/公司档案与配置.md §1A（2026-08-18 裁决）
 *   1. exporterProfile 唯一真源 = 服务端 SystemConfig `global::company.exporterProfile`
 *      （本机 localStorage 降级为只读缓存，禁止反向写入）
 *   2. 写入口唯一 = 本路由 PUT（RBAC 仅 SUPER_ADMIN/ADMIN，legacy 角色常量 owner/admin）
 *   3. GET 全登录可读（单据生成链路 CI/PL/Contract 依赖）
 *   4. 审计闭环：写操作经 systemConfigService.set 落 SystemConfigHistory
 *      （versionFrom/To + actorId + reason）；银行四字段任一变更时 reason 必填
 *
 * 端点（挂载点：/api/v1/config，与 automationRoute 同一 sdkAuth 注册点）：
 *   GET  /company.exporterProfile         — 登录即可读；配置不存在时返回默认值（200 + isDefault:true），不落库
 *   PUT  /company.exporterProfile         — 仅 owner/admin；body: { value: {...}, reason?: string }
 *   GET  /company.exporterProfile/history — 仅 owner/admin；SystemConfigHistory 倒序列表
 *
 * 错误语义（对齐 moqRoute/adminRoute 既有格式）：
 *   401 { error:'UNAUTHORIZED' } — 未登录（requireAuth/requireRole 中间件）
 *   403 { error:'FORBIDDEN' }    — 权限不足（requireRole 中间件）
 *   400 { error:'VALIDATION_FAILED' | 'REASON_REQUIRED' } — payload 校验失败 / 银行字段变更缺理由
 */

import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/middleware';
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { requirePermission } from '../auth/permissionGuard';
import { logger } from '../lib/logger';
import {
  createSystemConfigService,
  getSystemConfigService,
} from './systemConfigService';

// ────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────

export const EXPORTER_PROFILE_CONFIG_KEY = 'company.exporterProfile';
export const EXPORTER_PROFILE_CONFIG_ID = `global::${EXPORTER_PROFILE_CONFIG_KEY}`;

export interface ExporterProfileValue {
  /** 公司英文名（单据抬头） */
  nameEn: string;
  /** 受益人名（银行/保险单据） */
  beneficiary: string;
  /** 公司英文地址（多行用 \n 分隔） */
  addressEn: string;
  /** 银行名称（CI 付款条款引用） */
  bankName: string;
  /** SWIFT Code */
  swiftCode: string;
  /** 银行地址 */
  bankAddress: string;
  /** USD 收款账号 */
  usdAccountNumber: string;
}

/**
 * 默认出口方档案。
 * ⚠️ 真源：前端 components/tools/exportDocs/exporterProfile.ts 的 EXPORTER_PROFILE 常量。
 *    本副本是服务端兜底值（GET 无配置时返回 + seed 初始写入），修改任一侧必须同步另一侧。
 */
export const DEFAULT_EXPORTER_PROFILE: ExporterProfileValue = {
  nameEn: 'JIANGSU PANDA CLOTHING CO.,LTD.',
  addressEn: 'ROOM A1028 WUYUE PLAZA,\nZHANGJIAGANG CITY, 215600 PR\nCHINA',
  beneficiary: 'JIANGSU PANDA CLOTHING CO.,LTD.',
  bankName: 'BANK OF CHINA ZHANGJIAGANG SUB-BRANCH',
  swiftCode: 'BKCHCNBJ95L',
  bankAddress: '111 MIDDLE RENMIN ROAD, ZHANGJIAGANG CITY, SUZHOU, JIANGSU PROV., P.R.CHINA.',
  usdAccountNumber: '467668133096',
};

/** 银行字段：任一变更时 reason 必填（§1A 审计裁决） */
const BANK_FIELDS = ['bankName', 'swiftCode', 'bankAddress', 'usdAccountNumber'] as const;
/** nameEn 必填，其余可选 string */
const OPTIONAL_FIELDS = ['beneficiary', 'addressEn', ...BANK_FIELDS] as const;

type ConfigService = ReturnType<typeof createSystemConfigService>;

export interface SystemConfigRouterOptions {
  prisma: PrismaClient;
  /** 是否启用读取认证（默认 true）；写操作始终核验当前用户权限。 */
  requireAuth?: boolean;
  /** 可注入（测试复用 mock prisma 构建的服务）；缺省用进程内单例（带 30s TTL 缓存） */
  configService?: ConfigService;
}

export function createSystemConfigRouter(options: SystemConfigRouterOptions): Router {
  const router = Router();
  const prisma = options.prisma as any;
  const requireAuthEnabled = options.requireAuth ?? true;
  const svc = options.configService ?? getSystemConfigService(options.prisma);

  // SystemConfig.updatedAt 为 BigInt（epoch ms），JSON 序列化前必须转 Number（否则 res.json 抛 TypeError）
  const toEpochMs = (v: bigint | number): number => Number(v);

  // ── GET /company.exporterProfile — 全登录可读（单据生成链路依赖）──
  router.get(
    `/${EXPORTER_PROFILE_CONFIG_KEY}`,
    ...(requireAuthEnabled ? [requireAuth] : []),
    async (_req: Request, res: Response) => {
      try {
        const found = await svc.get(EXPORTER_PROFILE_CONFIG_KEY);
        if (!found) {
          // 未配置：返回默认值 + isDefault 标记，不落库（由 seed 负责首次写入）
          return res.json({
            ok: true,
            key: EXPORTER_PROFILE_CONFIG_KEY,
            value: { ...DEFAULT_EXPORTER_PROFILE },
            version: 0,
            isDefault: true,
          });
        }
        // 与前端 getExporterProfile() 同语义：合并默认值兜底新增字段
        const value = { ...DEFAULT_EXPORTER_PROFILE, ...((found.value as object) || {}) };
        res.json({
          ok: true,
          key: EXPORTER_PROFILE_CONFIG_KEY,
          value,
          version: found.row.version,
          isDefault: false,
          updatedAt: toEpochMs(found.row.updatedAt),
          updatedBy: found.row.updatedBy ?? null,
        });
      } catch (e: any) {
        logger.error('[SystemConfigRoute] GET exporterProfile failed', { error: e?.message });
        res.status(500).json({ error: 'CONFIG_READ_FAILED', message: '出口方档案读取失败，请联系管理员（原文已记入服务端日志）' });
      }
    },
  );

  // ── PUT /company.exporterProfile — 仅 SUPER_ADMIN/ADMIN（legacy: owner/admin）──
  // Current rolePermissionMatrix SystemSettings.write is dictionary:write. The
  // older document's settings:write is absent from PERMISSION_SCOPES; do not
  // invent it or silently grant new authority. Keep the documented role AND cap.
  router.put(
    `/${EXPORTER_PROFILE_CONFIG_KEY}`,
    createCurrentWriteActor(options.prisma), requireRole('owner', 'admin'), requirePermission('dictionary:write'),
    async (req: Request, res: Response) => {
      try {
        const body = req.body || {};
        const value = body.value;
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

        // payload 校验：value 对象；nameEn 必填非空 string；其余可选 string
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'value 必填且必须为对象 { nameEn, beneficiary?, addressEn?, bankName?, swiftCode?, bankAddress?, usdAccountNumber? }' });
        }
        if (typeof value.nameEn !== 'string' || value.nameEn.trim() === '') {
          return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'value.nameEn 必填且必须为非空字符串（单据抬头）' });
        }
        for (const f of OPTIONAL_FIELDS) {
          if (value[f] !== undefined && typeof value[f] !== 'string') {
            return res.status(400).json({ error: 'VALIDATION_FAILED', message: `value.${f} 必须为字符串` });
          }
        }

        // 当前生效值（skipCache：银行变更判定是审计关键路径，必须读最新库值）
        const existing = await svc.get(EXPORTER_PROFILE_CONFIG_KEY, { skipCache: true });
        const current: ExporterProfileValue = existing
          ? { ...DEFAULT_EXPORTER_PROFILE, ...((existing.value as object) || {}) }
          : { ...DEFAULT_EXPORTER_PROFILE };

        // 合并语义：nameEn 必填全覆盖，其余字段仅在显式提供时更新
        const next: ExporterProfileValue = { ...current, nameEn: value.nameEn };
        for (const f of OPTIONAL_FIELDS) {
          if (value[f] !== undefined) next[f] = value[f];
        }

        // 银行四字段任一变更 → reason 必填（§1A 审计裁决）
        const bankChanged = BANK_FIELDS.some((f) => next[f] !== current[f]);
        if (bankChanged && !reason) {
          return res.status(400).json({
            error: 'REASON_REQUIRED',
            message: `银行字段（${BANK_FIELDS.join('/')}）变更必须填写变更理由 reason（审计要求）`,
          });
        }

        const actor = (req as any).actor;
        const result = await svc.set(EXPORTER_PROFILE_CONFIG_KEY, next, {
          group: 'company',
          label: '出口方档案（单据抬头/收款账户）',
          valueType: 'json',
          description: 'CI/PL/Contract 等外贸单据卖方抬头与收款银行信息；写入口唯一（AdminPanel 公司档案 Tab）',
          actorId: actor?.userId ?? null,
          reason: reason || null,
        });

        res.json({
          ok: true,
          key: EXPORTER_PROFILE_CONFIG_KEY,
          value: result.row.value,
          version: result.row.version,
          updatedAt: toEpochMs(result.row.updatedAt),
        });
      } catch (e: any) {
        logger.error('[SystemConfigRoute] PUT exporterProfile failed', { error: e?.message });
        res.status(500).json({ error: 'CONFIG_UPDATE_FAILED', message: '出口方档案保存失败，本次修改未生效，请稍后重试（原文已记入服务端日志）' });
      }
    },
  );

  // ── GET /company.exporterProfile/history — 仅 SUPER_ADMIN/ADMIN；createdAt 倒序 ──
  router.get(
    `/${EXPORTER_PROFILE_CONFIG_KEY}/history`,
    ...(requireAuthEnabled ? [requireRole('owner', 'admin')] : []),
    async (req: Request, res: Response) => {
      try {
        const rawLimit = Number(req.query.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
        const items = await prisma.systemConfigHistory.findMany({
          where: { configId: EXPORTER_PROFILE_CONFIG_ID },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        res.json({
          ok: true,
          items: (items || []).map((h: any) => ({
            id: h.id,
            configId: h.configId,
            versionFrom: h.versionFrom,
            versionTo: h.versionTo,
            valueFrom: h.valueFrom ?? null,
            valueTo: h.valueTo ?? null,
            actorId: h.actorId ?? null,
            reason: h.reason ?? null,
            createdAt: h.createdAt,
          })),
        });
      } catch (e: any) {
        logger.error('[SystemConfigRoute] GET exporterProfile history failed', { error: e?.message });
        res.status(500).json({ error: 'CONFIG_HISTORY_READ_FAILED', message: '出口方档案变更记录读取失败，请联系管理员（原文已记入服务端日志）' });
      }
    },
  );

  return router;
}
