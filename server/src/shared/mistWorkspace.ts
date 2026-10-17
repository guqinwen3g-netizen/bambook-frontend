import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import {developmentCharged,developmentDomain,developmentInitiator,emptyFabricRequirements,fabricRequirementError,validFabricSample,type DevelopmentDomain,type DevelopmentInitiator,type DevelopmentRequestType,type FabricDevelopmentRequirements} from './mistDevelopmentDomain';
import { relationHoldReason } from './mistRelationHold';
import {demoAccountRef,ownerChangeText,resolveMember,setMemberGroups,type MistMemberDirectoryEntry,type MistMemberGroupAssignment} from './mistAccounts';
import { supplierBusinessDay, supplierUnavailableReason } from './mistSupplierStatus';
import {assignFactoryLetters,defaultFactoryTask,developmentClosure,developmentRoundBlocker,duplicateRoundFactories,factoryTaskError,factoryTaskNote,factoryTaskSync,factoryTaskSyncBlocker,minorVersionBlocker,minorVersionLabel,minorVersions,nextRoundNumber,roundVersionLabel,type FactoryTaskInput} from './mistDevelopmentRounds';
import {createFulfillmentState,applyFulfillmentCommand,fulfillmentCommandPermission,getFulfillmentReviews,assertProductionTransition,type FulfillmentState,type FulfillmentCommand} from './mistFulfillment';
import {createMarketState,applyMarketCommand,backfillQuoteLineFamilies,marketCommandPermission,getMarketReviews,type MarketState,type MarketCommand} from './mistMarket';
import {createCrmState,applyCrmCommand,crmCommandPermission,type CrmState,type CrmCommand} from './mistCrm';
import {seedDemoModules,DEMO_SEED_VERSION} from './mistDemoSeed';
import {createEmailState,applyEmailCommand,emailCommandPermission,seedEmailExamples,type EmailState,type EmailCommand} from './mistEmail';
import {createPlatformState,applyPlatformCommand,platformCommandPermission,getPlatformReviews,platformCreditAppliedMinor,getRequiredBusinessNumberPlan as platformBusinessNumberPlan,platformBusinessDate,type PlatformState,type PlatformCommand} from './mistPlatform';
import type {MistCreditDocumentIssue} from './mistCreditDocuments';
import {developmentNoticeBlocker,developmentNoticeContent,developmentNoticeFingerprint,developmentNoticeNo,type DevNoticeArtifact,type DevNoticeRecord,type DevNoticeSnapshot} from './mistDevelopmentNotice';
import type {MistReviewTask} from './mistReview';
import {DEVELOPMENT_BILLING_LOCK,billingRequestBlocker,billingTotals,developmentBillTo,developmentBillingSettled,developmentBillingStage,developmentFeeSummary,developmentSamplesOf,makingFeeBlocker,type MistDevBilling} from './mistDevelopmentBilling';
import {confirmationNeedsForms,developmentVersionSamples,sampleDispatchBlocker,sampleFormBlocker,sampleRef,type MistSampleDispatch,type MistSampleFee,type MistSampleRef} from './mistDevelopmentSamples';
import {assertOrderLineSource,type OrderLineSource} from './mistOrderSource';
import {lineQuantityFromBreakdown,type OrderLineBreakdown} from './mistOrderBreakdown';
import {isLineClosed} from './mistOrderClosure';
import {createOrderGovernance,applyOrderGovernanceCommand,orderGovernancePermission,getOrderGovernanceReviews,assertOrderApproved,assertOrderWritable,assertOrderNotTerminated,type OrderGovernanceFields,type OrderGovernanceCommand,type OrderGovernanceInput} from './mistOrderGovernance';
import {createOrderFundingState,applyOrderFundingCommand,orderFundingCommandPermission,assertOrderDepositCovered,assertOrderFundingIntegrity,type OrderFundingState,type OrderFundingCommand} from './mistOrderFunding';
import {createPayablesState,applyPayablesCommand,payablesCommandPermission,getPayableReviews,type PayablesState,type PayablesCommand} from './mistPayables';

/** Mist's typed business workspace. Shared by its API and the approved frontend. */
export type MistTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'ai';
export type MistImage = 'coat' | 'blazer' | 'suit' | 'clay';
export type MistBusinessNumberPrefix = 'CLM' | 'RT' | 'PV';
export type MistContext = {
  id: () => string; now: string; actorName: string; actorId?: string;
  /** 服务端从实时读投影生成，不能由命令 payload 扩大；不重构共享通知的数据模型。 */
  visibleNotificationIds?: string[];
  /** 服务端按本次执行账号的实时有效权限生成；领域处理内二次校验用，缺省视为无权（失败关闭）。 */
  can?: (scope: string) => boolean;
  consumeBusinessNumber?: (prefix: MistBusinessNumberPrefix) => string;
  creditDocumentIssue?: MistCreditDocumentIssue;
  /** 服务端按本次执行时的所有者、授权成员、账号状态与业务组构建（包 A）；负责人/经手人只能从这里按账号 ID 选，缺省一律拒绝。 */
  members?: MistMemberDirectoryEntry[];
  authority?: { supplier: Record<string,{version:number;userIds:string[]}>; claimReviewerId?:string; businessReviewerId?:string; orderReviewerIds?:{garment:string[];fabric:string[]}; paymentReviewerIds?:string[]; /** 风险处理与审批：服务端按当前账号岗位权限与部门主管路由重建，不接受 payload。 */ risk?:{ all:boolean; orders:boolean; customers:boolean }; riskReviewerIds?:string[] };
};
export type DevelopmentValues = {
  domain?:DevelopmentDomain; sampleForm?:string; sampleUnit?:string; targetCurrency?:string; targetUnit?:string; fabricRequirements?:FabricDevelopmentRequirements;
  name: string; customer: string; style: string; season: string; category: string;
  kind: 'new' | 'rev' | 'copy'; fabric: string; color: string; target: string;
  sizeBase: string; goal: string; factories: string[]; due: string;
  collaborators: string[]; sampleQuantity: number; sourceDevId?: string; sourceVersionId?: string;
  /** 发起方（BB-DEV-1）：客户要求须有客户与要求类型；内部需求无客户，须有内部需求方。 */
  initiator?: DevelopmentInitiator; requestType?: DevelopmentRequestType; requestNote?: string;
  requester?: string; requesterId?: string; charged?: boolean;
};
export type MistFile = { id: string; name: string; mimeType: string; size: number; storageKey: string; createdAt: string; uploadedBy?: string; url?: string };
export type MistDraft = { id: string; values: DevelopmentValues; fileIds: string[]; updatedAt: string };
export type MistConfirmation = { id: string; result: 'approved' | 'needs_adjustment' | 'rejected'; confirmer: string; organization: string; confirmedAt: string; basis: string; originalText: string; recordedAt: string; recordedBy: string;
  /** BB-DEV-6：面料版本有多条实物时，本次确认针对的准确实物（记录时快照编号与形态）。旧记录没有该字段。 */
  samples?: MistSampleRef[] };
export type MistQc = {
  result: 'pass' | 'conditional' | 'reject'; reviewer: string; reviewedAt: string; report: string; opinion: string;
  fabricMeasurements?:Array<{property:string;actual:number;unit:string}>;
  measurements?: Array<{ point: string; standard: number; actual: number; tolerance: number }>;
  appearanceDefects?: number;
};
export type MistVersion = {
  /** factoryId：工厂的供应商 ID（稳定引用）；factory 为供应商当前显示名，供应商改名时同步。 */
  factoryId: string;
  id: string; devId: string; label: string; factory: string; sample: string; sampleQuantity: number;
  sampleForm?:string; sampleUnit?:string; sampleLocation?:string; sampleColor?:string; fabricRequirements?:FabricDevelopmentRequirements;
  size: string; fabric: string; img: MistImage; fileIds: string[]; returnedAt: string | null;
  qc: MistQc | null; confirmations: MistConfirmation[]; archivedAt: string | null; note: string;
  confirmationDraft?: Omit<MistConfirmation, 'id' | 'recordedAt' | 'recordedBy'>;
  /** 所属轮次（BB-DEV-2 起建立的版本才有；历史版本按原版本号展示）。 */
  roundId?: string; factoryLetter?: string;
  /** 历次 QC（整改复检前的结论保留在这里，最新结论仍在 qc）。 */
  qcHistory?: MistQcRecord[];
  /** QC 不通过后的处理：整改复检（仅成衣）/ 重新打样（开新一轮）/ 放弃本版。 */
  qcDecision?: MistQcDecision;
  /** 本厂在本轮的任务（BB-DEV-3）：建轮时复制的共同要求、差异要求与样品要求。改共同要求后需逐厂同步才更新。 */
  task?: MistFactoryTask;
  /** 本厂本轮的试样通知单（BB-DEV-4），每次生成追加一份，旧版保留。 */
  notices?: DevNoticeRecord[];
  /** 服装小版本（BB-DEV-5）：在大版本上记录小调整生成 R4-A.1、.2…；沿用大版本实物与 QC 结论，需求方确认单独记录。 */
  minor?: MistMinorVersion;
  /** BB-DEV-8：从本版准确实物寄出的记录；每条对应样品仓库一条寄出流水。 */
  dispatches?: MistSampleDispatch[];
};
export type MistMinorVersion = { parentVersionId: string; seq: number; change: string; recordedAt: string; recordedBy: string };
export type MistFactoryTask = { commonRequirements: string; extraRequirements: string; sampleForm: string; sampleQuantity: number; sampleUnit: string; dueDate: string; syncedAt: string; syncedBy: string };
export type MistQcDecisionKind = 'rework' | 'resample' | 'abandon';
export type MistQcDecision = { kind: MistQcDecisionKind; note: string; decidedAt: string; decidedBy: string; roundId?: string };
export type MistQcRecord = MistQc & { decision?: MistQcDecision };
/** 开发轮次：一批共同要求，可派给多家工厂；每家工厂在本轮形成一个大版本 R{轮次}-{字母}。 */
export type MistRound = {
  id: string; devId: string; number: number; requirements: string; fileIds: string[];
  /** 参与工厂的供应商 ID。 */
  referenceVersionIds: string[]; factories: string[]; targetDate: string;
  createdAt: string; createdBy: string;
  /** 最近一次修改共同要求（不会自动覆盖已有工厂任务）。 */
  requirementsUpdatedAt?: string; requirementsUpdatedBy?: string;
};
export type MistDev = {
  /** owner 为负责人显示名快照，ownerId 为负责人账号。 */
  id: string; code: string; name: string; style: string; owner: string; ownerId: string; due: string; dueRel: string;
  stage: number; state: string; tone: MistTone; ver: string; fac: number; img: MistImage;
  factory: string; sample: string; fabric: string; goal: string; customer: string; customerId: string;
  currentVersionId: string | null; versionIds: string[]; values: DevelopmentValues; fileIds: string[];
  createdAt: string; updatedAt: string;
  /** 工厂（供应商 ID）→ 本案固定字母；首次参与时分配，之后不变。 */
  factoryLetters?: Record<string, string>;
  /** 开发案级结束：取消 / 归档（手工，须写原因）；不收费开发案认可即结案按派生规则判断。 */
  closure?: { kind: 'closed' | 'archived' | 'cancelled'; at: string; by: string; reason: string };
  /** BB-DEV-9：开发费用（制作费）、开票申请与销账结案；只有收费案使用。 */
  billing?: MistDevBilling;
};
export type MistFabric = { id: string; code: string; name: string; owner: string; ownerId: string; due: string; state: string; tone: MistTone; sub: string; request: string; answer: string; confirmed: boolean; fileIds: string[] };
export type MistOrderLine = { id: string; orderId: string; name: string; style: string; img: MistImage; qty: number; unit: string; price: number; made: number; qc: number };
export type MistChecklistItem = { id: string; label: string; done: boolean; note: string; actor?: string; at?: string };
export type MistOrder = {
  governance?:OrderGovernanceFields;
  id: string; code: string; type: 'garment' | 'fabric'; customerId: string; customer: string;
  season: string; lines: number; qty: number; amount: number; currency: string; due: string;
  progress: number; state: string; tone: MistTone; owner: string; img: MistImage;
  /** 负责人账号（owner 为显示名快照）：按账号选择，服务端校验为本工作区有效成员。 */
  ownerId: string;
  checklist: MistChecklistItem[]; handoffAt: string | null; createdAt: string; updatedAt: string;
};
export type MistProduction = { sourcePurchaseId?:string; id: string; code: string; orderId: string; lineId: string; order: string; name: string; factory: string; qty: number; due: string; pct: number; img: MistImage; col: 'cut' | 'sew' | 'finish' | 'qc' | 'done'; risk?: string; startDate?: string };
export type MistPayment = { id: string; code: string; date: string; payee: string; amount: number; currency: string; ref: string;
  /** finance：财务在付款凭证页登记；旧凭证无此字段。reversalOf：本凭证是对该凭证的反向冲回记录（金额为负）。 */
  origin?: 'finance'; reversalOf?: string;
  /** 该笔付款从哪个公司银行账户付出（财务逐笔归属）；反向冲回凭证沿用原凭证的账户。 */
  accountId?: string };
export type MistReceipt = { id: string; code: string; date: string; payer: string; amount: number; remaining: number; currency: string; ref: string; state: 'unmatched' | 'suggested' | 'matched'; suggest?: string; confidence?: number;
  /** 到账进入的公司银行账户（财务逐笔归属）。 */
  accountId?: string };
/**
 * 公司银行账户台账。一个账户一个币种；期初余额为期初日期当天开始前的银行余额（可为负，如透支）。
 * 账户余额 = 期初 + 已归属到账 − 已归属付款（付款冲回的负额凭证自然加回）。不按汇率折算，不用收款减付款猜余额。
 */
export type MistBankAccount = { id: string; code: string; name: string; bankName: string; accountNo: string; currency: string; openingDate: string; openingBalance: number; createdAt: string; actor: string; actorId?: string; updatedAt?: string };
export type MistBankAccountBalance = { account: MistBankAccount; receipts: number; payments: number; receiptCount: number; paymentCount: number; fxIn: number; fxOut: number; balance: number };
/**
 * 锁汇 / 结汇记录。锁汇：与银行约定的远期汇率合同（原币金额 × 锁定汇率 = 合同本币金额），不动账户余额。
 * 结汇：按银行水单登记实际卖出的原币与入账本币，原币账户减少、本币账户增加；汇率由两笔实际金额得出，不估算。
 * 登记错误另记冲回（reversed），原记录保留。
 */
export type MistFxRecord = { id: string; code: string; kind: 'lock' | 'settlement'; date: string; bankName: string; currency: string; amount: number; localCurrency: string; localAmount: number; rate: string; ref: string; note: string;
  settleBy?: string; fromAccountId?: string; toAccountId?: string; lockId?: string;
  createdAt: string; actor: string; actorId?: string; reversed?: { at: string; actor: string; reason: string } };
/** 按 6 位小数的汇率字符串换算本币（分），四舍五入；只用于锁汇合同金额，不用于估算余额。 */
export function mistFxLocalMinor(amountMinor: number, rate: string): number {
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(rate) || !(Number(rate) > 0)) throw new MistCommandError('VALIDATION', '汇率须为正数，最多 6 位小数');
  const [w, f = ''] = rate.split('.'), scaled = BigInt(w) * BigInt(1000000) + BigInt(f.padEnd(6, '0'));
  const out = (BigInt(amountMinor) * scaled + BigInt(500000)) / BigInt(1000000);
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new MistCommandError('VALIDATION', '金额超出支持范围');
  return Number(out);
}
/** 实际成交汇率：本币 ÷ 原币，6 位小数（由两笔实际金额得出）。 */
export function mistFxRate(amount: number, localAmount: number): string {
  const a = BigInt(Math.round(amount * 100)), l = BigInt(Math.round(localAmount * 100));
  if (a <= BigInt(0)) return '0';
  const scaled = (l * BigInt(1000000) * BigInt(2) + a) / (a * BigInt(2)), text = scaled.toString().padStart(7, '0');
  return text.slice(0, -6) + '.' + text.slice(-6);
}
/** 锁汇合同的已结与剩余（原币，按分）。 */
export function mistFxLockUsage(state: Pick<MistState,'fxRecords'>, lockId: string): { settled: number; remaining: number } {
  const lock = (state.fxRecords || []).find(r => r.id === lockId && r.kind === 'lock');
  const settled = (state.fxRecords || []).filter(r => r.kind === 'settlement' && r.lockId === lockId && !r.reversed).reduce((t, r) => t + Math.round(r.amount * 100), 0);
  return { settled: settled / 100, remaining: lock ? (Math.round(lock.amount * 100) - settled) / 100 : 0 };
}
/** 各账户余额（原币，按分计算）与未归属账户的流水笔数。 */
export function mistBankAccountBalances(state: Pick<MistState,'receipts'|'payments'|'bankAccounts'|'fxRecords'>): { accounts: MistBankAccountBalance[]; unassigned: { receipts: number; payments: number } } {
  const minor = (v: number) => Math.round(v * 100);
  const accounts = (state.bankAccounts || []).map(account => {
    const rs = state.receipts.filter(r => r.accountId === account.id), ps = state.payments.filter(x => x.accountId === account.id);
    const receipts = rs.reduce((t, r) => t + minor(r.amount), 0), payments = ps.reduce((t, x) => t + minor(x.amount), 0);
    const fx = (state.fxRecords || []).filter(r => r.kind === 'settlement' && !r.reversed);
    const fxIn = fx.filter(r => r.toAccountId === account.id).reduce((t, r) => t + minor(r.localAmount), 0), fxOut = fx.filter(r => r.fromAccountId === account.id).reduce((t, r) => t + minor(r.amount), 0);
    return { account, receipts: receipts / 100, payments: payments / 100, receiptCount: rs.length, paymentCount: ps.length, fxIn: fxIn / 100, fxOut: fxOut / 100, balance: (minor(account.openingBalance) + receipts - payments + fxIn - fxOut) / 100 };
  });
  const known = new Set((state.bankAccounts || []).map(a => a.id));
  return { accounts, unassigned: { receipts: state.receipts.filter(r => !r.accountId || !known.has(r.accountId)).length, payments: state.payments.filter(x => !x.accountId || !known.has(x.accountId)).length } };
}
export type MistInvoice = { id: string; code: string; orderId: string; order: string; customer: string; due: string; amount: number; open: number; currency: string; voidedAt?: string; voidReason?: string; voidedBy?: string; voidedById?: string; voidSourceDocumentId?: string;
  /** BB-DEV-9：开发费用应收票据回链来源开发案（这类票据没有订单，orderId 为空）。 */
  devId?: string;
  /** CI 签发形成的应收须经财务确认：pending 待确认、confirmed 已确认、rejected 已驳回（同时作废、CI 退回草稿）。 */
  financeStatus?: MistReceivableFinanceStatus; sourceDocumentId?: string;
  financeConfirmedAt?: string; financeConfirmedBy?: string; financeConfirmedById?: string;
  financeRejectedAt?: string; financeRejectedBy?: string; financeRejectedById?: string; financeRejectReason?: string };
export type MistReceivableFinanceStatus = 'pending' | 'confirmed' | 'rejected';
/** Void preserves the original face value while removing the invoice from current receivables. */
export function isActiveMistInvoice(invoice: Pick<MistInvoice, 'voidedAt'>): boolean { return !invoice.voidedAt; }
/** 已作废之外，CI 应收待财务确认或已驳回时也不计入余额、账龄、报表、催收与核销。 */
export function isRecognizedMistInvoice(invoice: Pick<MistInvoice, 'voidedAt' | 'financeStatus'>): boolean { return isActiveMistInvoice(invoice) && invoice.financeStatus !== 'pending' && invoice.financeStatus !== 'rejected'; }
export function isPendingFinanceMistInvoice(invoice: Pick<MistInvoice, 'voidedAt' | 'financeStatus'>): boolean { return isActiveMistInvoice(invoice) && invoice.financeStatus === 'pending'; }
export type MistAllocation = { id: string; receiptId: string; invoiceId: string; amount: number; currency: string; createdAt: string; actor: string; payerBasis?:string };
/**
 * 核销 / 付款冲回记录。原记录不删除不改写：核销冲回后原核销整条快照保存在 allocation 中、
 * 退出当前核销集合（流水余额与发票未收按剩余有效核销回算）；付款冲回另记一张负额反向凭证（voucherId）。
 */
export type MistFinanceReversal = { id: string; kind: 'allocation' | 'payment'; targetId: string; amount: number; currency: string; reason: string; at: string; actor: string; actorId?: string;
  allocation?: MistAllocation; receiptId?: string; invoiceId?: string; voucherId?: string };
export type MistCustomer = { id: string; name: string; code: string; country: string; city: string; industry: string; owner: string; /** 同 MistOrder.ownerId。 */ ownerId: string; grade: string; currency: string; terms: string; incoterm: string; categories: string; creditLimit: number; since: string };
export type MistContact = { id: string; customerId: string; name: string; role: string; email: string; phone: string; tone: MistTone };
export type MistEvent = { id: string; entityType: string; entityId: string; actor: string; at: string; text: string; fileIds: string[] };
export type MistTarget = { view: string; id?: string; versionId?: string; customerId?: string; orderLineId?: string; productionId?: string };
/**
 * 工作事项必须写明由谁处理：assigneeIds 为指定账号；permission 为「持有该权限的任何人」（岗位事项，如财务开票、后勤接手）。
 * 两者都为空的事项不进入任何人的「我的工作」和侧栏数字。
 */
export type MistTask = { id: string; title: string; due: string; done: boolean; kind: string; target: MistTarget; assigneeIds: string[]; permission?: string };
/** 后勤岗位标识（logistics:handle）：只决定出运交接、待物流接手等事项归谁，不授予任何操作；与清关等操作权限分开调整。 */
export const MIST_LOGISTICS_DUTY = 'logistics:handle';
/** 订单负责人账号（变更、取消、客诉后续由订单负责人跟进）。 */
export function mistOrderOwnerIds(root: Pick<MistState, 'orders'>, orderId: string): string[] { const owner = root.orders.find(order => order.id === orderId)?.ownerId; return owner ? [owner] : []; }
export type MistNotification = { id: string; title: string; detail: string; at: string; readAt: string | null; target: MistTarget; category?:'qc'|'shipping'|'suggestion'|'general' };
export type MistCalendarEvent = { id: string; title: string; date: string; time: string; note: string; target?: MistTarget };
export type MistCompanyProfile={legalName:string;englishName:string;address:string;englishAddress:string;phone:string;email:string;taxId:string;customsCode:string;bankName:string;bankAccount:string;swift:string;defaultCurrency:string};
export type MistSettings = { companyProfile?:MistCompanyProfile; theme: 'light' | 'dark' | 'system'; density: 'compact' | 'default' | 'comfy'; reducedMotion: boolean; notifications: { qc: boolean; shipping: boolean; suggestions: boolean; digest: boolean }; workspaceName: string; profileName: string; profileEmail: string; locale: string; /** 仅演示工作区：示例数据版本；客户端不可设置。 */ demoSeed?: { version: number; seededAt: string } };
export type MistState = {
  orderFunding?:OrderFundingState;
  payables?:PayablesState;
  workspaceArchive?: {at:string;actorId:string};
  schemaVersion: 1; devs: MistDev[]; versions: MistVersion[]; rounds?: MistRound[]; drafts: MistDraft[]; fabrics: MistFabric[];
  orders: MistOrder[]; orderLines: MistOrderLine[]; productions: MistProduction[];
  receipts: MistReceipt[]; invoices: MistInvoice[]; allocations: MistAllocation[]; payments: MistPayment[];
  financeReversals?: MistFinanceReversal[];
  bankAccounts?: MistBankAccount[];
  fxRecords?: MistFxRecord[];
  customers: MistCustomer[]; contacts: MistContact[]; files: MistFile[];
  events: MistEvent[]; tasks: MistTask[]; notifications: MistNotification[]; calendar: MistCalendarEvent[];
  settings: MistSettings; fulfillment:FulfillmentState; market:MarketState; platform:PlatformState; email:EmailState; crm:CrmState; reviewerIds?:string[];
  /** 所有者明确授权进入本空间的账号（只管进入，不授予业务权限）与授权历史。 */
  memberIds?:string[]; members?:MistWorkspaceMember[]; memberLog?:MistWorkspaceMemberLog[];
  /** 成员业务组（面料/成衣，可多选），所有者在成员管理设置。 */
  memberGroups?:MistMemberGroupAssignment[];
};
export type MistOrderInput = { type: 'garment' | 'fabric'; customerId: string; season: string; currency: string; due: string; ownerId: string; governance?:OrderGovernanceInput; lines: Array<Omit<MistOrderLine, 'id' | 'orderId' | 'made' | 'qc'> & OrderLineSource & {breakdown?:OrderLineBreakdown}> };
export type MistCommand = FulfillmentCommand | MarketCommand | PlatformCommand | EmailCommand | CrmCommand | OrderGovernanceCommand | OrderFundingCommand | PayablesCommand
  | { type: 'development.saveDraft'; payload: { draftId?: string; values: DevelopmentValues; fileIds: string[] } }
  | { type: 'development.submit'; payload: { draftId?: string; values: DevelopmentValues; fileIds: string[] } }
  | { type: 'development.update'; payload: { devId: string; patch: Partial<DevelopmentValues> } }
  | { type: 'development.move'; payload: { devId: string; stage: number } }
  | { type: 'development.recordSample'; payload: { devId: string; versionId: string; sample: string; quantity: number; returnedAt: string; form?:string; unit?:string; location?:string; color?:string } }
  | { type: 'development.recordQc'; payload: { devId: string; versionId: string; qc: MistQc; domain?:DevelopmentDomain } }
  | { type: 'development.confirm'; payload: { devId: string; versionId: string; result: MistConfirmation['result']; confirmer: string; organization: string; confirmedAt: string; basis: string; originalText: string; sampleIds?: string[] } }
  | { type: 'development.saveConfirmationDraft'; payload: { devId: string; versionId: string; draft: Omit<MistConfirmation, 'id' | 'recordedAt' | 'recordedBy'> } }
  | { type: 'development.revise'; payload: { devId: string; versionId: string; note: string } }
  | { type: 'development.archive'; payload: { devId: string; versionId: string } }
  | { type: 'development.round.create'; payload: { devId: string; factories: string[]; requirements: string; fileIds?: string[]; referenceVersionIds?: string[]; targetDate: string; /** QC 不通过后“重新打样”：记录来源版本的处理决定 */ resampleFromVersionId?: string; /** 逐厂差异要求、样品形态、数量和单位、要求日期；缺省按开发案计划样品与本轮目标日期 */ factoryTasks?: Array<Partial<FactoryTaskInput> & { factory: string }> } }
  | { type: 'development.round.updateRequirements'; payload: { devId: string; roundId: string; requirements: string } }
  | { type: 'development.version.syncRequirements'; payload: { devId: string; versionId: string } }
  | { type: 'development.notice.generate'; payload: { devId: string; versionId: string } }
  | { type: 'development.version.addSampleForm'; payload: { devId: string; versionId: string; form: string; quantity: number; unit: string; location?: string; color?: string; note?: string } }
  | { type: 'development.sample.dispatch'; payload: { devId: string; versionId: string; sampleId: string; quantity: number; recipient: string; trackingNo?: string; fee?: MistSampleFee | null; note?: string; sourceLocation?: string } }
  | { type: 'development.sample.dispatchFee'; payload: { devId: string; versionId: string; dispatchId: string; fee: MistSampleFee } }
  | { type: 'development.fee.recordMaking'; payload: { devId: string; sampleId: string; amount: number; currency: string } }
  | { type: 'development.billing.request'; payload: { devId: string } }
  | { type: 'finance.developmentInvoice.issue'; payload: { devId: string; requestId: string; due: string } }
  | { type: 'development.version.recordMinor'; payload: { devId: string; versionId: string; change: string } }
  | { type: 'development.close'; payload: { devId: string; kind: 'archived' | 'cancelled'; reason: string } }
  | { type: 'development.qc.decide'; payload: { devId: string; versionId: string; decision: 'rework' | 'abandon'; note: string } }
  | { type: 'fabric.create'; payload: { name: string; request: string; ownerId: string; due: string } }
  | { type: 'fabric.answer'; payload: { id: string; answer: string; fileIds: string[] } }
  | { type: 'fabric.confirm'; payload: { id: string; approved: boolean; note: string } }
  | { type: 'order.create'; payload: MistOrderInput }
  | { type: 'order.update'; payload: { orderId: string; due?: string; season?: string; ownerId?: string } }
  | { type: 'order.checklist'; payload: { orderId: string; itemId: string; done: boolean } }
  | { type: 'order.handoff'; payload: { orderId: string; note?: string } }
  | { type: 'production.move'; payload: { id: string; col: MistProduction['col']; note?: string } }
  | { type: 'production.update'; payload: { id: string; pct: number; risk?: string; note?: string; startDate?: string; due?: string } }
  | { type: 'finance.importReceipts'; payload: { receipts: Array<{ date: string; payer: string; amount: number; currency: string; ref: string }> } }
  | { type: 'finance.receivable.confirm'; payload: { invoiceId: string } }
  | { type: 'finance.receivable.reject'; payload: { invoiceId: string; reason: string } }
  | { type: 'finance.reconcile'; payload: { receiptId: string; invoiceId: string; amount?: number; payerBasis?:string } }
  | { type: 'finance.acceptSuggestions'; payload: { receiptIds: string[] } }
  | { type: 'finance.payment.save'; payload: { date: string; payee: string; amount: number; currency: string; ref: string } }
  | { type: 'finance.allocation.reverse'; payload: { allocationId: string; reason: string } }
  | { type: 'finance.payment.reverse'; payload: { paymentId: string; reason: string } }
  | { type: 'finance.account.save'; payload: { id?: string; name: string; bankName: string; accountNo: string; currency: string; openingDate: string; openingBalance: number } }
  | { type: 'finance.account.assign'; payload: { kind: 'receipt' | 'payment'; id: string; accountId: string | null; reason?: string } }
  | { type: 'finance.fx.lock'; payload: { date: string; bankName: string; currency: string; amount: number; rate: string; localCurrency: string; settleBy: string; ref: string; note?: string } }
  | { type: 'finance.fx.settle'; payload: { date: string; fromAccountId: string; toAccountId: string; amount: number; localAmount: number; ref: string; note?: string; lockId?: string } }
  | { type: 'finance.fx.reverse'; payload: { id: string; reason: string } }
  | { type: 'customer.update'; payload: { id: string; patch: Partial<Omit<MistCustomer, 'id' | 'owner'>> } }
  | { type: 'member.groups.set'; payload: { userId: string; groups: Array<'fabric' | 'garment'> } }
  | { type: 'contact.save'; payload: { id?: string; customerId: string; name: string; role: string; email: string; phone: string } }
  | { type: 'contact.delete'; payload: { id: string } }
  | { type: 'settings.update'; payload: Partial<Omit<MistSettings,'companyProfile'>> & { companyProfile?: Partial<MistCompanyProfile> } }
  | { type: 'notification.read'; payload: { id: string } }
  | { type: 'notification.readAll'; payload: Record<string, never> }
  | { type: 'task.complete'; payload: { id: string; done: boolean } }
  | { type: 'calendar.save'; payload: { id?: string; title: string; date: string; time: string; note: string; target?: MistTarget } }
  | { type: 'files.add'; payload: { file: MistFile } };

/** 付款凭证能否在付款凭证页冲回：返回不能冲回的原因，可冲回时返回 null。供应商付款生成的凭证走应付冲回。 */
export function mistPaymentReverseBlock(state: Pick<MistState,'payments'|'payables'>, v: MistPayment): string | null {
  if((state.payables?.payments||[]).some(x=>x.paymentId===v.id)||(state.payables?.prepaymentMoves||[]).some(x=>x.paymentId===v.id))return '供应商付款生成的凭证请在应付页冲回供应商付款';
  if(v.reversalOf||!(v.amount>0)||(!v.origin&&v.ref.startsWith('冲回')))return '反向冲回凭证不能再次冲回';
  if(state.payments.some(x=>x.reversalOf===v.id))return v.code+' 已冲回';
  return null;
}
export class MistCommandError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); this.name = 'MistCommandError'; }
}

/** Existing unverified records remain readable, but cannot authorize new fulfillment. */
export function assertMistOrderApproved(state:MistState,orderId:string):MistOrder {
  return assertOrderApproved(state,orderId);
}
/** BB-ORD-7：已取消 / 作废 / 取消审批中订单不能新建采购或生产安排（草稿也不行）。 */
export function assertMistOrderOpen(state:MistState,orderId:string):void {
  const order=state.orders.find(o=>o.id===orderId);if(order)assertOrderNotTerminated(order as never);
}
export function assertMistOrderDeposit(state:MistState,orderId:string):void {
  assertMistOrderApproved(state,orderId);assertOrderDepositCovered(state,orderId);
}

export type MistCommandResult = { id?: string; draftId?: string; devId?: string; versionId?: string; orderId?: string; contactId?: string; fileId?: string; applied?: number; [key: string]: unknown };
export type MistWorkspaceMember={userId:string;name:string;addedBy:string;addedByName:string;addedAt:string};
export type MistWorkspaceMemberLog={id:string;action:'add'|'remove';userId:string;name:string;actorId:string;actorName:string;at:string};
/** 服务端按当前账号现有读权限裁剪数据后附带的说明：hidden 为当前账号无权查看、已被隐藏的数据范围。 */
export type MistWorkspaceAccess={role:'owner'|'member';canManageMembers:boolean;hidden:Array<{key:string;label:string;permissions:string[]}>};
export type MistWorkspaceEnvelope = { id: string; ownerId: string; name: string; revision: number; state: MistState; access?: MistWorkspaceAccess };
export type MistRunReceipt = { requestId: string; revision: number; result: MistCommandResult };

import * as Seed from './mistSeed';

const STAGES = ['需求与计划', '工厂与实物', 'QC 评审', '需求方确认', '成果留档'];
const COLS = ['cut', 'sew', 'finish', 'qc', 'done'];
const text = (value: unknown, label: string, required = true, max = 8000): string => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new MistCommandError('VALIDATION', label + '未填写或格式无效');
  return value.trim();
};
const positive = (value: unknown, label: string, allowZero = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (allowZero ? 0 : Number.MIN_VALUE) || value > 1e12) throw new MistCommandError('VALIDATION', label + '必须为有效正数');
  return value;
};
export function mistMoneyMinor(value: number | string): number {
  const source = String(value);
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(source)) throw new MistCommandError('VALIDATION', '金额须为最多两位小数的非负数');
  const [whole, fraction = ''] = source.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new MistCommandError('VALIDATION', '金额超出支持范围');
  return cents;
}
const major = (value: number) => value / 100;
const moneySum = (values: number[]) => {
  const total=values.reduce((sum,value)=>sum+BigInt(mistMoneyMinor(value)),BigInt(0));
  if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new MistCommandError('VALIDATION','总金额超出支持范围');
  return major(Number(total));
};
export const lineAmount = (qty: number, price: number) => {
  const q = String(qty);
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(q)) throw new MistCommandError('VALIDATION', '数量最多支持四位小数');
  const [whole, fraction = ''] = q.split('.');
  const units = BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  const cents = (units * BigInt(mistMoneyMinor(price)) + BigInt(5000)) / BigInt(10000);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MistCommandError('VALIDATION', '条目金额超出支持范围');
  return Number(cents) / 100;
};
const date = (value: unknown, label = '日期'): string => {
  const source = text(value, label, true, 40);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source) || !Number.isFinite(Date.parse(source + 'T00:00:00Z')) || new Date(source + 'T00:00:00Z').toISOString().slice(0, 10) !== source) throw new MistCommandError('VALIDATION', label + '格式无效');
  return source;
};
const instant = (value: unknown, context: MistContext): string => {
  const source = text(value, '确认时间', true, 60), at = Date.parse(source);
  if (!Number.isFinite(at) || at > Date.parse(context.now) + 1000) throw new MistCommandError('VALIDATION', '确认时间须为已发生的实际时间');
  return new Date(at).toISOString();
};
const find = <T extends {id: string}>(items: T[], id: string, name: string): T => {
  const item = items.find(row => row.id === id);
  if (!item) throw new MistCommandError('NOT_FOUND', name + '不存在', 404);
  return item;
};
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > 100) throw new MistCommandError('VALIDATION', label + '格式无效');
  return [...new Set(value.map(item => text(item, label, true, 240)))];
};
const iso = (value: string, context: MistContext) => /^\d\d\/\d\d$/.test(value) ? context.now.slice(0,4) + '-' + value.replace('/', '-') : value;
function emptyValues(): DevelopmentValues {
  return {name:'',customer:'',style:'',season:'',category:'',kind:'new',fabric:'',color:'',target:'',sizeBase:'',goal:'',factories:[],due:'',collaborators:[],sampleQuantity:1};
}
function values(input: DevelopmentValues, complete: boolean): DevelopmentValues {
  const v = {...emptyValues(), ...input};
  if (v.initiator !== undefined && !['customer','internal'].includes(v.initiator)) throw new MistCommandError('VALIDATION','发起方无效');
  const explicitInitiator = v.initiator !== undefined, internal = developmentInitiator(v) === 'internal';
  if (explicitInitiator) v.initiator = developmentInitiator(v);
  if (internal) v.customer = '';
  for (const key of ['name','customer','style','season','category','fabric','color','target','sizeBase','goal','due'] as const) v[key] = text(v[key], key, complete && (key==='name'||(key==='customer'&&!internal)||(key==='style'&&developmentDomain(v)==='garment')));
  if (internal) {
    delete v.requestType; delete v.requestNote;
    v.requester = text(v.requester ?? '', '内部需求方', complete, 120); v.requesterId = text(v.requesterId ?? '', '内部需求方账号', false, 200) || undefined;
    if (!v.requesterId) delete v.requesterId;
  } else {
    delete v.requester; delete v.requesterId;
    if (v.requestType !== undefined && !['replicate','design','other'].includes(v.requestType)) throw new MistCommandError('VALIDATION','客户要求类型无效');
    if (complete && explicitInitiator && !v.requestType) throw new MistCommandError('VALIDATION','请选择客户要求类型：复刻、我方设计或其他');
    v.requestNote = text(v.requestNote ?? '', '要求说明', complete && v.requestType === 'other', 2000);
    if (!v.requestNote) delete v.requestNote;
  }
  if (v.charged === undefined) { if (explicitInitiator) v.charged = !internal; }
  else if (typeof v.charged !== 'boolean') throw new MistCommandError('VALIDATION','是否收费格式无效');
  if (!['new','rev','copy'].includes(v.kind)) throw new MistCommandError('VALIDATION','开发类型无效');
  v.factories = strings(v.factories, '工厂'); v.collaborators = strings(v.collaborators, '协作人');
  if (v.due) v.due = date(v.due, '目标日期');
  v.sampleQuantity = positive(Number(v.sampleQuantity), '首样数量');
  if(v.domain!==undefined&&!['garment','fabric'].includes(v.domain))throw new MistCommandError('VALIDATION','开发业务域无效');
  if(developmentDomain(v)==='fabric'){
    for(const key of ['sampleForm','sampleUnit','targetCurrency','targetUnit'] as const)v[key]=text(v[key]||'',key,false,120);
    if(complete&&!validFabricSample(v.sampleQuantity,v.sampleForm||'',v.sampleUnit||''))throw new MistCommandError('VALIDATION','面料计划样品须记录实际形态与单位：米样按米，其他剪片类按整数份');
    if(v.fabricRequirements){if(typeof v.fabricRequirements!=='object'||Array.isArray(v.fabricRequirements))throw new MistCommandError('VALIDATION','面料目标规格格式无效');v.fabricRequirements={...emptyFabricRequirements(),...v.fabricRequirements};for(const key of Object.keys(v.fabricRequirements) as Array<keyof FabricDevelopmentRequirements>)v.fabricRequirements[key]=text(v.fabricRequirements[key],key,false);const problem=fabricRequirementError(v.fabricRequirements);if(complete&&problem)throw new MistCommandError('VALIDATION',problem);}
    if(complete&&v.target&&(!v.targetCurrency||!v.targetUnit))throw new MistCommandError('VALIDATION','面料目标价须同时填写币种与计价单位');
    v.sizeBase='';
  }
  if (v.target) mistMoneyMinor(v.target);
  return v;
}
function files(state: MistState, ids: string[]) {
  const unique = strings(ids, '附件');
  unique.forEach(id => find(state.files, id, '附件'));
  return unique;
}
function event(state: MistState, context: MistContext, entityType: string, entityId: string, message: string, target?: MistTarget, category:NonNullable<MistNotification['category']>='general') {
  state.events.unshift({id:context.id(),entityType,entityId,actor:context.actorName,at:context.now,text:message,fileIds:[]});
  if (target) state.notifications.unshift({id:context.id(),title:message,detail:context.actorName,at:context.now,readAt:null,target,category});
}
/** BB-DEV-4：按当前工厂任务冻结通知单快照（仓储层渲染 PDF 前调用，命令内再次核对）。payload 只能是 devId + versionId。 */
export function prepareDevelopmentNoticeSnapshot(state: MistState, payload: unknown, context: MistContext): DevNoticeSnapshot {
  if(!payload||typeof payload!=='object'||Object.keys(payload).some(key=>key!=='devId'&&key!=='versionId'))throw new MistCommandError('VALIDATION','通知单内容只能由服务端按当前工厂任务生成');
  const p=payload as {devId:string;versionId:string}, [dev,version]=versionOf(state,p.devId,p.versionId);
  const blocked=developmentNoticeBlocker(state,dev,version);if(blocked)throw new MistCommandError('PRECONDITION',blocked);
  if(!context.actorId)throw new MistCommandError('VALIDATION','缺少真实生成人');
  const content=developmentNoticeContent(state,dev,version), seq=(version.notices?.length||0)+1;
  return {...content,noticeNo:developmentNoticeNo(content,seq),seq,templateVersion:1,generatedAt:context.now,generatedBy:context.actorName,generatedById:context.actorId};
}
function sampleFee(value: unknown): MistSampleFee {
  const fee=value as MistSampleFee;
  if(!fee||typeof fee!=='object')throw new MistCommandError('VALIDATION','寄样费格式无效');
  const currency=text(fee.currency,'寄样费币种',true,3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))throw new MistCommandError('VALIDATION','寄样费币种须为三位字母代码');
  return {amount:major(mistMoneyMinor(fee.amount)),currency};
}
/** 需求方确认针对的形态：面料多形态必须明确；未传时旧数据与单形态保持原样。 */
function confirmationSamples(state: MistState, dev: MistDev, version: MistVersion, ids: unknown): MistSampleRef[] | undefined {
  const samples=developmentVersionSamples(state,version);
  if(ids===undefined||ids===null||(Array.isArray(ids)&&!ids.length)){
    if(confirmationNeedsForms(state,dev,version))throw new MistCommandError('VALIDATION','本版有多种实物形态，请选择本次确认针对的形态');
    return undefined;
  }
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw new MistCommandError('VALIDATION','确认形态格式无效');
  const unique=[...new Set(ids as string[])], picked=unique.map(id=>samples.find(s=>s.id===id));
  if(picked.some(s=>!s))throw new MistCommandError('VALIDATION','确认形态必须是本版的准确实物');
  return picked.map(s=>sampleRef(s!));
}
/** BB-DEV-9：销账结果回到开发案——核销到零时记“已最终结案”，冲回后恢复待收款（保留动态记录）。 */
function syncDevelopmentBilling(state: MistState, context: MistContext) {
  for(const dev of state.devs){
    if(dev.billing?.request?.state!=='invoiced')continue;
    const settled=developmentBillingSettled(state,dev);
    if(settled&&!dev.billing.settledAt){dev.billing.settledAt=context.now;updateDev(state,dev,context);event(state,context,'development',dev.id,'开发费用已收款销账，开发案已最终结案',{view:'development/detail',id:dev.id});}
    else if(!settled&&dev.billing.settledAt){delete dev.billing.settledAt;updateDev(state,dev,context);event(state,context,'development',dev.id,'开发费用核销已冲回，恢复待收款',{view:'development/detail',id:dev.id});}
  }
}
function versionOf(state: MistState, devId: string, versionId: string): [MistDev, MistVersion] {
  const dev = find(state.devs,devId,'开发案'), version = find(state.versions,versionId,'版本');
  if (version.devId !== dev.id || !dev.versionIds.includes(version.id)) throw new MistCommandError('VALIDATION','版本不属于当前开发案');
  return [dev,version];
}
function addVersions(state: MistState, dev: MistDev, context: MistContext, round = 1) {
  dev.values.factories.forEach((factory,index) => {
    const id=context.id(), label='R'+round+'-'+String.fromCharCode(65+index)+'-1';
    state.versions.push({...((developmentDomain(dev.values)==='fabric'&&dev.values.fabricRequirements)?{fabricRequirements:JSON.parse(JSON.stringify(dev.values.fabricRequirements))}:{}),id,devId:dev.id,label,factoryId:factory,factory:factoryName(state,factory),sample:'',sampleQuantity:dev.values.sampleQuantity,size:dev.values.sizeBase,fabric:dev.values.fabric,img:dev.img,fileIds:[...dev.fileIds],returnedAt:null,qc:null,confirmations:[],archivedAt:null,note:dev.values.goal});
    dev.versionIds.push(id);
    if (!dev.currentVersionId) dev.currentVersionId=id;
  });
}
/** 客户要求须对应唯一已有客户；内部需求不关联客户。 */
function developmentCustomer(state: MistState, v: DevelopmentValues) {
  if(developmentInitiator(v)==='internal')return undefined;
  const customer=state.customers.find(c=>c.id===v.customer)||(state.customers.filter(c=>c.name===v.customer).length===1?state.customers.find(c=>c.name===v.customer):undefined);
  if(!customer)throw new MistCommandError('VALIDATION','客户要求的开发须选择已有客户');
  return customer;
}
/** 内部需求方从员工档案选择时，账号须存在且姓名一致。 */
function assertRequester(state: MistState, v: DevelopmentValues) {
  if(developmentInitiator(v)!=='internal'||!v.requesterId)return;
  const employee=state.platform.employees.find(e=>e.id===v.requesterId);
  if(!employee||employee.name!==v.requester)throw new MistCommandError('VALIDATION','所选内部需求方不在员工档案中');
}
type RoundInput = { factories: unknown; requirements: unknown; fileIds?: unknown; referenceVersionIds?: unknown; targetDate: unknown; factoryTasks?: unknown };
/** 开发工厂的供应商显示名（按供应商 ID 取当前名称）。 */
export function factoryName(state: Pick<MistState,'market'>, supplierId: string): string { return state.market?.suppliers.find(s=>s.id===supplierId)?.name || supplierId; }
/** 开发工厂按供应商 ID 引用（包 A）：须为现有供应商，新引用时不能已暂停/停用；面料开发须为面料类工厂。 */
function assertDevelopmentFactories(state: MistState, factories: string[], fabric: boolean, context: MistContext) {
  for(const id of factories){
    const supplier=state.market.suppliers.find(s=>s.id===id);
    if(!supplier)throw new MistCommandError('VALIDATION','请从供应商档案选择工厂'+(id.length<=60?'：'+id:''));
    const unavailable=supplierUnavailableReason(supplier,supplierBusinessDay(context.now));if(unavailable)throw new MistCommandError('PRECONDITION',unavailable);
    if(fabric&&!/面料|纺织|织造|染整|fabric|textile|weav|dye/i.test(supplier.type+' '+supplier.capabilities))throw new MistCommandError('VALIDATION',`${supplier.name} 不是面料工厂，请选择面料工厂`);
  }
}
/** 逐厂任务：只接受本轮参与工厂、每厂一条；缺省值沿用开发案计划样品与本轮目标日期。 */
function roundFactoryTasks(state: MistState, dev: MistDev, factories: string[], raw: unknown, targetDate: string, context: MistContext): Record<string, Omit<MistFactoryTask, 'commonRequirements'>> {
  const nameOf=(id:string)=>factoryName(state,id);
  if(raw!==undefined&&!Array.isArray(raw))throw new MistCommandError('VALIDATION','逐厂要求格式无效');
  const rows=(raw||[]) as Array<Record<string, unknown>>, given=new Map<string, Record<string, unknown>>();
  for(const row of rows){
    const factory=typeof row?.factory==='string'?row.factory.trim():'';
    if(!factories.includes(factory))throw new MistCommandError('VALIDATION','逐厂要求只能填写本轮参与工厂'+(factory?'：'+nameOf(factory):''));
    if(given.has(factory))throw new MistCommandError('VALIDATION','同一工厂只能有一份逐厂要求：'+nameOf(factory));
    given.set(factory,row);
  }
  const result: Record<string, Omit<MistFactoryTask, 'commonRequirements'>> = {};
  for(const factory of factories){
    const base=defaultFactoryTask(dev,factory,targetDate), row=given.get(factory)||{};
    const pick=(key:'extraRequirements'|'sampleForm'|'sampleUnit'|'dueDate')=>row[key]===undefined?base[key]:typeof row[key]==='string'?(row[key] as string).trim():(()=>{throw new MistCommandError('VALIDATION',nameOf(factory)+'：逐厂要求格式无效');})();
    const quantity=row.sampleQuantity===undefined?base.sampleQuantity:Number(row.sampleQuantity);
    const task={extraRequirements:text(pick('extraRequirements'),'差异要求',false),sampleForm:pick('sampleForm'),sampleQuantity:quantity,sampleUnit:pick('sampleUnit'),dueDate:pick('dueDate')};
    // 缺省值（建案首轮、改版等未逐厂填写的入口）沿用开发案原有计划样品，不因历史数据缺形态而阻断。
    const error=given.has(factory)?factoryTaskError(dev,{factory:nameOf(factory),...task}):null;if(error)throw new MistCommandError('VALIDATION',error);
    result[factory]={...task,dueDate:date(task.dueDate,'要求日期'),syncedAt:context.now,syncedBy:context.actorName};
  }
  return result;
}
/** 建立新一轮：校验共同要求、参考版本与参与工厂，为首次参与的工厂固定字母，并逐厂建立 R{轮次}-{字母} 大版本。 */
function createRound(state: MistState, dev: MistDev, input: RoundInput, context: MistContext) {
  state.rounds ||= [];
  const blocked = developmentRoundBlocker(state, dev);
  if(blocked)throw new MistCommandError('PRECONDITION', blocked);
  if(Array.isArray(input.factories)){const duplicated=duplicateRoundFactories(input.factories);if(duplicated.length)throw new MistCommandError('VALIDATION','同一轮内工厂不能重复：'+duplicated.map(id=>factoryName(state,id)).join('、'));}
  const factories = strings(input.factories, '参与工厂');
  if(!factories.length)throw new MistCommandError('VALIDATION','请至少选择一家参与工厂');
  assertDevelopmentFactories(state,factories,developmentDomain(dev.values)==='fabric',context);
  const requirements = text(input.requirements, '本轮共同要求'), targetDate = date(input.targetDate, '本轮目标日期');
  const fileIds = files(state, (input.fileIds ?? []) as string[]);
  const referenceVersionIds = strings(input.referenceVersionIds ?? [], '参考版本');
  const references = referenceVersionIds.map(id => { const version = find(state.versions, id, '参考版本'); if(version.devId!==dev.id||!dev.versionIds.includes(id))throw new MistCommandError('VALIDATION','参考版本须属于本开发案'); return version; });
  const tasks = roundFactoryTasks(state, dev, factories, input.factoryTasks, targetDate, context);
  const number = nextRoundNumber(state, dev), letters = assignFactoryLetters(state, dev, factories);
  const round: MistRound = { id: context.id(), devId: dev.id, number, requirements, fileIds, referenceVersionIds, factories, targetDate, createdAt: context.now, createdBy: context.actorName };
  state.rounds.push(round);
  const fabric = developmentDomain(dev.values)==='fabric', created: MistVersion[] = [];
  for(const factory of factories){
    const base = references.find(version => version.factoryId===factory) || references[0];
    const id = context.id(), requirementsCopy = fabric ? (base?.fabricRequirements || dev.values.fabricRequirements) : undefined;
    const task:MistFactoryTask={...tasks[factory],commonRequirements:requirements};
    const version: MistVersion = {...(requirementsCopy?{fabricRequirements:JSON.parse(JSON.stringify(requirementsCopy))}:{}),id,devId:dev.id,label:roundVersionLabel(number,letters[factory]),factoryId:factory,factory:factoryName(state,factory),sample:'',sampleQuantity:task.sampleQuantity,size:fabric?'':(base?.size??dev.values.sizeBase),fabric:base?.fabric??dev.values.fabric,img:base?.img??dev.img,fileIds:[...new Set([...(base?.fileIds??dev.fileIds),...fileIds])],returnedAt:null,qc:null,confirmations:[],archivedAt:null,note:factoryTaskNote(requirements,task.extraRequirements),roundId:round.id,factoryLetter:letters[factory],task};
    state.versions.push(version); dev.versionIds.push(id); created.push(version);
  }
  dev.values.factories = [...new Set([...dev.values.factories, ...factories])];
  dev.currentVersionId = created[0].id;
  return { round, versions: created };
}
function updateDev(state: MistState, dev: MistDev, context: MistContext) {
  const version=state.versions.find(row=>row.id===dev.currentVersionId);
  dev.fac=dev.values.factories.length; dev.factory=version?.factory || (dev.values.factories[0]?factoryName(state,dev.values.factories[0]):'') || '待定';
  dev.ver=version?.label || '—'; dev.sample=version?.sample || '—'; dev.updatedAt=context.now;
  const latest=version?.confirmations.at(-1);
  const billing=developmentBillingStage(state,dev);
  if(dev.closure?.kind==='cancelled'){dev.state='已取消';dev.tone='neutral';}
  else if(dev.closure?.kind==='archived'){dev.state='已归档';dev.tone='neutral';}
  else if(billing?.label==='已最终结案'){dev.stage=4;dev.state='已最终结案';dev.tone='ok';}
  else if(billing&&dev.billing?.request){dev.stage=4;dev.state=billing.label;dev.tone=billing.tone;}
  else if(version?.archivedAt){dev.stage=4;dev.state='成果已留档';dev.tone='ok';}
  else if(latest?.result==='approved'){dev.stage=4;dev.state=billing?'已认可 · 待发起开票':'已认可 · 已结案';dev.tone='ok';}
  else if(latest?.result==='rejected'){dev.stage=3;dev.state='不采用';dev.tone='bad';}
  else if(latest?.result==='needs_adjustment'){dev.stage=3;dev.state='待改版';dev.tone='warn';}
  else if(version?.qcDecision?.kind==='abandon'){dev.stage=2;dev.state='本版不采用';dev.tone='bad';}
  else if(version?.qcDecision?.kind==='resample'){dev.stage=2;dev.state='QC 不通过 · 已重新打样';dev.tone='bad';}
  else if(version?.qc?.result==='reject'){dev.stage=2;dev.state='QC 不通过';dev.tone='bad';}
  else if(version?.qc){dev.stage=3;dev.state=version.qc.result==='conditional'?'有保留通过 · 待确认':'待需求方确认';dev.tone='accent';}
  else if(version?.returnedAt&&version.qcHistory?.length){dev.stage=2;dev.state='整改中 · 待复检';dev.tone='warn';}
  else if(version?.returnedAt){dev.stage=2;dev.state='QC 待评审';dev.tone='warn';}
  else if(version){dev.stage=1;dev.state=developmentDomain(dev.values)==='fabric'?'待工厂试样':'工厂制作中';dev.tone='neutral';}
  else {dev.stage=0;dev.state='开发计划';dev.tone='neutral';}
}
function recalculate(state: MistState) {
  for(const invoice of state.invoices) invoice.open=isRecognizedMistInvoice(invoice)?major(Math.max(0,mistMoneyMinor(invoice.amount)-state.allocations.filter(a=>a.invoiceId===invoice.id).reduce((s,a)=>s+mistMoneyMinor(a.amount),0)-platformCreditAppliedMinor(state,invoice.id))):0;
  for(const receipt of state.receipts){
    receipt.remaining=major(Math.max(0,mistMoneyMinor(receipt.amount)-state.allocations.filter(a=>a.receiptId===receipt.id).reduce((s,a)=>s+mistMoneyMinor(a.amount),0)));
    if(receipt.remaining===0) receipt.state='matched';
  }
  for(const order of state.orders){
    const rows=state.orderLines.filter(line=>line.orderId===order.id);
    order.lines=rows.length; order.qty=rows.reduce((s,row)=>s+row.qty,0);
    order.amount=moneySum(rows.map(row=>lineAmount(row.qty,row.price)));
    const jobs=state.productions.filter(job=>job.orderId===order.id), quantity=jobs.reduce((s,p)=>s+p.qty,0);
    if(quantity) order.progress=Math.round(jobs.reduce((s,p)=>s+p.qty*p.pct,0)/quantity);
    const shipments=(state.fulfillment?.shipments||[]).filter(s=>s.lines.some(line=>line.orderId===order.id)&&s.state!=='cancelled');
    const departed=shipments.filter(s=>s.state==='departed');
    if(order.governance&&order.governance.status!=='approved'){
      // BB-ORD-7：已作废 / 已取消为终止状态
      const gs=order.governance.status;order.state=gs==='pending'?'待主单审批':gs==='rejected'?'主单已退回':gs==='void'?'已作废':gs==='cancelled'?'已取消':'订单草稿';order.tone=gs==='pending'?'warn':gs==='rejected'||gs==='cancelled'?'bad':'neutral';
    }else if(departed.length){
      const complete=rows.every(line=>isLineClosed(line)||departed.reduce((sum,s)=>sum+s.lines.filter(item=>item.lineId===line.id).reduce((n,item)=>n+Math.round(item.quantity*10000),0),0)>=Math.round(line.qty*10000));
      const unpaid=state.invoices.some(invoice=>invoice.orderId===order.id&&invoice.open>0);
      // BB-ORD-5：所有条目已出足或已结案 → 履约完成（应收仍有余额时保留"待收尾款"提示，财务不在此自动变更）
      order.state=complete?(unpaid?'待收尾款':'履约完成'):'部分出运';order.tone=complete?(unpaid?'warn':'ok'):'accent';
    }else if(shipments.length){order.state='出运准备中';order.tone='accent';}
    else if(jobs.some(job=>job.sourcePurchaseId)){
      order.state=jobs.every(job=>job.col==='done')?'待出运':jobs.some(job=>job.col==='qc')?'待终期 QC':'生产中';order.tone='accent';
    }else if((state.fulfillment?.purchases||[]).some(p=>p.orderId===order.id&&p.state==='approved')){order.state='备料中';order.tone='neutral';}
    if(order.governance?.status==='approved'&&order.governance.cancellation?.status==='pending'){order.state='取消审批中';order.tone='warn';}
  }
}
export function createMistState(context: MistContext, seed: 'demo'|'empty' = 'demo', onDemoSeedFailures?: (failures: Array<{step:string;message:string}>) => void): MistState {
  const state={schemaVersion:1,devs:[],versions:[],rounds:[],drafts:[],fabrics:[],orders:[],orderLines:[],productions:[],receipts:[],invoices:[],allocations:[],payments:[],customers:[],contacts:[],files:[],events:[],tasks:[],notifications:[],calendar:[],settings:{theme:'system',density:'default',reducedMotion:false,notifications:{qc:true,shipping:true,suggestions:true,digest:false},workspaceName:'成衣一组',profileName:context.actorName,profileEmail:'',locale:'zh-CN'}} as unknown as MistState;
  normalizeMistState(state,context);
  if(seed==='empty') return state;
  const customers=[...new Set(Seed.ORDERS.map(row=>row.customer))];
  state.customers=customers.map((name,index)=>({id:'customer-'+index,name,code:'CUS-'+String(index+1).padStart(4,'0'),country:index===0?'英国':'',city:index===0?'伦敦':'',industry:'服装零售',owner:index===1?'沈禾':'顾言',ownerId:demoAccountRef(index===1?'沈禾':'顾言').id,grade:index===0?'A · 战略客户':'B · 合作客户',currency:'USD',terms:'T/T 30/70',incoterm:'FOB 上海',categories:'大衣 · 西装 · Blazer',creditLimit:index===0?200000:100000,since:'2023-04-01'}));
  // 演示工厂先建档：开发案按供应商 ID 引用工厂（包 A），详细档案在 seedDemoModules 中补齐。
  for(const [id,code,name,capabilities,capacity,leadDays] of [['supplier-jiangnan','SUP-0001','江南成衣','大衣 · 西装 · 双面呢手工',6000,35],['supplier-yuanshan','SUP-0002','远山服装','精纺西装 · Blazer · 衬里',4500,40]] as const)
    state.market.suppliers.push({id,code,name,type:'成衣加工',country:'中国',address:'',capabilities,capacity,capacityUnit:'件/月',leadDays,status:'active',blockReason:'',contacts:[],fileIds:[],note:'',createdAt:context.now,updatedAt:context.now});
  const demoFactory=(name:string)=>state.market.suppliers.find(s=>s.name===name)!.id;
  for(const source of Seed.DEVS){
    const v:DevelopmentValues={...emptyValues(),name:source.name,customer:source.customer,style:source.style,season:'AW27',category:source.name.includes('Blazer')?'Blazer':source.name.includes('西装')?'西装':'大衣',fabric:source.fabric,sizeBase:'M',goal:source.goal,due:iso(source.due,context),factories:source.fac? [demoFactory(source.factory),...(source.fac>1?[demoFactory(source.factory==='江南成衣'?'远山服装':'江南成衣')]:[])]:[],sampleQuantity:2};
    const dev:MistDev={...source,ownerId:demoAccountRef(source.owner).id,id:source.id,code:source.id,img:source.img as MistImage,tone:source.tone as MistTone,customerId:state.customers.find(c=>c.name===source.customer)!.id,values:v,versionIds:[],currentVersionId:null,fileIds:[],createdAt:context.now,updatedAt:context.now,due:v.due};
    state.devs.push(dev); addVersions(state,dev,context,Number(source.ver.match(/^R(\d+)/)?.[1]||1));
    if(dev.currentVersionId){
      const version=state.versions.find(row=>row.id===dev.currentVersionId)!;
      version.label=source.ver; version.sample=source.sample==='—'?'':source.sample;
      if(version.sample) version.returnedAt=iso('10/10',context)+'T08:00:00Z';
      if(source.stage===3) version.qc={result:'pass',reviewer:'许言',reviewedAt:iso('10/11',context)+'T09:02:00Z',report:'QC-G-2026-0086',opinion:'外观与尺寸已由 QC 专业评审通过。',...(source.id==='DEV-G-2026-031'?{measurements:[{point:'胸围',standard:112,actual:112.4,tolerance:1},{point:'衣长',standard:104,actual:103.6,tolerance:1},{point:'袖长',standard:63.5,actual:64.1,tolerance:1},{point:'肩宽',standard:46,actual:46.2,tolerance:1}],appearanceDefects:0}:{measurements:[]})};
      else if(source.id==='DEV-G-2026-021') version.qc={result:'reject',reviewer:'许言',reviewedAt:iso('10/11',context)+'T09:02:00Z',report:'QC-G-2026-0084',opinion:'袖长需修正，等待新样复验。'};
    }
  }
  state.fabrics=Seed.FABRICS.map(row=>({...row,ownerId:demoAccountRef(row.owner).id,code:row.id,tone:row.tone as MistTone,due:iso(row.due,context),request:row.name,answer:row.state==='已结案'?'已按要求找到并确认面料。':'',confirmed:row.state==='已结案',fileIds:[]}));
  state.orders=Seed.ORDERS.map(row=>({...row,ownerId:demoAccountRef(row.owner).id,code:row.id,type:'garment',img:row.img as MistImage,tone:row.tone as MistTone,customerId:state.customers.find(c=>c.name===row.customer)!.id,due:iso(row.due,context),handoffAt:null,createdAt:context.now,updatedAt:context.now,checklist:['拟发范围确认','收货与贸易条款确认','收款条件核对','装箱单草稿','唛头确认','尾期 QC 预约','报关资料','订舱'].map((label,index)=>({id:row.id+'-check-'+index,label,done:index===3||index===4,note:index===6?'待补齐':'',...(index===3||index===4?{actor:'顾言',at:context.now}:{})}))}));
  for(const order of state.orders){
    const base=order.code==='SO-G-2026-018'?Seed.ORDER_LINES:null;
    const jobs=Seed.PRODS.filter(p=>p.order===order.code);
    for(let index=0;index<order.lines;index++){
      const original=base?.[index], job=jobs[index], fallback=Seed.DEVS[index%Seed.DEVS.length];
      const qty=original?.qty ?? (job?.qty ?? Math.floor(order.qty/order.lines)+(index===order.lines-1?order.qty%order.lines:0));
      state.orderLines.push({id:order.id+'-line-'+index,orderId:order.id,name:original?.name||job?.name||fallback.name,style:original?.style||fallback.style,img:(original?.img||job?.img||fallback.img) as MistImage,qty,unit:'件',price:original?.price??major(Math.round(mistMoneyMinor(order.amount)/order.qty)),made:original?.made??job?.pct??order.progress,qc:original?.qc??0});
    }
  }
  state.productions=Seed.PRODS.map(source=>{const order=state.orders.find(o=>o.code===source.order)!, line=state.orderLines.find(l=>l.orderId===order.id&&l.name===source.name)||state.orderLines.find(l=>l.orderId===order.id)!;return {...source,code:source.id,orderId:order.id,lineId:line.id,col:source.col as MistProduction['col'],img:source.img as MistImage,due:iso(source.due,context)};});
  state.receipts=Seed.RECEIPTS.map(row=>({...row,code:row.id,state:row.state as MistReceipt['state'],date:iso(row.date,context),remaining:row.amount}));
  state.invoices=Seed.INVOICES.map(row=>({...row,code:row.id,orderId:state.orders.find(o=>o.code===row.order)!.id,due:iso(row.due,context)}));
  for(const receipt of state.receipts) if(receipt.state==='matched'&&receipt.suggest){
    const invoice=state.invoices.find(row=>row.code===receipt.suggest);
    if(invoice) state.allocations.push({id:context.id(),receiptId:receipt.id,invoiceId:invoice.id,amount:receipt.amount,currency:receipt.currency,createdAt:context.now,actor:'财务'});
  }
  // Seed prior paid amounts as explicit allocations, never as an inconsistent open balance.
  for(const source of Seed.INVOICES) if(source.open<source.amount&&!state.allocations.some(a=>a.invoiceId===source.id)){
    const amount=major(mistMoneyMinor(source.amount)-mistMoneyMinor(source.open)), receiptId=context.id();
    state.receipts.push({id:receiptId,code:'BR-历史-'+source.id,date:iso('10/01',context),payer:source.customer,amount,remaining:0,currency:source.currency,ref:source.id,state:'matched',suggest:source.id});
    state.allocations.push({id:context.id(),receiptId,invoiceId:source.id,amount,currency:source.currency,createdAt:context.now,actor:'财务'});
  }
  state.contacts=Seed.CONTACTS.map((row,index)=>({...row,id:'contact-'+index,customerId:state.customers[0].id,phone:'',tone:row.tone as MistTone}));
  state.tasks=state.devs.slice(0,4).map(dev=>({id:context.id(),title:dev.name,due:dev.due,done:false,kind:'development',target:{view:'development/detail',id:dev.id,versionId:dev.currentVersionId||undefined},assigneeIds:dev.ownerId?[dev.ownerId]:[]}));
  state.calendar=[{id:context.id(),title:'秋冬首样评审',date:iso('10/12',context),time:'14:00',note:'顾言、沈禾、QC 许言 · 30 分钟',target:{view:'development/detail',id:state.devs[0].id}}];
  state.notifications=[{id:context.id(),category:'qc',title:'首样评审报告已回传',detail:'查看当前版本的专业评审结果。',at:context.now,readAt:null,target:{view:'development/detail',id:state.devs[0].id,versionId:state.devs[0].currentVersionId||undefined}}];
  seedEmailExamples(state,context);
  recalculate(state);
  // 各模块示例数据：经真实业务命令生成，失败步骤被跳过（测试要求零失败）。
  const demo=seedDemoModules(state,context),seeded=demo.state;onDemoSeedFailures?.(demo.failures);
  seeded.settings.demoSeed={version:DEMO_SEED_VERSION,seededAt:context.now};
  recalculate(seeded);
  return seeded;
}

export function getRequiredBusinessNumberPlan(state: MistState, command: MistCommand) { return platformBusinessNumberPlan(state, command); }
export function mistCommandPermission(command: MistCommand): string | null {
  if(command.type.startsWith('order.governance.'))return orderGovernancePermission(command as OrderGovernanceCommand);
  if(command.type.startsWith('funding.'))return orderFundingCommandPermission(command as OrderFundingCommand);
  if(command.type.startsWith('payable.'))return payablesCommandPermission(command as PayablesCommand);
  if(command.type.startsWith('fulfillment.'))return fulfillmentCommandPermission(command as FulfillmentCommand);
  if(command.type.startsWith('market.'))return marketCommandPermission(command as MarketCommand);
  if(command.type.startsWith('platform.'))return platformCommandPermission(command as PlatformCommand);
  if(command.type.startsWith('email.'))return emailCommandPermission(command as EmailCommand);
  if(command.type.startsWith('crm.'))return crmCommandPermission(command as CrmCommand);
  if(command.type==='development.recordQc')return command.payload.domain==='fabric'?'qc:fabric_chain:write':'qc:garment_chain:write';
  if(command.type.startsWith('development.')||command.type.startsWith('fabric.')||command.type==='files.add')return 'products:write';
  if(command.type.startsWith('order.')||command.type.startsWith('production.'))return 'orders:write';
  if(command.type==='finance.developmentInvoice.issue')return MIST_FINANCE_SCOPES.invoice;
  if(command.type==='finance.receivable.confirm'||command.type==='finance.receivable.reject')return MIST_FINANCE_SCOPES.invoice;
  if(command.type==='finance.importReceipts'||command.type==='finance.payment.save'||command.type==='finance.payment.reverse'||command.type==='finance.account.save'||command.type==='finance.account.assign'||command.type.startsWith('finance.fx.'))return MIST_FINANCE_SCOPES.voucher;
  if(command.type==='finance.reconcile'||command.type==='finance.acceptSuggestions'||command.type==='finance.allocation.reverse')return MIST_FINANCE_SCOPES.reconcile;
  if(command.type.startsWith('finance.'))throw new MistCommandError('VALIDATION','未知财务操作');
  if(command.type.startsWith('customer.')||command.type.startsWith('contact.'))return 'relations:write';
  // member.groups.set：权限 null 由仓储层限定为工作区所有者（与成员授权一致）。
  if(['settings.update','notification.read','notification.readAll','task.complete','calendar.save','member.groups.set'].includes(command.type))return null;
  throw new MistCommandError('VALIDATION','未知操作');
}
export function applyMistCommand(original: MistState, command: MistCommand, context: MistContext): {state:MistState;result:MistCommandResult} {
  return applyMistCommandUnbound(original, command, context);
}
function applyMistCommandUnbound(original: MistState, command: MistCommand, context: MistContext): {state:MistState;result:MistCommandResult} {
  if(!original||original.schemaVersion!==1)throw new MistCommandError('INVALID_STATE','工作区数据版本无效',500);
  if(!command||typeof command.type!=='string'||!command.payload||typeof command.payload!=='object')throw new MistCommandError('VALIDATION','操作格式无效');
  mistCommandPermission(command);
  const state: MistState=JSON.parse(JSON.stringify(original));
  normalizeMistState(state,context);
  if(command.type.startsWith('order.governance.')){const result=applyOrderGovernanceCommand(state,command as OrderGovernanceCommand,context);recalculate(state);assertOrderFundingIntegrity(state);return {state,result};}
  if(command.type.startsWith('funding.')){const result=applyOrderFundingCommand(state,command as OrderFundingCommand,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('payable.')){const result=applyPayablesCommand(state,command as PayablesCommand,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('fulfillment.')){const result=applyFulfillmentCommand(state,command as FulfillmentCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type==='market.lead.convertToCrm'){const result=convertLeadToCrm(state,command.payload as Extract<MarketCommand,{type:'market.lead.convertToCrm'}>['payload'],context);recalculate(state);return {state,result};}
  if(command.type.startsWith('market.')){const result=applyMarketCommand(state,command as MarketCommand,context);for(const order of state.orders)if(!original.orders.some(old=>old.id===order.id)&&!order.governance){order.governance=createOrderGovernance(context);order.state='订单草稿';order.tone='neutral';order.checklist=['拟发范围确认','收货与贸易条款确认','收款条件核对'].map((label,index)=>({id:order.id+'-check-'+index,label,done:false,note:''}));}normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('platform.')){const result=applyPlatformCommand(state,command as PlatformCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('email.')){const result=applyEmailCommand(state,command as EmailCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  if(command.type.startsWith('crm.')){const result=applyCrmCommand(state,command as CrmCommand,context);normalizeMistState(state,context);recalculate(state);return {state,result};}
  const p:any=command.payload;
  let result:MistCommandResult={};
  switch(command.type){
    case 'development.saveDraft': {
      const v=values(p.values,false), fileIds=files(state,p.fileIds), id=p.draftId||context.id();
      if(p.draftId)find(state.drafts,p.draftId,'草稿');
      state.drafts=state.drafts.filter(d=>d.id!==id);
      state.drafts.push({id,values:v,fileIds,updatedAt:context.now}); result={id,draftId:id}; break;
    }
    case 'development.submit': {
      const v=values(p.values,true), fileIds=files(state,p.fileIds);
      if(p.draftId)find(state.drafts,p.draftId,'草稿');
      if(v.kind!=='new'&&!v.sourceDevId)throw new MistCommandError('VALIDATION','请选择来源开发案');
      if(v.sourceVersionId){const source=find(state.versions,v.sourceVersionId,'来源版本');if(source.devId!==v.sourceDevId)throw new MistCommandError('VALIDATION','来源版本不属于准确来源开发案');}
      if(v.sourceDevId&&developmentDomain(find(state.devs,v.sourceDevId,'来源开发案').values)!==developmentDomain(v))throw new MistCommandError('VALIDATION','来源开发案业务域不同，请分别创建开发案');
      if(developmentDomain(v)==='fabric'){if(!v.factories.length)throw new MistCommandError('VALIDATION','请至少选择一家实际面料工厂');if(!v.due)throw new MistCommandError('VALIDATION','请填写目标日期');}
      assertDevelopmentFactories(state,v.factories,developmentDomain(v)==='fabric',context);
      const owner=resolveMember(context,context.actorId,'开发负责人');
      const customer=developmentCustomer(state,v);assertRequester(state,v);
      const id=context.id(), code='DEV-'+context.now.slice(0,4)+'-'+String(state.devs.length+1).padStart(4,'0');
      const dev:MistDev={id,code,name:v.name,style:v.style,owner:owner.name,ownerId:owner.id,due:v.due,dueRel:'',stage:0,state:'开发计划',tone:'neutral',ver:'—',fac:v.factories.length,img:developmentDomain(v)==='fabric'?'clay':v.category.includes('西装')?'suit':v.category.includes('Blazer')?'blazer':'coat',factory:v.factories[0]?factoryName(state,v.factories[0]):'待定',sample:'—',fabric:v.fabric,goal:v.goal,customer:customer?.name||'',customerId:customer?.id||'',currentVersionId:null,versionIds:[],values:{...v,customer:customer?.name||''},fileIds,createdAt:context.now,updatedAt:context.now};
      state.devs.unshift(dev); if(v.factories.length)createRound(state,dev,{factories:v.factories,requirements:v.goal||v.name,targetDate:v.due||context.now.slice(0,10),fileIds:[]},context); updateDev(state,dev,context);
      if(p.draftId)state.drafts=state.drafts.filter(d=>d.id!==p.draftId);
      state.tasks.unshift({id:context.id(),title:'推进 '+dev.name,due:dev.due,done:false,kind:'development',target:{view:'development/detail',id:dev.id},assigneeIds:dev.ownerId?[dev.ownerId]:[]});
      event(state,context,'development',id,'创建开发案 '+code,{view:'development/detail',id}); result={id,devId:id,versionId:dev.currentVersionId||undefined}; break;
    }
    case 'development.update': {
      const dev=find(state.devs,p.devId,'开发案');
      if(p.patch?.domain!==undefined&&p.patch.domain!==developmentDomain(dev.values))throw new MistCommandError('PRECONDITION','已有开发案不能改变业务域，请另建案');
      const v=values({...dev.values,domain:developmentDomain(dev.values),...p.patch},true);
      if(developmentInitiator(v)!==developmentInitiator(dev.values))throw new MistCommandError('PRECONDITION','已立项开发案不能改变发起方，请另建案');
      const customer=developmentCustomer(state,v);assertRequester(state,v);
      if(developmentDomain(v)!==developmentDomain(dev.values))throw new MistCommandError('PRECONDITION','已有开发案不能改变业务域，请另建案');
      {const added=v.factories.filter(f=>!dev.values.factories.includes(f));if(added.length)assertDevelopmentFactories(state,added,developmentDomain(v)==='fabric',context);}
      dev.values={...v,customer:customer?.name||''}; dev.name=v.name;dev.style=v.style;dev.customer=customer?.name||'';dev.customerId=customer?.id||'';dev.goal=v.goal;dev.fabric=v.fabric;dev.due=v.due;
      if(!dev.versionIds.length&&v.factories.length)createRound(state,dev,{factories:v.factories,requirements:v.goal||v.name,targetDate:v.due||context.now.slice(0,10),fileIds:[]},context);
      updateDev(state,dev,context);event(state,context,'development',dev.id,'更新开发计划');result={devId:dev.id,versionId:dev.currentVersionId||undefined};break;
    }
    case 'development.saveConfirmationDraft': {
      const [dev,version]=versionOf(state,p.devId,p.versionId);
      if(version.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      version.confirmationDraft={...p.draft};dev.updatedAt=context.now;result={devId:dev.id,versionId:version.id};break;
    }
    case 'development.confirm': {
      const [dev,version]=versionOf(state,p.devId,p.versionId);
      if(version.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      if(!version.returnedAt)throw new MistCommandError('PRECONDITION','请先记录本版实际返样');
      if(!version.qc)throw new MistCommandError('PRECONDITION','本版尚未完成 QC 评审，QC 通过或有保留通过后才能记录需求方确认');
      if(version.qc.result==='reject')throw new MistCommandError('PRECONDITION','本版最新 QC 不通过，不能记录需求方确认；请选择整改复检、重新打样或放弃本版');
      if(!['approved','needs_adjustment','rejected'].includes(p.result))throw new MistCommandError('VALIDATION','确认结论无效');
      const confirmed=confirmationSamples(state,dev,version,p.sampleIds);
      version.confirmations.push({id:context.id(),result:p.result,confirmer:text(p.confirmer,'实际确认人',true,120),organization:text(p.organization,'所属组织',false,240),confirmedAt:instant(p.confirmedAt,context),basis:text(p.basis,'确认依据'),originalText:text(p.originalText,'需求方原文',false),recordedAt:context.now,recordedBy:context.actorName,...(confirmed?{samples:confirmed}:{})});
      delete version.confirmationDraft;updateDev(state,dev,context);
      event(state,context,'development',dev.id,'记录 '+version.label+' 需求方确认'+(confirmed?'（'+confirmed.map(s=>s.form+' '+s.code).join('、')+'）':''),{view:'development/detail',id:dev.id,versionId:version.id});result={devId:dev.id,versionId:version.id};break;
    }
    case 'development.recordSample': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(dev.billing?.request)throw new MistCommandError('PRECONDITION',DEVELOPMENT_BILLING_LOCK);
      if(v.minor)throw new MistCommandError('PRECONDITION','小版本 '+v.label+' 沿用大版本实物，不登记新实物');
      if(v.archivedAt||v.qc||v.confirmations.length)throw new MistCommandError('PRECONDITION','已有QC、确认或留档记录的实物不可替换，请创建新版本');
      if(state.fulfillment.samples.some(s=>s.source.kind==='version'&&s.source.versionId===v.id))throw new MistCommandError('PRECONDITION','已有入库实物不能覆盖，请创建新版本或在本版追加实物形态');
      if(developmentDomain(dev.values)==='fabric'){if(!validFabricSample(p.quantity,p.form||'',p.unit||''))throw new MistCommandError('VALIDATION','面料返样须明确形态、数量和单位：米样按米，剪片类按整数份');v.sampleForm=text(p.form,'实际形态');v.sampleUnit=text(p.unit,'实际单位');v.sampleLocation=text(p.location||'','实际位置',false);v.sampleColor=text(p.color||dev.values.color,'实际颜色',false);v.size='';}
      else if(!Number.isInteger(p.quantity))throw new MistCommandError('VALIDATION','成衣返样须为正整数件数');
      v.sample=text(p.sample,'样品编号',true,120);v.sampleQuantity=positive(p.quantity,'返样数量');v.returnedAt=instant(p.returnedAt,context);
      updateDev(state,dev,context);applyFulfillmentCommand(state,{type:'fulfillment.samples.sync',payload:{}},context);event(state,context,'development',dev.id,'记录 '+v.label+' 返样');result={devId:dev.id,versionId:v.id};break;
    }
    case 'development.recordQc': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(v.minor)throw new MistCommandError('PRECONDITION','小版本 '+v.label+' 沿用大版本 QC 结论，不单独记录 QC');
      if(minorVersions(state,v).length)throw new MistCommandError('PRECONDITION','本版已有小版本 '+minorVersions(state,v).map(x=>x.label).join('、')+' 沿用当前 QC 结论，不能改写');
      if(v.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      if(!v.returnedAt)throw new MistCommandError('PRECONDITION','请先记录实物返样');
      if(v.qcDecision)throw new MistCommandError('PRECONDITION',v.qcDecision.kind==='abandon'?'本版已放弃，不能再记录 QC':'本版已转为重新打样，请在新一轮版本上记录 QC');
      if(v.qc?.result==='reject')throw new MistCommandError('PRECONDITION','本版 QC 不通过；成衣请先选择整改复检后再提交复检，面料请重新打样或放弃本版');
      if(v.confirmations.length)throw new MistCommandError('PRECONDITION','本版已有需求方确认记录，不能改写 QC');
      if((p.domain||'garment')!==developmentDomain(dev.values))throw new MistCommandError('VALIDATION','QC专业权限域与准确开发版本不一致');
      if(developmentDomain(dev.values)==='fabric'&&p.qc?.measurements?.length)throw new MistCommandError('VALIDATION','面料开发不套成衣尺寸公差，请填写面料实测');
      const fabricMeasurements=p.qc?.fabricMeasurements||[];if(!Array.isArray(fabricMeasurements)||fabricMeasurements.length>200)throw new MistCommandError('VALIDATION','面料实测最多支持200行');
      const fabricFacts=fabricMeasurements.map((row:any)=>{if(!row||typeof row.actual!=='number'||!Number.isFinite(row.actual)||row.actual<0)throw new MistCommandError('VALIDATION','面料实测须为有限非负数');return{property:text(row.property,'实测项目',true,120),actual:row.actual,unit:text(row.unit,'实测单位',true,120)};});
      if(developmentDomain(dev.values)==='garment'&&fabricFacts.length)throw new MistCommandError('VALIDATION','成衣QC不接收面料实测');
      if(!['pass','conditional','reject'].includes(p.qc?.result))throw new MistCommandError('VALIDATION','QC结论无效');
      const measurements=p.qc.measurements===undefined?[]:p.qc.measurements;
      if(!Array.isArray(measurements)||measurements.length>200)throw new MistCommandError('VALIDATION','测量记录最多支持200行');
      const measured=(value:unknown,label:string)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new MistCommandError('VALIDATION',label+'须为有限非负数');return value;};
      const facts=measurements.map((row:unknown,index:number)=>{
        if(!row||typeof row!=='object')throw new MistCommandError('VALIDATION','测量记录格式无效');
        const item=row as Record<string,unknown>,label='测量点'+(index+1);
        return{point:text(item.point,label+'部位',true,120),standard:measured(item.standard,label+'标准'),actual:measured(item.actual,label+'实测'),tolerance:measured(item.tolerance,label+'公差')};
      });
      if(p.qc.appearanceDefects!==undefined&&(!Number.isSafeInteger(p.qc.appearanceDefects)||p.qc.appearanceDefects<0))throw new MistCommandError('VALIDATION','外观缺陷数量须为非负整数');
      if(v.qc)v.qcHistory=[...(v.qcHistory||[]),v.qc];
      v.qc={result:p.qc.result,reviewer:text(p.qc.reviewer,'评审人',true,120),reviewedAt:instant(p.qc.reviewedAt,context),report:text(p.qc.report,'报告编号',true,120),opinion:text(p.qc.opinion,'专业意见'),measurements:facts,...(developmentDomain(dev.values)==='fabric'?{fabricMeasurements:fabricFacts}:{}),...(p.qc.appearanceDefects===undefined?{}:{appearanceDefects:p.qc.appearanceDefects})};
      updateDev(state,dev,context);event(state,context,'development',dev.id,'记录 '+v.label+' QC评审',{view:'development/detail',id:dev.id,versionId:v.id},'qc');result={devId:dev.id,versionId:v.id};break;
    }
    case 'development.move': {
      const dev=find(state.devs,p.devId,'开发案'), v=state.versions.find(x=>x.id===dev.currentVersionId);
      if(!Number.isInteger(p.stage)||p.stage<0||p.stage>4)throw new MistCommandError('VALIDATION','阶段无效');
      if(p.stage>=1&&!v)throw new MistCommandError('PRECONDITION','请先指定工厂并建立样品版本');
      if(p.stage>=2&&!v?.returnedAt)throw new MistCommandError('PRECONDITION','请先记录实际返样');
      if(p.stage>=3&&(!v?.qc||v.qc.result==='reject'))throw new MistCommandError('PRECONDITION','本版 QC 通过或有保留通过后才能进入需求方确认');
      if(p.stage===4&&v?.confirmations.at(-1)?.result!=='approved')throw new MistCommandError('PRECONDITION','本版尚未获得需求方认可');
      dev.stage=p.stage;dev.updatedAt=context.now;event(state,context,'development',dev.id,'进入 '+STAGES[p.stage]);result={devId:dev.id};break;
    }
    case 'development.revise': {
      const [dev,previous]=versionOf(state,p.devId,p.versionId), note=text(p.note,'改版说明');
      const {round,versions}=createRound(state,dev,{factories:[previous.factoryId],requirements:note,referenceVersionIds:[previous.id],targetDate:dev.due||context.now.slice(0,10),fileIds:[]},context),version=versions[0];
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,'创建改版 '+version.label,{view:'development/detail',id:dev.id,versionId:version.id});result={devId:dev.id,versionId:version.id,roundId:round.id};break;
    }
    case 'development.close': {
      const dev=find(state.devs,p.devId,'开发案');
      if(p.kind!=='archived'&&p.kind!=='cancelled')throw new MistCommandError('VALIDATION','开发案结束方式无效');
      if(dev.closure)throw new MistCommandError('PRECONDITION','开发案已'+(dev.closure.kind==='cancelled'?'取消':dev.closure.kind==='archived'?'归档':'结案'));
      dev.closure={kind:p.kind,at:context.now,by:context.actorName,reason:text(p.reason,'原因')};updateDev(state,dev,context);
      event(state,context,'development',dev.id,(p.kind==='cancelled'?'取消开发案：':'归档开发案：')+dev.closure.reason,{view:'development/detail',id:dev.id});result={devId:dev.id};break;
    }
    case 'development.qc.decide': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(v.archivedAt)throw new MistCommandError('PRECONDITION','本版已留档，请通过新版本继续记录');
      if(v.qc?.result!=='reject')throw new MistCommandError('PRECONDITION','只有最新 QC 不通过的版本才需要选择处理方式');
      if(v.qcDecision)throw new MistCommandError('PRECONDITION','本版已选择处理方式');
      if(p.decision!=='rework'&&p.decision!=='abandon')throw new MistCommandError('VALIDATION','处理方式无效；重新打样请开新一轮');
      if(p.decision==='abandon'&&!(typeof p.note==='string'&&p.note.trim()))throw new MistCommandError('VALIDATION','放弃本版须填写原因');
      const decision:MistQcDecision={kind:p.decision,note:text(p.note||'','处理说明',false),decidedAt:context.now,decidedBy:context.actorName};
      if(p.decision==='rework'){
        if(developmentDomain(dev.values)==='fabric')throw new MistCommandError('VALIDATION','面料开发没有整改复检，请重新打样或放弃本版');
        v.qcHistory=[...(v.qcHistory||[]),{...v.qc,decision}];v.qc=null;
      }else v.qcDecision=decision;
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,(p.decision==='rework'?'整改复检 ':'放弃 ')+v.label,{view:'development/detail',id:dev.id,versionId:v.id},'qc');
      result={devId:dev.id,versionId:v.id};break;
    }
    case 'development.round.create': {
      const dev=find(state.devs,p.devId,'开发案');
      const source=p.resampleFromVersionId?state.versions.find(row=>row.id===p.resampleFromVersionId&&row.devId===dev.id):undefined;
      if(p.resampleFromVersionId){
        if(!source)throw new MistCommandError('VALIDATION','重新打样的来源版本不存在');
        if(source.qc?.result!=='reject'||source.qcDecision)throw new MistCommandError('PRECONDITION','只有 QC 不通过且尚未处理的版本才能重新打样');
      }
      const {round,versions}=createRound(state,dev,p,context);
      if(source)source.qcDecision={kind:'resample',note:text(p.requirements,'本轮要求'),decidedAt:context.now,decidedBy:context.actorName,roundId:round.id};
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,'开启第 '+round.number+' 轮：'+versions.map(v=>v.label).join('、'),{view:'development/detail',id:dev.id,versionId:versions[0].id});
      result={devId:dev.id,roundId:round.id,versionId:versions[0].id,versionIds:versions.map(v=>v.id)};break;
    }
    case 'development.round.updateRequirements': {
      const dev=find(state.devs,p.devId,'开发案'), closure=developmentClosure(state,dev);
      if(closure)throw new MistCommandError('PRECONDITION','开发案'+closure.label+'，不能再改共同要求');
      const round=(state.rounds||[]).find(row=>row.id===p.roundId&&row.devId===dev.id);
      if(!round)throw new MistCommandError('NOT_FOUND','轮次不存在');
      const requirements=text(p.requirements,'本轮共同要求');
      if(requirements===round.requirements)throw new MistCommandError('PRECONDITION','共同要求没有变化');
      round.requirements=requirements;round.requirementsUpdatedAt=context.now;round.requirementsUpdatedBy=context.actorName;
      const pending=state.versions.filter(v=>v.roundId===round.id&&!factoryTaskSync(state,v)?.inSync).map(v=>v.label);
      dev.updatedAt=context.now;
      event(state,context,'development',dev.id,'修改第 '+round.number+' 轮共同要求'+(pending.length?'；待逐厂同步：'+pending.join('、'):''),{view:'development/detail',id:dev.id});
      result={devId:dev.id,roundId:round.id};break;
    }
    case 'development.version.syncRequirements': {
      const [dev,v]=versionOf(state,p.devId,p.versionId), blocked=factoryTaskSyncBlocker(state,dev,v);
      if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      const round=factoryTaskSync(state,v)!.round;
      const task:MistFactoryTask=v.task||{...defaultFactoryTask(dev,v.factory,round.targetDate),commonRequirements:'',sampleQuantity:v.sampleQuantity,syncedAt:'',syncedBy:''};
      v.task={...task,commonRequirements:round.requirements,syncedAt:context.now,syncedBy:context.actorName};
      v.note=factoryTaskNote(round.requirements,v.task.extraRequirements);
      dev.updatedAt=context.now;
      event(state,context,'development',dev.id,v.label+' 已同步第 '+round.number+' 轮共同要求',{view:'development/detail',id:dev.id,versionId:v.id});
      result={devId:dev.id,versionId:v.id};break;
    }
    case 'development.notice.generate': {
      const [dev,v]=versionOf(state,p.devId,p.versionId), snapshot=prepareDevelopmentNoticeSnapshot(state,p,context);
      const artifact=(context as MistContext&{developmentNotice?:DevNoticeArtifact}).developmentNotice;
      if(!artifact||artifact.record.versionId!==v.id||artifact.record.snapshotFingerprint!==developmentNoticeFingerprint(snapshot)||developmentNoticeFingerprint(artifact.record.snapshot)!==artifact.record.snapshotFingerprint||artifact.record.contentFingerprint!==developmentNoticeFingerprint(developmentNoticeContent(state,dev,v))||artifact.record.fileId!==artifact.file.id)throw new MistCommandError('PRECONDITION','通知单须由服务端按当前工厂任务生成并归档');
      const record=artifact.record;
      if(state.versions.some(row=>row.notices?.some(n=>n.id===record.id||n.fileId===record.fileId))||state.files.some(f=>f.id===artifact.file.id))throw new MistCommandError('CONFLICT','通知单记录或文件已存在',409);
      state.files.push(structuredClone(artifact.file));v.notices=[...(v.notices||[]),structuredClone(record)];dev.updatedAt=context.now;
      event(state,context,'development',dev.id,'生成'+snapshot.title+' '+record.noticeNo+'（'+v.factory+'）',{view:'development/detail',id:dev.id,versionId:v.id});
      result={devId:dev.id,versionId:v.id,noticeId:record.id,fileId:record.fileId};break;
    }
    case 'development.version.addSampleForm': {
      const [dev,v]=versionOf(state,p.devId,p.versionId), blocked=sampleFormBlocker(state,dev,v);
      if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      if(!validFabricSample(p.quantity,p.form,p.unit))throw new MistCommandError('VALIDATION','面料实物须明确形态、数量和单位：米样按米，其他形态按整数份');
      const form=text(p.form,'实物形态',true,60), unit=text(p.unit,'单位',true,20);
      const {id}=applyFulfillmentCommand(state,{type:'fulfillment.samples.create',payload:{name:dev.name,category:'面料',form,unit,quantity:p.quantity,location:text(p.location||'','位置',false,240),size:'',color:text(p.color||v.sampleColor||dev.values.color||'','颜色',false,120),source:{kind:'version',devId:dev.id,versionId:v.id},fileIds:[],note:text(p.note||'','备注',false,1000)||('来源实物 '+v.sample+' 追加'+form)}},context) as {id:string};
      const sample=find(state.fulfillment.samples,id,'样品');
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,v.label+' 追加实物形态 '+form+' '+sample.quantity+' '+unit+'（'+sample.code+'）',{view:'development/detail',id:dev.id,versionId:v.id});
      result={devId:dev.id,versionId:v.id,id};break;
    }
    case 'development.sample.dispatch': {
      const [dev,v]=versionOf(state,p.devId,p.versionId), blocked=sampleDispatchBlocker(state,dev,v);
      if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      const sample=developmentVersionSamples(state,v).find(s=>s.id===p.sampleId);
      if(!sample)throw new MistCommandError('VALIDATION','请选择本版的准确实物');
      if(typeof p.quantity!=='number'||!Number.isFinite(p.quantity)||p.quantity<=0)throw new MistCommandError('VALIDATION','寄出数量必须为有效正数');
      if(sample.unit!=='米'&&!Number.isInteger(p.quantity))throw new MistCommandError('VALIDATION','按份/件的实物必须整数寄出');
      if(p.quantity>sample.available)throw new MistCommandError('PRECONDITION','寄出数量超过可用余额（'+sample.available+' '+sample.unit+'）');
      const recipient=text(p.recipient,'收件方',true,240), trackingNo=text(p.trackingNo||'','运单号',false,120), fee=p.fee==null?null:sampleFee(p.fee), note=text(p.note||'','备注',false,1000);
      const {id:movementId}=applyFulfillmentCommand(state,{type:'fulfillment.samples.move',payload:{id:sample.id,kind:'send',quantity:p.quantity,person:recipient,location:'',note:['寄样 '+dev.code+' '+v.label,trackingNo&&('运单 '+trackingNo),note].filter(Boolean).join('；'),...(p.sourceLocation!==undefined?{sourceLocation:p.sourceLocation}:{})}},context) as {id:string};
      const dispatchId=context.id(), movement=find(state.fulfillment.sampleMovements,movementId,'出库流水');
      movement.development={devId:dev.id,versionId:v.id,dispatchId};if(trackingNo)movement.trackingNo=trackingNo;
      (v.dispatches||=[]).push({id:dispatchId,sampleId:sample.id,sampleCode:sample.code,form:sample.form,unit:sample.unit,quantity:movement.quantity,recipient,trackingNo,fee,note,movementId,recordedAt:context.now,recordedBy:context.actorName});
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,v.label+' 寄样 '+sample.form+' '+movement.quantity+' '+sample.unit+' → '+recipient+(trackingNo?'（运单 '+trackingNo+'）':''),{view:'development/detail',id:dev.id,versionId:v.id});
      result={devId:dev.id,versionId:v.id,id:dispatchId};break;
    }
    case 'development.sample.dispatchFee': {
      const [dev,v]=versionOf(state,p.devId,p.versionId), row=(v.dispatches||[]).find(d=>d.id===p.dispatchId);
      if(dev.billing?.request)throw new MistCommandError('PRECONDITION',DEVELOPMENT_BILLING_LOCK);
      if(!row)throw new MistCommandError('NOT_FOUND','寄样记录不存在',404);
      if(row.fee)throw new MistCommandError('PRECONDITION','寄样费已登记，不能覆盖');
      row.fee=sampleFee(p.fee);row.feeRecordedAt=context.now;row.feeRecordedBy=context.actorName;dev.updatedAt=context.now;
      event(state,context,'development',dev.id,v.label+' 补登寄样费 '+row.fee.amount+' '+row.fee.currency+'（'+row.sampleCode+'）');
      result={devId:dev.id,versionId:v.id,id:row.id};break;
    }
    case 'development.fee.recordMaking': {
      const dev=find(state.devs,p.devId,'开发案'), blocked=makingFeeBlocker(state,dev,p.sampleId);
      if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      const sample=developmentSamplesOf(state,dev).find(s=>s.id===p.sampleId)!, fee=sampleFee({amount:p.amount,currency:p.currency});
      const versionId=sample.source.kind==='version'?sample.source.versionId:'';
      (dev.billing||={makingFees:[]}).makingFees.push({sampleId:sample.id,versionId,sampleCode:sample.code,form:sample.form,amount:fee.amount,currency:fee.currency,recordedAt:context.now,recordedBy:context.actorName});
      dev.updatedAt=context.now;
      event(state,context,'development',dev.id,'登记制作费 '+sample.form+' '+sample.code+'：'+fee.amount+' '+fee.currency);
      result={devId:dev.id,id:sample.id};break;
    }
    case 'development.billing.request': {
      const dev=find(state.devs,p.devId,'开发案'), blocked=billingRequestBlocker(state,dev);
      if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      const summary=developmentFeeSummary(state,dev), id=context.id(), taskId=context.id();
      (dev.billing||={makingFees:[]}).request={id,requestedAt:context.now,requestedBy:context.actorName,billTo:developmentBillTo(dev),lines:summary.lines,totals:summary.totals,state:'pending',invoiceIds:[],taskId};
      // 财务待办落到财务应收区（顶部“开发费用待开票”列表），不用开发案 ID 冒充票据或流水目标。
      state.tasks.unshift({id:taskId,title:'为 '+dev.code+' 开具开发费用发票（'+summary.totals.map(t=>t.amount+' '+t.currency).join(' + ')+'）',due:context.now.slice(0,10),done:false,kind:'finance',target:{view:'payment-vouchers'},assigneeIds:[],permission:'invoices:write'});
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,'发起开发费用开票：'+summary.totals.map(t=>t.amount+' '+t.currency).join(' + ')+' → '+dev.billing.request.billTo,{view:'development/detail',id:dev.id});
      result={devId:dev.id,id};break;
    }
    case 'finance.developmentInvoice.issue': {
      const dev=find(state.devs,p.devId,'开发案'), request=dev.billing?.request;
      if(!request||request.id!==p.requestId)throw new MistCommandError('NOT_FOUND','开票申请不存在',404);
      if(request.state!=='pending')throw new MistCommandError('CONFLICT','本开票申请已开票，请勿重复开票',409);
      if(!developmentCharged(dev.values))throw new MistCommandError('PRECONDITION','不收费开发不开票');
      if(dev.closure?.kind==='cancelled')throw new MistCommandError('PRECONDITION','开发案已取消');
      const due=date(p.due,'到期日'), year=context.now.slice(0,4);
      // 开票按申请时冻结的明细；与当前合计不一致说明快照被改动，不开票。
      if(JSON.stringify(billingTotals(request.lines))!==JSON.stringify(request.totals))throw new MistCommandError('PRECONDITION','开票明细与合计不一致，请核对后重新发起');
      for(const total of request.totals){
        const id=context.id(), seq=state.invoices.filter(i=>i.code.startsWith('DI-'+year+'-')).length+1, code='DI-'+year+'-'+String(seq).padStart(4,'0');
        state.invoices.push({id,code,orderId:'',order:dev.code,customer:request.billTo,due,amount:total.amount,open:total.amount,currency:total.currency,devId:dev.id});
        request.invoiceIds.push(id);
        event(state,context,'invoice',id,'开具开发费用发票 '+code+'（'+dev.code+'）：'+total.amount+' '+total.currency,{view:'payment-vouchers',id});
      }
      request.state='invoiced';request.invoicedAt=context.now;request.invoicedBy=context.actorName;
      for(const task of state.tasks)if(task.id===request.taskId)task.done=true;
      updateDev(state,dev,context);
      event(state,context,'development',dev.id,'财务已开具开发费用发票 '+state.invoices.filter(i=>request.invoiceIds.includes(i.id)).map(i=>i.code).join('、'),{view:'development/detail',id:dev.id});
      result={devId:dev.id,id:request.invoiceIds[0]};break;
    }
    case 'development.version.recordMinor': {
      const [dev,parent]=versionOf(state,p.devId,p.versionId), blocked=minorVersionBlocker(state,dev,parent);
      if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      const change=text(p.change,'调整内容'), siblings=minorVersions(state,parent), seq=siblings.length+1, id=context.id();
      const minor:MistVersion={id,devId:dev.id,label:minorVersionLabel(parent.label,seq),factoryId:parent.factoryId,factory:parent.factory,sample:parent.sample,sampleQuantity:parent.sampleQuantity,
        ...(parent.sampleForm!==undefined?{sampleForm:parent.sampleForm}:{}),...(parent.sampleUnit!==undefined?{sampleUnit:parent.sampleUnit}:{}),
        size:parent.size,fabric:parent.fabric,img:parent.img,fileIds:[...parent.fileIds],returnedAt:parent.returnedAt,qc:structuredClone(parent.qc),confirmations:[],archivedAt:null,note:change,
        ...(parent.roundId?{roundId:parent.roundId}:{}),...(parent.factoryLetter?{factoryLetter:parent.factoryLetter}:{}),
        minor:{parentVersionId:parent.id,seq,change,recordedAt:context.now,recordedBy:context.actorName}};
      const after=dev.versionIds.indexOf((siblings.at(-1)||parent).id);
      state.versions.push(minor);dev.versionIds.splice(after+1,0,id);dev.currentVersionId=id;updateDev(state,dev,context);
      event(state,context,'development',dev.id,'在 '+parent.label+' 上记录小调整，生成 '+minor.label+'：'+change,{view:'development/detail',id:dev.id,versionId:id});
      result={devId:dev.id,versionId:id};break;
    }
    case 'development.archive': {
      const [dev,v]=versionOf(state,p.devId,p.versionId);
      if(!v.qc||v.qc.result==='reject')throw new MistCommandError('PRECONDITION','准确版本QC通过或有保留通过后才能留档');
      if(!v.archivedAt){v.archivedAt=context.now;event(state,context,'development',dev.id,'留档 '+v.label);}
      updateDev(state,dev,context);result={devId:dev.id,versionId:v.id};break;
    }
    case 'fabric.create': {
      const id=context.id(), code='SR-F-'+context.now.slice(0,4)+'-'+String(state.fabrics.length+1).padStart(4,'0');
      state.fabrics.unshift({id,code,name:text(p.name,'面料'),request:text(p.request,'需求'),...(()=>{const o=resolveMember(context,p.ownerId,'寻样负责人');return{owner:o.name,ownerId:o.id};})(),due:date(p.due),state:'寻样中',tone:'warn',sub:'等待候选答复',answer:'',confirmed:false,fileIds:[]});
      event(state,context,'fabric',id,'创建面料寻样 '+code);result={id};break;
    }
    case 'fabric.answer': {
      const f=find(state.fabrics,p.id,'寻样任务');f.answer=text(p.answer,'答复');f.fileIds=files(state,p.fileIds);f.state='待发起人确认';f.tone='accent';f.sub='已提交答复';
      event(state,context,'fabric',f.id,'提交寻样答复');result={id:f.id};break;
    }
    case 'fabric.confirm': {
      const f=find(state.fabrics,p.id,'寻样任务');if(!f.answer)throw new MistCommandError('PRECONDITION','尚无可确认答复');
      f.confirmed=!!p.approved;f.state=p.approved?'已结案':'待补充';f.tone=p.approved?'ok':'warn';f.sub=text(p.note,'确认意见',!p.approved);
      event(state,context,'fabric',f.id,p.approved?'确认寻样答复':'退回补充寻样');result={id:f.id};break;
    }
    case 'order.create': {
      const governance=createOrderGovernance(context,p.governance);
      const c=governance.contract.kind==='internal'?null:find(state.customers,p.customerId,'客户');if(c){const held=relationHoldReason(state,{customerId:c.id});if(held)throw new MistCommandError('PRECONDITION',held);}if(!['garment','fabric'].includes(p.type)||!Array.isArray(p.lines)||!p.lines.length||p.lines.length>200)throw new MistCommandError('VALIDATION','订单类型或条目无效');
      const orderOwner=resolveMember(context,p.ownerId,'订单负责人');
      const id=context.id(),code='SO-'+(p.type==='fabric'?'F':'G')+'-'+context.now.slice(0,4)+'-'+String(state.orders.length+1).padStart(4,'0'),currency=text(p.currency,'币种',true,3).toUpperCase();
      if(!/^[A-Z]{3}$/.test(currency))throw new MistCommandError('VALIDATION','币种格式无效');
      const order:MistOrder={id,code,type:p.type,customerId:c?.id||'',customer:c?.name||governance.contract.receiver||'内部接收方待填写',governance,season:text(p.season,'季节'),lines:0,qty:0,amount:0,currency,due:date(p.due),progress:0,state:'订单草稿',tone:'neutral',owner:orderOwner.name,ownerId:orderOwner.id,img:p.lines[0].img||'coat',checklist:['拟发范围确认','收货与贸易条款确认','收款条件核对'].map((label,index)=>({id:id+'-check-'+index,label,done:false,note:''})),handoffAt:null,createdAt:context.now,updatedAt:context.now};
      // BB-ORD-2：来源与条目同一命令写入，先全部校验再落库，任何一条不合规整单拒绝
      const scope={type:p.type,customerId:c?.id||'',internal:governance.contract.kind==='internal'};
      const rows=(p.lines as MistOrderInput['lines']).map((row,index)=>{const name=text(row.name,'品名'),fromBreakdown=lineQuantityFromBreakdown(p.type,row,`条目「${name||index+1}」`),qty=fromBreakdown.qty??positive(row.qty,'数量'),price=positive(row.price,'单价',true);lineAmount(qty,price);return {...(fromBreakdown.breakdown?{breakdown:fromBreakdown.breakdown}:{}),name,style:text(row.style,'款号'),img:['coat','blazer','suit','clay'].includes(row.img)?row.img:'coat' as MistImage,qty,unit:text(row.unit,'单位',true,20),price,source:assertOrderLineSource(state,scope,row,name||String(index+1))};});
      state.orders.unshift(order);
      for(const {source,...row} of rows)state.orderLines.push({id:context.id(),orderId:id,...row,made:0,qc:0,...source} as MistOrderLine);
      event(state,context,'order',id,'创建订单 '+code,{view:'orders/detail',id});result={id,orderId:id};break;
    }
    case 'order.update': {
      const o=find(state.orders,p.orderId,'订单');assertOrderWritable(o);
      if((p as Record<string,unknown>).owner!==undefined)throw new MistCommandError('VALIDATION','负责人须按账号选择');
      if(o.governance?.status==='pending'||o.governance?.changeDraft?.status==='pending')throw new MistCommandError('PRECONDITION','审批中的订单内容已锁定');
      if((p.due!==undefined&&p.due!==o.due||p.season!==undefined&&p.season!==o.season)&&(!o.governance||o.governance.status==='approved'))throw new MistCommandError('PRECONDITION','正式商业条款变更须保存变更草稿并重新审批');
      if(p.due!==undefined)o.due=date(p.due);if(p.season!==undefined)o.season=text(p.season,'季节');let ownerText='';if(p.ownerId!==undefined&&p.ownerId!==o.ownerId){const next=resolveMember(context,p.ownerId,'订单负责人');ownerText=ownerChangeText('负责人',o.owner,next.name);o.owner=next.name;o.ownerId=next.id;}o.updatedAt=context.now;event(state,context,'order',o.id,ownerText?'更新订单 · '+ownerText:'更新订单');result={orderId:o.id};break;
    }
    case 'order.checklist': {
      const o=assertMistOrderApproved(state,p.orderId), item=find(o.checklist,p.itemId,'准备事项');item.done=!!p.done;item.actor=context.actorName;item.at=context.now;o.updatedAt=context.now;result={orderId:o.id};break;
    }
    case 'order.handoff': {
      const o=assertMistOrderApproved(state,p.orderId);const readiness=o.checklist.filter(i=>['拟发范围确认','收货与贸易条款确认','收款条件核对'].includes(i.label));if(readiness.length!==3||!readiness.every(i=>i.done))throw new MistCommandError('PRECONDITION','请先核对拟发范围、收货贸易条款和收款条件');
      if(!o.handoffAt){o.handoffAt=context.now;state.tasks.unshift({id:context.id(),title:'核对 '+o.code+' 出运交接',due:o.due,done:false,kind:'shipping',target:{view:'orders/detail',id:o.id},assigneeIds:[],permission:MIST_LOGISTICS_DUTY});event(state,context,'order',o.id,'交接后勤'+(p.note?'：'+text(p.note,'交接说明',false):''),{view:'orders/detail',id:o.id},'shipping');}
      result={orderId:o.id};break;
    }
    case 'production.move': {
      const job=find(state.productions,p.id,'生产单'),from=COLS.indexOf(job.col),to=COLS.indexOf(p.col);
      if(to<0||to>from+1)throw new MistCommandError('PRECONDITION','请按相邻工序推进');
      assertProductionTransition(state,job,p.col,job.pct);
      if(p.col==='done'&&job.pct<100)throw new MistCommandError('PRECONDITION','完成进度达到100%并完成尾期QC后才能待出运');
      job.col=p.col;
      event(state,context,'production',job.id,'更新工序为 '+p.col,{view:'production-board',id:job.id,productionId:job.id});result={id:job.id,orderId:job.orderId};break;
    }
    case 'production.update': {
      const job=find(state.productions,p.id,'生产单'),pct=positive(p.pct,'进度',true);if(pct>100)throw new MistCommandError('VALIDATION','进度不得超过100%');
      assertProductionTransition(state,job,job.col,pct);
      job.pct=pct;if(p.risk!==undefined)job.risk=text(p.risk,'风险说明',false);
      if(p.due!==undefined)job.due=date(p.due);if(p.startDate!==undefined&&p.startDate)job.startDate=date(p.startDate);
      if(job.startDate&&job.startDate>job.due)throw new MistCommandError('VALIDATION','开始日期不得晚于交期');
      event(state,context,'production',job.id,'更新生产进度 '+pct+'%');result={id:job.id,orderId:job.orderId};break;
    }
    case 'finance.receivable.confirm':
    case 'finance.receivable.reject': {
      const i=find(state.invoices,text(p.invoiceId,'应收'),'应收');
      if(!isPendingFinanceMistInvoice(i))throw new MistCommandError('PRECONDITION',i.financeStatus==='confirmed'?'该应收已由财务确认':'仅待财务确认的应收可以确认或驳回');
      if(command.type==='finance.receivable.confirm'){
        i.financeStatus='confirmed';i.financeConfirmedAt=context.now;i.financeConfirmedBy=context.actorName;if(context.actorId)i.financeConfirmedById=context.actorId;
        event(state,context,'invoice',i.id,'财务确认应收 '+i.code+'，计入应收余额',{view:'invoices',id:i.id});result={id:i.id};break;
      }
      const reason=text(p.reason,'驳回原因',true,500),f=state.fulfillment;
      const docs=(f?.documents||[]).filter(d=>d.type==='CI'&&d.invoiceId===i.id&&d.status==='issued');
      if(docs.length!==1)throw new MistCommandError('PRECONDITION','未找到唯一的来源 CI，不能驳回');
      const d=docs[0],s=f.shipments.find(x=>x.id===d.shipmentId);
      if(!s||s.state==='departed'||s.state==='cancelled')throw new MistCommandError('PRECONDITION','来源出运已离港或已取消，CI 不能退回修正，请走财务更正');
      Object.assign(i,{financeStatus:'rejected',financeRejectedAt:context.now,financeRejectedBy:context.actorName,financeRejectReason:reason,voidedAt:context.now,voidReason:'财务驳回：'+reason,voidedBy:context.actorName,voidSourceDocumentId:d.id,open:0},context.actorId?{financeRejectedById:context.actorId,voidedById:context.actorId}:{});
      d.status='draft';delete d.invoiceId;delete d.issuedAt;d.financeRejection={reason,at:context.now,actor:context.actorName,invoiceId:i.id};
      if(s.state==='ready')s.state='preparing';delete s.documentsSentAt;
      event(state,context,'invoice',i.id,'财务驳回应收 '+i.code+'：'+reason+'；CI 退回草稿待修正',{view:'invoices',id:i.id});result={id:i.id,documentId:d.id};break;
    }
    case 'finance.importReceipts': {
      if(!Array.isArray(p.receipts)||!p.receipts.length||p.receipts.length>2000)throw new MistCommandError('VALIDATION','流水数量无效');
      let imported=0,skipped=0;
      for(const row of p.receipts){const amount=positive(row.amount,'到账金额');mistMoneyMinor(amount);const value={date:date(row.date),payer:text(row.payer,'付款方'),amount,currency:text(row.currency,'币种',true,3).toUpperCase(),ref:text(row.ref,'附言',false)};if(!/^[A-Z]{3}$/.test(value.currency))throw new MistCommandError('VALIDATION','币种无效');
        if(value.ref&&state.receipts.some(r=>r.date===value.date&&r.payer===value.payer&&r.amount===value.amount&&r.currency===value.currency&&r.ref===value.ref)){skipped++;continue;}
        const id=context.id();state.receipts.push({id,code:'BR-'+context.now.slice(0,10).replace(/-/g,'')+'-'+String(state.receipts.length+1).padStart(3,'0'),...value,remaining:amount,state:'unmatched'});imported++;}
      event(state,context,'finance','receipts','导入 '+imported+' 笔到账流水，跳过 '+skipped+' 笔已存在流水');result={imported,skipped};break;
    }
    case 'finance.reconcile':
    case 'finance.acceptSuggestions': {
      const pairs=command.type==='finance.reconcile'?[{receiptId:p.receiptId,invoiceId:p.invoiceId,amount:p.amount,payerBasis:p.payerBasis}]:strings(p.receiptIds,'到账流水').map(id=>({receiptId:id,invoiceId:state.receipts.find(r=>r.id===id)?.suggest,amount:undefined,payerBasis:undefined}));
      let applied=0;
      for(const pair of pairs){
        const r=find(state.receipts,pair.receiptId,'到账流水'),i=state.invoices.find(v=>v.id===pair.invoiceId||v.code===pair.invoiceId);
        if(command.type==='finance.acceptSuggestions'&&(!i||!isRecognizedMistInvoice(i)||(r.confidence||0)<80||r.remaining<=0||i.open<=0))continue;
        if(!i)throw new MistCommandError('VALIDATION','请选择发票');
        if(!isActiveMistInvoice(i))throw new MistCommandError('PRECONDITION','已作废发票不能核销');
        if(isPendingFinanceMistInvoice(i))throw new MistCommandError('PRECONDITION','应收待财务确认，确认前不能登记收款核销');
        if(i.currency!==r.currency)throw new MistCommandError('VALIDATION','到账和发票币种不同');
        const samePayer=r.payer.trim().toLocaleLowerCase()===i.customer.trim().toLocaleLowerCase();
        if(command.type==='finance.acceptSuggestions'&&!samePayer)continue;
        const payerBasis=samePayer?(pair.payerBasis?text(pair.payerBasis,'付款方关系依据',true,2000):''):text(pair.payerBasis,'付款方关系依据',true,2000);
        const amount=pair.amount===undefined?major(Math.min(mistMoneyMinor(r.remaining),mistMoneyMinor(i.open))):positive(pair.amount,'核销金额');
        const cents=mistMoneyMinor(amount);if(cents<=0||cents>mistMoneyMinor(r.remaining)||cents>mistMoneyMinor(i.open))throw new MistCommandError('VALIDATION','核销金额超出可分配余额');
        state.allocations.push({id:context.id(),receiptId:r.id,invoiceId:i.id,amount,currency:r.currency,createdAt:context.now,actor:context.actorName,...(payerBasis?{payerBasis}:{})});applied++;recalculate(state);
        event(state,context,'invoice',i.id,'核销 '+r.code+' → '+i.code,{view:'payment-vouchers',id:i.id});
      }
      assertOrderFundingIntegrity(state);result={applied};break;
    }
    case 'finance.payment.save': {
      const amount=positive(p.amount,'付款金额');mistMoneyMinor(amount);const id=context.id();
      const currency=text(p.currency,'币种',true,3).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new MistCommandError('VALIDATION','币种无效');
      state.payments.push({id,code:'PAY-'+context.now.slice(0,4)+'-'+String(state.payments.length+1).padStart(4,'0'),date:date(p.date),payee:text(p.payee,'收款方'),amount,currency,ref:text(p.ref,'备注',false),origin:'finance'});
      event(state,context,'payment',id,'登记付款凭证');result={id};break;
    }
    case 'finance.allocation.reverse': {
      const a=find(state.allocations,text(p.allocationId,'核销记录'),'核销记录'),reason=text(p.reason,'冲回原因',true,500);
      const r=state.receipts.find(x=>x.id===a.receiptId),i=state.invoices.find(x=>x.id===a.invoiceId);
      const id=context.id();state.financeReversals=[...(state.financeReversals||[]),{id,kind:'allocation',targetId:a.id,amount:a.amount,currency:a.currency,reason,at:context.now,actor:context.actorName,...(context.actorId?{actorId:context.actorId}:{}),allocation:{...a},receiptId:a.receiptId,invoiceId:a.invoiceId}];
      state.allocations=state.allocations.filter(x=>x.id!==a.id);recalculate(state);
      if(r&&r.remaining>0&&r.state==='matched')r.state=r.suggest&&(r.confidence||0)>0?'suggested':'unmatched';
      assertOrderFundingIntegrity(state);
      event(state,context,'invoice',a.invoiceId,'冲回核销 '+(r?.code||a.receiptId)+' → '+(i?.code||a.invoiceId)+'（'+a.amount+' '+a.currency+'）：'+reason+'；原核销记录保留',{view:'payment-vouchers',id:a.invoiceId});
      result={id,receiptId:a.receiptId,invoiceId:a.invoiceId};break;
    }
    case 'finance.payment.reverse': {
      const v=find(state.payments,text(p.paymentId,'付款凭证'),'付款凭证'),reason=text(p.reason,'冲回原因',true,500);
      const blocked=mistPaymentReverseBlock(state,v);if(blocked)throw new MistCommandError('PRECONDITION',blocked);
      const id=context.id(),voucherId=context.id();
      state.payments.push({id:voucherId,code:'PAY-'+context.now.slice(0,4)+'-'+String(state.payments.length+1).padStart(4,'0'),date:platformBusinessDate(context.now),payee:v.payee,amount:-v.amount,currency:v.currency,ref:'冲回 '+v.code+' · '+reason,origin:'finance',reversalOf:v.id,...(v.accountId?{accountId:v.accountId}:{})});
      state.financeReversals=[...(state.financeReversals||[]),{id,kind:'payment',targetId:v.id,amount:v.amount,currency:v.currency,reason,at:context.now,actor:context.actorName,...(context.actorId?{actorId:context.actorId}:{}),voucherId}];
      event(state,context,'payment',v.id,'冲回付款凭证 '+v.code+'：'+reason+'；原凭证保留，另记反向凭证');
      result={id,voucherId};break;
    }
    case 'finance.account.save': {
      const accounts=state.bankAccounts||(state.bankAccounts=[]),old=p.id?find(accounts,text(p.id,'银行账户'),'银行账户'):undefined;
      const name=text(p.name,'账户名称',true,80),bankName=text(p.bankName,'开户行',true,120),accountNo=text(p.accountNo,'银行账号',true,40).replace(/\s+/g,'');
      if(!/^[0-9A-Za-z-]{4,40}$/.test(accountNo))throw new MistCommandError('VALIDATION','银行账号格式无效');
      const currency=text(p.currency,'币种',true,3).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new MistCommandError('VALIDATION','币种无效');
      const openingDate=date(p.openingDate,'期初日期');if(openingDate>platformBusinessDate(context.now))throw new MistCommandError('VALIDATION','期初日期不能晚于今天');
      if(typeof p.openingBalance!=='number'||!Number.isFinite(p.openingBalance))throw new MistCommandError('VALIDATION','期初余额无效');
      const openingBalance=(p.openingBalance<0?-1:1)*major(mistMoneyMinor(Math.abs(p.openingBalance)));
      if(accounts.some(a=>a.id!==old?.id&&a.accountNo===accountNo&&a.currency===currency))throw new MistCommandError('CONFLICT','该账号同币种账户已登记');
      if(old){
        const used=state.receipts.some(r=>r.accountId===old.id)||state.payments.some(x=>x.accountId===old.id)||(state.fxRecords||[]).some(r=>!r.reversed&&(r.fromAccountId===old.id||r.toAccountId===old.id));
        if(used&&(old.currency!==currency||old.openingDate!==openingDate||old.openingBalance!==openingBalance))throw new MistCommandError('PRECONDITION','已有流水或结汇记入此账户，币种和期初不能修改；请先解除归属或冲回结汇');
        const before=old.openingBalance+' '+old.currency+' @'+old.openingDate;
        Object.assign(old,{name,bankName,accountNo,currency,openingDate,openingBalance,updatedAt:context.now});
        event(state,context,'finance',old.id,'修改银行账户 '+old.code+(before!==openingBalance+' '+currency+' @'+openingDate?'（期初 '+before+' → '+openingBalance+' '+currency+' @'+openingDate+'）':''));result={id:old.id};break;
      }
      const id=context.id(),code='BA-'+String(accounts.length+1).padStart(3,'0');
      accounts.push({id,code,name,bankName,accountNo,currency,openingDate,openingBalance,createdAt:context.now,actor:context.actorName,...(context.actorId?{actorId:context.actorId}:{})});
      event(state,context,'finance',id,'登记银行账户 '+code+' '+name+'，期初 '+openingBalance+' '+currency+'（'+openingDate+'）');result={id};break;
    }
    case 'finance.account.assign': {
      const kind=p.kind==='receipt'||p.kind==='payment'?p.kind:(()=>{throw new MistCommandError('VALIDATION','流水类型无效');})();
      const row:MistReceipt|MistPayment=kind==='receipt'?find(state.receipts,text(p.id,'到账流水'),'到账流水'):find(state.payments,text(p.id,'付款凭证'),'付款凭证');
      const accountId=p.accountId===null?null:text(p.accountId,'银行账户'),account=accountId?find(state.bankAccounts||[],accountId,'银行账户'):undefined;
      if((row.accountId||null)===accountId)throw new MistCommandError('PRECONDITION','该流水已归属此账户');
      const reason=row.accountId?text(p.reason,'调整原因',true,500):(p.reason===undefined?'':text(p.reason,'调整原因',false,500));
      if(account){
        if(account.currency!==row.currency)throw new MistCommandError('VALIDATION','账户币种 '+account.currency+' 与流水币种 '+row.currency+' 不同');
        if(row.date<account.openingDate)throw new MistCommandError('PRECONDITION','交易日期早于账户期初日期 '+account.openingDate+'，已含在期初余额中');
      }
      const before=(state.bankAccounts||[]).find(a=>a.id===row.accountId);
      if(account)row.accountId=account.id;else delete row.accountId;
      event(state,context,kind==='receipt'?'finance':'payment',row.id,(account?(before?'调整 '+row.code+' 归属账户 '+before.code+' → '+account.code:row.code+' 归属账户 '+account.code):'解除 '+row.code+' 的账户归属 '+(before?.code||''))+(reason?'：'+reason:''));
      result={id:row.id,accountId};break;
    }
    case 'finance.fx.lock':
    case 'finance.fx.settle': {
      const records=state.fxRecords||(state.fxRecords=[]),settle=command.type==='finance.fx.settle',day=date(p.date,settle?'结汇日期':'锁汇日期');
      if(day>platformBusinessDate(context.now))throw new MistCommandError('VALIDATION','日期不能晚于今天');
      const amount=positive(p.amount,'原币金额'),amountMinor=mistMoneyMinor(amount),ref=text(p.ref,settle?'银行水单号':'锁汇合同号',true,120),note=p.note===undefined?'':text(p.note,'备注',false,1000);
      const id=context.id(),code='FX-'+String(records.length+1).padStart(3,'0'),base={id,code,date:day,amount,ref,note,createdAt:context.now,actor:context.actorName,...(context.actorId?{actorId:context.actorId}:{})};
      if(!settle){
        const currency=text(p.currency,'原币币种',true,3).toUpperCase(),localCurrency=text(p.localCurrency,'本币币种',true,3).toUpperCase();
        if(!/^[A-Z]{3}$/.test(currency)||!/^[A-Z]{3}$/.test(localCurrency)||currency===localCurrency)throw new MistCommandError('VALIDATION','原币与本币须为不同的三位币种代码');
        const rate=text(p.rate,'锁定汇率',true,20),localAmount=major(mistFxLocalMinor(amountMinor,rate)),settleBy=date(p.settleBy,'交割截止日');
        if(settleBy<day)throw new MistCommandError('VALIDATION','交割截止日不能早于锁汇日期');
        records.push({...base,kind:'lock',bankName:text(p.bankName,'银行',true,120),currency,localCurrency,localAmount,rate,settleBy});
        event(state,context,'finance',id,'登记锁汇 '+code+'：'+amount+' '+currency+' @ '+rate+' = '+localAmount+' '+localCurrency+'，交割截止 '+settleBy);
      }else{
        const accounts=state.bankAccounts||[],from=find(accounts,text(p.fromAccountId,'卖出账户'),'卖出账户'),to=find(accounts,text(p.toAccountId,'入账账户'),'入账账户');
        if(from.id===to.id||from.currency===to.currency)throw new MistCommandError('VALIDATION','卖出账户与入账账户须为不同币种');
        if(from.openingDate>day||to.openingDate>day)throw new MistCommandError('PRECONDITION','结汇日期早于账户期初日期');
        const localAmount=positive(p.localAmount,'入账本币金额');mistMoneyMinor(localAmount);
        let lockId:string|undefined;
        if(p.lockId){const lock=find(records,text(p.lockId,'锁汇合同'),'锁汇合同');
          if(lock.kind!=='lock'||lock.reversed)throw new MistCommandError('PRECONDITION','锁汇合同无效或已冲回');
          if(lock.currency!==from.currency||lock.localCurrency!==to.currency)throw new MistCommandError('VALIDATION','币种与锁汇合同不一致');
          if(day<lock.date)throw new MistCommandError('VALIDATION','结汇日期早于锁汇日期');
          if(amountMinor>Math.round(mistFxLockUsage(state,lock.id).remaining*100))throw new MistCommandError('PRECONDITION','超过锁汇合同剩余可交割金额');
          lockId=lock.id;}
        records.push({...base,kind:'settlement',bankName:from.bankName,currency:from.currency,localCurrency:to.currency,localAmount,rate:mistFxRate(amount,localAmount),fromAccountId:from.id,toAccountId:to.id,...(lockId?{lockId}:{})});
        event(state,context,'finance',id,'登记结汇 '+code+'：'+from.code+' 卖出 '+amount+' '+from.currency+' → '+to.code+' 入账 '+localAmount+' '+to.currency+(lockId?'（交割锁汇 '+records.find(r=>r.id===lockId)!.code+'）':''));
      }
      result={id};break;
    }
    case 'finance.fx.reverse': {
      const r=find(state.fxRecords||[],text(p.id,'锁汇 / 结汇记录'),'锁汇 / 结汇记录'),reason=text(p.reason,'冲回原因',true,500);
      if(r.reversed)throw new MistCommandError('PRECONDITION',r.code+' 已冲回');
      if(r.kind==='lock'&&(state.fxRecords||[]).some(x=>x.lockId===r.id&&!x.reversed))throw new MistCommandError('PRECONDITION','该锁汇已有结汇交割，请先冲回相关结汇');
      r.reversed={at:context.now,actor:context.actorName,reason};
      event(state,context,'finance',r.id,'冲回'+(r.kind==='lock'?'锁汇 ':'结汇 ')+r.code+'：'+reason+'；原记录保留');result={id:r.id};break;
    }
    case 'customer.update': {
      const c=find(state.customers,p.id,'客户');
      if(p.patch&&(p.patch as Record<string,unknown>).owner!==undefined)throw new MistCommandError('VALIDATION','负责人须按账号选择');
      for(const key of ['name','country','city','industry','grade','currency','terms','incoterm','categories','since'] as const)if(p.patch[key]!==undefined)c[key]=text(p.patch[key],key,key==='name');
      let ownerText='';if(p.patch.ownerId!==undefined&&p.patch.ownerId!==c.ownerId){const next=resolveMember(context,p.patch.ownerId,'客户负责人');ownerText=ownerChangeText('负责人',c.owner,next.name);c.owner=next.name;c.ownerId=next.id;}
      if(p.patch.creditLimit!==undefined){mistMoneyMinor(p.patch.creditLimit);c.creditLimit=p.patch.creditLimit;}
      state.devs.filter(d=>d.customerId===c.id).forEach(d=>{d.customer=c.name;d.values.customer=c.name;});state.orders.filter(o=>o.customerId===c.id).forEach(o=>{o.customer=c.name;});
      event(state,context,'customer',c.id,ownerText?'更新客户档案 · '+ownerText:'更新客户档案');result={id:c.id,customerId:c.id};break;
    }
    case 'member.groups.set': {
      result=setMemberGroups(state,p,context);break;
    }
    case 'contact.save': {
      find(state.customers,p.customerId,'客户');const id=p.id||context.id();if(p.id)find(state.contacts,id,'联系人');
      const email=text(p.email,'邮箱',false,254);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new MistCommandError('VALIDATION','邮箱格式无效');
      const row:MistContact={id,customerId:p.customerId,name:text(p.name,'姓名',true,120),role:text(p.role,'职务',false,240),email,phone:text(p.phone,'电话',false,80),tone:'accent'};
      state.contacts=state.contacts.filter(c=>c.id!==id);state.contacts.push(row);event(state,context,'customer',p.customerId,'保存联系人 '+row.name);result={id,contactId:id};break;
    }
    case 'contact.delete': {const c=find(state.contacts,p.id,'联系人');state.contacts=state.contacts.filter(x=>x.id!==c.id);event(state,context,'customer',c.customerId,'删除联系人 '+c.name);result={id:c.id};break;}
    case 'settings.update': {
      const patch=p;
      if(patch.companyProfile!==undefined){
        const input=patch.companyProfile;if(!input||typeof input!=='object'||Array.isArray(input))throw new MistCommandError('VALIDATION','公司资料格式无效');
        const fields=['legalName','englishName','address','englishAddress','phone','email','taxId','customsCode','bankName','bankAccount','swift','defaultCurrency'] as const;
        if(Object.keys(input).some(k=>!fields.includes(k as any)))throw new MistCommandError('VALIDATION','公司资料含未知字段');
        const previous=state.settings.companyProfile,value={} as MistCompanyProfile;for(const key of fields)value[key]=text(input[key]??previous?.[key]??'',key,false,500);
        if(value.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))throw new MistCommandError('VALIDATION','公司邮箱格式无效，请填写如 name@example.com 的完整地址');
        if(value.defaultCurrency&&!/^[A-Z]{3}$/.test(value.defaultCurrency))throw new MistCommandError('VALIDATION','币种须使用三位大写代码，如 USD、CNY、EUR');
        state.settings.companyProfile=value;
      }
      if(patch.theme!==undefined&&!['light','dark','system'].includes(patch.theme))throw new MistCommandError('VALIDATION','主题无效');
      if(patch.density!==undefined&&!['compact','default','comfy'].includes(patch.density))throw new MistCommandError('VALIDATION','密度无效');
      for(const key of ['workspaceName','profileName','profileEmail','locale'] as const)if(patch[key]!==undefined)state.settings[key]=text(patch[key],key,false,240);
      if(patch.theme!==undefined)state.settings.theme=patch.theme;if(patch.density!==undefined)state.settings.density=patch.density;
      if(patch.reducedMotion!==undefined)state.settings.reducedMotion=!!patch.reducedMotion;
      if(patch.notifications)for(const key of ['qc','shipping','suggestions','digest'] as const)if(patch.notifications[key]!==undefined)state.settings.notifications[key]=!!patch.notifications[key];
      result={};break;
    }
    case 'notification.read': {find(state.notifications,p.id,'通知').readAt=context.now;result={id:p.id};break;}
    case 'notification.readAll': {
      const visible = context.visibleNotificationIds === undefined ? undefined : new Set(context.visibleNotificationIds);
      state.notifications.forEach(n => { if (!visible || visible.has(n.id)) n.readAt = context.now; });
      result={};break;
    }
    case 'task.complete': {find(state.tasks,p.id,'事项').done=!!p.done;result={id:p.id};break;}
    case 'calendar.save': {
      const id=p.id||context.id();if(p.id)find(state.calendar,id,'日程');
      if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.time))throw new MistCommandError('VALIDATION','时间无效');
      state.calendar=state.calendar.filter(e=>e.id!==id);state.calendar.push({id,title:text(p.title,'日程'),date:date(p.date),time:p.time,note:text(p.note,'说明',false),...(p.target?{target:p.target}:{})});result={id};break;
    }
    case 'files.add': {
      const f=p.file;
      text(f.id,'文件ID',true,120);text(f.name,'文件名',true,240);text(f.mimeType,'文件类型',true,160);
      if(!/^[A-Za-z0-9/_-]+$/.test(f.storageKey)||f.storageKey.includes('..')||!Number.isSafeInteger(f.size)||f.size<0||f.size>50*1024*1024)throw new MistCommandError('VALIDATION','文件信息无效');
      if(state.files.some(x=>x.id===f.id))throw new MistCommandError('CONFLICT','文件已存在',409);state.files.push({...f});result={id:f.id,fileId:f.id};break;
    }
    default: throw new MistCommandError('VALIDATION','未知操作');
  }
  recalculate(state);
  syncDevelopmentBilling(state,context);
  return {state,result};
}

/** Read-time additive defaults preserve existing records; the next command persists them. */
export function normalizeMistState(state:MistState,context:MistContext):void {
  const eventLabels:Record<string,string>={
    'market.supplier.save':'保存供应商档案','market.supplier.status':'更新供应商合作状态',
    'market.relation.save':'保存关系档案','market.contact.save':'保存联系人',
    'market.product.save':'保存数字档案','market.product.fromVersion':'从确认版本建立数字档案',
    'market.quotation.feedback.add':'追加报价客户反馈','market.quotation.costing.save':'保存报价条目专业核算','market.quotation.save':'保存报价草稿','market.quotation.submit':'提交报价审批',
    'market.quotation.decide':'记录报价审批决定','market.quotation.send':'记录报价交付',
    'market.quotation.respond':'记录客户报价答复','market.quotation.convert':'报价转为订单','market.quotation.skipLines':'报价条目标记不再转','market.quotation.document':'生成报价单',
    'market.season.save':'保存季节规划','market.season.review':'记录季节回顾',
    'market.trend.save':'保存趋势资料','market.show.save':'保存展会资料',
    'market.campaign.save':'保存营销活动','market.lead.save':'保存线索',
    'market.lead.convert':'线索转为客户','market.lookbook.save':'保存画册资料',
    'market.attachment.set':'关联业务附件'
  };
  for(const event of state.events||[])if(eventLabels[event.text])event.text=eventLabels[event.text];
  if(!Array.isArray(state.rounds))state.rounds=[];
  const defaults={fulfillment:createFulfillmentState(context,state),market:createMarketState(context,state),platform:createPlatformState(context,state),email:createEmailState(context,state),crm:createCrmState(context,state),orderFunding:createOrderFundingState(context,state),payables:createPayablesState(context,state)};
  for(const name of ['fulfillment','market','platform','email','crm','orderFunding','payables'] as const){
    if(!state[name]) (state as any)[name]=defaults[name];
    else for(const [key,value] of Object.entries(defaults[name])) if((state[name] as any)[key]===undefined)(state[name] as any)[key]=structuredClone(value);
  }
  backfillQuoteLineFamilies(state,state.market);
  recalculate(state);
}
export function getMistReviewTasks(state:MistState):MistReviewTask[]{return [...getOrderGovernanceReviews(state),...getFulfillmentReviews(state),...getMarketReviews(state),...getPlatformReviews(state),...getPayableReviews(state)];}
export { renderDemoFile } from './mistDemoFiles';

/** 线索一键转 CRM：选已有客户或按线索公司新建客户（含联系人），可同时建立商机；整个过程在同一次命令内完成，任一步失败都不落库。 */
function convertLeadToCrm(state:MistState,p:Extract<MarketCommand,{type:'market.lead.convertToCrm'}>['payload'],context:MistContext):MistCommandResult{
  const lead=state.market.leads.find(l=>l.id===p?.id);if(!lead)throw new MistCommandError('NOT_FOUND','线索不存在',404);
  if(lead.status==='Converted')throw new MistCommandError('PRECONDITION','线索已转化');if(lead.status==='Lost')throw new MistCommandError('PRECONDITION','已流失的线索请先恢复跟进');
  let customerId=p.customerId||'';
  if(customerId){if(!state.customers.some(c=>c.id===customerId))throw new MistCommandError('NOT_FOUND','客户不存在',404);}
  else{
    const same=state.customers.find(c=>c.name.trim().toLowerCase()===lead.company.trim().toLowerCase());if(same)throw new MistCommandError('CONFLICT',`已有同名客户 ${same.name}（${same.code}），请选择该客户`,409);
    const created=applyMarketCommand(state,{type:'market.customer.create',payload:{input:{name:lead.company,country:'',city:'',industry:'',ownerId:context.actorId||'',grade:'',currency:lead.currency||'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:context.now.slice(0,10)}}},context);customerId=String(created.customerId||created.id);
    applyMarketCommand(state,{type:'market.contact.save',payload:{kind:'customer',parentId:customerId,name:lead.name,role:'',email:lead.email,phone:lead.phone,primary:true}},context);
  }
  let opportunityId='';
  if(p.opportunity){const parent=lead.source==='show'?state.market.shows.find(x=>x.id===lead.parentId)?.name:state.market.campaigns.find(x=>x.id===lead.parentId)?.name;
    const r=applyCrmCommand(state,{type:'crm.opportunity.save',payload:{input:{customerId,title:p.opportunity.title,domain:p.opportunity.domain,amount:p.opportunity.amount,currency:p.opportunity.currency,expectedDate:p.opportunity.expectedDate,ownerId:context.actorId||'',note:`来源线索：${lead.name} · ${lead.company}（${parent||'来源活动'}）\n${lead.demand}`,devIds:[],quotationIds:[],orderIds:[]}}},context);opportunityId=String(r.id);}
  applyMarketCommand(state,{type:'market.lead.transition',payload:{id:lead.id,status:'Converted',customerId,actualValue:'0',note:opportunityId?'转为 CRM 客户并建立商机':'转为 CRM 客户'}},context);
  const row=state.market.leads.find(l=>l.id===lead.id)!;if(opportunityId)row.opportunityId=opportunityId;
  return {id:lead.id,customerId,opportunityId};
}
