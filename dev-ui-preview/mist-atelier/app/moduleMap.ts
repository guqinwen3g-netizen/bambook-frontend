/**
 * 全站 35 个模块 → Mist 页面模板映射（迁移的唯一依据）。
 * template = 参考应用里可直接照抄的页面；detail = 该模块的详情页用哪个模板。
 * wave = 推进批次（先外壳，再按批次逐个模块迁移）。
 */
export type TemplateId = 'workbench' | 'list-preview' | 'list-table' | 'record-detail' | 'document' | 'reconcile' | 'profile' | 'board' | 'form-wizard' | 'settings' | 'analytics' | 'calendar' | 'assistant' | 'special';

export const TEMPLATES: Record<TemplateId, { name: string; page?: string; when: string }> = {
  'workbench':     { name: 'T1 工作台',       page: 'cockpit',            when: '个人首页 / 今日待办 / 焦点事项' },
  'list-preview':  { name: 'T2 列表 + 预览',  page: 'development',        when: '对象有图片或需要快速预览（开发案、样品、产品）' },
  'list-table':    { name: 'T3 宽表列表',     page: 'orders',             when: '纯数据记录、列多、需要排序（订单、采购单、发票）' },
  'record-detail': { name: 'T4 对象详情',     page: 'development/detail', when: '有阶段流转 + 决策 + 动态（开发案、样品、QC、索赔）' },
  'document':      { name: 'T5 单据详情',     page: 'orders/detail',      when: '有金额、条目、履约流程（订单、报价、出运、报关）' },
  'reconcile':     { name: 'T6 匹配核销',     page: 'payment-vouchers',   when: '两侧数据对账（收款↔发票、装箱↔订单）' },
  'profile':       { name: 'T7 档案详情',     page: 'crm',                when: '客户 / 供应商 / 员工档案' },
  'board':         { name: 'T8 看板',         page: 'production-board',   when: '按状态列推进（生产、营销活动、验货任务）' },
  'form-wizard':   { name: 'T9 新建 / 编辑',  page: 'development/new',    when: '所有新建与长表单编辑' },
  'settings':      { name: 'T10 设置',        page: 'system-settings',    when: '系统/账号/模块配置、管理后台' },
  'analytics':     { name: 'T11 分析报表',    page: 'cockpit',            when: '统计卡 + 图表（报表中心、全景看板、利润）。图表用 recharts + toneColor()' },
  'calendar':      { name: 'T12 日历',        page: 'cockpit',            when: '复用 WeekStrip + Agenda，月视图用 mist-card 网格' },
  'assistant':     { name: 'T13 助手',        page: 'cockpit',            when: '复用 AssistantDrawer 的消息/输入组件做整页' },
  'special':       { name: '特殊可视化',      when: '地球/关系图等保留原可视化，只把外层容器换成 Card + PageHeader' },
};

export type ModuleMapEntry = { id: string; view: string; label: string; group: string; entry: string; lines: number; template: TemplateId; detail?: TemplateId; create?: boolean; wave: 1 | 2 | 3 | 4 | 5; notes?: string };

export const MODULE_MAP: ModuleMapEntry[] = [
  // ── Wave 1：核心闭环（开发 → 订单 → QC → 出运）──
  { id: 'cockpit', view: 'cockpit', label: '我的工作', group: '我的事务', entry: 'dev-ui-preview/mist-atelier/app/pages/HomePage.tsx', lines: 103, template: 'workbench', wave: 1, notes: '参考页即成品。数据来自 workbenchFocus / 待办接口' },
  { id: 'development', view: 'development', label: '开发与寻样', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/DevListPage.tsx', lines: 100, template: 'list-preview', detail: 'record-detail', create: true, wave: 1, notes: '参考页即成品；面料寻样为第二个 Tab' },
  { id: 'samples', view: 'samples', label: '样品仓库', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-preview', detail: 'record-detail', create: true, wave: 1 },
  { id: 'orders', view: 'orders', label: '订单管理', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/OrderListPage.tsx', lines: 79, template: 'list-table', detail: 'document', create: true, wave: 1, notes: '面料订单/成衣订单用 Tabs' },
  { id: 'qc-workbench', view: 'qc-workbench', label: 'QC 工作台', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'board', detail: 'record-detail', wave: 1, notes: '验货任务=看板；报告=对象详情（MeasurementTable）；驻地/业务线配置=设置模板' },
  { id: 'shipments', view: 'shipments', label: '货运管理', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-table', detail: 'document', create: true, wave: 1, notes: '出运准备用 Checklist；装箱分配用 reconcile 模板' },
  // ── Wave 2：财务与成本 ──
  { id: 'payment-vouchers', view: 'payment-vouchers', label: '财务管理', group: '财务与成本', entry: 'dev-ui-preview/mist-atelier/app/pages/FinancePage.tsx', lines: 133, template: 'reconcile', detail: 'document', wave: 2, notes: '收款核销=参考页；凭证列表=宽表' },
  { id: 'invoices', view: 'invoices', label: '发票管理', group: '财务与成本', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'list-table', detail: 'document', create: true, wave: 2 },
  { id: 'pricing', view: 'pricing', label: '定价与利润', group: '财务与成本', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'analytics', wave: 2, notes: '计算器=表单(FormGrid)+右侧 SummaryBar；利润表/退税率/价格历史/佣金=宽表 Tabs' },
  { id: 'bom', view: 'bom', label: 'BOM 成本核算', group: '财务与成本', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'list-table', detail: 'document', create: true, wave: 2 },
  { id: 'risks', view: 'risks', label: '风险管理与合规', group: '财务与成本', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'list-table', detail: 'record-detail', wave: 2, notes: '风险等级用 Pill tone：bad/warn/ok' },
  { id: 'claims', view: 'claims', label: '售后索赔', group: '财务与成本', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'list-table', detail: 'record-detail', create: true, wave: 2 },
  // ── Wave 3：客户与市场 + 产品 ──
  { id: 'crm', view: 'crm', label: '客户关系管理', group: '客户与市场', entry: 'dev-ui-preview/mist-atelier/app/pages/CustomerPage.tsx', lines: 118, template: 'list-table', detail: 'profile', create: true, wave: 3, notes: '客户详情=参考页' },
  { id: 'suppliers', view: 'suppliers', label: '供应商管理', group: '客户与市场', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx', lines: 87, template: 'list-table', detail: 'profile', create: true, wave: 3 },
  { id: 'relations', view: 'relations', label: '关系智库', group: '客户与市场', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx', lines: 87, template: 'list-preview', detail: 'profile', wave: 3 },
  { id: 'seasons', view: 'seasons', label: '季节性与趋势', group: '客户与市场', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx', lines: 87, template: 'analytics', wave: 3 },
  { id: 'marketing', view: 'marketing', label: '营销推广', group: '客户与市场', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx', lines: 87, template: 'board', detail: 'record-detail', wave: 3, notes: '营销活动=看板；线索=宽表；电子画册=列表+预览' },
  { id: 'quotations', view: 'quotations', label: '报价管理', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx', lines: 87, template: 'list-table', detail: 'document', create: true, wave: 3 },
  { id: 'products', view: 'products', label: '数字档案', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/MarketPages.tsx', lines: 87, template: 'list-preview', detail: 'record-detail', create: true, wave: 3, notes: '体量最大，先迁列表与详情，模块设置页最后' },
  // ── Wave 4：履约其余 ──
  { id: 'production-board', view: 'production-board', label: '生产进度', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/ProductionPage.tsx', lines: 74, template: 'board', detail: 'document', wave: 4, notes: '看板=参考页' },
  { id: 'procurement', view: 'procurement', label: '采购管理', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-table', detail: 'document', create: true, wave: 4 },
  { id: 'inventory', view: 'inventory', label: '库存与仓储', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-table', detail: 'record-detail', wave: 4 },
  { id: 'customs', view: 'customs', label: '外贸与报关', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-table', detail: 'document', wave: 4 },
  { id: 'document-center', view: 'document-center', label: '单据中心', group: '订单履约', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-preview', detail: 'document', wave: 4, notes: '预览区放单据 PDF 缩略图' },
  // ── Wave 5：平台与其他 ──
  { id: 'calendar', view: 'calendar', label: '日历', group: '我的事务', entry: 'dev-ui-preview/mist-atelier/app/pages/CalendarPage.tsx', lines: 96, template: 'calendar', wave: 5 },
  { id: 'emails', view: 'emails', label: '智能邮箱', group: '我的事务', entry: 'components/EmailManager.tsx', lines: 2326, template: 'list-preview', wave: 5, notes: '右侧预览=邮件正文；AI 摘要用 Banner tone=ai' },
  { id: 'dashboard', view: 'dashboard', label: '全景看板', group: '我的事务', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'special', wave: 5, notes: '使用 Mist 统计卡与订单履约聚合，不恢复旧可视化页面' },
  { id: 'reports', view: 'reports', label: '报表中心', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'analytics', wave: 5 },
  { id: 'data-center', view: 'data-center', label: '数据中心', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'analytics', wave: 5, notes: '当前工作空间的数据关联质量、记录汇总与来源入口' },
  { id: 'assistant', view: 'assistant', label: 'AI 助手', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'assistant', wave: 5 },
  { id: 'hr', view: 'hr', label: '人事管理', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'list-table', detail: 'profile', wave: 5, notes: '7 个子视图用 Tabs；组织架构保留树形，外层 Card' },
  { id: 'business-tools', view: 'business-tools', label: '业务工具', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'workbench', wave: 5, notes: '工具入口用 CardButton 网格' },
  { id: 'admin', view: 'admin-panel', label: '管理后台', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/PlatformPages.tsx', lines: 58, template: 'settings', wave: 5 },
  { id: 'settings', view: 'settings', label: '设置', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/SettingsPage.tsx', lines: 104, template: 'settings', wave: 5, notes: '设置=参考页' },
  { id: 'mes', view: 'mes', label: '历史加工记录', group: '平台', entry: 'dev-ui-preview/mist-atelier/app/pages/modules/FulfillmentPages.tsx', lines: 99, template: 'list-table', wave: 5 },
];
