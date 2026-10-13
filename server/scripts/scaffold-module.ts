/**
 * scaffold-module.ts — Bambook 模块脚手架生成器（MVP）
 *
 * 设计原则（来自 docs/MODULE_CONTRACT.md §10）：
 * 1. **零新依赖**：不引入 yaml / handlebars / plop。用原生 string template + JSON-in-TS spec。
 * 2. **独立新文件直接写盘 + 高频文件只打印 patch 片段**。
 *    高频文件（manifest.ts / defaults.ts / toolRuntime.ts / planner.ts / sync.ts / e2e-agent-test.ts）
 *    每天都被多个模块同时改动，AST 自动 patch 必然引发 merge conflict。
 *    生成器只**打印**应该插入的代码片段 + 标注插入位置，由人工 copy-paste。
 * 3. **默认 dry-run**：只打印，不写盘。加 `--write` 才落盘。
 *    加 `--output=<dir>` 自定义独立新文件的目标目录（默认 `scaffold-output/<module>/`）。
 *
 * 用法：
 *   npx tsx scripts/scaffold-module.ts --spec=finance                    # dry-run，打印所有片段
 *   npx tsx scripts/scaffold-module.ts --spec=finance --write           # 写入独立新文件 + 打印 patch 片段
 *   npx tsx scripts/scaffold-module.ts --spec=finance --output=tmp/x    # 自定义输出目录
 *   npx tsx scripts/scaffold-module.ts --list                           # 列出已知 spec
 *
 * 契约引用：
 *   - L1 数据层 → prisma model
 *   - L2 API 层 → server/src/<module>/route.ts
 *   - L3 同步 → server/src/entities/sync.ts (patch 片段)
 *   - L4 审批 → 通过 manifest.safety.approval 隐式接入
 *   - L5 Agent 4 处同步 → manifest / defaults / toolRuntime / planner（全是 patch 片段）
 *   - L7 测试 → server/scripts/e2e-agent-test.ts (patch 片段)
 *   - L8 前端 → packages/desktop-app/src/modules/<module>/index.tsx (独立新文件)
 *
 * 故意不做的事：
 *   - 不自动 patch 现有文件（避免冲突）
 *   - 不生成 prisma migration（schema 改动需要 review，不能盲生）
 *   - 不调用 prisma generate / tsc（generator 是脚手架，不是 CI）
 */

import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────
// Spec 定义
// ─────────────────────────────────────────────────────────────────────

type ModuleSpec = {
  /** 模块小写驼峰名，例：finance / shipping。会成为 URL/目录/scope 字面量。 */
  name: string;
  /** 模块中文显示名，例："财务管理"。会出现在文档/UI 标题。 */
  displayName: string;
  /** 模块英文 Pascal 名，例：Finance。会出现在类名/函数名前缀。 */
  pascalName: string;
  /** Prisma 模型名（PascalCase），例：FinanceVoucher。 */
  prismaModel: string;
  /** Prisma 模型小写复数（用于 prisma.x.findMany），例：financeVouchers → 实际是 prisma.financeVoucher。 */
  prismaAccessor: string;
  /** API 路径前缀（不含 /api/v1），例：finance。 */
  apiPath: string;
  /** Agent domain 名，例：finance（必须和 manifest seeds.domain 一致）。 */
  domain: string;
  /** scope 字面量，给 RBAC 用，例：finance。一般等于 domain。 */
  scope: string;
  /** 工具列表 */
  tools: ToolSpec[];
  /** 跨实体 link 类型（接入 EntityLink 拓扑） */
  links: LinkSpec[];
  /** Planner 触发关键词（中英对照正则字符串），例：'(财务|发票|invoice|payment|finance)' */
  plannerTriggers: string;
  /** 主键关联实体名，例："发票"——出现在 reason / description */
  entityNoun: string;
  /** 给 RBAC 默认 allowedRoles（read tools） */
  readRoles: string[];
  /** 给 RBAC 默认 allowedRoles（mutation tools） */
  mutationRoles: string[];
  /** 是否需要 approval（mutation 工具的审批角色） */
  approvalRoles: string[];
  /**
   * 可选：附加 prisma 模型（主 model 之外的子表，例如 finance 的 PaymentVoucher）。
   * 每个 extraModel 会在生成的 route.ts 里多产出一组 CRUD 路由，挂在 /<apiPath>/<subPath> 下。
   * 不影响 manifest/defaults/toolRuntime 的渲染——这些按 tools[] 走，与 model 数解耦。
   */
  extraModels?: ExtraModelSpec[];
};

type ExtraModelSpec = {
  /** Prisma 模型名（PascalCase），例：PaymentVoucher。 */
  prismaModel: string;
  /** prisma 客户端访问名（lowerCamel），例：paymentVoucher。 */
  prismaAccessor: string;
  /** 子路径，例：vouchers → /api/v1/finance/vouchers。 */
  subPath: string;
  /** 中文显示名，例：付款凭证。 */
  displayName: string;
  /** Pascal 名，用于函数/类型，例：Voucher。 */
  pascalName: string;
};

type ToolSpec = {
  /** 工具 ID，必须 `<domain>.<verb_snake>`，例：finance.query / finance.create_voucher。 */
  id: string;
  /** 工具显示名，PascalCase + 空格，例：Query Finance Vouchers。 */
  name: string;
  /** 中文 description（manifest）。不超过 100 字。 */
  description: string;
  /** inputHint（zod-lite 文本表达式）。 */
  inputHint: string;
  /** example.user 自然语言；example.input JSON 对象。 */
  example: { user: string; input: Record<string, unknown> };
  /** 是 read（只读）还是 mutation（写）。决定 RBAC 角色和 approval。 */
  kind: 'read' | 'mutation';
  /** mutation 时是否要 approval。read 必须 false。 */
  approval?: boolean;
  /** 风险等级，对应 defaults.ts.risk。 */
  risk: 'low' | 'medium' | 'high';
};

type LinkSpec = {
  linkKind: string;       // 例：aboutVoucher / belongsToCustomer
  fromType: string;       // 例：finance.voucher
  toType: string;         // 例：order
  notes: string;          // 注释
};

// ─────────────────────────────────────────────────────────────────────
// 内置 spec（finance，作为 dry-run 实战测试样本）
// ─────────────────────────────────────────────────────────────────────

const FINANCE_SPEC: ModuleSpec = {
  name: 'finance',
  displayName: '财务管理',
  pascalName: 'Finance',
  prismaModel: 'Invoice',
  prismaAccessor: 'invoice',
  apiPath: 'finance',
  domain: 'finance',
  scope: 'finance',
  entityNoun: '发票/收付款凭证',
  extraModels: [
    {
      prismaModel: 'PaymentVoucher',
      prismaAccessor: 'paymentVoucher',
      subPath: 'vouchers',
      displayName: '收付款凭证',
      pascalName: 'Voucher',
    },
  ],
  readRoles: ['owner', 'admin', 'manager', 'finance', 'sales', 'merchandiser'],
  mutationRoles: ['owner', 'admin', 'manager', 'finance'],
  approvalRoles: ['owner', 'admin', 'manager'],
  plannerTriggers: '(财务|发票|应收|应付|核销|收款|付款|结汇|往来|账期|invoice|payment|voucher|finance|settle|receivable|payable)',
  tools: [
    {
      id: 'finance.list_invoices',
      name: 'List Invoices',
      description: '按条件检索发票（应收/应付）。filters 走 type/status/customerRelationId/orderId/dueDate 区间。',
      inputHint: '{ filters?: { type?: "Receivable"|"Payable", status?: string[], customerRelationId?: string, orderId?: string, dueDateFrom?: string, dueDateTo?: string, currency?: string }, sort?: { field: "dueDate"|"issueDate"|"createdAt", direction: "asc"|"desc" }, limit?: number }',
      example: {
        user: '本月到期未结清的应收发票有哪些？',
        input: { filters: { type: 'Receivable', status: ['Issued', 'PartiallyPaid'], dueDateTo: '2026-06-30' }, sort: { field: 'dueDate', direction: 'asc' }, limit: 50 },
      },
      kind: 'read',
      risk: 'low',
    },
    {
      id: 'finance.get_invoice',
      name: 'Get Invoice',
      description: '按 invoiceNumber / id 读取单张发票详情（含核销快照）。',
      inputHint: '{ invoiceNumber?: string, id?: string }',
      example: {
        user: '读取发票号 INV-20260615-001 的完整信息。',
        input: { invoiceNumber: 'INV-20260615-001' },
      },
      kind: 'read',
      risk: 'low',
    },
    {
      id: 'finance.list_vouchers',
      name: 'List Payment Vouchers',
      description: '按条件检索收/付款凭证。可按 invoiceId 反查"这张发票收过哪些款"。',
      inputHint: '{ filters?: { type?: "Receipt"|"Disbursement", invoiceId?: string, customerRelationId?: string, orderId?: string, paymentDateFrom?: string, paymentDateTo?: string }, sort?: { field: "paymentDate"|"createdAt", direction: "asc"|"desc" }, limit?: number }',
      example: {
        user: '发票 INV-20260615-001 收过几笔款？',
        input: { filters: { invoiceId: '<INVOICE_ID>' }, sort: { field: 'paymentDate', direction: 'asc' }, limit: 50 },
      },
      kind: 'read',
      risk: 'low',
    },
    {
      id: 'finance.get_voucher',
      name: 'Get Payment Voucher',
      description: '按 voucherNumber / id 读取单张收/付款凭证。',
      inputHint: '{ voucherNumber?: string, id?: string }',
      example: {
        user: '读取凭证 PAY-20260615-001 的完整信息。',
        input: { voucherNumber: 'PAY-20260615-001' },
      },
      kind: 'read',
      risk: 'low',
    },
    {
      id: 'finance.query_outstanding',
      name: 'Query Outstanding Balance',
      description: '聚合查询某客户/订单的未结清应收应付（合计金额 + 笔数 + 最早到期日）。',
      inputHint: '{ scope: { customerRelationId?: string, orderId?: string }, type?: "Receivable"|"Payable", asOfDate?: string }',
      example: {
        user: '客户 Peerless 还有多少应收没收回？',
        input: { scope: { customerRelationId: '<RELATION_ID>' }, type: 'Receivable' },
      },
      kind: 'read',
      risk: 'low',
    },
    {
      id: 'finance.create_invoice',
      name: 'Create Invoice',
      description: '创建发票（应收 Receivable / 应付 Payable）。资金动作：影响应收应付账款，必须 approval。',
      inputHint: '{ type: "Receivable"|"Payable", invoiceNumber: string, amount: number, currency: string, issueDate: string, dueDate?: string, exchangeRate?: number, baseCurrency?: string, orderId?: string, customerRelationId?: string, customerName?: string, notes?: string }',
      example: {
        user: '为订单 PO-2026-001 创建一张 50000 USD 的应收发票。',
        input: { type: 'Receivable', invoiceNumber: 'INV-20260615-001', amount: 50000, currency: 'USD', issueDate: '2026-06-15', dueDate: '2026-09-13', exchangeRate: 7.18, orderId: '<ORDER_ID>', customerRelationId: '<RELATION_ID>' },
      },
      kind: 'mutation',
      approval: true,
      risk: 'high',
    },
    {
      id: 'finance.create_voucher',
      name: 'Create Payment Voucher',
      description: '创建收/付款凭证（资金实际入/出账）。资金动作：必须 approval。',
      inputHint: '{ type: "Receipt"|"Disbursement", voucherNumber: string, amount: number, currency: string, paymentDate: string, paymentMethod: string, exchangeRate?: number, bankFee?: number, invoiceId?: string, appliedAmount?: number, orderId?: string, customerRelationId?: string, customerName?: string, notes?: string }',
      example: {
        user: '收到客户 Peerless 一笔 30000 USD 的 TT 收款，对应发票 INV-20260615-001。',
        input: { type: 'Receipt', voucherNumber: 'PAY-20260615-001', amount: 30000, currency: 'USD', paymentDate: '2026-06-15', paymentMethod: 'TT', invoiceId: '<INVOICE_ID>', appliedAmount: 30000, customerRelationId: '<RELATION_ID>' },
      },
      kind: 'mutation',
      approval: true,
      risk: 'high',
    },
    {
      id: 'finance.apply_voucher_to_invoice',
      name: 'Apply Voucher To Invoice',
      description: '把已挂账的凭证核销到指定发票（更新 invoiceId / appliedAmount，并按累计核销额刷新发票 status：PartiallyPaid / Paid）。资金动作：必须 approval。',
      inputHint: '{ voucherId: string, invoiceId: string, appliedAmount: number, notes?: string }',
      example: {
        user: '把凭证 PAY-20260615-001 中的 20000 USD 核销到发票 INV-20260615-001。',
        input: { voucherId: '<VOUCHER_ID>', invoiceId: '<INVOICE_ID>', appliedAmount: 20000 },
      },
      kind: 'mutation',
      approval: true,
      risk: 'high',
    },
  ],
  links: [
    {
      linkKind: 'aboutOrder',
      fromType: 'invoice',
      toType: 'order',
      notes: '发票关联订单整体（区别 aboutProduct 的单 SKU）',
    },
    {
      linkKind: 'billTo',
      fromType: 'invoice',
      toType: 'relation.organization',
      notes: '发票的结算/开票对象（客户或供应商组织）',
    },
    {
      linkKind: 'aboutOrder',
      fromType: 'paymentVoucher',
      toType: 'order',
      notes: '凭证关联订单（便于按订单聚合资金流）',
    },
    {
      linkKind: 'billTo',
      fromType: 'paymentVoucher',
      toType: 'relation.organization',
      notes: '凭证交易对象（客户或供应商组织）',
    },
    {
      linkKind: 'settlesInvoice',
      fromType: 'paymentVoucher',
      toType: 'invoice',
      notes: '凭证核销的发票（资金销账动作；区别 belongsTo 的"属于"语义）',
    },
  ],
};

const SPECS: Record<string, ModuleSpec> = {
  finance: FINANCE_SPEC,
};

// ─────────────────────────────────────────────────────────────────────
// 工具：渲染辅助
// ─────────────────────────────────────────────────────────────────────

function rolesArray(roles: string[]): string {
  return `[${roles.map(r => `'${r}'`).join(', ')}]`;
}

function jsonInline(obj: unknown): string {
  return JSON.stringify(obj);
}

function bannerLine(msg: string): string {
  return `\n${'─'.repeat(78)}\n  ${msg}\n${'─'.repeat(78)}`;
}

// ─────────────────────────────────────────────────────────────────────
// 1. 独立新文件：server/src/<module>/route.ts
// ─────────────────────────────────────────────────────────────────────

function renderRouteFile(spec: ModuleSpec): string {
  const M = spec.pascalName;
  const m = spec.prismaAccessor;
  const noun = spec.entityNoun;
  return `/**
 * ${spec.displayName} API — /api/v1/${spec.apiPath}
 *
 * 由 scaffold-module.ts 生成于 ${new Date().toISOString()}.
 * 生成器只搭骨架，业务校验/字段白名单/审计需要人工补全。
 *
 * 契约钩子（来自 docs/MODULE_CONTRACT.md）：
 *   - L2.2 输入校验：在每个 mutation 入口加 zod / 手写白名单
 *   - L3.1 EntityLink 同步：mutation 必须调用 sync${M}References
 *   - L4 审批：高风险 mutation 默认走 manifest.safety.approval=required
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
// TODO[L3]: import { sync${M}References } from '../entities/sync';

export interface ${M}RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

type ${M}CreateInput = {
  // TODO[L1]: 根据 prisma.${spec.prismaModel} 字段补齐
  voucherNo: string;
  type: string;
  amount: number;
  currency: string;
};

export function create${M}Router(options: ${M}RouterOptions): Router {
  const { prisma, onDataChange } = options;
  const router = Router();

  // GET /api/v1/${spec.apiPath} — list / search
  router.get('/', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const items = await prisma.${m}.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      });
      res.json({ items, total: items.length });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });
    }
  });

  // GET /api/v1/${spec.apiPath}/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const item = await prisma.${m}.findUnique({ where: { id: req.params.id } });
      if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '${noun}不存在' } });
      res.json(item);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'GET_FAILED', message: err.message } });
    }
  });

  // POST /api/v1/${spec.apiPath} — create (high risk, approval upstream)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const input = req.body as ${M}CreateInput;
      // TODO[L2.2]: 字段白名单 + 必填校验
      const created = await prisma.${m}.create({ data: input as any });
      // TODO[L3.1]: await sync${M}References(prisma, created.id, { source: 'route:create' });
      onDataChange?.({ entity: '${spec.name}', action: 'create', ids: [created.id] });
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'CREATE_FAILED', message: err.message } });
    }
  });

  // PATCH /api/v1/${spec.apiPath}/:id
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const updated = await prisma.${m}.update({ where: { id: req.params.id }, data: req.body });
      // TODO[L3.1]: await sync${M}References(prisma, updated.id, { source: 'route:update' });
      onDataChange?.({ entity: '${spec.name}', action: 'update', ids: [updated.id] });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'UPDATE_FAILED', message: err.message } });
    }
  });
${renderExtraModelRoutes(spec)}
  return router;
}
`;
}

/**
 * 为每个 extraModel 渲染一组 CRUD 路由（list/get/create/update），
 * 挂在 /api/v1/<apiPath>/<subPath> 下。返回值会被注入到 renderRouteFile 末尾。
 *
 * 说明：spec.extraModels 不影响 manifest/defaults/toolRuntime 的渲染——
 * 这些按 tools[] 走，与 model 数解耦；工具具体路由到哪个 prisma accessor
 * 由 toolRuntime patch 的 stub 实现决定。
 */
function renderExtraModelRoutes(spec: ModuleSpec): string {
  const extras = spec.extraModels;
  if (!extras || extras.length === 0) return '';

  const blocks = extras.map(em => {
    const M = em.pascalName;
    const acc = em.prismaAccessor;
    const sub = em.subPath;
    return [
      ``,
      `  // ────────────────────────────────────────────────────────────────`,
      `  // ${em.displayName}（${em.prismaModel}） — /api/v1/${spec.apiPath}/${sub}`,
      `  // ────────────────────────────────────────────────────────────────`,
      ``,
      `  // GET /api/v1/${spec.apiPath}/${sub} — list / search`,
      `  router.get('/${sub}', async (req: Request, res: Response) => {`,
      `    try {`,
      `      const limit = Math.min(Number(req.query.limit) || 50, 200);`,
      `      const offset = Number(req.query.offset) || 0;`,
      `      const items = await (prisma as any).${acc}.findMany({`,
      `        take: limit,`,
      `        skip: offset,`,
      `        orderBy: { createdAt: 'desc' },`,
      `      });`,
      `      res.json({ items, total: items.length });`,
      `    } catch (err: any) {`,
      `      res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });`,
      `    }`,
      `  });`,
      ``,
      `  // GET /api/v1/${spec.apiPath}/${sub}/:id`,
      `  router.get('/${sub}/:id', async (req: Request, res: Response) => {`,
      `    try {`,
      `      const item = await (prisma as any).${acc}.findUnique({ where: { id: req.params.id } });`,
      `      if (!item) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '${em.displayName}不存在' } });`,
      `      res.json(item);`,
      `    } catch (err: any) {`,
      `      res.status(500).json({ error: { code: 'GET_FAILED', message: err.message } });`,
      `    }`,
      `  });`,
      ``,
      `  // POST /api/v1/${spec.apiPath}/${sub} — create (high risk, approval upstream)`,
      `  router.post('/${sub}', async (req: Request, res: Response) => {`,
      `    try {`,
      `      // TODO[L2.2]: 字段白名单 + 必填校验`,
      `      const created = await (prisma as any).${acc}.create({ data: req.body });`,
      `      // TODO[L3.1]: await sync${M}References(prisma, created.id, { source: 'route:create' });`,
      `      onDataChange?.({ entity: '${spec.name}.${sub}', action: 'create', ids: [created.id] });`,
      `      res.status(201).json(created);`,
      `    } catch (err: any) {`,
      `      res.status(500).json({ error: { code: 'CREATE_FAILED', message: err.message } });`,
      `    }`,
      `  });`,
      ``,
      `  // PATCH /api/v1/${spec.apiPath}/${sub}/:id`,
      `  router.patch('/${sub}/:id', async (req: Request, res: Response) => {`,
      `    try {`,
      `      const updated = await (prisma as any).${acc}.update({ where: { id: req.params.id }, data: req.body });`,
      `      // TODO[L3.1]: await sync${M}References(prisma, updated.id, { source: 'route:update' });`,
      `      onDataChange?.({ entity: '${spec.name}.${sub}', action: 'update', ids: [updated.id] });`,
      `      res.json(updated);`,
      `    } catch (err: any) {`,
      `      res.status(500).json({ error: { code: 'UPDATE_FAILED', message: err.message } });`,
      `    }`,
      `  });`,
      ``,
    ].join('\n');
  });

  return blocks.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// 2. 独立新文件：前端模块骨架
// ─────────────────────────────────────────────────────────────────────

function renderFrontendModule(spec: ModuleSpec): string {
  return `/**
 * ${spec.displayName} 前端模块骨架
 * 由 scaffold-module.ts 生成于 ${new Date().toISOString()}.
 *
 * 契约钩子（来自 docs/MODULE_CONTRACT.md）：
 *   - L8.1 路由注册：在 moduleRegistry 加 { id: '${spec.name}', label: '${spec.displayName}', view: ${spec.pascalName}Manager }
 *   - L8.2 跨模块跳转：DetailPanel "关联视图"卡片需要识别本模块的 entity type
 *   - L8.3 i18n：把 displayName 抽到 i18n key '${spec.name}.title'
 */
import React from 'react';

export const ${spec.pascalName}Manager: React.FC = () => {
  return (
    <div className="${spec.name}-manager">
      <h1>${spec.displayName}</h1>
      <p>TODO[L8]: 列表 + 详情 + 创建表单</p>
    </div>
  );
};

export default ${spec.pascalName}Manager;
`;
}

// ─────────────────────────────────────────────────────────────────────
// 3. 高频文件 patch 片段：manifest.ts
// ─────────────────────────────────────────────────────────────────────

function renderManifestPatch(spec: ModuleSpec): string {
  const seeds = spec.tools.map(t => {
    const safetyPart = t.kind === 'mutation'
      ? `\n    safety: { approval: '${t.approval ? 'always' : 'never'}', sideEffects: true },`
      : '';
    return `  {
    id: '${t.id}',
    name: '${t.name}',
    domain: '${spec.domain}',
    description: '${t.description.replace(/'/g, "\\'")}',
    inputHint: '${t.inputHint.replace(/'/g, "\\'")}',
    example: {
      user: '${t.example.user.replace(/'/g, "\\'")}',
      input: ${jsonInline(t.example.input)},
    },${safetyPart}
  },`;
  }).join('\n');

  return `// ── 插入位置：server/src/agent/mcp/manifest.ts，在 MANIFEST_SEEDS 数组末尾追加 ──
// （在最后一个 } 之前粘贴下面的内容）

${seeds}
`;
}

// ─────────────────────────────────────────────────────────────────────
// 4. 高频文件 patch 片段：defaults.ts
// ─────────────────────────────────────────────────────────────────────

function renderDefaultsPatch(spec: ModuleSpec): string {
  const items = spec.tools.map(t => {
    const allowed = t.kind === 'read' ? spec.readRoles : spec.mutationRoles;
    const approvalLine = (t.kind === 'mutation' && t.approval)
      ? `\n    approvalRoles: ${rolesArray(spec.approvalRoles)},`
      : '';
    return `  {
    id: '${t.id}',
    name: '${t.name}',
    scope: '${spec.scope}',
    risk: '${t.risk}',
    allowedRoles: ${rolesArray(allowed)},${approvalLine}
  },`;
  }).join('\n');

  return `// ── 插入位置：server/src/agent/defaults.ts，在 DEFAULT_AGENT_TOOLS 数组末尾追加 ──
// （在最后一个 } 之前粘贴下面的内容）

  // ${spec.displayName} (${spec.name}) — generated by scaffold-module.ts
${items}
`;
}

// ─────────────────────────────────────────────────────────────────────
// 5. 高频文件 patch 片段：toolRuntime.ts
// ─────────────────────────────────────────────────────────────────────

function renderToolRuntimePatch(spec: ModuleSpec): string {
  const dispatches = spec.tools.map(t => {
    const fnName = `handle${spec.pascalName}${t.id.split('.')[1]
      .split('_')
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')}`;
    return `  if (call.toolId === '${t.id}') return ${fnName}(prisma, call.input);`;
  }).join('\n');

  const stubs = spec.tools.map(t => {
    const fnName = `handle${spec.pascalName}${t.id.split('.')[1]
      .split('_')
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')}`;
    return `async function ${fnName}(prisma: PrismaClient, input: any): Promise<any> {
  // TODO[L5.3]: 实现 ${t.name}
  // ${t.description}
  throw new Error('${t.id} not implemented');
}`;
  }).join('\n\n');

  return `// ── 插入位置 1：server/src/agent/toolRuntime.ts，在 dispatch 链末尾（development.* 之后）追加 ──
${dispatches}

// ── 插入位置 2：server/src/agent/toolRuntime.ts，文件末尾追加实现 stubs ──
${stubs}
`;
}

// ─────────────────────────────────────────────────────────────────────
// 6. 高频文件 patch 片段：planner.ts
// ─────────────────────────────────────────────────────────────────────

function renderPlannerPatch(spec: ModuleSpec): string {
  const queryTool = spec.tools.find(t => t.kind === 'read' && t.id.endsWith('.query'))
    || spec.tools.find(t => t.kind === 'read' && /list_/i.test(t.id))
    || spec.tools.find(t => t.kind === 'read');
  const queryToolId = queryTool ? queryTool.id : `${spec.domain}.query`;
  return [
    `// ── 插入位置：server/src/agent/mcp/planner.ts，在 development 触发块之后追加 ──`,
    ``,
    `  // ── ${spec.displayName} (${spec.domain}) ──`,
    `  // Triggers when the user asks about ${spec.entityNoun}.`,
    `  if (/${spec.plannerTriggers}/i.test(query)) {`,
    `    pushStep(steps, seen, {`,
    `      toolId: '${queryToolId}',`,
    `      input: {`,
    `        query: extractEntitySearchQuery(query) || query,`,
    `        limit: extractLimit(query, 10),`,
    `      },`,
    `      reason: '用户询问${spec.entityNoun}，需要查询 ${spec.prismaModel} 表',`,
    `    }, '读取${spec.entityNoun}候选', manifestIds);`,
    `  }`,
    ``,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// 7. 高频文件 patch 片段：sync.ts
// ─────────────────────────────────────────────────────────────────────

function renderSyncPatch(spec: ModuleSpec): string {
  const M = spec.pascalName;
  const m = spec.prismaAccessor;
  const linkBlocks = spec.links.map(link => `      // ${link.notes}
      // ${link.fromType} → ${link.toType} (${link.linkKind})`).join('\n');

  return [
    `// ── 插入位置：server/src/entities/sync.ts，在文件末尾追加 ──`,
    ``,
    `/**`,
    ` * ${spec.displayName}：双写 EntityLink + EntityReference`,
    ` *`,
    ` * 链接类型：`,
    ...spec.links.map(l => ` *   - ${l.linkKind}: ${l.fromType} → ${l.toType} (${l.notes})`),
    ` */`,
    `export async function sync${M}References(`,
    `  prisma: PrismaClient,`,
    `  ${spec.name}Id: string,`,
    `  options: { source: string } = { source: 'unknown' }`,
    `): Promise<void> {`,
    `  const item = await prisma.${m}.findUnique({ where: { id: ${spec.name}Id } });`,
    `  if (!item) return;`,
    ``,
    `  // TODO[L3.1]: 根据 spec.links 双写 EntityLink + EntityReference`,
    linkBlocks,
    `  // 参考 syncDevelopmentCaseReferences 的实现模板`,
    `}`,
    ``,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// 8. 高频文件 patch 片段：e2e-agent-test.ts
// ─────────────────────────────────────────────────────────────────────

function renderE2ePatch(spec: ModuleSpec): string {
  const cases = spec.tools.map(t => {
    return `    {
      name: '${t.id}',
      toolId: '${t.id}',
      input: ${jsonInline(t.example.input)},
      expectApproval: ${t.kind === 'mutation' && t.approval ? 'true' : 'false'},
    },`;
  }).join('\n');

  const plannerCase = `    {
      name: 'planner-${spec.domain}',
      query: '${spec.tools[0]?.example.user || `查询${spec.entityNoun}`}',
      expectToolIds: [${spec.tools.filter(t => t.kind === 'read').slice(0, 1).map(t => `'${t.id}'`).join(', ')}],
    },`;

  return [
    `// ── 插入位置 1：server/scripts/e2e-agent-test.ts，在 EXECUTOR_CASES 数组末尾追加 ──`,
    ``,
    `    // ${spec.displayName} (${spec.domain})`,
    cases,
    ``,
    `// ── 插入位置 2：server/scripts/e2e-agent-test.ts，在 PLANNER_CASES 数组末尾追加 ──`,
    ``,
    plannerCase,
    ``,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// 9. PR Checklist 渲染
// ─────────────────────────────────────────────────────────────────────

function renderPrChecklist(spec: ModuleSpec): string {
  return [
    `## PR Checklist: 新增 ${spec.displayName} 模块`,
    ``,
    `参考 docs/MODULE_CONTRACT.md §3 PR 模板。`,
    ``,
    `### L1 数据层`,
    `- [ ] prisma/schema.prisma 新增 model ${spec.prismaModel}（含 createdAt/updatedAt）`,
    ...(spec.extraModels ?? []).map(em => `- [ ] prisma/schema.prisma 新增 model ${em.prismaModel}（${em.displayName}）`),
    `- [ ] 跑 \`npx prisma migrate dev --name add_${spec.name}\``,
    `- [ ] seed 脚本（如需要）写入 ${spec.entityNoun} 样例数据`,
    ``,
    `### L2 API 层`,
    `- [ ] server/src/${spec.name}/route.ts 已生成（生成器产物）`,
    `- [ ] server/src/index.ts 注册 \`app.use('/api/v1/${spec.apiPath}', create${spec.pascalName}Router({ prisma, ... }))\``,
    ...(spec.extraModels ?? []).map(em => `- [ ] 子表 \`${em.prismaModel}\` 的 CRUD 路由（/${spec.apiPath}/${em.subPath}）已挂载`),
    `- [ ] mutation 端点接入 \`sync${spec.pascalName}References\``,
    ...(spec.extraModels ?? []).map(em => `- [ ] mutation 端点接入 \`sync${em.pascalName}References\`（${em.displayName}）`),
    `- [ ] 错误码：CREATE_FAILED / UPDATE_FAILED / NOT_FOUND / 业务码`,
    ``,
    `### L3 EntityLink 同步`,
    `- [ ] server/src/entities/sync.ts 已加 \`sync${spec.pascalName}References\`（patch 片段）`,
    ...(spec.extraModels ?? []).map(em => `- [ ] server/src/entities/sync.ts 已加 \`sync${em.pascalName}References\`（${em.displayName}，patch 片段）`),
    ...spec.links.map(l => `- [ ] linkKind \`${l.linkKind}\` 已登记到 MODULE_CONTRACT §L3 R3.1 表格`),
    ``,
    `### L4 审批`,
    ...spec.tools.filter(t => t.kind === 'mutation' && t.approval).map(t => `- [ ] \`${t.id}\` manifest.safety.approval = required`),
    `- [ ] approval RBAC：${rolesArray(spec.approvalRoles)}`,
    ``,
    `### L5 Agent 4 处同步（最高频踩坑点）`,
    `- [ ] manifest.ts MANIFEST_SEEDS 追加 ${spec.tools.length} 条`,
    `- [ ] defaults.ts DEFAULT_AGENT_TOOLS 追加 ${spec.tools.length} 条（同步 RBAC）`,
    `- [ ] toolRuntime.ts dispatch + ${spec.tools.length} 个实现函数`,
    `- [ ] planner.ts 触发规则正则：\`/${spec.plannerTriggers}/i\``,
    ``,
    `### L7 测试`,
    `- [ ] e2e-agent-test.ts EXECUTOR_CASES 追加 ${spec.tools.length} 个用例`,
    `- [ ] e2e-agent-test.ts PLANNER_CASES 追加 1 个触发用例`,
    `- [ ] 跑 \`npx tsx scripts/e2e-agent-test.ts\` 全绿`,
    ``,
    `### L8 前端`,
    `- [ ] 模块骨架 ${spec.pascalName}Manager 已生成`,
    `- [ ] moduleRegistry 注册 \`{ id: '${spec.name}', label: '${spec.displayName}', ... }\``,
    `- [ ] DetailPanel "关联视图"识别 ${spec.name} entity type`,
    ``,
    `### 验收`,
    `- [ ] tsc --noEmit 全量 exit 0`,
    `- [ ] vite build 通过`,
    `- [ ] 数据回归：EntityLink/EntityReference 1:1 对齐`,
    ``,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { specName?: string; write: boolean; output?: string; list: boolean } {
  const out: any = { write: false, list: false };
  for (const arg of argv) {
    if (arg === '--write') out.write = true;
    else if (arg === '--list') out.list = true;
    else if (arg.startsWith('--spec=')) out.specName = arg.slice('--spec='.length);
    else if (arg.startsWith('--output=')) out.output = arg.slice('--output='.length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log('Available specs:');
    for (const name of Object.keys(SPECS)) {
      const s = SPECS[name];
      console.log(`  - ${name} (${s.displayName}, ${s.tools.length} tools)`);
    }
    return;
  }

  if (!args.specName) {
    console.error('Usage: tsx scaffold-module.ts --spec=<name> [--write] [--output=<dir>]');
    console.error('       tsx scaffold-module.ts --list');
    process.exit(1);
  }

  const spec = SPECS[args.specName];
  if (!spec) {
    console.error(`Unknown spec: ${args.specName}. Available: ${Object.keys(SPECS).join(', ')}`);
    process.exit(1);
  }

  const baseDir = path.resolve(__dirname, '..');
  const outputDir = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.resolve(baseDir, 'scaffold-output', spec.name);

  console.log(bannerLine(`Scaffolding module: ${spec.name} (${spec.displayName})`));
  console.log(`  Mode: ${args.write ? 'WRITE (落盘)' : 'DRY-RUN (只打印)'}`);
  console.log(`  Output dir for new files: ${outputDir}`);
  console.log(`  Tools: ${spec.tools.length} (${spec.tools.filter(t => t.kind === 'read').length} read / ${spec.tools.filter(t => t.kind === 'mutation').length} mutation)`);
  console.log(`  Links: ${spec.links.length}`);

  // 独立新文件
  const standaloneFiles: Array<{ relPath: string; content: string }> = [
    { relPath: 'src/' + spec.name + '/route.ts', content: renderRouteFile(spec) },
    { relPath: 'scaffold-frontend/' + spec.pascalName + 'Manager.tsx', content: renderFrontendModule(spec) },
  ];

  console.log(bannerLine('独立新文件'));
  for (const f of standaloneFiles) {
    const absPath = path.join(outputDir, f.relPath);
    if (args.write) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, f.content);
      console.log('  ✅ WROTE: ' + absPath + ' (' + f.content.length + ' chars)');
    } else {
      console.log('  📄 ' + f.relPath + ' (' + f.content.length + ' chars) — preview first 6 lines:');
      console.log(f.content.split('\n').slice(0, 6).map(l => '       ' + l).join('\n'));
    }
  }

  // 高频文件 patch 片段
  const patches: Array<{ label: string; content: string }> = [
    { label: 'L5.1 manifest.ts', content: renderManifestPatch(spec) },
    { label: 'L5.2 defaults.ts (RBAC)', content: renderDefaultsPatch(spec) },
    { label: 'L5.3 toolRuntime.ts', content: renderToolRuntimePatch(spec) },
    { label: 'L6 planner.ts', content: renderPlannerPatch(spec) },
    { label: 'L3 sync.ts', content: renderSyncPatch(spec) },
    { label: 'L7 e2e-agent-test.ts', content: renderE2ePatch(spec) },
  ];

  console.log(bannerLine('高频文件 PATCH 片段（人工 copy-paste）'));
  for (const p of patches) {
    console.log('\n>>> ' + p.label + ' <<<');
    console.log(p.content);
  }

  // PR Checklist
  const checklist = renderPrChecklist(spec);
  console.log(bannerLine('PR CHECKLIST（粘贴到 PR description）'));
  console.log(checklist);

  if (args.write) {
    const checklistPath = path.join(outputDir, 'PR_CHECKLIST.md');
    fs.mkdirSync(path.dirname(checklistPath), { recursive: true });
    fs.writeFileSync(checklistPath, checklist);
    console.log('\n  ✅ WROTE: ' + checklistPath);
  }

  console.log(bannerLine('Done.'));
  console.log('  Next steps:');
  console.log('    1. 阅读 docs/MODULE_CONTRACT.md §3 PR 模板');
  console.log('    2. 把 patch 片段 copy-paste 到对应高频文件');
  console.log('    3. 跑 npx tsc --noEmit + npx tsx scripts/e2e-agent-test.ts');
  console.log('    4. 用 PR Checklist 自查覆盖度');
}

main();
