/** 公司银行账户台账：登记账户与期初、逐笔流水归属账户。余额 = 期初 + 已归属到账 − 已归属付款，按原币，不折算汇率。 */
import React from 'react';
import { Banner, Button, Dialog, Field, FormGrid, Select, TextInput, useToast } from '../../../../components/mist';
import { MIST_FINANCE_SCOPES } from '../../../../server/src/shared/mistFinancePermissions';
import { mistCommandPermission, type MistBankAccount, type MistCommand, type MistPayment, type MistReceipt, type MistState } from '../../../../server/src/shared/mistWorkspace';
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
