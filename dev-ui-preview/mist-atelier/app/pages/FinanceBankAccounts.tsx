/** 公司银行账户台账：登记账户与期初、逐笔流水归属账户。余额 = 期初 + 已归属到账 − 已归属付款，按原币，不折算汇率。 */
import React from 'react';
import { Banner, Button, Card, CardHeader, DataTable, Dialog, EmptyState, Field, FormGrid, Pill, Select, TextInput, useToast } from '../../../../components/mist';
import { FX_REVAL_KIND_LABEL, fxPrevMonth, fxRevaluationPreview, readFxPeriodRates, readFxRevaluations, type FxPeriodRate, type FxRevalLine, type FxRevaluation } from '../../../../server/src/shared/mistFxRates';
import { ModuleEditorDialog, type ModuleEditorSpec } from './modules/ModuleWorkbench';
import { MIST_FINANCE_SCOPES } from '../../../../server/src/shared/mistFinancePermissions';
import { mistCommandPermission, mistFxLockUsage, mistFxRate, type MistBankAccount, type MistCommand, type MistFxRecord, type MistPayment, type MistReceipt, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistSession } from '../runtime/auth';

export const bankMoney = (amount: number, currency: string) => `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
export const accountLabel = (a: MistBankAccount) => `${a.name} · ${a.bankName} 尾号 ${a.accountNo.slice(-4)}`;

/** 财务账户动作的执行器：先按命令权限拦截，失败信息留在弹窗里。 */
export function useBankAccountCommand() {
  const { run, loading, saving, pending } = useMistWorkspace(), session = useMistSession();
  const [working, setWorking] = React.useState(false), [failure, setFailure] = React.useState('');
  const busy = working || loading || saving || !!pending, canWrite = session.hasPermission(MIST_FINANCE_SCOPES.voucher);
  const execute = async (command: MistCommand, done: () => void) => {
    const permission = mistCommandPermission(command);
    if (permission && !session.hasPermission(permission as any)) { setFailure('没有办理此项财务动作的权限。'); return; }
    if (busy) return; setWorking(true); setFailure('');
    try { await run(command); done(); } catch (problem) { setFailure(problem instanceof Error ? problem.message : '操作失败，请重试'); } finally { setWorking(false); }
  };
  return { execute, busy, failure, setFailure, canWrite };
}

type AccountDraft = { id?: string; name: string; bankName: string; accountNo: string; currency: string; openingDate: string; openingBalance: string };
export const newAccountDraft = (): AccountDraft => ({ name: '', bankName: '', accountNo: '', currency: 'USD', openingDate: platformBusinessDate(new Date()), openingBalance: '' });
export const editAccountDraft = (a: MistBankAccount): AccountDraft => ({ id: a.id, name: a.name, bankName: a.bankName, accountNo: a.accountNo, currency: a.currency, openingDate: a.openingDate, openingBalance: String(a.openingBalance) });

export function BankAccountDialog({ draft, used, onClose }: { draft: AccountDraft; used: boolean; onClose: () => void }) {
  const { execute, busy, failure, canWrite } = useBankAccountCommand(), toast = useToast();
  const [form, setForm] = React.useState(draft), [local, setLocal] = React.useState('');
  const set = (key: keyof AccountDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const submit = () => {
    const opening = Number(form.openingBalance);
    if (!form.name.trim() || !form.bankName.trim() || !form.accountNo.trim()) return setLocal('请填写账户名称、开户行和银行账号。');
    if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) return setLocal('币种请填三位代码，如 USD、CNY。');
    if (!form.openingBalance.trim() || !Number.isFinite(opening) || !/^-?\d+(\.\d{1,2})?$/.test(form.openingBalance.trim())) return setLocal('期初余额请填最多两位小数的金额（透支可填负数）。');
    setLocal('');
    void execute({ type: 'finance.account.save', payload: { ...(form.id ? { id: form.id } : {}), name: form.name, bankName: form.bankName, accountNo: form.accountNo, currency: form.currency.trim().toUpperCase(), openingDate: form.openingDate, openingBalance: opening } }, () => { toast(form.id ? '账户已更新' : '账户已登记，可把流水归属到该账户'); onClose(); });
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={640} title={form.id ? '编辑银行账户' : '新增银行账户'} description="一个账户一个币种。期初余额为期初日期当天开始前的银行余额，期初日之前的流水不能归属到该账户。"
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canWrite} onClick={submit}>保存账户</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能保存">{message}</Banner>}
      {!canWrite && <Banner tone="warn" title="只读">需要付款凭证权限才能维护账户。</Banner>}
      {used && <Banner title="已有流水归属">币种、期初日期和期初余额已锁定；如需更正，先解除相关流水的账户归属。</Banner>}
      <FormGrid>
        <Field label="账户名称" required><TextInput aria-label="账户名称" value={form.name} onChange={set('name')} placeholder="如 美元收款户" /></Field>
        <Field label="开户行" required><TextInput aria-label="开户行" value={form.bankName} onChange={set('bankName')} /></Field>
        <Field label="银行账号" required><TextInput aria-label="银行账号" value={form.accountNo} onChange={set('accountNo')} /></Field>
        <Field label="币种" required><TextInput aria-label="币种" value={form.currency} disabled={used} onChange={set('currency')} /></Field>
        <Field label="期初日期" required><TextInput aria-label="期初日期" type="date" value={form.openingDate} disabled={used} onChange={set('openingDate')} /></Field>
        <Field label="期初余额" required hint="按银行对账单填写原币金额"><TextInput aria-label="期初余额" type="number" step="0.01" value={form.openingBalance} disabled={used} onChange={set('openingBalance')} /></Field>
      </FormGrid>
    </div>
  </Dialog>;
}

/** 流水归属账户：只列同币种、期初日不晚于交易日的账户；改归属或解除须写原因。 */
export function AccountAssignDialog({ state, kind, row, onClose }: { state: MistState; kind: 'receipt' | 'payment'; row: MistReceipt | MistPayment; onClose: () => void }) {
  const { execute, busy, failure, canWrite } = useBankAccountCommand(), toast = useToast();
  const options = (state.bankAccounts || []).filter(a => !a.closed && a.currency === row.currency && a.openingDate <= row.date);
  const [accountId, setAccountId] = React.useState(row.accountId || options[0]?.id || ''), [reason, setReason] = React.useState(''), [local, setLocal] = React.useState('');
  const changing = !!row.accountId, same = (row.accountId || '') === accountId;
  const submit = () => {
    if (same) return setLocal(accountId ? '该流水已归属此账户。' : '请选择账户。');
    if (changing && !reason.trim()) return setLocal('调整或解除已有归属须写原因。');
    setLocal('');
    void execute({ type: 'finance.account.assign', payload: { kind, id: row.id, accountId: accountId || null, ...(reason.trim() ? { reason } : {}) } }, () => { toast(accountId ? '已归属账户，余额已重算' : '已解除账户归属'); onClose(); });
  };
  const message = local || failure;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={560} title="归属公司银行账户" description={`${row.code} · ${row.date} · ${bankMoney(row.amount, row.currency)}`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canWrite || (!options.length && !changing)} onClick={submit}>{accountId || !changing ? '确认归属' : '解除归属'}</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能保存">{message}</Banner>}
      {!options.length && <Banner tone="warn" title={`没有可用的 ${row.currency} 账户`}>请先在“账户与余额”新增 {row.currency} 账户，且期初日期不晚于 {row.date}。</Banner>}
      <FormGrid>
        <Field label="银行账户" required><Select aria-label="银行账户" value={accountId} options={[...(changing ? [{ value: '', label: '解除归属' }] : []), ...options.map(a => ({ value: a.id, label: `${a.code} · ${accountLabel(a)}` }))]} onChange={e => setAccountId(e.target.value)} /></Field>
        {changing && <Field label="调整原因" required><TextInput aria-label="调整原因" value={reason} onChange={e => setReason(e.target.value)} /></Field>}
      </FormGrid>
    </div>
  </Dialog>;
}

type FxDraft = { kind: 'lock' | 'settlement'; date: string; bankName: string; currency: string; amount: string; rate: string; localCurrency: string; settleBy: string; ref: string; note: string; fromAccountId: string; toAccountId: string; localAmount: string; lockId: string };
export const newFxDraft = (kind: 'lock' | 'settlement', state: MistState | null, lockId = ''): FxDraft => {
  const lock = (state?.fxRecords || []).find(r => r.id === lockId), accounts = (state?.bankAccounts || []).filter(a => !a.closed);
  const from = accounts.find(a => a.currency === (lock?.currency || 'USD')) || accounts.find(a => a.currency !== 'CNY'), to = accounts.find(a => a.currency === (lock?.localCurrency || 'CNY') && a.id !== from?.id);
  return { kind, date: platformBusinessDate(new Date()), bankName: lock?.bankName || from?.bankName || '', currency: lock?.currency || from?.currency || 'USD', amount: '', rate: '', localCurrency: lock?.localCurrency || 'CNY', settleBy: '', ref: '', note: '', fromAccountId: from?.id || '', toAccountId: to?.id || '', localAmount: '', lockId };
};
const amountOk = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;

/** 锁汇：登记银行远期合同；结汇：按银行水单登记卖出原币与入账本币，汇率由实际金额得出。 */
export function FxDialog({ state, draft, onClose }: { state: MistState; draft: FxDraft; onClose: () => void }) {
  const { execute, busy, failure, canWrite } = useBankAccountCommand(), toast = useToast();
  const [form, setForm] = React.useState(draft), [local, setLocal] = React.useState('');
  const set = (key: keyof FxDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: e.target.value });
  const accounts = state.bankAccounts || [], from = accounts.find(a => a.id === form.fromAccountId), to = accounts.find(a => a.id === form.toAccountId);
  const locks = (state.fxRecords || []).filter(r => r.kind === 'lock' && !r.reversed && (!from || r.currency === from.currency) && (!to || r.localCurrency === to.currency)).map(r => ({ r, left: mistFxLockUsage(state, r.id).remaining })).filter(x => x.left > 0);
  const settle = form.kind === 'settlement', derived = settle && amountOk(form.amount) && amountOk(form.localAmount) ? mistFxRate(Number(form.amount), Number(form.localAmount)) : '';
  const submit = () => {
    if (!amountOk(form.amount)) return setLocal('原币金额请填正数，最多两位小数。');
    if (!form.ref.trim()) return setLocal(settle ? '请填写银行水单号。' : '请填写锁汇合同号。');
    if (settle) {
      if (!from || !to) return setLocal('请选择卖出账户和入账账户。');
      if (!amountOk(form.localAmount)) return setLocal('入账本币金额请按银行水单填写。');
      setLocal('');
      void execute({ type: 'finance.fx.settle', payload: { date: form.date, fromAccountId: from.id, toAccountId: to.id, amount: Number(form.amount), localAmount: Number(form.localAmount), ref: form.ref, note: form.note, ...(form.lockId ? { lockId: form.lockId } : {}) } }, () => { toast('结汇已登记，两个账户余额已更新'); onClose(); });
      return;
    }
    if (!form.bankName.trim()) return setLocal('请填写锁汇银行。');
    if (!/^\d{1,6}(\.\d{1,6})?$/.test(form.rate.trim()) || !(Number(form.rate) > 0)) return setLocal('锁定汇率请按合同填写，最多 6 位小数。');
    if (!form.settleBy) return setLocal('请填写交割截止日。');
    setLocal('');
    void execute({ type: 'finance.fx.lock', payload: { date: form.date, bankName: form.bankName, currency: form.currency.trim().toUpperCase(), amount: Number(form.amount), rate: form.rate.trim(), localCurrency: form.localCurrency.trim().toUpperCase(), settleBy: form.settleBy, ref: form.ref, note: form.note } }, () => { toast('锁汇已登记'); onClose(); });
  };
  const message = local || failure, accountOptions = (pick: (a: MistBankAccount) => boolean) => [{ value: '', label: '请选择账户' }, ...accounts.filter(a => !a.closed && pick(a)).map(a => ({ value: a.id, label: `${a.code} · ${a.currency} · ${accountLabel(a)}` }))];
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={680} title={settle ? '登记结汇' : '登记锁汇'} description={settle ? '按银行结汇水单登记实际卖出的原币和入账本币；汇率由两笔金额得出，不估算。' : '登记与银行签订的远期锁汇合同；锁汇本身不改变账户余额，交割时另登记结汇。'}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canWrite} onClick={submit}>{settle ? '保存结汇' : '保存锁汇'}</Button></>}>
    <div className="mist-col">
      {message && <Banner tone="bad" title="还不能保存">{message}</Banner>}
      {!canWrite && <Banner tone="warn" title="只读">需要付款凭证权限才能登记。</Banner>}
      <FormGrid>
        <Field label={settle ? '结汇日期' : '锁汇日期'} required><TextInput aria-label={settle ? '结汇日期' : '锁汇日期'} type="date" value={form.date} onChange={set('date')} /></Field>
        <Field label={settle ? '银行水单号' : '锁汇合同号'} required><TextInput aria-label={settle ? '银行水单号' : '锁汇合同号'} value={form.ref} onChange={set('ref')} /></Field>
        {settle ? <>
          <Field label="卖出账户（原币）" required><Select aria-label="卖出账户" value={form.fromAccountId} options={accountOptions(() => true)} onChange={set('fromAccountId')} /></Field>
          <Field label="入账账户（本币）" required><Select aria-label="入账账户" value={form.toAccountId} options={accountOptions(a => !from || a.currency !== from.currency)} onChange={set('toAccountId')} /></Field>
          <Field label={`卖出原币金额${from ? '（' + from.currency + '）' : ''}`} required><TextInput aria-label="卖出原币金额" type="number" step="0.01" value={form.amount} onChange={set('amount')} /></Field>
          <Field label={`入账本币金额${to ? '（' + to.currency + '）' : ''}`} required hint={derived ? `成交汇率 ${derived}` : '按水单填写'}><TextInput aria-label="入账本币金额" type="number" step="0.01" value={form.localAmount} onChange={set('localAmount')} /></Field>
          <Field label="交割锁汇合同"><Select aria-label="交割锁汇合同" value={form.lockId} options={[{ value: '', label: '不对应锁汇（即期结汇）' }, ...locks.map(({ r, left }) => ({ value: r.id, label: `${r.code} · ${r.ref} · @${r.rate} · 剩余 ${bankMoney(left, r.currency)}` }))]} onChange={set('lockId')} /></Field>
        </> : <>
          <Field label="锁汇银行" required><TextInput aria-label="锁汇银行" value={form.bankName} onChange={set('bankName')} /></Field>
          <Field label="原币币种" required><TextInput aria-label="原币币种" value={form.currency} onChange={set('currency')} /></Field>
          <Field label="原币金额" required><TextInput aria-label="原币金额" type="number" step="0.01" value={form.amount} onChange={set('amount')} /></Field>
          <Field label="锁定汇率" required hint="1 单位原币兑本币，按合同填写"><TextInput aria-label="锁定汇率" value={form.rate} onChange={set('rate')} /></Field>
          <Field label="本币币种" required><TextInput aria-label="本币币种" value={form.localCurrency} onChange={set('localCurrency')} /></Field>
          <Field label="交割截止日" required><TextInput aria-label="交割截止日" type="date" value={form.settleBy} onChange={set('settleBy')} /></Field>
        </>}
        <Field label="备注" full><TextInput aria-label="备注" value={form.note} onChange={set('note')} /></Field>
      </FormGrid>
    </div>
  </Dialog>;
}

export function FxReverseDialog({ record, onClose }: { record: MistFxRecord; onClose: () => void }) {
  const { execute, busy, failure, canWrite } = useBankAccountCommand(), toast = useToast();
  const [reason, setReason] = React.useState(''), [local, setLocal] = React.useState('');
  const submit = () => { if (!reason.trim()) return setLocal('请填写冲回原因。'); setLocal(''); void execute({ type: 'finance.fx.reverse', payload: { id: record.id, reason } }, () => { toast(record.code + ' 已冲回，原记录保留'); onClose(); }); };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} width={520} title={record.kind === 'lock' ? '冲回锁汇' : '冲回结汇'} description={`${record.code} · ${record.ref} · ${bankMoney(record.amount, record.currency)} → ${bankMoney(record.localAmount, record.localCurrency)}。原记录保留${record.kind === 'settlement' ? '，两个账户余额恢复' : ''}。`}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={busy || !canWrite} onClick={submit}>确认冲回</Button></>}>
    <div className="mist-col">
      {(local || failure) && <Banner tone="bad" title="还不能冲回">{local || failure}</Banner>}
      <Field label="冲回原因" required><TextInput aria-label="冲回原因" value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </div>
  </Dialog>;
}

/** 月末汇率（报表暂估用）：每月每币种一条，依据必填；登错作废后重登。报表“月末暂估”口径取不晚于所选月份的最新一期。 */
export function FxPeriodRatesCard() {
  const { state, run, loading, saving, pending } = useMistWorkspace(), session = useMistSession();
  const canWrite = session.hasPermission(MIST_FINANCE_SCOPES.voucher), busy = loading || saving || !!pending;
  const [spec, setSpec] = React.useState<ModuleEditorSpec | null>(null);
  const rows = [...readFxPeriodRates(state || {})].sort((a, b) => Number(!!a.voided) - Number(!!b.voided) || b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency));
  const currencies = [...new Set([...(state?.orders || []).map(o => o.currency), ...(state?.bankAccounts || []).map(a => a.currency)])].filter(c => c && c !== 'CNY').sort();
  const lastMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const add: ModuleEditorSpec = { title: '登记月末汇率', submitLabel: '登记', description: '用于报表“月末暂估”折算；通常取中国人民银行月末中间价或开户行月末牌价。每月每币种一条。',
    fields: [{ key: 'month', label: '月份（YYYY-MM）', type: 'text', required: true }, { key: 'currency', label: '币种', type: 'select', required: true, options: (currencies.length ? currencies : ['USD', 'EUR']).map(c => ({ value: c, label: c })) },
      { key: 'rate', label: '汇率（1 单位外币兑人民币）', type: 'text', required: true, hint: '最多 6 位小数，如 7.1234' }, { key: 'source', label: '依据', type: 'text', required: true, hint: '如：人民银行 2026-09-30 中间价' }],
    initialValues: { month: lastMonth, currency: currencies[0] || 'USD', rate: '', source: '' },
    submit: v => run({ type: 'fxrate.period.save', payload: { month: String(v.month || ''), currency: String(v.currency || ''), rate: String(v.rate || '').trim(), source: String(v.source || '') } }) };
  const voidSpec = (r: FxPeriodRate): ModuleEditorSpec => ({ title: `作废 ${r.month} ${r.currency} 月末汇率`, submitLabel: '作废', description: '作废后保留记录，可重新登记正确汇率。', fields: [{ key: 'reason', label: '作废原因', type: 'textarea', required: true }], initialValues: { reason: '' },
    submit: v => run({ type: 'fxrate.period.void', payload: { id: r.id, reason: String(v.reason || '') } }) });
  return <Card>
    <CardHeader title={`月末汇率 · ${rows.filter(r => !r.voided).length}`} sub="报表“月末暂估”口径用；结汇实际汇率另按结汇记录加权。" tools={canWrite ? <Button size="sm" disabled={busy} onClick={() => setSpec(add)}>登记月末汇率</Button> : undefined} />
    <DataTable ariaLabel="月末汇率" rows={rows} rowKey={r => r.id} loading={loading} columns={[
      { key: 'month', header: '月份', width: '100px', render: r => r.month },
      { key: 'currency', header: '币种', width: '72px', render: r => r.currency },
      { key: 'rate', header: '汇率', width: '110px', align: 'right', render: r => <span className="mist-num">{r.rate}</span> },
      { key: 'source', header: '依据', width: 'minmax(160px,2fr)', hideOnMobile: true, render: r => <div className="mist-col" style={{ gap: 2 }}><span>{r.source}</span><small className="mist-muted">{r.actor} · {r.createdAt.slice(0, 10)}{r.voided ? ` · 作废：${r.voided.reason}` : ''}</small></div> },
      { key: 'act', header: '', width: '90px', align: 'right', render: r => r.voided ? <Pill tone="neutral">已作废</Pill> : canWrite ? <Button size="sm" disabled={busy} onClick={() => setSpec(voidSpec(r))}>作废</Button> : null },
    ]} empty={<EmptyState title="还没有月末汇率" description="每月初登记上月末各外币汇率，报表即可按月末暂估折算人民币毛利。" compact />} />
    <ModuleEditorDialog spec={spec} onClose={() => setSpec(null)} />
  </Card>;
}

const cny = (v: number) => (v < 0 ? '−' : '') + '¥' + Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gain = (v: number) => <span className="mist-num" style={{ color: v > 0 ? 'var(--mist-ok)' : v < 0 ? 'var(--mist-bad)' : undefined }}>{v > 0 ? '收益 ' : v < 0 ? '损失 ' : ''}{cny(Math.abs(v))}</span>;
function RevalLinesTable({ lines, label }: { lines: FxRevalLine[]; label: string }) {
  return <DataTable ariaLabel={label} rows={lines} rowKey={l => l.kind + l.refId} columns={[
    { key: 'kind', header: '项目', width: '110px', render: l => FX_REVAL_KIND_LABEL[l.kind] },
    { key: 'ref', header: '对象', width: 'minmax(160px,2fr)', render: l => l.ref },
    { key: 'amount', header: '外币余额', width: '130px', align: 'right', render: l => <span className="mist-num">{l.currency} {l.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span> },
    { key: 'rate', header: '记账 → 月末', width: '150px', align: 'right', hideOnMobile: true, render: l => <span className="mist-num" title={l.kind === 'settlement' ? '结汇按记账汇率转出，与实际成交汇率之差为已实现损益' : '月初汇率入账，按月末汇率重估'}>{l.bookRate} → {l.closingRate}{l.kind === 'settlement' ? '（成交）' : ''}</span> },
    { key: 'book', header: '账面人民币', width: '130px', align: 'right', hideOnMobile: true, render: l => <span className="mist-num">{cny(l.bookCny)}</span> },
    { key: 'closing', header: '重估 / 实收', width: '130px', align: 'right', hideOnMobile: true, render: l => <span className="mist-num">{cny(l.closingCny)}</span> },
    { key: 'diff', header: '汇兑损益', width: '140px', align: 'right', render: l => gain(l.diff) },
  ]} empty={<EmptyState title="没有外币项目" compact />} />;
}
/** 期末调汇：月初汇率记账、月末汇率重估外币银行存款 / 应收 / 待核销到账，当月结汇差额计已实现损益。 */
export function FxRevaluationCard() {
  const { state, run, loading, saving, pending } = useMistWorkspace(), session = useMistSession();
  const canWrite = session.hasPermission(MIST_FINANCE_SCOPES.voucher), busy = loading || saving || !!pending;
  const today = platformBusinessDate(new Date()), last = fxPrevMonth(today.slice(0, 7));
  const [month, setMonth] = React.useState(last);
  const [spec, setSpec] = React.useState<ModuleEditorSpec | null>(null);
  const [detail, setDetail] = React.useState<FxRevaluation | null>(null);
  const months = Array.from({ length: 12 }, (_, i) => { let m = today.slice(0, 7); for (let k = 0; k < i; k++) m = fxPrevMonth(m); return m; });
  const view = state ? fxRevaluationPreview(state, month, today) : null;
  const history = [...readFxRevaluations(state || {})].sort((a, b) => Number(!!a.voided) - Number(!!b.voided) || b.month.localeCompare(a.month));
  const post: ModuleEditorSpec | null = view && { title: `登记 ${month} 期末调汇`, submitLabel: '登记', description: `按 ${view.monthEnd} 账面余额冻结明细：未实现 ${cny(view.unrealized)}、结汇已实现 ${cny(view.realized)}，合计 ${cny(view.total)}（正数为收益）。登记后作为外部账务期末调汇凭证依据；有误可作废重登。`,
    fields: [{ key: 'note', label: '备注', type: 'textarea' }], initialValues: { note: '' }, submit: v => run({ type: 'fxrate.reval.post', payload: { month, note: String(v.note || '') } }) };
  const voidSpec = (r: FxRevaluation): ModuleEditorSpec => ({ title: `作废 ${r.month} 期末调汇`, submitLabel: '作废', description: '作废后保留记录，可重新登记；须从最近一期倒着作废。', fields: [{ key: 'reason', label: '作废原因', type: 'textarea', required: true }], initialValues: { reason: '' },
    submit: v => run({ type: 'fxrate.reval.void', payload: { id: r.id, reason: String(v.reason || '') } }) });
  return <Card>
    <CardHeader title="期末调汇 · 汇兑损益" sub="当月外币业务按月初汇率（上月末汇率）入账；月末按本月末汇率重估外币银行存款、外币应收与待核销到账，当月结汇与记账汇率之差为已实现损益。" tools={<span className="mist-row">
      <Select aria-label="调汇月份" value={month} onChange={e => setMonth(e.target.value)} options={months.map(m => ({ value: m, label: m }))} />
      {canWrite && <Button size="sm" disabled={busy || !view || view.blockers.length > 0} onClick={() => post && setSpec(post)}>登记期末调汇</Button>}</span>} />
    <div className="mist-card-body mist-col">
      {view && view.blockers.length > 0 && <Banner tone="warn" title="暂不能登记">{view.blockers.join('；')}</Banner>}
      {view && view.currencies.length > 0 && <div className="mist-row" style={{ flexWrap: 'wrap', gap: 16 }}>{view.currencies.map(c => <span key={c.currency} className="mist-col" style={{ gap: 2 }}><b>{c.currency} · {c.bookRate} → {c.closingRate || '缺月末汇率'}</b><small className="mist-muted">未实现 {cny(c.unrealized)} · 结汇 {cny(c.realized)} · 合计 {cny(c.total)}</small></span>)}</div>}
      {view && <RevalLinesTable lines={view.lines} label={`${month} 期末调汇预览`} />}
      <span className="mist-note">余额按月末截止：银行按流水日期，应收按开票日期、核销按到账日期计入；外币应付暂不纳入（供应商结算为人民币）。须按月连续登记。</span>
    </div>
    <DataTable ariaLabel="已登记期末调汇" rows={history} rowKey={r => r.id} loading={loading} onRowClick={r => setDetail(r)} columns={[
      { key: 'code', header: '记录', width: 'minmax(140px,1fr)', render: r => <div className="mist-col" style={{ gap: 2 }}><span className="mist-num">{r.code} · {r.month}</span><small className="mist-muted">{r.actor} · {r.createdAt.slice(0, 10)}{r.note ? ' · ' + r.note : ''}{r.voided ? ` · 作废：${r.voided.reason}` : ''}</small></div> },
      { key: 'unrealized', header: '未实现', width: '140px', align: 'right', render: r => gain(r.unrealized) },
      { key: 'realized', header: '结汇已实现', width: '140px', align: 'right', hideOnMobile: true, render: r => gain(r.realized) },
      { key: 'total', header: '合计', width: '140px', align: 'right', render: r => gain(r.total) },
      { key: 'act', header: '', width: '90px', align: 'right', render: r => r.voided ? <Pill tone="neutral">已作废</Pill> : canWrite ? <Button size="sm" disabled={busy} onClick={e => { e.stopPropagation(); setSpec(voidSpec(r)); }}>作废</Button> : null },
    ]} empty={<EmptyState title="还没有登记期末调汇" description="每月结账时先登记本月末汇率，再登记期末调汇。" compact />} />
    {detail && <Dialog open onClose={() => setDetail(null)} width={900} title={`${detail.code} · ${detail.month} 期末调汇明细`} description={`截至 ${detail.monthEnd}；登记时冻结，之后的流水变动不影响本记录。合计 ${cny(detail.total)}。`}>
      <RevalLinesTable lines={detail.lines} label="期末调汇明细" />
    </Dialog>}
    <ModuleEditorDialog spec={spec} onClose={() => setSpec(null)} />
  </Card>;
}

/** 账户状态与销户 / 恢复：销户须余额为零、销户日后无流水（服务端校验）。 */
export function AccountStatusCell({ account, balance }: { account: MistBankAccount; balance: number }) {
  const { run, loading, saving, pending } = useMistWorkspace(), session = useMistSession();
  const canWrite = session.hasPermission(MIST_FINANCE_SCOPES.voucher), busy = loading || saving || !!pending;
  const [spec, setSpec] = React.useState<ModuleEditorSpec | null>(null);
  const close: ModuleEditorSpec = { title: `销户 ${account.code} · ${account.name}`, submitLabel: '销户', description: '银行销户后登记。须账户余额为零（先转出余额、登记结息或手续费），销户日之后不能有流水；销户后不再记入新流水、结汇或归属。',
    fields: [{ key: 'date', label: '销户日期', type: 'date', required: true }, { key: 'reason', label: '销户依据', type: 'textarea', required: true, hint: '如：中行销户回执编号' }], initialValues: { date: platformBusinessDate(new Date()), reason: '' },
    submit: v => run({ type: 'finance.account.close', payload: { id: account.id, date: String(v.date || ''), reason: String(v.reason || '') } }) };
  const reopen: ModuleEditorSpec = { title: `恢复 ${account.code}`, submitLabel: '恢复', description: `原销户日 ${account.closed?.date || ''}。仅在银行撤销销户或销户登记有误时恢复。`, fields: [{ key: 'reason', label: '恢复原因', type: 'textarea', required: true }], initialValues: { reason: '' },
    submit: v => run({ type: 'finance.account.reopen', payload: { id: account.id, reason: String(v.reason || '') } }) };
  return <span className="mist-row" onClick={e => e.stopPropagation()}>
    {account.closed ? <Pill tone="neutral">已销户 {account.closed.date}</Pill> : <Pill tone="ok">使用中</Pill>}
    {canWrite && (account.closed ? <Button size="sm" disabled={busy} onClick={() => setSpec(reopen)}>恢复</Button> : <Button size="sm" disabled={busy} title={Math.round(balance * 100) ? '余额须为零才能销户' : undefined} onClick={() => setSpec(close)}>销户</Button>)}
    <ModuleEditorDialog spec={spec} onClose={() => setSpec(null)} />
  </span>;
}
