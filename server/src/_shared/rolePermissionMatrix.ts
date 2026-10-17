/**
 * rolePermissionMatrix.ts — 角色权限矩阵单一权威真源（Phase 0-01）
 *
 * 设计原则：
 *   - 所有权限字符串都在此文件定义为 TS 常量/枚举，绝不允许业务代码手写 'orders:write' 等字符串
 *   - 7 个系统内置角色（GAP-R11 已收口：Sales/SalesManager/Finance/Admin/QC/Logistics/SuperAdmin；
 *     FinanceManager 已删除收编——付款审批权上抬 SM/总领导，退税审批归 Finance，见其位移注释）
 *     的 默认模块权限位（R/W/D/A + 敏感字段 + 行级数据范围） 全部在此硬编码，
 *     DB 中的 Role/Permission/RolePermission 表运行时可以 UI 调整，
 *     但初始化 seed 和 代码级判断的 fallback 默认值 必须 从这里取。
 *   - 决策依据来源：PL-1A（贸易公司典型矩阵） + PL-2B（同部门互相可见，跨部门隔离）
 *     ＋ 10 处和推荐不一致的用户选择 已全部对齐。
 *
 * 本文件被三处消费：
 *   1. server/scripts/seed-rbac.ts — 首次部署时写 DB
 *   2. server/src/auth/permissionGuard.ts — 后端守卫运行时判断（DB 中找不到该权限时 fallback 这里的默认值）
 *   3. 前端 components/* 各处按钮显隐、敏感字段遮罩 — /api/auth/permissions 拉取当前用户权限后用工具函数判断
 *
 * ★★ 审批类权限码的口径（2026-09-17 业务方拍板，**口径 B1**）：
 *   下面这 13 个审批码**只作界面上的「能力标签」，不是强制门禁** ——
 *   审批实际走 `approvals/` 内核（`approvalRoutingService` + 审批策略，按策略自动找人）。
 *   ⚠️ 它们已登记为 `ui-label-only`（见 `server/src/auth/__tests__/danglingScopeConsumption.test.ts`），
 *   **那是"设计如此"、不是"欠账"** —— 别去给它们"接通门禁"，那会改变业务方确认过的行为：
 *     orders:approve:change_delivery / change_qty / change_price / cancel
 *     quotations:approve · procurement:approve · shipments:approve · knowledge:approve
 *     invoices:approve:writeoff
 *     vouchers:approve:pay_lt5 / pay_gt5 / pay_new_supplier
 *     finance:payment_request:approve
 *   见 `docs/业务口径决策单-2026-09-17.md` **B1**。
 */

import { View } from './_typesView';

// ═══════════════════════════════════════════════════════════════════
// 1. 系统内置角色（不可删除，isSystem=true，DB Role 表 seed 时对应 id）
// ═══════════════════════════════════════════════════════════════════

export const SYSTEM_ROLE_IDS = {
  SALES: 'role-sales',
  SALES_MANAGER: 'role-sales-manager',
  FINANCE: 'role-finance',
  ADMIN: 'role-admin',
  QC: 'role-qc',
  LOGISTICS: 'role-logistics',
  SUPER_ADMIN: 'role-super-admin',
} as const;

export type SystemRoleId = (typeof SYSTEM_ROLE_IDS)[keyof typeof SYSTEM_ROLE_IDS];

export const SYSTEM_ROLE_META: Record<SystemRoleId, { name: string; description: string; rank: number }> = {
  [SYSTEM_ROLE_IDS.SALES]: {
    name: '业务员',
    description: '业务部一线跟单/报价/开发/采购及相关库存操作；仅本人及同部门数据',
    rank: 1,
  },
  [SYSTEM_ROLE_IDS.SALES_MANAGER]: {
    name: '销售主管',
    description: '业务部小团队负责人；本团队变更审批权',
    rank: 2,
  },
  [SYSTEM_ROLE_IDS.FINANCE]: {
    name: '财务',
    description: '财务部会计/出纳；全公司财务数据可读写，业务域只读',
    rank: 2,
  },
  // §10.4.1（2026-09-12 业务方定案）：六业务角色不再新增，按现有内置角色落位——
  // 系统管理员 = 业务上的「领导」，超级管理员 = 「总经理」。改名只影响展示与 seed 的
  // Role.name，判定一律走 role id（见 admin/route.ts isSuperAdminRole），不依赖名字。
  [SYSTEM_ROLE_IDS.ADMIN]: {
    name: '领导',
    description:
      '业务线上的总经理/领导：审批中心、电子签、全局总览、PP 样放行签字与特批；兼管账号/角色/权限/字典等系统配置。' +
      '敏感字段可见成本/利润/佣金/税基，**不可见员工薪酬**（仅总经理可见）',
    rank: 3,
  },
  [SYSTEM_ROLE_IDS.QC]: {
    name: 'QC',
    description: '质检专员；QC 疵点录入/验货任务执行，业务域只读',
    rank: 2,
  },
  [SYSTEM_ROLE_IDS.LOGISTICS]: {
    name: '后勤',
    description: '物流/单证专员；运单/装箱/报关单证管理，业务域只读',
    rank: 2,
  },
  [SYSTEM_ROLE_IDS.SUPER_ADMIN]: {
    name: '总经理',
    description: '最高权限；所有模块 R/W/D/A，权限配置，审计日志全可见，唯一可看员工薪酬；不可删除此角色账户',
    rank: 10,
  },
};

// ═══════════════════════════════════════════════════════════════════
// 2. 模块权限位 (R=读 W=写 D=删 A=审批) + 敏感字段可见位 (S)
// ═══════════════════════════════════════════════════════════════════

export type ModulePermissionBit = 'R' | 'W' | 'D' | 'A' | 'S';
/** 敏感字段可见 (S) 的细粒度：把模块内多个敏感字段拆成独立 scope 可分别授权 */
export type SensitiveFieldScope =
  | 'cost'        // 采购价/BOM成本/PO金额等采购侧成本
  | 'profit'      // 毛利/毛利率/利润率等利润数据
  | 'commission'  // 佣金率/佣金金额
  | 'salary'      // 薪资/HR薪酬
  | 'tax_base';   // 进项税/退税基数等税务底值
type PermissionBitsSet = Partial<Record<ModulePermissionBit, true>>;

// ═══════════════════════════════════════════════════════════════════
// 3. 权限 scope 字符串常量（和 Permission.scope DB 字段一致）
//    命名约定：<module-or-domain>:<action>
// ═══════════════════════════════════════════════════════════════════

export const PERMISSION_SCOPES = {
  // --- 经营总览域 ---
  'dashboard:read': '全景看板查看',
  'cockpit:read': '经营驾驶舱查看（含财务敏感KPI）',
  'reports:read': '报表中心查看与运行',
  'reports:write': '报表设计器/保存自定义报表',
  'reports:admin': '报表订阅推送/全员模板管理',
  'ai:chat': 'AI助手对话（含只读查询）',
  'ai:write:low': 'AI助手执行低风险写入（登记跟进/加标签）',
  'ai:write:medium': 'AI助手执行中风险写入（需确认）',
  'ai:write:high': 'AI助手执行高风险写入（需二次验证）',

  // --- 客户与市场域 ---
  'relations:read': '业务伙伴档案查看',
  'relations:write': '业务伙伴档案新增/编辑',
  'relations:delete': '业务伙伴档案删除（高危）',
  'relations:admin': '客户等级ABC/信用评级人工调整',
  'crm:read': 'CRM跟进记录查看',
  'crm:write': 'CRM跟进记录登记/编辑',
  'suppliers:read': '供应商档案查看',
  'suppliers:write': '供应商档案新增/编辑',
  'suppliers:admin': '供应商评级调整/暂停新单/解除',
  'seasons:read': '季节/季度看板查看',
  'seasons:write': '季节项目创建/编辑',
  'marketing:read': '营销活动与ROI查看',
  'marketing:write': '营销活动创建/编辑',
  'emails:read': '业务邮件查看',
  'emails:write': '邮件发送/草稿编辑',
  'emails:admin': '邮件账户绑定/全局分类规则配置',
  'emails:maintenance:write': '邮件历史维护（关联回填/分类回填）',

  // --- 订单履约域 ---
  'orders:read': '订单管理查看',
  'orders:write': '订单创建/编辑（Draft/Confirmed阶段）',
  'orders:delete': '订单删除',
  'business:delete': '业务记录删除（订单、货运单及分配、关系档案；原 owner/admin/manager 角色组）',
  'agent:approvals:approve': 'Agent 待批工具调用的批准/驳回',
  'orders:approve:change_delivery': '订单变更-交期（≤7天由SM，>7天总监）审批',
  'orders:approve:change_qty': '订单变更-数量（±10%内SM，超总监）审批',
  'orders:approve:change_price': '订单变更-价格 双签（FinMan+SM）审批',
  'orders:approve:cancel': '订单取消 三签审批',
  'quotations:read': '报价单查看',
  'quotations:write': '报价单创建/编辑',
  'quotations:approve': '报价单审批（偏差block级）',
  'quotations:convert': '报价单转化为订单',
  'products:read': '产品数字档案查看',
  'products:write': '产品档案新增/编辑',
  'bom:read': 'BOM成本核算查看',
  'bom:write': 'BOM创建/编辑（Draft态）',
  'bom:admin': 'BOM版本状态变更（Active/Obsolete）+ 新增自定义计算模型',
  'production:read': '生产跟踪/阶段看板查看',
  'production:write': '生产阶段登记/QC疵点录入',
  'shipments:read': '运单与发货查看',
  'shipments:write': '运单创建/装箱/发货登记',
  'shipments:approve': '发货放行审批（大货最终放行）',
  'customs:read': '报关单证/外贸单证查看',
  'customs:write': '单证签发/修正案创建',
  'customs:clear': '登记出口清关完成（海关放行事实；仅后勤/单证与领导）',
  'customs:admin': '单证模板/公司抬头签章配置',
  'qc:read': '质检工作台/疵点记录查看',
  'qc:write': 'QC疵点录入/QC结果登记',
  'qc:inspect': '专业 QC 检验与正式样品评审执行',
  'aftersales:read': '售后客诉登记查看',
  'aftersales:write': '客诉登记/扣赔处理录入',
  'aftersales:approve': '客诉扣赔/折让审批（影响应收金额）',
  'procurement:read': '采购订单PO查看',
  'procurement:write': '采购订单PO创建/编辑',
  'inventory:read': '库存查看',
  'inventory:write': '库存实物动作登记',
  'procurement:approve': '采购订单PO审批+首单供应商+1级审批',

  // --- 财务与成本域 ---
  'finance:read': '财务看板/账龄/报表查看',
  'invoices:read': '应收应付发票查看',
  'invoices:write': '发票创建/签发（Commercial Invoice）',
  'invoices:reconcile': '发票核销（收付款分配到发票）',
  'invoices:suggest_match': '提出回款匹配建议（不写核销账）',
  'invoices:approve:writeoff': '坏账核销/发票作废审批',
  'vouchers:read': '收付款凭证查看',
  'vouchers:write': '收付款凭证录入',
  'vouchers:approve:pay_lt5': '付款申请审批（≤5万RMB，财务主管）',
  'vouchers:approve:pay_gt5': '付款申请审批（>5万RMB，总监）',
  'vouchers:approve:pay_new_supplier': '首单付款+1级审批（总经理级）',
  'pricing:read': '定价与利润/退税率表查看',
  'pricing:write': '退税率表维护/定价记录创建',
  'pricing:admin': '默认利润率/客户等级调整%/佣金规则配置',
  'vat:read': '增值税发票/进项/销项查看',
  'vat:write': 'VAT发票登记/勾选认证',
  'tax:read': '出口退税申报查看',
  'tax:write': '退税申报录入',
  'tax:approve': '退税申报提交审批',
  'remit:read': '付汇水单/外汇业务查看',
  'remit:write': '付汇水单登记',
  'fx:lock': '汇率锁定（远期结售汇）登记/分配',
  'risk:read': '风险管理-预警/信用/合规/质量 总览查看',
  'risk:write': '预警确认/解决/信用评级录入',
  'risk:admin': '信用额度调整/合规豁免（高危，总监级）',

  // --- 平台域 ---
  'knowledge:read': '知识库/数据中心看板查看',
  'knowledge:write': '知识库文档创建/草稿',
  'knowledge:approve': '知识库文档发布审核',
  'knowledge:admin': '归档/恢复/全库ACL配置',
  'tools:execute': '业务工具（8个小工具）使用权限',
  'settings:account': '个人账户设置（密码/通知偏好/头像）',
  'settings:system:read': '系统设置查看（仅Admin可见内容）',
  'users:read': '后台管理-用户/角色/部门查看',
  'users:write': '后台管理-用户创建/编辑/角色分配',
  'users:admin': '用户删除/权限矩阵修改/SuperAdmin角色授予（仅SuperAdmin）',
  'audit:read': '审计日志查看',
  'audit:export': '审计日志导出CSV（仅FinanceMan+/Admin+）',
  'dictionary:write': '数据字典（枚举值真源）增删改',
  'hr:read': 'HR人事-员工档案/考勤/薪酬查看',
  'hr:write': 'HR人事-员工/入职/调动编辑',
  'hr:salary:read': '薪酬明细查看（极敏感，仅SuperAdmin + 指定HR）',
  'data:import': 'Excel批量导入（订单/产品/客户/供应商）',
  'data:export:full': '全量数据导出/迁移（高危，仅SuperAdmin）',

  // --- 敏感字段查看权限（细粒度，单独scope而不是简单模块S位）---
  'sensitive:cost': '敏感-成本/采购价/BOM成本 查看（S:cost）',
  'sensitive:profit': '敏感-毛利/毛利率/利润率 查看（S:profit）',
  'sensitive:commission': '敏感-佣金率/佣金金额 查看（S:commission）',
  'sensitive:salary': '敏感-员工薪酬明细 查看（S:salary）',
  'sensitive:tax_base': '敏感-进项税/退税计税底值 查看（S:tax_base）',

  // --- Phase 1 预分配（DR-007 审批组织归属 + Phase 2 全域模块 scope，避免并行代理抢改本文件）---
  'settings:moq:write': 'MOQ 阈值配置写入（设置后台）',
  // ★ 2026-09-29：公差标准（双轨制：我方内部一套 + 客户一套，客户 P0）
  'settings:tolerance:write': '内部公差标准写入（设置后台；数量公差 / 幅宽扣款分档表）',
  'moq:line_override': 'MOQ 行级覆盖申请（订单行降级/调整）',
  'moq:capsule_exemption:write': 'MOQ Capsule 档豁免审批/写入',
  'order:change_request:create': '订单变更申请创建（交期/数量/价格）',
  'order:change_request:apply': '订单变更申请审批通过后的生效执行',
  'sample:early_production:write': '早期生产样登记/写入（DR-015）',
  'sample:shipment:write': '船样登记/写入（S/S）',
  'sample:color_batch:write': '打色批次登记/客户判定写入（REQ2-01 色差管理）',
  'sample:room:write': '样品间样卡登记/借出/归还/看样登记（REQ2-16）',
  'production:pp_release:production_sign': '产前样放行-生产部签署（DR-053 阶段 2）',
  'production:pp_release:business_sign': '产前样放行-业务部签署（DR-053 阶段 2）',
  'production:pp_release:admin': '产前样放行-暂停/撤销/恢复（DR-053 阶段 2）',
  'exception:dr013:create': 'DR-013 受控例外申请创建',
  'finance:payment_request:create': '付款申请创建',
  'finance:payment_request:approve': '付款申请审批',
  'credit:freeze:write': '客户信用冻结（高危）',
  'credit:thaw:write': '客户信用解冻（高危）',
  'order:internal_trade:write': '内部交易（内部面料结算价 DR-006）写入',
  'qc:fabric_chain:write': 'QC 面料链（DR-029）业务登记写入',
  'qc:garment_chain:write': 'QC 成衣链业务登记写入',
  'settings:automation:write': '自动化规则配置写入（后台管理）',
} as const satisfies Record<string, string>;

export type PermissionScope = keyof typeof PERMISSION_SCOPES;

// ═══════════════════════════════════════════════════════════════════
// 4. 模块 → 主权限 scope 映射（读/写/删/审批 各对应哪个scope）
//    View 枚举已经在 types.ts 有36个视图，这里把视图和主scope绑定
// ═══════════════════════════════════════════════════════════════════

export interface ViewPermissionScopes {
  read: PermissionScope;      // R
  write?: PermissionScope;    // W
  delete?: PermissionScope;   // D
  approve?: PermissionScope;  // A 主审批（具体子审批另有scope）
  sensitive?: Partial<Record<SensitiveFieldScope, PermissionScope>>;
}

export const VIEW_TO_MAIN_SCOPES: Record<View, ViewPermissionScopes> = {
  [View.Dashboard]:     { read: 'dashboard:read' },
  [View.Cockpit]:       { read: 'cockpit:read', sensitive: { cost: 'sensitive:cost', profit: 'sensitive:profit' } },
  [View.Assistant]:     { read: 'ai:chat' },
  [View.Reports]:       { read: 'reports:read', write: 'reports:write', approve: 'reports:admin' },
  // 日历页（2026-09-02 新增）：聚合只读总览，复用 orders:read，public-authenticated
  [View.Calendar]:      { read: 'orders:read' },
  // 售后索赔（2026-09-17 A-2）：本模块首次真实消费 aftersales:* 三码
  // ⚠️ approve 按口径 B1 只作 UI 能力标签（不作强制门禁），此处登记供前端按钮显隐
  [View.Claims]:        { read: 'aftersales:read', write: 'aftersales:write', approve: 'aftersales:approve' },
  [View.Relations]:     { read: 'relations:read', write: 'relations:write', delete: 'relations:delete', approve: 'relations:admin' },
  [View.CRM]:           { read: 'crm:read', write: 'crm:write' },
  [View.Suppliers]:     { read: 'suppliers:read', write: 'suppliers:write', approve: 'suppliers:admin' },
  [View.Seasons]:       { read: 'seasons:read', write: 'seasons:write' },
  [View.Marketing]:     { read: 'marketing:read', write: 'marketing:write' },
  [View.Emails]:        { read: 'emails:read', write: 'emails:write', approve: 'emails:admin' },
  [View.Products]:      { read: 'products:read', write: 'products:write' },
  [View.BOM]:           { read: 'bom:read', write: 'bom:write', approve: 'bom:admin' },
  [View.Orders]:        { read: 'orders:read', write: 'orders:write', delete: 'orders:delete' },
  [View.Quotations]:    { read: 'quotations:read', write: 'quotations:write', approve: 'quotations:approve' },
  [View.Procurement]:   { read: 'procurement:read', write: 'procurement:write', approve: 'procurement:approve' },
  [View.ProductionBoard]: { read: 'production:read', write: 'production:write' },
  [View.Shipments]:     { read: 'shipments:read', write: 'shipments:write', approve: 'shipments:approve' },
  [View.Customs]:       { read: 'customs:read', write: 'customs:write', approve: 'customs:admin' },
  [View.QcWorkbench]:   { read: 'qc:read', write: 'qc:write' },
  // 售后客诉暂挂在 Orders 下（没独立View），用 scope 直接控
  [View.Invoices]:      { read: 'invoices:read', write: 'invoices:write', approve: 'invoices:approve:writeoff' },
  [View.PaymentVouchers]:{ read: 'vouchers:read', write: 'vouchers:write' },
  [View.Pricing]:       { read: 'pricing:read', write: 'pricing:write', approve: 'pricing:admin',
                          sensitive: { cost: 'sensitive:cost', profit: 'sensitive:profit', commission: 'sensitive:commission', tax_base: 'sensitive:tax_base' } },
  [View.Risks]:         { read: 'risk:read', write: 'risk:write', approve: 'risk:admin' },
  // VAT/退税/付汇 暂时挂在FinanceManager/Invoices（没独立View）
  [View.DataCenter]:    { read: 'knowledge:read', write: 'knowledge:write', approve: 'knowledge:approve' },
  [View.BusinessTools]: { read: 'tools:execute' },
  [View.Development]:   { read: 'products:read', write: 'products:write' },
  [View.Samples]:       { read: 'products:read', write: 'products:write' }, // 样品管理域（DR-052）：样品源自开发/订单域，读写真源对齐 products
  [View.Inventory]:     { read: 'orders:read' },
  [View.DocumentCenter]:{ read: 'customs:read', write: 'customs:write' },
  [View.MES]:           { read: 'production:read' }, // MES搁置，但权限先定义
  [View.Settings]:      { read: 'settings:account' },
  [View.AccountSettings]: { read: 'settings:account' },
  [View.SystemSettings]:{ read: 'settings:system:read', write: 'dictionary:write', approve: 'users:admin' },
  [View.AdminPanel]:    { read: 'users:read', write: 'users:write', delete: 'audit:read' },
  [View.HR]:            { read: 'hr:read', write: 'hr:write',
                          sensitive: { salary: 'sensitive:salary' } },
  [View.UiLab]:         { read: 'dashboard:read' }, // dev-only 视图在modulePermissions.ts里另有限制
};

// ═══════════════════════════════════════════════════════════════════
// 5. 行级数据范围过滤 默认规则（PL-2B：同部门互相可见，跨部门隔离）
//    注意：SalesManager 和 Sales 同属一个部门范围，Finance/Admin/SuperAdmin 全公司
// ═══════════════════════════════════════════════════════════════════

export type DataScopeRule =
  | { kind: 'all'; write?: 'all' | 'department' | 'self' }                   // 全公司可见（v2.2 DR-042 §4.4：write 可独立收窄，缺省 = 'all'）
  | { kind: 'department'; own: boolean; includeDescendantDepartments?: boolean } // 仅本部门（默认跨部门隔离）
  | { kind: 'team' }                                                         // 仅本Team（预留更细粒度，目前按department够用）
  | { kind: 'self' };                                                        // 仅自己（ownerId=me，暂时不启用因为CM-2选了无唯一owner，以后可开）

/**
 * v2.2（DR-042 §4.4 读写分离）：解析规则的写侧 kind。
 * - { kind: 'all' } 缺省 write = 'all'（真全权角色：财务/QC/后勤/admin/超管）
 * - { kind: 'all', write: 'self' }：读全量、写本人维（sales 档案图书馆化口径）
 * - 其余 kind：写侧 = 读侧 kind（原语义）
 */
export function resolveWriteKind(rule: DataScopeRule): 'all' | 'department' | 'team' | 'self' {
  return rule.kind === 'all' ? (rule.write ?? 'all') : rule.kind;
}

export const DEFAULT_DATA_SCOPE_BY_ROLE: Record<
  SystemRoleId,
  /** 每个模块单独可以设，不设 = fallback 到 '*' 通配 */
  { '*': DataScopeRule } & Partial<Record<string, DataScopeRule>>
> = {
  // --- 业务员/销售主管：§10.4.1 三档数据范围——「团队」= 系统里配的小组 ---
  // 历史坑：此前写的是 department，但业务数据域的 department 规则在
  // permissionService 里被强制降级为 self（DR-042 §5.1 组为主），于是这两个角色
  // 实际恒等于「只看自己」，同组同事互相看不见。改为 team 后按小组解析（含本人）。
  [SYSTEM_ROLE_IDS.SALES]: {
    '*': { kind: 'team' },
    // v2.2（DR-042 §5.1 L1 档案图书馆化）：读全公司（normal 档案全公司可查，
    // confidential 由服务层收窄为本人维），写本人维（跟进人）
    // —— 档案域是「图书馆」性质，不按组隔离，保留 all + write:'self'。
    relations: { kind: 'all', write: 'self' },
    crm: { kind: 'all', write: 'self' },
    // 财务域：业务员只能看自己/同组经手的订单关联的发票/凭证，不能看全公司
    invoices: { kind: 'team' },
    vouchers: { kind: 'team' },
    // HR：业务员只能看自己
    hr: { kind: 'self' },
  },
  [SYSTEM_ROLE_IDS.SALES_MANAGER]: {
    // 主管 = 领导（2026-09-12 业务方澄清）：看本组（可含多组），跨组不可见
    '*': { kind: 'team' },
    relations: { kind: 'team' },
    crm: { kind: 'team' },
    invoices: { kind: 'team' },
    vouchers: { kind: 'team' },
    hr: { kind: 'department', own: true }, // 人事编制域保留部门维（DEPT_SCOPE_EXEMPT_MODULES）
  },
  // --- 财务：财务域全公司，业务域只读全公司 ---
  [SYSTEM_ROLE_IDS.FINANCE]: {
    '*': { kind: 'all' }, // 财务看所有模块全公司范围
    // 但 HR 的薪酬明细仍要敏感 salary scope 才能看
  },
  // --- 系统管理员：配置看全公司，业务/财务数据按需要给scope但默认行级all（方便配置）---
  [SYSTEM_ROLE_IDS.ADMIN]: {
    '*': { kind: 'all' },
  },
  // --- QC：QC 域可写，其余业务域只读（全公司）---
  [SYSTEM_ROLE_IDS.QC]: {
    '*': { kind: 'all' },
  },
  // --- 后勤：物流/单证域可写，其余业务域只读（全公司）---
  [SYSTEM_ROLE_IDS.LOGISTICS]: {
    '*': { kind: 'all' },
  },
  // --- 超级管理员：无条件all，所有scope全开 ---
  [SYSTEM_ROLE_IDS.SUPER_ADMIN]: {
    '*': { kind: 'all' },
  },
};

// ═══════════════════════════════════════════════════════════════════
// 6. 6 系统角色 × 权限 scope → true/false 默认矩阵
//    这是 seed 数据的唯一真源；True=拥有该scope，False/undefined=没有
// ═══════════════════════════════════════════════════════════════════

type RolePermissionMatrix = Partial<Record<PermissionScope, true>>;

const SALES_BASE: RolePermissionMatrix = {
  // 经营总览
  'dashboard:read': true,
  'cockpit:read': true, // 可以看驾驶舱（但成本/利润敏感scope没给=自动遮罩显示****）
  'reports:read': true,
  'reports:write': true,
  'ai:chat': true,
  'ai:write:low': true,    // AI-1选C：低风险写（登记跟进/加标签）无确认
  'ai:write:medium': true, // 中风险需要确认框的（前端UI再弹窗），后端有scope就允许执行（确认框是前端UX）
  // 客户市场
  'relations:read': true,
  'relations:write': true,
  'crm:read': true,
  'crm:write': true,
  'suppliers:read': true,
  'seasons:read': true,
  'seasons:write': true,
  'marketing:read': true,
  'emails:read': true,
  'emails:write': true,
  // 订单履约
  'orders:read': true,
  'orders:write': true,
  'quotations:read': true,
  'quotations:write': true,
  'quotations:convert': true,
  'products:read': true,
  'products:write': true,
  'bom:read': true,
  'bom:write': true, // Draft 态编辑（文档 §6.1；W-C 批三-E 走查发现矩阵漏授）
  'production:read': true,
  'production:write': true, // QC/疵点业务员自己登
  'shipments:read': true,
  'shipments:write': true,
  'customs:read': true,
  'customs:write': true, // 报关草稿（文档 §6.1；S3 γ 车道实锤矩阵漏授）
  'qc:read': true,
  'qc:write': true,
  'aftersales:read': true,
  'aftersales:write': true,
  'procurement:read': true,
  'procurement:write': true, // PO 草稿发起（文档 §6.1；S3 走查发现矩阵漏授，业务员建 PO 被 403）
  'inventory:read': true,
  'inventory:write': true, // 对应业务组经手人办理相关库存实物动作；不设仓储专岗
  // 财务（业务员只读自己的应收/应付情况，不能登账）
  'finance:read': true,
  'invoices:read': true,
  'vouchers:read': true,
  'pricing:read': true,
  'risk:read': true,
  // 平台域
  'knowledge:read': true,
  'knowledge:write': true,
  'tools:execute': true,
  'settings:account': true,
  'data:import': true,
  // Phase 1 预分配：业务员申请侧 scope（DR-007 审批路由发起人）
  'moq:line_override': true,
  'order:change_request:create': true,
  'sample:early_production:write': true,
  'sample:shipment:write': true,
  'sample:color_batch:write': true,
  'sample:room:write': true,
  'production:pp_release:business_sign': true, // DR-053 阶段 2：业务部签署
  'exception:dr013:create': true,
  'finance:payment_request:create': true,
};

const SALES_MANAGER_BASE: RolePermissionMatrix = {
  ...SALES_BASE, // 继承业务员所有权限
  // 原 requireRole(owner/admin/manager) 端点迁到权限点后的等价授予（行为不变）
  'business:delete': true,
  'emails:maintenance:write': true,
  'agent:approvals:approve': true,
  // 额外：变更审批（SM 级审批权）
  'orders:approve:change_delivery': true,
  'orders:approve:change_qty': true,
  'quotations:approve': true,
  'shipments:approve': true,
  // 客户/供应商评级
  'relations:admin': true,
  'suppliers:admin': true,
  // 报价转化已有，再给风险处理
  'risk:write': true,
  // 报表订阅推送管理
  'reports:admin': true,
  // 客诉处理审批
  'aftersales:approve': true,
  // 采购PO审批（DR-007 组织归属解析；首单自动上抬总领导）
  'procurement:approve': true,
  // DR-053 阶段 2：产前样放行-暂停/撤销/恢复（SM 级）
  'production:pp_release:admin': true,
  // §10.3-4 / §10.7 P-3：放行 = **领导单签**，且业务方已澄清「销售主管 = 领导（同一档）」。
  // 领导以「业务部签署」身份签字，故销售主管必须持有 business_sign ——
  // 此前只给了 pp_release:admin，导致放行面板「领导签字放行」对销售主管恒 403（放行走不通）。
  'production:pp_release:business_sign': true,
  // GAP-R11 FinMan 位移：本团队小单付款审批（大单/跨团队自动上抬总领导）
  'vouchers:approve:pay_lt5': true,
  // GAP-R11 FinMan 位移：订单变更-价格 双签之一（另一签总领导）
  'orders:approve:change_price': true,
  // GAP-R11 FinMan 位移：BOM 版本/计算模型管理（与 QC 共享）
  'bom:admin': true,
  // GAP-R11 FinMan 位移：付款申请审批（DR-017 本团队档）
  'finance:payment_request:approve': true,
  // Phase 1 预分配：销售主管审批侧 scope（继承 SALES 申请侧；此处为 SM 独有增量）
  'moq:capsule_exemption:write': true,
  'order:change_request:apply': true,
  'qc:fabric_chain:write': true,
  'qc:garment_chain:write': true,
};

const FINANCE_BASE: RolePermissionMatrix = {
  // 经营总览：全部（含驾驶舱敏感数字可见scope）
  'dashboard:read': true,
  'cockpit:read': true,
  'reports:read': true,
  'reports:write': true,
  'reports:admin': true,
  'ai:chat': true,
  'ai:write:low': true,
  'ai:write:medium': true,
  // 敏感字段：财务可见成本/利润/税基/佣金（做账发薪必需；GAP-R11 FinMan 位移）
  'sensitive:cost': true,
  'sensitive:profit': true,
  'sensitive:tax_base': true,
  'sensitive:commission': true,
  // 客户市场：只读（不做编辑）
  'relations:read': true,
  'crm:read': true,
  'suppliers:read': true,
  'seasons:read': true,
  'marketing:read': true,
  'emails:read': true,
  // 订单履约：只读（不允许直接改订单/报价，走变更审批流程）
  'orders:read': true,
  'quotations:read': true,
  'products:read': true,
  'bom:read': true,
  'production:read': true,
  'shipments:read': true,
  'customs:read': true,
  'qc:read': true,
  'aftersales:read': true,
  'procurement:read': true,
  // 财务域：可写+核销
  'finance:read': true,
  'invoices:read': true,
  'invoices:write': true,
  'invoices:reconcile': true,
  'vouchers:read': true,
  'vouchers:write': true,
  'pricing:read': true,
  'pricing:write': true,
  'vat:read': true,
  'vat:write': true,
  'tax:read': true,
  'tax:write': true,
  // GAP-R11 FinMan 位移：退税申报审批 = 财务专业合规工作（不归业务审批链）
  'tax:approve': true,
  'remit:read': true,
  'remit:write': true,
  'fx:lock': true,
  'risk:read': true,
  'risk:write': true,
  // 平台域
  'knowledge:read': true,
  'knowledge:write': true,
  'tools:execute': true,
  'settings:account': true,
  'audit:read': true,  // 财务可以看审计日志
  'hr:read': true,     // HR基本信息可见（发薪对象等）
  // Phase 1 预分配：财务申请侧 scope
  'finance:payment_request:create': true,
  'exception:dr013:create': true,
};

const ADMIN_BASE: RolePermissionMatrix = {
  // 原 requireRole(owner/admin/manager) 端点迁到权限点后的等价授予（行为不变）
  'business:delete': true,
  'emails:maintenance:write': true,
  'agent:approvals:approve': true,
  // 配置后台 + 用户管理
  'settings:system:read': true,
  'users:read': true,
  'users:write': true, // 但不能授予/撤销 SuperAdmin 角色（users:admin scope），要下面那个
  'dictionary:write': true,
  // 知识库审核/归档
  'knowledge:approve': true,
  'knowledge:admin': true,
  // 数据字典/BOM自定义插件添加（低风险配置项）
  'tools:execute': true,
  'settings:account': true,
  // 知识库/AI助手
  'knowledge:read': true,
  'knowledge:write': true,
  'ai:chat': true,
  'ai:write:low': true,
  'ai:write:medium': true,
  // 报表中心
  'reports:read': true,
  'reports:write': true,
  'reports:admin': true,
  // 审计日志查看（导出归总领导/SuperAdmin）
  'audit:read': true,
  // GAP-R11 FinMan 位移：总领导兜底审批档（大单付款/首单+1级/坏账核销/订单取消/价格双签另一签）
  'vouchers:approve:pay_gt5': true,
  'vouchers:approve:pay_new_supplier': true,
  'invoices:approve:writeoff': true,
  'orders:approve:cancel': true,
  // GAP-R11 FinMan 位移：风控总监级 + 定价管理员级 + 审计导出
  'risk:admin': true,
  'pricing:admin': true,
  'audit:export': true,
  // 文档 §6.6 总领导对齐：敏感字段四项（salary 仍不给，仅老板+指定 HR）
  'sensitive:cost': true,
  'sensitive:profit': true,
  'sensitive:commission': true,
  'sensitive:tax_base': true,
  // 文档 §6.6 总领导对齐：业务兜底审批全档（跨团队/大单/高风险）
  'orders:approve:change_delivery': true,
  'orders:approve:change_qty': true,
  'orders:approve:change_price': true,
  'quotations:approve': true,
  'shipments:approve': true,
  'aftersales:approve': true,
  'procurement:approve': true,
  'vouchers:approve:pay_lt5': true,
  'tax:approve': true,
  // 文档 §6.6：评级/BOM/用户管理最高档/HR 写/AI 高危/数据导入
  'relations:admin': true,
  'suppliers:admin': true,
  'bom:admin': true,
  'users:admin': true,
  'hr:write': true,
  'ai:write:high': true,
  'data:import': true,
  // 文档 §6.6 业务域全只读补遗：marketing/inventory（qc:read 已有）
  'marketing:read': true,
  'inventory:read': true,
  // 看所有业务域只读（Admin要能排障，不能两眼一抹黑）
  'dashboard:read': true,
  'cockpit:read': true,
  'relations:read': true,
  'crm:read': true,
  'suppliers:read': true,
  'seasons:read': true,
  'emails:read': true,
  'orders:read': true,
  'quotations:read': true,
  'products:read': true,
  'bom:read': true,
  'production:read': true,
  'shipments:read': true,
  'customs:read': true,
  // 领导可代为登记清关完成（与后勤/单证同列；部门门禁仍要求后勤部门或总经理）
  'customs:clear': true,
  'qc:read': true,
  'aftersales:read': true,
  'procurement:read': true,
  'finance:read': true,
  'invoices:read': true,
  'vouchers:read': true,
  'pricing:read': true,
  'vat:read': true,
  'tax:read': true,
  'remit:read': true,
  'risk:read': true,
  // HR：管理员看基本信息 + hr:write（§6.6 人事管理归总领导）；薪酬明细仍需 sensitive:salary（不给）
  'hr:read': true,
  // Phase 1 预分配：Admin 获得全部 15 个新 scope（配置/排障兜底；SUPER_ADMIN 代码级全放行）
  'settings:moq:write': true,
  'settings:tolerance:write': true,
  'moq:line_override': true,
  'moq:capsule_exemption:write': true,
  // §10.3-4 / §10.7 P-3：放行 = 领导单签。领导必须持有业务部签署 scope，否则 P-3
  // 放行面板里「领导签字放行」对领导账号恒 403（此前仅销售主管持有 = 口径洞）。
  'production:pp_release:business_sign': true,
  'production:pp_release:production_sign': true,
  'production:pp_release:admin': true,
  'order:change_request:create': true,
  'order:change_request:apply': true,
  'sample:early_production:write': true,
  'sample:shipment:write': true,
  'sample:color_batch:write': true,
  'sample:room:write': true,
  'exception:dr013:create': true,
  'finance:payment_request:create': true,
  'finance:payment_request:approve': true,
  'credit:freeze:write': true,
  'credit:thaw:write': true,
  'order:internal_trade:write': true,
  'qc:fabric_chain:write': true,
  'qc:garment_chain:write': true,
  'settings:automation:write': true,
};

const QC_BASE: RolePermissionMatrix = {
  // 经营总览（文档 §6.4）
  'dashboard:read': true,
  'cockpit:read': true,
  'reports:read': true,
  'ai:chat': true,
  'ai:write:low': true,
  // 客户市场（只读）
  'relations:read': true,
  'suppliers:read': true,
  'seasons:read': true,
  // 订单履约（只读）
  'orders:read': true,
  'quotations:read': true,
  'products:read': true,
  'production:read': true,
  'shipments:read': true,
  'customs:read': true,
  'aftersales:read': true,
  'procurement:read': true,
  // 财务 KPI 层只读（敏感字段遮罩；W-C 视图门禁对齐文档 §6.4）
  'finance:read': true,
  // QC 域（可写）
  'qc:read': true,
  'qc:write': true,
  'qc:inspect': true,
  // DR-029 双链样品评审（S3 走查 F-QC-1 实锤：GAP-R11 收编漏补，S1 主链 QC 评审节点死胡同）
  'qc:fabric_chain:write': true,
  'qc:garment_chain:write': true,
  'production:write': true, // 阶段登记/疵点录入
  'production:pp_release:production_sign': true, // DR-053 阶段 2：产前样放行生产部签署
  'bom:read': true,
  'bom:write': true, // Draft 编辑
  // BOM 版本/工艺模型管理（与 SM 共享；GAP-R11 FinMan 位移）
  'bom:admin': true,
  // 平台域
  'knowledge:read': true,
  'knowledge:write': true,
  'tools:execute': true,
  'settings:account': true,
};

const LOGISTICS_BASE: RolePermissionMatrix = {
  // 经营总览（文档 §6.5）
  'dashboard:read': true,
  'cockpit:read': true,
  'reports:read': true,
  'ai:chat': true,
  'ai:write:low': true,
  // 客户市场（只读）
  'relations:read': true,
  'crm:read': true,
  'suppliers:read': true,
  'seasons:read': true,
  'marketing:read': true,
  'emails:read': true,
  // 订单履约（只读）
  'orders:read': true,
  'quotations:read': true,
  'products:read': true,
  'production:read': true,
  'bom:read': true,
  'qc:read': true,
  // 物流/单证域（可写）
  'shipments:read': true,
  'shipments:write': true,
  'customs:read': true,
  'customs:write': true,
  // 单证模板/公司签章配置（GAP-R11 FinMan 位移）
  'customs:admin': true,
  // 清关完成（海关放行）事实只由后勤/单证登记；业务员只能保存草稿/已申报
  'customs:clear': true,
  // 保留既有跨流程协作能力；常规采购/库存由业务组经办，scope 不代表独立仓储岗位
  'procurement:read': true,
  'procurement:write': true,
  'inventory:read': true,
  'inventory:write': true,
  // 售后物流部分
  'aftersales:read': true,
  'aftersales:write': true,
  // 财务只读（KPI/商业发票做报关/水单核对；W-C 视图门禁对齐文档 §6.5）
  'finance:read': true,
  'invoices:read': true,
  'vouchers:read': true,
  // 平台域
  'knowledge:read': true,
  'knowledge:write': true,
  'tools:execute': true,
  'settings:account': true,
  'data:import': true,
};

const SUPER_ADMIN_BASE: RolePermissionMatrix = {};
// 超级管理员：ALL SCOPES = TRUE （运行时用 `role === SUPER_ADMIN` 直接放行，不查表）
// 这里不展开所有scope，代码级判断时：
//   if roleId === SYSTEM_ROLE_IDS.SUPER_ADMIN => return true for any scope

export const DEFAULT_ROLE_PERMISSION_MATRIX: Record<SystemRoleId, RolePermissionMatrix> = {
  [SYSTEM_ROLE_IDS.SALES]: SALES_BASE,
  [SYSTEM_ROLE_IDS.SALES_MANAGER]: SALES_MANAGER_BASE,
  [SYSTEM_ROLE_IDS.FINANCE]: FINANCE_BASE,
  [SYSTEM_ROLE_IDS.ADMIN]: ADMIN_BASE,
  [SYSTEM_ROLE_IDS.QC]: QC_BASE,
  [SYSTEM_ROLE_IDS.LOGISTICS]: LOGISTICS_BASE,
  [SYSTEM_ROLE_IDS.SUPER_ADMIN]: SUPER_ADMIN_BASE,
};

// ═══════════════════════════════════════════════════════════════════
// 7. 前端/守卫辅助工具函数（纯函数，不依赖DB，fallback判断用）
// ═══════════════════════════════════════════════════════════════════

/** 判断一个系统角色是否拥有某scope（先看DB拉取的用户权限集，没有或为空时fallback到默认矩阵） */
export function hasPermission(
  roleId: string | string[] | null | undefined,
  scope: PermissionScope,
  runtimeUserScopes?: Set<string> | null,
): boolean {
  // 运行时给的集合优先（服务端/前端拉取后放入 Set 最快）
  if (runtimeUserScopes && runtimeUserScopes.size > 0) {
    if (runtimeUserScopes.has(scope)) return true;
  }
  // 角色数组（多角色用户）
  const roles = Array.isArray(roleId) ? roleId : roleId ? [roleId] : [];
  for (const r of roles) {
    if (r === SYSTEM_ROLE_IDS.SUPER_ADMIN) return true;
    const matrix = DEFAULT_ROLE_PERMISSION_MATRIX[r as SystemRoleId];
    if (matrix && matrix[scope] === true) return true;
  }
  return false;
}

/** 某个敏感字段scope是否可见（和普通scope走相同权限，只是语义单独分组） */
export function canViewSensitive(
  roleId: string | string[] | null | undefined,
  field: SensitiveFieldScope,
  runtimeUserScopes?: Set<string> | null,
): boolean {
  const scope = `sensitive:${field}` as PermissionScope;
  return hasPermission(roleId, scope, runtimeUserScopes);
}

/** 根据模块获取默认行级范围过滤规则（代码级fallback） */
export function getDataScopeRule(
  roleId: string | null | undefined,
  moduleOrView?: string,
): DataScopeRule {
  if (!roleId) return { kind: 'self' }; // 无角色=仅自己
  if (roleId === SYSTEM_ROLE_IDS.SUPER_ADMIN) return { kind: 'all' };
  const roleRules = DEFAULT_DATA_SCOPE_BY_ROLE[roleId as SystemRoleId];
  if (!roleRules) return { kind: 'self' };
  if (moduleOrView && moduleOrView in roleRules) {
    return (roleRules as Record<string, DataScopeRule>)[moduleOrView];
  }
  return roleRules['*'];
}

/** 给指定角色返回全部默认 scope 字符串数组（seed 用） */
export function getDefaultScopeListForRole(roleId: SystemRoleId): string[] {
  if (roleId === SYSTEM_ROLE_IDS.SUPER_ADMIN) {
    // SuperAdmin 在守卫里特判，DB 里 seed 也给他 ALL SCOPES 防止有bug
    return Object.keys(PERMISSION_SCOPES);
  }
  const matrix = DEFAULT_ROLE_PERMISSION_MATRIX[roleId];
  return Object.entries(matrix)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

/**
 * §10.4.1「领导」主体判定——人维度的豁免，与权限点（scope）互补。
 *
 * 用于「谁提的谁撤 + 领导可撤」这类**归属型**口径：动作本身归提交人所有，
 * 但允许领导代行。判定只看身份（role id / legacy 角色码），不看 scope，
 * 因为这类豁免不是"权限"而是"组织层级"。
 *
 * 业务方 2026-09-12 追加澄清：**销售主管就是领导，同一档**——因此 SALES_MANAGER
 * 与 ADMIN / SUPER_ADMIN 同列。
 *
 * 待收口：主管目前与老板一样可撤任何人的申请；「只撤本团队」的收窄由第二批
 * 三档数据范围引擎（小组档 + 按单分配）提供，不在本批擅自加范围条件。
 */
const LEADER_ROLE_IDS: ReadonlySet<string> = new Set<string>([
  SYSTEM_ROLE_IDS.ADMIN,         // 领导（业务审批/电子签/特批）
  SYSTEM_ROLE_IDS.SALES_MANAGER, // 销售主管 = 领导（2026-09-12 业务方澄清：同一档）
  SYSTEM_ROLE_IDS.SUPER_ADMIN,   // 老板
]);
/** legacy AgentRole 码（JWT.roles 里可能仍是旧码，与 roleId 并存） */
const LEADER_LEGACY_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'manager']);

export function isLeaderPrincipal(roles?: readonly string[] | null): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some((r) => LEADER_ROLE_IDS.has(r) || LEADER_LEGACY_ROLES.has(r));
}

/** Database provisioning only: new write capabilities are never granted by the
 * compatibility fallback for an old token without a current grant snapshot. */
export function getDatabaseSeedScopeListForRole(roleId: SystemRoleId): string[] {
  const scopes = getDefaultScopeListForRole(roleId);
  const receiptProposalRoles: string[] = [SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.SALES_MANAGER, SYSTEM_ROLE_IDS.FINANCE, SYSTEM_ROLE_IDS.ADMIN];
  return receiptProposalRoles.includes(roleId) ? [...new Set([...scopes, 'invoices:suggest_match' as const])] : scopes;
}
