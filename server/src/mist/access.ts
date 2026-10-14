import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import type { MistState, MistWorkspaceMember, MistWorkspaceMemberLog, MistWorkspaceAccess as SharedAccess } from '../shared/mistWorkspace';
/**
 * 工作空间访问与读投影。
 * - 成员资格只决定"能不能进这个空间"，看到哪些业务数据仍由账号自身现有岗位的读权限决定；
 * - 所有者同样按自身读权限投影（全权限账号看到完整数据）。
 * 不新增任何权限点，只引用岗位矩阵里已有的读权限。
 */
export type MistMemberRecord = MistWorkspaceMember;
export type MistMemberLog = MistWorkspaceMemberLog;
export type MistWorkspaceAccess = SharedAccess;
type Section = { key: string; label: string; permissions: PermissionScope[]; paths: string[][]; entityTypes: string[]; views: string[] };
export const MIST_READ_SECTIONS: Section[] = [
  { key: 'receivables', label: '应收票据', permissions: ['invoices:read'], paths: [['invoices'], ['platform', 'invoiceDrafts']], entityTypes: ['invoice'], views: ['invoices'] },
  { key: 'receipts', label: '收款与核销', permissions: ['invoices:read', 'vouchers:read'], paths: [['receipts'], ['allocations']], entityTypes: ['finance', 'receipt'], views: ['receipts', 'payment-vouchers'] },
  { key: 'payments', label: '付款记录', permissions: ['vouchers:read'], paths: [['payments']], entityTypes: ['payment'], views: [] },
  { key: 'payables', label: '供应商票据与应付', permissions: ['invoices:read', 'vouchers:read'], paths: [['payables']], entityTypes: ['payable'], views: ['payables'] },
  { key: 'funding', label: '订单资金归属', permissions: ['finance:read', 'invoices:read', 'vouchers:read'], paths: [['orderFunding']], entityTypes: ['orderFunding'], views: ['funding'] },
  { key: 'relations', label: '客户与联系人', permissions: ['relations:read'], paths: [['customers'], ['contacts'], ['market', 'relations']], entityTypes: ['customer', 'relation'], views: ['customers', 'relations'] },
  { key: 'crm', label: '客户跟进', permissions: ['crm:read'], paths: [['crm']], entityTypes: ['crm'], views: ['crm'] },
  { key: 'email', label: '邮件', permissions: ['emails:read'], paths: [['email']], entityTypes: ['email'], views: ['emails'] },
  { key: 'quotations', label: '报价', permissions: ['quotations:read'], paths: [['market', 'quotations']], entityTypes: ['quotation'], views: ['quotations'] },
  { key: 'products', label: '开发与产品', permissions: ['products:read'], paths: [['devs'], ['versions'], ['drafts'], ['fabrics'], ['market', 'products'], ['fulfillment', 'samples'], ['fulfillment', 'sampleMovements']], entityTypes: ['development', 'fabric', 'product', 'sample'], views: ['development/detail', 'development/list', 'development/new', 'fabric-sourcing', 'products', 'samples'] },
  { key: 'suppliers', label: '供应商档案', permissions: ['suppliers:read'], paths: [['market', 'suppliers']], entityTypes: ['supplier'], views: ['suppliers'] },
  { key: 'seasons', label: '季节与市场参考', permissions: ['seasons:read'], paths: [['market', 'seasons'], ['market', 'trends'], ['market', 'shows']], entityTypes: ['season', 'trend', 'show'], views: ['seasons', 'trends', 'shows'] },
  { key: 'marketing', label: '营销', permissions: ['marketing:read'], paths: [['market', 'campaigns'], ['market', 'leads'], ['market', 'lookbooks']], entityTypes: ['campaign', 'lead', 'lookbook'], views: ['marketing'] },
  { key: 'claims', label: '售后案件与贷项', permissions: ['aftersales:read'], paths: [['platform', 'claims'], ['platform', 'credits'], ['platform', 'creditApplications'], ['platform', 'claimGoods']], entityTypes: ['claim', 'credit'], views: ['claims'] },
  { key: 'bom', label: '成本核算', permissions: ['bom:read'], paths: [['platform', 'boms']], entityTypes: ['bom'], views: ['bom'] },
  { key: 'pricing', label: '定价记录', permissions: ['pricing:read'], paths: [['platform', 'pricing']], entityTypes: ['pricing'], views: ['pricing'] },
  { key: 'risks', label: '风险台账', permissions: ['risk:read'], paths: [['platform', 'risks']], entityTypes: ['risk'], views: ['risks'] },
  { key: 'employees', label: '员工档案', permissions: ['hr:read'], paths: [['platform', 'employees']], entityTypes: ['employee'], views: ['hr'] },
  { key: 'assistant', label: '助手草稿', permissions: ['ai:chat'], paths: [['platform', 'assistantDrafts']], entityTypes: ['assistant'], views: ['ai-assistant'] },
  { key: 'procurement', label: '采购合同与收货', permissions: ['procurement:read'], paths: [['fulfillment', 'purchases'], ['fulfillment', 'receipts']], entityTypes: ['procurement'], views: ['procurement'] },
  { key: 'qc', label: '质检工作台', permissions: ['qc:read'], paths: [['fulfillment', 'qcTasks'], ['fulfillment', 'qcReports']], entityTypes: ['qc'], views: ['qc-workbench'] },
  { key: 'inventory', label: '库存', permissions: ['inventory:read'], paths: [['fulfillment', 'warehouses'], ['fulfillment', 'returnReceipts'], ['fulfillment', 'receivedRecords'], ['fulfillment', 'stock'], ['fulfillment', 'stockMovements']], entityTypes: ['inventory', 'stock'], views: ['inventory'] },
  { key: 'shipments', label: '出运与装箱', permissions: ['shipments:read'], paths: [['fulfillment', 'shipments'], ['fulfillment', 'packing'], ['fulfillment', 'shippingTerms']], entityTypes: ['shipment', 'packing'], views: ['shipments', 'shipping', 'packing'] },
  { key: 'customs', label: '报关与单证', permissions: ['customs:read'], paths: [['fulfillment', 'customs'], ['fulfillment', 'documents']], entityTypes: ['customs', 'document'], views: ['customs', 'documents'] },
  { key: 'orders', label: '订单', permissions: ['orders:read'], paths: [['orders'], ['orderLines']], entityTypes: ['order'], views: ['orders/detail', 'orders/list', 'orders/new'] },
  { key: 'production', label: '生产', permissions: ['production:read'], paths: [['productions'], ['fulfillment', 'productionFacts']], entityTypes: ['production'], views: ['production-board'] },
];
export const memberIds = (state: MistState): string[] => Array.isArray(state.memberIds) ? state.memberIds.filter((id: unknown) => typeof id === 'string') : [];
export const members = (state: MistState): MistMemberRecord[] => Array.isArray(state.members) ? state.members : [];
export const isOwner = (row: { ownerId: string }, actor: TokenPayload) => row.ownerId === actor.userId;
export const isMember = (row: { state: MistState }, actor: TokenPayload) => memberIds(row.state).includes(actor.userId);
export function hiddenSections(actor: TokenPayload) { return MIST_READ_SECTIONS.filter(section => section.permissions.some(scope => !hasScope(actor, scope))); }
/** 非所有者可执行的"无权限点"命令：仅限个人提醒类，不能改空间设置。 */
export const MEMBER_PERSONAL_COMMANDS = ['notification.read', 'notification.readAll', 'task.complete', 'calendar.save'];
/** 读取与提醒动作使用同一来源边界；未知路由不能绕过受限账号的读投影。 */
function targetVisibility(hidden: Section[]) {
  if (!hidden.length) return (_target?: { view?: string }) => true;
  const deniedViews = new Set(hidden.flatMap(section => section.views)), knownViews = new Set(MIST_READ_SECTIONS.flatMap(section => section.views));
  if (hidden.some(section => ['receivables', 'receipts', 'payments', 'payables', 'funding'].includes(section.key))) deniedViews.add('finance');
  knownViews.add('finance');
  return (target?: { view?: string }) => !target?.view || knownViews.has(target.view) && !deniedViews.has(target.view);
}
export function canReadTarget(actor: TokenPayload, target?: { view?: string }) {
  return targetVisibility(hiddenSections(actor))(target);
}
/** 按账号自身读权限裁剪状态；被隐藏的数据结构用空工作空间的同名结构替换，保证页面结构完整。 */
export function projectState(state: MistState, actor: TokenPayload, empty: () => MistState, ownerId?: string): { state: MistState; hidden: Section[] } {
  const hidden = hiddenSections(actor), next: MistState = { ...state };
  if (hidden.length) {
    const blank = empty();
    for (const section of hidden) for (const path of section.paths) {
      const [root, child] = path;
      if (child) (next as any)[root] = { ...(next as any)[root], [child]: structuredClone((blank as any)[root]?.[child] ?? []) };
      else (next as any)[root] = structuredClone((blank as any)[root] ?? []);
    }
    const deniedTypes = new Set(hidden.flatMap(s => s.entityTypes)), allowedTypes = new Set(MIST_READ_SECTIONS.flatMap(s => s.entityTypes));
    const visibleTarget = targetVisibility(hidden);
    next.events = (state.events || []).filter(event => event.entityType === 'workspace' || allowedTypes.has(event.entityType) && !deniedTypes.has(event.entityType));
    next.tasks = (state.tasks || []).filter(task => visibleTarget(task.target));
    next.notifications = (state.notifications || []).filter(item => visibleTarget(item.target));
    next.calendar = (state.calendar || []).filter(item => visibleTarget(item.target));
  }
  next.files = visibleFiles(state, next, actor.userId, ownerId);
  return { state: next, hidden };
}
/** 精确匹配附件 ID，不用全文子串判断，避免相似文本开放隐藏附件。 */
function referencedFiles(state: MistState): Set<string> {
  const ids = new Set((state.files || []).map(file => file.id)), found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') { if (ids.has(value)) found.add(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk({ ...state, files: [] });
  return found;
}
/** 已引用附件须有可见来源；尚未引用的附件只给上传人/空间所有者。 */
function visibleFiles(full: MistState, projected: MistState, actorId: string, ownerId?: string) {
  const visible = referencedFiles(projected), referenced = referencedFiles(full);
  return (full.files || []).filter(file => visible.has(file.id) || !referenced.has(file.id) && (actorId === ownerId || file.uploadedBy === actorId));
}
export function canReadFile(state: MistState, actor: TokenPayload, fileId: string, empty: () => MistState, ownerId?: string) {
  return projectState(state, actor, empty, ownerId).state.files.some(file => file.id === fileId);
}