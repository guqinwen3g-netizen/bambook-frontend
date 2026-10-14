/**
 * 售后索赔协同（CAP-claims-01..03 · 协同首轮）。
 * 业务口径（2026-10-14 用户确认的实际做法）：
 * - 业务员接到客诉后建案，并通知内部质检、负责人、跟单 / 采购和相关工厂。通知工厂只是请其配合核实，
 *   不等于认定工厂责任，也不等于答应客户金额；系统不对外发送，只记录实际通知方式、时间与内部备注。
 *   本系统是公司端；供应商端 / 客户端是后续独立平台（数据互通），本轮不做对外说明或对外可见字段。
 * - 内部质检牵头核实事实：是否属实、影响范围、货物位置、可减损措施、工厂回复、是否涉及安全隐患。
 *   先核实再谈责任和金额；紧急情况允许先处置，页面会明确标出“质检尚未核实”。
 * - 两笔账分开：对客户的处置（折让 / 退货退款 / 补发 / 返修，沿用原处置审批）与向工厂追偿分别记录；
 *   公司自担 = 对客户已批准金额 − 工厂已同意金额，仅同币种时计算，不做汇率估算。
 * - 工厂追偿：协商中 → 已同意（金额与方式）→ 已落实（实际扣款 / 收款凭据）；放弃追偿须负责人（aftersales:approve）且不能自批。
 * - 客户处理完、工厂补偿落实或经批准放弃，案件才能关闭。
 */
import { MistCommandError, mistMoneyMinor, type MistContext, type MistState } from './mistWorkspace';
import { recoveryDeductedMinor } from './mistPayables';

export type ClaimGoodsLocation = 'factory' | 'transit' | 'customer' | 'sold' | 'unknown';
export type ClaimVerifyResult = 'confirmed' | 'partial' | 'notConfirmed';
export type ClaimRecoveryMethod = 'deduction' | 'payment' | 'replacement' | 'mixed';
export type ClaimRecoveryState = 'Negotiating' | 'Agreed' | 'Settled' | 'Waived' | 'Withdrawn';
export type ClaimNotice = { id: string; at: string; by: string; byId: string; supplierId: string; supplierName: string; factoryChannel: string; note: string; /** 首轮旧字段，只读兼容 */ factoryNote?: string; internalNote?: string };
export type ClaimVerification = { id: string; at: string; by: string; byId: string; result: ClaimVerifyResult; scope: string; affectedQuantity: number; unit: string; goodsLocation: ClaimGoodsLocation; mitigation: string; factoryResponse: string; safety: boolean; fileIds: string[] };
export type ClaimRecoveryEvent = { at: string; by: string; action: string; note: string };
export type ClaimRecovery = {
  id: string; supplierId: string; supplierName: string; currency: string; requested: number; basis: string; state: ClaimRecoveryState; createdAt: string; createdBy: string; createdById: string;
  agreed?: number; method?: ClaimRecoveryMethod; agreedNote?: string; settled?: number; settledRef?: string; settledDate?: string; waiveReason?: string; events: ClaimRecoveryEvent[];
};
export type ClaimCoordination = { notices: ClaimNotice[]; verifications: ClaimVerification[]; recoveries: ClaimRecovery[] };
type ClaimLike = { id: string; code: string; orderId: string; invoiceId: string; state: string; coordination?: ClaimCoordination; dispositions: Array<{ kind: string; amount: number; state: string; supersededById?: string }> };

export type ClaimCoordinationCommand =
  | { type: 'platform.claim.notify'; payload: { id: string; supplierId: string; factoryChannel: string; note: string } }
  | { type: 'platform.claim.verify'; payload: { id: string; result: ClaimVerifyResult; scope: string; affectedQuantity: number; unit: string; goodsLocation: ClaimGoodsLocation; mitigation: string; factoryResponse: string; safety: boolean; fileIds: string[] } }
  | { type: 'platform.claim.recovery.open'; payload: { claimId: string; supplierId: string; currency: string; requested: number; basis: string } }
  | { type: 'platform.claim.recovery.agree'; payload: { id: string; agreed: number; method: ClaimRecoveryMethod; note: string } }
  | { type: 'platform.claim.recovery.settle'; payload: { id: string; amount: number; reference: string; date: string } }
  | { type: 'platform.claim.recovery.waive'; payload: { id: string; reason: string } };

export const CLAIM_COORDINATION_COMMANDS = ['platform.claim.notify', 'platform.claim.verify', 'platform.claim.recovery.open', 'platform.claim.recovery.agree', 'platform.claim.recovery.settle', 'platform.claim.recovery.waive'] as const;
export const CLAIM_GOODS_LOCATIONS: ClaimGoodsLocation[] = ['factory', 'transit', 'customer', 'sold', 'unknown'];
export const CLAIM_RECOVERY_METHODS: ClaimRecoveryMethod[] = ['deduction', 'payment', 'replacement', 'mixed'];
export const CLAIM_LOCATION_LABEL: Record<ClaimGoodsLocation, string> = { factory: '还在工厂', transit: '运输途中', customer: '已到客户仓库', sold: '已上架 / 已销售', unknown: '尚不清楚' };
export const CLAIM_RESULT_LABEL: Record<ClaimVerifyResult, string> = { confirmed: '问题属实', partial: '部分属实', notConfirmed: '不属实' };
export const CLAIM_METHOD_LABEL: Record<ClaimRecoveryMethod, string> = { deduction: '从货款中扣', payment: '工厂付款', replacement: '工厂免费补货 / 返修', mixed: '组合方式' };
export const CLAIM_RECOVERY_LABEL: Record<ClaimRecoveryState, string> = { Negotiating: '协商中', Agreed: '工厂已同意', Settled: '已落实', Waived: '已批准放弃', Withdrawn: '已撤回' };

export function claimCoordinationPermission(type: ClaimCoordinationCommand['type']): string {
  if (type === 'platform.claim.verify') return 'qc:inspect';
  if (type === 'platform.claim.recovery.settle') return 'invoices:reconcile';
  if (type === 'platform.claim.recovery.waive') return 'aftersales:approve';
  return 'aftersales:write';
}

function fail(message: string, code = 'VALIDATION'): never { throw new MistCommandError(code as any, message); }
function text(v: unknown, label: string, required = true, max = 2000) { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail(label + '未填写或格式无效'); return (v as string).trim(); }
function amount(v: unknown, label: string, allowZero = false) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) fail(label + (allowZero ? '须为非负金额' : '须大于零')); const minor = mistMoneyMinor(v as number); if (!/^\d{1,12}(\.\d{1,2})?$/.test(String(v))) fail(label + '最多两位小数'); return minor / 100; }
function day(v: unknown) { const s = text(v, '日期'); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) fail('日期无效'); return s; }
function businessDay(instant: string) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)); const v = (t: string) => parts.find(x => x.type === t)?.value ?? ''; return v('year') + '-' + v('month') + '-' + v('day'); }
function enumOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T { if (!allowed.includes(v as T)) fail(label + '无效'); return v as T; }
function coordination(claim: ClaimLike): ClaimCoordination { if (!claim.coordination) claim.coordination = { notices: [], verifications: [], recoveries: [] }; return claim.coordination; }
function active(claim: ClaimLike) { if (claim.state === 'Closed' || claim.state === 'Cancelled') fail('案件已结束，不能继续处理'); }
function actor(c: MistContext) { if (!c.actorId) fail('须记录实际登录账号', 'PRECONDITION'); return c.actorId!; }
function supplier(root: MistState, id: string) { const row = (root as MistState & { market?: { suppliers: Array<{ id: string; name: string }> } }).market?.suppliers.find(s => s.id === id); if (!row) fail('请选择供应商档案中的准确工厂', 'NOT_FOUND'); return row!; }
function claimOf(claims: ClaimLike[], id: string) { const row = claims.find(r => r.id === id); if (!row) fail('客诉案件不存在', 'NOT_FOUND'); return row!; }
function recoveryOf(claims: ClaimLike[], id: string) { for (const claim of claims) { const row = claim.coordination?.recoveries.find(r => r.id === id); if (row) return { claim, row }; } return fail('工厂追偿记录不存在', 'NOT_FOUND'); }
function emit(root: MistState, c: MistContext, claimId: string, message: string, fileIds: string[] = []) { root.events.unshift({ id: c.id(), entityType: 'claim', entityId: claimId, at: c.now, actor: c.actorName, text: message, fileIds: [...fileIds] }); }
function task(root: MistState, c: MistContext, claimId: string, kind: string, title: string) { const existing = root.tasks.find(t => t.kind === kind && t.target.view === 'claims' && t.target.id === claimId); if (existing) { existing.title = title; existing.done = false; return; } root.tasks.unshift({ id: c.id(), title, due: '', done: false, kind, target: { view: 'claims', id: claimId } }); }
function done(root: MistState, claimId: string, kind: string) { for (const t of root.tasks) if (t.kind === kind && t.target.view === 'claims' && t.target.id === claimId) t.done = true; }
function notify(root: MistState, c: MistContext, claimId: string, title: string, detail: string) { root.notifications.unshift({ id: c.id(), title, detail, at: c.now, readAt: null, target: { view: 'claims', id: claimId }, category: 'general' }); }
function claimFiles(root: MistState, ids: unknown) { if (!Array.isArray(ids) || ids.length > 50) fail('附件无效'); for (const id of ids) if (!root.files.some(f => f.id === id)) fail('附件不存在', 'NOT_FOUND'); return [...new Set(ids as string[])]; }

/** 当前质检结论（最新一次核实）；未核实返回 null。 */
export function currentClaimVerification(claim: { coordination?: ClaimCoordination }) { const rows = claim.coordination?.verifications ?? []; return rows.length ? rows[rows.length - 1] : null; }
const OPEN_RECOVERY: ClaimRecoveryState[] = ['Negotiating', 'Agreed'];

/** 两笔账（creditsOpen：贷项通知单仍有未结清余额，客户这边尚未真正处理完）：对客户已批准 / 已执行的金额、工厂已同意 / 已落实的金额、公司自担（同币种才计算）。 */
export function claimLedger(root: MistState, claim: ClaimLike, opts: { creditsOpen?: boolean } = {}) {
  const currency = root.invoices.find(i => i.id === claim.invoiceId)?.currency ?? '';
  const customerMinor = claim.dispositions.filter(d => ['approved', 'Executed'].includes(d.state) && !d.supersededById).reduce((s, d) => s + mistMoneyMinor(d.amount || 0), 0);
  const pendingMinor = claim.dispositions.filter(d => ['Draft', 'pending'].includes(d.state) && !d.supersededById).reduce((s, d) => s + mistMoneyMinor(d.amount || 0), 0);
  const recoveries = (claim.coordination?.recoveries ?? []).filter(r => r.state !== 'Withdrawn');
  const sameCurrency = recoveries.every(r => r.currency === currency);
  const agreedMinor = recoveries.filter(r => r.state === 'Agreed' || r.state === 'Settled').reduce((s, r) => s + mistMoneyMinor(r.agreed ?? 0), 0);
  const settledMinor = recoveries.filter(r => r.state === 'Settled').reduce((s, r) => s + mistMoneyMinor(r.settled ?? 0), 0);
  const requestedMinor = recoveries.filter(r => r.state !== 'Waived').reduce((s, r) => s + mistMoneyMinor(r.requested), 0);
  const customerOpen = claim.dispositions.some(d => ['Draft', 'pending', 'approved'].includes(d.state) && !d.supersededById);
  const recoveryOpen = recoveries.some(r => OPEN_RECOVERY.includes(r.state));
  return {
    currency, customer: customerMinor / 100, customerPending: pendingMinor / 100, recoveryRequested: sameCurrency ? requestedMinor / 100 : null,
    recoveryAgreed: sameCurrency ? agreedMinor / 100 : null, recoverySettled: sameCurrency ? settledMinor / 100 : null,
    companyLoss: sameCurrency ? (customerMinor - agreedMinor) / 100 : null, sameCurrency,
    customerSettled: claim.dispositions.length > 0 && !customerOpen && !opts.creditsOpen, customerMoneyOpen: !!opts.creditsOpen, recoveryOpen, hasRecovery: recoveries.length > 0,
  };
}

/** 关闭前置：工厂追偿必须已落实、已批准放弃或已撤回。 */
export function assertClaimRecoveriesSettled(claim: ClaimLike) {
  const open = (claim.coordination?.recoveries ?? []).filter(r => OPEN_RECOVERY.includes(r.state));
  if (open.length) fail('客户这边已处理，但还有 ' + open.length + ' 笔工厂补偿未落实；落实或经负责人批准放弃后才能关闭', 'PRECONDITION');
}

/** 撤销案件：已落实的工厂补偿不能随案撤销；协商中 / 已同意的追偿一并撤回并留痕。 */
export function withdrawClaimRecoveries(claim: ClaimLike, reason: string, c: MistContext) {
  const rows = claim.coordination?.recoveries ?? [];
  if (rows.some(r => r.state === 'Settled')) fail('工厂补偿已落实，不能直接撤销案件；请人工核对退回工厂款项', 'PRECONDITION');
  for (const r of rows) if (OPEN_RECOVERY.includes(r.state)) { r.state = 'Withdrawn'; r.events.push({ at: c.now, by: c.actorName, action: 'withdraw', note: '随案撤销：' + reason }); }
}

export function applyClaimCoordinationCommand(root: MistState, claims: ClaimLike[], command: ClaimCoordinationCommand, c: MistContext): Record<string, unknown> {
  switch (command.type) {
    case 'platform.claim.notify': {
      const v = command.payload, claim = claimOf(claims, v.id); active(claim); const byId = actor(c), s = supplier(root, text(v.supplierId, '相关工厂'));
      const notice: ClaimNotice = { id: c.id(), at: c.now, by: c.actorName, byId, supplierId: s.id, supplierName: s.name, factoryChannel: text(v.factoryChannel, '通知工厂的实际方式', true, 200), note: text(v.note, '备注', false) };
      coordination(claim).notices.push(notice);
      task(root, c, claim.id, 'claim-verify:' + claim.id, '质检核实客诉事实 · ' + claim.code);
      task(root, c, claim.id, 'claim-factory:' + claim.id, '跟进工厂核实回复 · ' + claim.code + ' · ' + s.name);
      notify(root, c, claim.id, claim.code + ' · 新客诉待关注', '业务员 ' + c.actorName + ' 已通知质检、跟单与工厂（' + s.name + '）配合核实；通知工厂不代表认定责任或答应客户金额。');
      emit(root, c, claim.id, '通知相关人员：内部质检 / 负责人 / 跟单，工厂 ' + s.name + '（' + notice.factoryChannel + '）');
      return { id: notice.id, claimId: claim.id };
    }
    case 'platform.claim.verify': {
      const v = command.payload, claim = claimOf(claims, v.id); active(claim); const byId = actor(c);
      const qty = v.affectedQuantity; if (typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty * 10000)) fail('影响数量须为非负数');
      const row: ClaimVerification = { id: c.id(), at: c.now, by: c.actorName, byId, result: enumOf(v.result, ['confirmed', 'partial', 'notConfirmed'] as const, '核实结论'), scope: text(v.scope, '影响范围（款式 / 批次）'), affectedQuantity: qty, unit: text(v.unit, '数量单位', qty > 0, 20), goodsLocation: enumOf(v.goodsLocation, CLAIM_GOODS_LOCATIONS, '货物现在的位置'), mitigation: text(v.mitigation, '减少损失的办法', false), factoryResponse: text(v.factoryResponse, '工厂回复', false), safety: v.safety === true, fileIds: claimFiles(root, v.fileIds ?? []) };
      const first = !coordination(claim).verifications.length; coordination(claim).verifications.push(row);
      done(root, claim.id, 'claim-verify:' + claim.id); if (row.factoryResponse) done(root, claim.id, 'claim-factory:' + claim.id);
      notify(root, c, claim.id, claim.code + ' · 质检' + (first ? '已核实' : '更新核实') + '：' + CLAIM_RESULT_LABEL[row.result], (row.safety ? '⚠ 涉及安全隐患，需单独评估停售或召回，不能只谈折扣。' : '') + '影响 ' + row.scope + ' · ' + row.affectedQuantity + ' ' + row.unit + ' · 货物' + CLAIM_LOCATION_LABEL[row.goodsLocation]);
      emit(root, c, claim.id, '质检核实：' + CLAIM_RESULT_LABEL[row.result] + (row.safety ? '（涉及安全隐患）' : ''), row.fileIds);
      return { id: row.id, claimId: claim.id };
    }
    case 'platform.claim.recovery.open': {
      const v = command.payload, claim = claimOf(claims, v.claimId); active(claim); const byId = actor(c), s = supplier(root, text(v.supplierId, '追偿工厂'));
      const currency = text(v.currency, '币种', true, 8).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) fail('币种须为三位代码');
      if (coordination(claim).recoveries.some(r => r.supplierId === s.id && OPEN_RECOVERY.includes(r.state))) fail('该工厂已有一笔未落实的追偿，请在原记录上继续', 'CONFLICT');
      const row: ClaimRecovery = { id: c.id(), supplierId: s.id, supplierName: s.name, currency, requested: amount(v.requested, '要求工厂承担的金额'), basis: text(v.basis, '追偿依据'), state: 'Negotiating', createdAt: c.now, createdBy: c.actorName, createdById: byId, events: [{ at: c.now, by: c.actorName, action: 'open', note: '向工厂提出 ' + currency + ' ' + v.requested }] };
      coordination(claim).recoveries.push(row); done(root, claim.id, 'claim-factory:' + claim.id);
      task(root, c, claim.id, 'claim-recovery:' + row.id, '跟进工厂补偿 · ' + claim.code + ' · ' + s.name);
      emit(root, c, claim.id, '向工厂 ' + s.name + ' 提出追偿 ' + currency + ' ' + row.requested);
      return { id: row.id, claimId: claim.id };
    }
    case 'platform.claim.recovery.agree': {
      const v = command.payload, { claim, row } = recoveryOf(claims, v.id); active(claim); actor(c);
      if (row.state !== 'Negotiating') fail('只有协商中的追偿可以记录工厂同意结果');
      row.agreed = amount(v.agreed, '工厂同意承担的金额'); row.method = enumOf(v.method, CLAIM_RECOVERY_METHODS, '补偿方式'); row.agreedNote = text(v.note, '工厂确认依据（邮件 / 签字等）'); row.state = 'Agreed';
      row.events.push({ at: c.now, by: c.actorName, action: 'agree', note: '工厂同意 ' + row.currency + ' ' + row.agreed + ' · ' + CLAIM_METHOD_LABEL[row.method] + ' · ' + row.agreedNote });
      emit(root, c, claim.id, '工厂 ' + row.supplierName + ' 同意承担 ' + row.currency + ' ' + row.agreed + '（' + CLAIM_METHOD_LABEL[row.method] + '）');
      return { id: row.id, claimId: claim.id };
    }
    case 'platform.claim.recovery.settle': {
      const v = command.payload, { claim, row } = recoveryOf(claims, v.id); active(claim); actor(c);
      if (row.state !== 'Agreed') fail('须先记录工厂同意的金额与方式，才能登记实际落实');
      // 从货款中扣：由财务在应付里按票据登记扣款，扣满后自动落实；组合方式：已扣部分 + 本次其他方式落实合计不超过同意金额。
      if (row.method === 'deduction') fail('该追偿方式为“从货款中扣”，请由财务在应付里按工厂票据登记索赔扣款，扣满后自动落实', 'PRECONDITION');
      const deducted = row.method === 'mixed' ? recoveryDeductedMinor(root, row.id) : 0;
      const other = amount(v.amount, '实际落实金额'), settledMinor = deducted + mistMoneyMinor(other);
      if (settledMinor > mistMoneyMinor(row.agreed ?? 0)) fail(deducted ? `已从货款中扣 ${(deducted / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}，加上本次落实会超过工厂同意金额` : '实际落实金额不能超过工厂同意金额');
      const settled = settledMinor / 100;
      const date = day(v.date); if (date > businessDay(c.now)) fail('落实日期不能在未来');
      row.settled = settled; row.settledRef = text(v.reference, '实际扣款 / 收款凭据'); row.settledDate = date; row.state = 'Settled';
      row.events.push({ at: c.now, by: c.actorName, action: 'settle', note: '实际落实 ' + row.currency + ' ' + settled + ' · ' + row.settledRef });
      done(root, claim.id, 'claim-recovery:' + row.id);
      emit(root, c, claim.id, '工厂补偿已落实 ' + row.currency + ' ' + settled + ' · ' + row.settledRef);
      return { id: row.id, claimId: claim.id };
    }
    case 'platform.claim.recovery.waive': {
      const v = command.payload, { claim, row } = recoveryOf(claims, v.id); active(claim); const byId = actor(c);
      if (!OPEN_RECOVERY.includes(row.state)) fail('当前追偿已结束');
      if (byId === row.createdById) fail('提出追偿的人不能自己批准放弃，请由负责人决定', 'FORBIDDEN');
      row.waiveReason = text(v.reason, '放弃追偿的原因'); row.state = 'Waived';
      row.events.push({ at: c.now, by: c.actorName, action: 'waive', note: row.waiveReason });
      done(root, claim.id, 'claim-recovery:' + row.id);
      emit(root, c, claim.id, '负责人批准放弃向 ' + row.supplierName + ' 追偿：' + row.waiveReason);
      return { id: row.id, claimId: claim.id };
    }
  }
}
