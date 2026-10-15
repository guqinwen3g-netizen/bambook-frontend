/** 公司银行账户台账：登记账户与期初、逐笔流水归属账户。余额 = 期初 + 已归属到账 − 已归属付款，按原币，不折算汇率。 */
import React from 'react';
import { Banner, Button, Dialog, Field, FormGrid, Select, TextInput, useToast } from '../../../../components/mist';
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
  const options = (state.bankAccounts || []).filter(a => a.currency === row.currency && a.openingDate <= row.date);
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
  const lock = (state?.fxRecords || []).find(r => r.id === lockId), accounts = state?.bankAccounts || [];
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
  const message = local || failure, accountOptions = (pick: (a: MistBankAccount) => boolean) => [{ value: '', label: '请选择账户' }, ...accounts.filter(pick).map(a => ({ value: a.id, label: `${a.code} · ${a.currency} · ${accountLabel(a)}` }))];
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
