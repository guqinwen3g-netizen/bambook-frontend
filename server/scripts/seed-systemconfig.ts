/**
 * seed-systemconfig.ts — Phase 0-08 初始化 7 类 37 项系统配置（幂等重跑）
 *
 * 运行：
 *   cd server && npx ts-node scripts/seed-systemconfig.ts
 *
 * 幂等策略：
 *   · 每项 key 已存在 → 完全跳过，不覆盖管理员已修改的值
 *   · 只在缺失时写入默认值（create only）
 */
import { PrismaClient } from '@prisma/client';
import type { ConfigGroup, ValueType } from '../src/config/systemConfigService';
import { DEFAULT_EXPORTER_PROFILE } from '../src/config/systemConfigRoute';

const prisma = new PrismaClient();

interface SeedItem {
  key: string;
  group: ConfigGroup;
  label: string;
  valueType: ValueType;
  value: unknown;
  encrypted?: boolean;
  description?: string;
  meta?: any;
}

const SEEDS: SeedItem[] = [
  // ─────────── company（9项）───────────
  { key: 'company.nameZh',            group: 'company',  valueType: 'string', label: '公司中文名',
    value: '江苏熊猫服饰有限公司',
    description: '展示在销售单据、发票、对账单抬头' },
  { key: 'company.nameEn',            group: 'company',  valueType: 'string', label: '公司英文名',
    value: process.env.BAMBOOK_COMPANY_NAME_EN || 'JIANGSU PANDA CLOTHING CO.,LTD.',
    description: '外贸单据 / 商业发票 / 装箱单抬头英文名称' },
  { key: 'company.addressZh',         group: 'company',  valueType: 'string', label: '中文注册地址', value: '江苏省南京市（请在 OPS Panel 修改为实际地址）' },
  { key: 'company.addressEn',         group: 'company',  valueType: 'string', label: '英文注册地址', value: 'Nanjing, Jiangsu, P.R.China (edit in OPS Panel)' },
  { key: 'company.taxId',             group: 'company',  valueType: 'string', label: '纳税人识别号 / 统一社会信用代码',
    value: '91XXXXXXXXXXXXXXXXXX', encrypted: true, // 属于公司敏感信息
    description: '增值税开票用；保存时 AES-256-GCM 加密' },
  { key: 'company.businessLicenseNo', group: 'company',  valueType: 'string', label: '营业执照号', value: '',
    description: '历史字段，新版多证合一后等同 taxId，可留空' },
  { key: 'company.phone',             group: 'company',  valueType: 'string', label: '联系电话', value: '+86 25 0000-0000' },
  { key: 'company.email',             group: 'company',  valueType: 'string', label: '业务邮箱', value: 'sales@jiangsupanda.com' },
  { key: 'company.logoUrl',           group: 'company',  valueType: 'string', label: 'Logo 图片 URL',
    value: '',
    meta: { placeholder: 'https://.../logo.png 或 /assets/logo.png' } },
  // W7 设置域：exporterProfile 服务端化（§1A 裁决：唯一真源 = SystemConfig global::company.exporterProfile）
  // 默认值真源 = 前端 components/tools/exportDocs/exporterProfile.ts 的 EXPORTER_PROFILE 常量
  // （服务端副本见 server/src/config/systemConfigRoute.ts DEFAULT_EXPORTER_PROFILE，两侧修改必须同步）
  { key: 'company.exporterProfile',   group: 'company',  valueType: 'json',   label: '出口方档案（单据抬头/收款账户）',
    value: DEFAULT_EXPORTER_PROFILE,
    description: 'CI/PL/Contract 等外贸单据卖方抬头与收款银行信息；写入口唯一 = PUT /api/v1/config/company.exporterProfile（仅 SUPER_ADMIN/ADMIN）' },

  // ─────────── finance（7项）───────────
  { key: 'finance.defaultCurrency',   group: 'finance',  valueType: 'string', label: '默认记账币种',
    value: 'CNY',
    meta: { options: ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'] } },
  { key: 'finance.defaultTradeCurrency', group: 'finance', valueType: 'string', label: '默认外贸报价币种', value: 'USD',
    meta: { options: ['USD', 'EUR', 'CNY', 'GBP', 'JPY'] } },
  { key: 'finance.usdCnyRate',        group: 'finance',  valueType: 'number', label: 'USD/CNY 汇率（默认值，实际请维护独立汇率表）',
    value: 7.30, meta: { min: 5, max: 9, step: 0.0001 } },
  { key: 'finance.defaultProfitRate', group: 'finance',  valueType: 'number', label: '默认利润率（%），如 8 表示 8%',
    value: 8, meta: { min: 0, max: 80, step: 0.5 } },
  { key: 'finance.defaultCommissionRate', group: 'finance', valueType: 'number', label: '默认外贸佣金率（%），如 3 表示 3%',
    value: 3, meta: { min: 0, max: 30, step: 0.5 } },
  { key: 'finance.defaultPaymentTerms',  group: 'finance', valueType: 'string', label: '默认付款条款',
    value: 'TT_30_PRE',
    description: '对应 DataDictionary.payment_terms 的 key' },
  { key: 'finance.arOverdueDaysThreshold', group: 'finance', valueType: 'number', label: '应收账款逾期预警天数阈值',
    value: 30, meta: { min: 0, max: 365 } },

  // ─────────── tax（5项）───────────
  { key: 'tax.defaultVatRate',        group: 'tax',      valueType: 'number', label: '默认增值税率（13/9/6）',
    value: 0.13, meta: { options: [0.13, 0.09, 0.06, 0.03, 0.00], step: 0.01 } },
  { key: 'tax.defaultTaxRefundRate',  group: 'tax',      valueType: 'number', label: '默认出口退税率（用于 FOB 报价 Track B）',
    value: 0.13, meta: { options: [0.13, 0.10, 0.09, 0.06, 0.00], step: 0.01 },
    description: '实际产品类退税率请在产品 / SKU 上维护；此值为通用默认值' },
  { key: 'tax.invoiceWarnThresholdCny', group: 'tax',    valueType: 'number', label: '单张开票金额预警阈值（人民币）',
    value: 1_000_000, meta: { min: 0, step: 10_000 } },
  { key: 'tax.invoiceTitleDefault',   group: 'tax',      valueType: 'string', label: '发票抬头默认值（公司中文全名）',
    value: '江苏熊猫服饰有限公司' },
  { key: 'tax.taxOfficeLocation',     group: 'tax',      valueType: 'string', label: '主管税务机关名称',
    value: '（请在 OPS Panel 修改实际主管税务机关）' },

  // ─────────── logistics（4项）───────────
  { key: 'logistics.defaultIncoterm', group: 'logistics',valueType: 'string', label: '默认贸易术语 Incoterms',
    value: 'FOB', meta: { options: ['FOB', 'CIF', 'EXW', 'CFR', 'DDP', 'DAP', 'CPT', 'CIP', 'FCA'] } },
  { key: 'logistics.defaultPortOfLoading', group: 'logistics', valueType: 'string', label: '默认起运港',
    value: 'Shanghai, China' },
  { key: 'logistics.defaultPortOfDestination', group: 'logistics', valueType: 'string', label: '默认目的港（仅默认值）', value: '' },
  { key: 'logistics.defaultForwarderContact', group: 'logistics', valueType: 'string', label: '默认货代联系人与电话', value: '' },

  // ─────────── ui（4项）───────────
  { key: 'ui.brandPrimary',           group: 'ui',       valueType: 'string', label: '品牌主题色（Tailwind 语义色名或 HEX）',
    value: 'bg-deep', description: '优先使用 design token；若写 HEX 必须使用 CSS 变量而不是硬编码到组件（此配置仅做偏好提示）' },
  { key: 'ui.defaultLocale',          group: 'ui',       valueType: 'string', label: '默认界面语言',
    value: 'zh-CN', meta: { options: ['zh-CN', 'en-US'] } },
  { key: 'ui.defaultDashboardLayout', group: 'ui',       valueType: 'string', label: '默认首页布局模式',
    value: 'overview', meta: { options: ['overview', 'cockpit', 'report', 'today'] } },
  { key: 'ui.denseModeDefault',       group: 'ui',       valueType: 'boolean', label: '列表默认紧凑模式', value: false },

  // ─────────── rbac（4项）───────────
  { key: 'rbac.passwordMinLength',    group: 'rbac',     valueType: 'number', label: '密码最小长度',
    value: 8, meta: { min: 6, max: 32 } },
  { key: 'rbac.passwordRequireStrong',group: 'rbac',     valueType: 'boolean', label: '密码强复杂度要求（大小写+数字+特殊字符至少3类）', value: true },
  { key: 'rbac.sessionTtlMinutes',    group: 'rbac',     valueType: 'number', label: '会话 TTL（分钟）',
    value: 60 * 24, meta: { min: 15, max: 60 * 24 * 30 } },
  { key: 'rbac.loginFailLockThreshold', group: 'rbac',   valueType: 'number', label: '连续登录失败锁定阈值（0=不启用）',
    value: 5, meta: { min: 0, max: 20 } },

  // ─────────── ops（4项，1项加密共5个 key）───────────
  { key: 'ops.backupEnabled',         group: 'ops',      valueType: 'boolean', label: '启用定期本地备份', value: true },
  { key: 'ops.backupCron',            group: 'ops',      valueType: 'string', label: '备份 Cron（默认 03:00 每日）', value: '0 3 * * *' },
  { key: 'ops.notifyEmailSmtpHost',   group: 'ops',      valueType: 'string', label: 'SMTP 通知邮件服务器', value: '' },
  { key: 'ops.notifyEmailSmtpPassword', group: 'ops',    valueType: 'string', label: 'SMTP 密码/授权码',
    value: '', encrypted: true,
    description: 'AES-256-GCM 加密存储；管理 UI 不回显明文' },
  { key: 'ops.llmGatewayBaseUrl',     group: 'ops',      valueType: 'string', label: 'LLM 网关 Base URL（可选）',
    value: '' },
  { key: 'ops.opsTokenExpireMinutes', group: 'ops',      valueType: 'number', label: 'OPS Token 有效期（分钟）',
    value: 60 * 8, meta: { min: 5, max: 60 * 24 * 7 } },
];

async function seedOne(item: SeedItem, db: PrismaClient = prisma): Promise<{ key: string; status: 'created' | 'skipped' }> {
  const id = `global::${item.key}`;
  const existing = await db.systemConfig.findUnique({ where: { id }, select: { id: true } });
  if (existing) return { key: item.key, status: 'skipped' };
  // 注意：这里直接 prisma 创建；systemConfigService.set 是给运行时用的，seed 里避免循环依赖
  let storedValue: unknown = item.value;
  if (item.encrypted) {
    // seed 时若 value 为空字符串就不做加密（允许管理员后续通过 service.set 写入）
    if (item.value === '' || item.value == null) {
      storedValue = null;
    } else {
      // 导入 service 的 encrypt 避免重复实现
      const crypto = require('crypto');
      const keyBuf = (() => {
        const envKey = process.env.SYSTEM_CONFIG_ENCRYPTION_KEY;
        if (envKey) {
          if (envKey.trim().length === 64) return Buffer.from(envKey.trim(), 'hex');
          if (envKey.trim().length === 32) return Buffer.from(envKey.trim(), 'utf8');
          throw new Error('seed-systemconfig: SYSTEM_CONFIG_ENCRYPTION_KEY 必须是 64 hex chars 或 32 chars ASCII');
        }
        if (process.env.NODE_ENV === 'production') {
          throw new Error('seed-systemconfig: 生产环境必须显式设置 SYSTEM_CONFIG_ENCRYPTION_KEY（64 hex chars）');
        }
        const fallbackSecret = process.env.BAMBOOK_COOKIE_SECRET || process.env.COOKIE_SECRET || 'dev-only-fallback-do-not-use-in-production';
        return crypto.createHash('sha256').update(`SYSTEM_CONFIG_DEVK_${fallbackSecret}`).digest();
      })();
      const iv = crypto.randomBytes(12);
      const plainBuf = Buffer.from(typeof item.value === 'string' ? item.value : JSON.stringify(item.value), 'utf8');
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
      const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
      const tag = cipher.getAuthTag();
      storedValue = `${iv.toString('hex')}.${ct.toString('hex')}.${tag.toString('hex')}`;
    }
  }
  await db.systemConfig.create({
    data: {
      id,
      scope: 'global',
      key: item.key,
      group: item.group,
      label: item.label,
      valueType: item.valueType,
      value: storedValue as any,
      encrypted: !!item.encrypted,
      version: 1,
      description: item.description ?? null,
      meta: item.meta ?? null,
      updatedBy: null,
      auditReason: null,
      updatedAt: BigInt(Date.now()),
    },
  });
  return { key: item.key, status: 'created' };
}

/**
 * 幂等 seed 入口（可注入 db，测试/复用；缺省用模块级 prisma）。
 * 与 seed-moq-thresholds.ts 范式一致：函数导出 + require.main 守卫，重复执行安全。
 */
export async function seedSystemConfigs(db: PrismaClient = prisma): Promise<{ created: number; skipped: number }> {
  console.log(`[seed-systemconfig] Start. 配置项=${SEEDS.length}`);
  let created = 0;
  let skipped = 0;
  for (const item of SEEDS) {
    try {
      const r = await seedOne(item, db);
      if (r.status === 'created') {
        console.log(`  + create ${r.key.padEnd(42)} [${item.group}] (${item.valueType}${item.encrypted ? ' +encrypted' : ''}) — ${item.label}`);
        created++;
      } else {
        console.log(`  · skip   ${r.key.padEnd(42)} [${item.group}] — 已存在（保留管理员值）`);
        skipped++;
      }
    } catch (e: any) {
      console.error(`  ✗ FAIL  ${item.key}: ${e?.message ?? e}`);
      throw e;
    }
  }
  console.log(`[seed-systemconfig] Done. created=${created}, skipped=${skipped}`);
  console.log('[seed-systemconfig] 敏感项加密密钥来源：process.env.SYSTEM_CONFIG_ENCRYPTION_KEY（64 hex chars）。生产环境必须显式设置。');
  return { created, skipped };
}

if (require.main === module) {
  seedSystemConfigs()
    .catch((err) => {
      console.error('[seed-systemconfig] FAILED:', err?.message ?? err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
