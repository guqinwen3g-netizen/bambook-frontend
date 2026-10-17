/** 出口退税：退税率版本、专票配单申报、税务核准、到账勾稽（财务办理）；只登记已发生事实，不代替电子税务局申报。 */
import React from 'react';
import { Ban, BadgeCheck, Landmark, Plus, Receipt, RotateCcw, Undo2 } from 'lucide-react';
import { Card, CardHeader, DataTable, EmptyState, Facts, Mono, Pill, TextLink, type Tone } from '../../../../../components/mist';
import type { MistCommand, MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentCustoms } from '../../../../../server/src/shared/mistFulfillment';
import { REBATE_STATE_LABEL, rebateBillTaxableMinor, rebateCandidateBills, rebateClaimForCustoms, rebateClaimTotals, rebateExportDate, rebateFor, rebateRateFor, readRebate, type RebateClaim, type RebateRate } from '../../../../../server/src/shared/mistExportRebate';
import { fmt } from '../../data';
import type { ModuleEditorSpec } from './ModuleWorkbench';
import { emptyOption, field, number, text, today } from './fulfillmentKit';
import { ActionBar, DetailBlock, type ReasonedAction } from './pageKit';

type Run = (command: MistCommand) => Promise<unknown>;
const cny = (value: number) => `${fmt(value, 2)} CNY`;
export const REBATE_TONE: Record<RebateClaim['state'], Tone> = { filed: 'accent', approved: 'warn', received: 'ok', withdrawn: 'neutral' };

/** 列表用的一行摘要：已申报显示状态与应退额；未申报显示可配专票数。 */
export function rebateSummary(state: MistState, c: FulfillmentCustoms) {
  const claim = rebateClaimForCustoms(state, c.id), candidates = rebateCandidateBills(state, c), exportDate = rebateExportDate(state, c);
  const rate = exportDate ? rebateRateFor(state, c.hsCode, exportDate) : undefined;
  const preview = rate ? candidates.reduce((n, b) => n + rebateFor(rebateBillTaxableMinor(b), rate.rate), 0) / 100 : 0;
  return { claim, candidates, exportDate, rate, preview, vatReady: !!claim || candidates.length > 0 };
}

export function RebateRatesCard({ state, canWrite, locked, open, run }: { state: MistState; canWrite: boolean; locked: boolean; open: (spec: ModuleEditorSpec) => void; run: Run }) {
  const rates = [...readRebate(state).rates].sort((a, b) => Number(!!a.voided) - Number(!!b.voided) || a.hsCode.localeCompare(b.hsCode) || b.effectiveFrom.localeCompare(a.effectiveFrom));
  const used = new Set(readRebate(state).claims.filter(c => c.state !== 'withdrawn').map(c => c.rateId));
  const add: ModuleEditorSpec = { title: '登记退税率版本', submitLabel: '登记', description: '按出口退税率文库或财政部 / 税务总局公告登记；同一编码调整税率时另登记新版本，按报关单出口日期自动适用。',
    fields: [{ ...field('hsCode', 'HS 编码'), hint: '4–10 位，可只登记前 6 或 8 位，按最长前缀匹配。' }, { ...field('rate', '退税率（%）'), hint: '如 13、9；0 表示不退税。' }, field('effectiveFrom', '生效日（按出口日期）', 'date'), field('basis', '依据（公告文号 / 文库版本）')],
    initialValues: { hsCode: '', rate: '13', effectiveFrom: today(), basis: '' },
    submit: v => run({ type: 'rebate.rate.save', payload: { hsCode: text(v, 'hsCode'), rate: text(v, 'rate'), effectiveFrom: text(v, 'effectiveFrom'), basis: text(v, 'basis') } }) };
  const voidSpec = (r: RebateRate): ModuleEditorSpec => ({ title: `作废 HS ${r.hsCode} · ${r.rate}%`, submitLabel: '作废', description: '只能作废尚未被申报使用的版本；作废后保留记录。', fields: [field('reason', '作废原因', 'textarea')], initialValues: { reason: '' },
    submit: v => run({ type: 'rebate.rate.void', payload: { id: r.id, reason: text(v, 'reason') } }) });
  return <Card>
    <CardHeader title={`退税率版本 · ${rates.filter(r => !r.voided).length}`} sub="按 HS 编码与生效日适用；登记有误的版本在使用前作废。"
      tools={canWrite ? <TextLink icon={Plus} onClick={() => { if (!locked) open(add); }}>登记退税率</TextLink> : undefined} />
    <DataTable ariaLabel="退税率版本" rows={rates} rowKey={r => r.id} empty={<EmptyState icon={Landmark} title="还没有退税率" description="财务登记报关 HS 编码的退税率后，系统按出口日期计算应退税额。" compact />} columns={[
      { key: 'hs', header: 'HS 编码', width: '120px', render: r => <Mono>{r.hsCode}</Mono> },
      { key: 'rate', header: '退税率', width: '80px', align: 'right', render: r => `${r.rate}%` },
      { key: 'from', header: '生效日', width: '110px', render: r => r.effectiveFrom },
      { key: 'basis', header: '依据', width: 'minmax(160px,2fr)', hideOnMobile: true, render: r => <div className="mist-col" style={{ gap: 2 }}><span>{r.basis}</span>{r.voided && <small className="mist-muted">作废：{r.voided.reason}</small>}</div> },
      { key: 'state', header: '状态', width: '96px', render: r => r.voided ? <Pill>已作废</Pill> : used.has(r.id) ? <Pill tone="ok">已使用</Pill> : <Pill tone="accent">有效</Pill> },
      ...(canWrite ? [{ key: 'act', header: '', width: '80px', align: 'right' as const, render: (r: RebateRate) => !r.voided && !used.has(r.id) ? <TextLink icon={Ban} onClick={() => { if (!locked) open(voidSpec(r)); }}>作废</TextLink> : null }] : []),
    ]} />
  </Card>;
}

export function RebateClaimBlock({ state, customs: c, canWrite, canReconcile, locked, open, run, onBill, onReceipt }: {
  state: MistState; customs: FulfillmentCustoms; canWrite: boolean; canReconcile: boolean; locked: boolean; open: (spec: ModuleEditorSpec) => void; run: Run; onBill?: (id: string) => void; onReceipt?: (id: string) => void;
}) {
  const { claim, candidates, exportDate, rate, preview } = rebateSummary(state, c);
  if (!claim) {
    const reason = !canWrite ? '需要财务开票权限' : c.status !== 'cleared' ? '报关单尚未海关放行' : !exportDate ? '出运尚未登记实际离港（出口日期）' : !rate ? `没有适用于 HS ${c.hsCode} 的退税率，请先登记退税率版本` : Number(rate.rate) <= 0 ? '适用退税率为 0' : !candidates.length ? '没有可配单的增值税专用发票（本票订单的人民币专票，财务在应付登记）' : false;
    const fileSpec: ModuleEditorSpec = { title: `登记退税申报 · 报关单 ${c.declarationNo}`, submitLabel: '登记申报',
      description: `出口日期 ${exportDate} · HS ${c.hsCode} 适用 ${rate?.rate}%（${rate?.basis}）。勾选本次配单的增值税专用发票；应退税额 = 计税金额 × 退税率。在电子税务局申报后再登记。`,
      fields: [...candidates.map(b => ({ ...field('bill:' + b.id, `${b.invoiceNo} · ${b.supplier} · 计税 ${cny(rebateBillTaxableMinor(b) / 100)} → 退 ${cny(rebateFor(rebateBillTaxableMinor(b), rate?.rate || '0') / 100)}`, 'checkbox', false) })),
        field('filedAt', '申报日', 'date'), field('batchRef', '申报批次号 / 受理回执号'), field('note', '备注', 'textarea', false)],
      initialValues: { ...Object.fromEntries(candidates.map(b => ['bill:' + b.id, true])), filedAt: today(), batchRef: '', note: '' },
      submit: v => run({ type: 'rebate.claim.file', payload: { customsId: c.id, billIds: candidates.filter(b => v['bill:' + b.id] === true).map(b => b.id), filedAt: text(v, 'filedAt'), batchRef: text(v, 'batchRef'), note: text(v, 'note') } }) };
    return <DetailBlock title="退税申报" aside={<span className="mist-muted">未申报</span>}>
      <Facts items={[
        { label: '出口日期', value: exportDate || '未离港' },
        { label: '适用退税率', value: rate ? `${rate.rate}% · ${rate.effectiveFrom} 起` : '未登记' },
        { label: '可配专票', value: `${candidates.length} 张` },
        { label: '预计应退', value: rate && candidates.length ? cny(preview) : '—' },
      ]} />
      {candidates.length > 0 && <DataTable ariaLabel={`${c.code} 可配专票`} rows={candidates} rowKey={b => b.id} columns={[
        { key: 'no', header: '发票号', render: b => onBill ? <TextLink onClick={() => onBill(b.id)}>{b.invoiceNo}</TextLink> : <Mono>{b.invoiceNo}</Mono> },
        { key: 'supplier', header: '供应商', hideOnMobile: true, render: b => b.supplier },
        { key: 'taxable', header: '计税金额', align: 'right', render: b => cny(rebateBillTaxableMinor(b) / 100) },
      ]} />}
      <ActionBar busy={locked} actions={[{ label: '登记退税申报', icon: Receipt, primary: true, onClick: () => open(fileSpec), reason: reason }] as ReasonedAction[]} />
    </DetailBlock>;
  }
  const totals = rebateClaimTotals(claim), live = claim.receipts.filter(r => !r.reversed);
  const receipts = state.receipts.filter(r => r.currency === 'CNY' && r.remaining > 0);
  const approveSpec: ModuleEditorSpec = { title: `登记税务核准 · ${claim.code}`, submitLabel: '登记核准', description: `应退税额 ${cny(claim.expected)}。按税务机关审核通知登记核准额；与应退不同须写原因。`,
    fields: [field('date', '核准日', 'date'), field('amount', '核准退税额（CNY）', 'number'), field('ref', '审核通知 / 批复文号'), field('reason', '差异原因（核准额不同时必填）', 'textarea', false)],
    initialValues: { date: today(), amount: claim.expected, ref: '', reason: '' },
    submit: v => run({ type: 'rebate.claim.approve', payload: { id: claim.id, date: text(v, 'date'), amount: number(v, 'amount'), ref: text(v, 'ref'), reason: text(v, 'reason') } }) };
  const receiveSpec: ModuleEditorSpec = { title: `退税到账勾稽 · ${claim.code}`, submitLabel: '勾稽到账', description: `待到账 ${cny(totals.open)}。退税款须先按银行水单导入到账流水；勾稽会占用该笔流水余额。`,
    fields: [field('receiptId', '到账流水（人民币）', 'select', true, [emptyOption, ...receipts.map(r => ({ value: r.id, label: `${r.code} · ${r.date.slice(0, 10)} · ${r.payer} · 余 ${cny(r.remaining)}` }))]), field('amount', '勾稽金额（CNY）', 'number'),
      { ...field('settle', '少收也按本次结清', 'checkbox', false), hint: '税务机关扣抵等原因到账少于核准额时勾选，并写明原因。' }, field('reason', '少收原因', 'textarea', false)],
    initialValues: { receiptId: '', amount: totals.open, settle: false, reason: '' },
    submit: v => run({ type: 'rebate.claim.receive', payload: { id: claim.id, receiptId: text(v, 'receiptId'), amount: number(v, 'amount'), settle: v.settle === true, ...(text(v, 'reason') ? { reason: text(v, 'reason') } : {}) } }) };
  const withdrawSpec: ModuleEditorSpec = { title: `撤回退税申报 · ${claim.code}`, submitLabel: '撤回', description: '撤回后发票与报关单释放，可重新配单申报。', fields: [field('reason', '撤回原因', 'textarea')], initialValues: { reason: '' },
    submit: v => run({ type: 'rebate.claim.withdraw', payload: { id: claim.id, reason: text(v, 'reason') } }) };
  const reverseSpec = (entryId: string, code: string): ModuleEditorSpec => ({ title: `冲回到账勾稽 · ${code}`, submitLabel: '冲回', description: '冲回后释放流水余额，原记录保留。', fields: [field('reason', '冲回原因', 'textarea')], initialValues: { reason: '' },
    submit: v => run({ type: 'rebate.claim.reverseReceipt', payload: { id: claim.id, entryId, reason: text(v, 'reason') } }) });
  const done = claim.state === 'received';
  return <DetailBlock title="退税申报" aside={<Pill tone={REBATE_TONE[claim.state]}>{REBATE_STATE_LABEL[claim.state]}</Pill>}>
    <Facts items={[
      { label: '申报', value: `${claim.code} · ${claim.batchRef}` },
      { label: '申报日 / 出口日期', value: `${claim.filedAt} / ${claim.exportDate}` },
      { label: '退税率', value: `${claim.rate}%（HS ${claim.hsCode}）` },
      { label: '计税金额', value: cny(claim.taxable) },
      { label: '应退税额', value: cny(claim.expected) },
      { label: '核准退税额', value: claim.approved ? `${cny(claim.approved.amount)} · ${claim.approved.ref}` : '待税务审核' },
      { label: '已到账', value: cny(totals.received) },
      { label: '待到账', value: done ? '已结清' : cny(totals.open) },
    ]} />
    {claim.approved?.reason && <p className="mist-sub">核准差异：{claim.approved.reason}</p>}
    {claim.settled && <p className="mist-sub">少收结清：{claim.settled.reason}（较应退 {cny(totals.difference)}）</p>}
    <DataTable ariaLabel={`${claim.code} 配单专票`} rows={claim.lines} rowKey={l => l.billId} columns={[
      { key: 'no', header: '专票', render: l => onBill ? <TextLink onClick={() => onBill(l.billId)}>{l.invoiceNo}</TextLink> : <Mono>{l.invoiceNo}</Mono> },
      { key: 'supplier', header: '供应商', hideOnMobile: true, render: l => l.supplier },
      { key: 'taxable', header: '计税金额', align: 'right', render: l => cny(l.taxable) },
      { key: 'rebate', header: '应退', align: 'right', render: l => cny(l.rebate) },
    ]} />
    {claim.receipts.length > 0 && <DataTable ariaLabel={`${claim.code} 到账勾稽`} rows={claim.receipts} rowKey={r => r.id} columns={[
      { key: 'receipt', header: '到账流水', render: r => onReceipt ? <TextLink onClick={() => onReceipt(r.receiptId)}>{r.receiptCode}</TextLink> : <Mono>{r.receiptCode}</Mono> },
      { key: 'date', header: '到账日', render: r => r.date },
      { key: 'amount', header: '金额', align: 'right', render: r => r.reversed ? <span className="mist-muted"><s>{cny(r.amount)}</s> 已冲回</span> : cny(r.amount) },
      ...(canReconcile ? [{ key: 'act', header: '', width: '72px', align: 'right' as const, render: (r: RebateClaim['receipts'][number]) => !r.reversed ? <TextLink icon={RotateCcw} onClick={() => { if (!locked) open(reverseSpec(r.id, r.receiptCode)); }}>冲回</TextLink> : null }] : []),
    ]} />}
    {claim.state !== 'withdrawn' && <ActionBar busy={locked} actions={[
      { label: '登记税务核准', icon: BadgeCheck, primary: claim.state === 'filed', onClick: () => open(approveSpec), reason: !canWrite ? '需要财务开票权限' : false, hidden: claim.state !== 'filed' },
      { label: '勾稽到账', icon: Landmark, primary: claim.state === 'approved', onClick: () => open(receiveSpec), reason: !canReconcile ? '需要财务核销权限' : !receipts.length ? '没有未分配的人民币到账流水，请先导入退税到账水单' : false, hidden: done },
      { label: '撤回申报', icon: Undo2, onClick: () => open(withdrawSpec), reason: !canWrite ? '需要财务开票权限' : live.length ? '已有到账勾稽，请先冲回' : false, hidden: done },
    ] as ReasonedAction[]} />}
    {claim.withdrawn && <span className="mist-note">已撤回：{claim.withdrawn.reason}</span>}
  </DetailBlock>;
}
