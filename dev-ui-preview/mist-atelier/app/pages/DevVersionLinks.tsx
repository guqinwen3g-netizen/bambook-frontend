/** 准确开发版本的下游关联：本版实物样品、QC 任务、产品档案、引用本版的报价 / 订单（BB-DEV-10）。 */
import React from 'react';
import { Archive } from 'lucide-react';
import { Banner, Button, Dialog, Field, FormGrid, TextInput } from '../../../../components/mist';
import type { MistState, MistVersion } from '../../../../server/src/shared/mistWorkspace';
import { quoteLineConversionStatus } from '../../../../server/src/shared/mistQuotationLineConversion';

export type VersionLinks = {
  product?: MistState['market']['products'][number];
  samples: MistState['fulfillment']['samples'];
  qcTasks: MistState['fulfillment']['qcTasks'];
  quotations: MistState['market']['quotations'];
  orders: MistState['orders'];
};

export function developmentVersionLinks(state: MistState | null | undefined, version: MistVersion | undefined): VersionLinks {
  if (!state || !version) return { samples: [], qcTasks: [], quotations: [], orders: [] };
  const fulfillment = state.fulfillment, market = state.market;
  const fromVersion = (source: { kind: string; versionId?: string } | undefined) => source?.kind === 'version' && source.versionId === version.id;
  const quotations = (market?.quotations || []).filter(quote => quote.lines.some(line => line.sourceVersionId === version.id));
  // 只按准确来源建立订单关联：订单条目的来源版本，或引用本版的报价条目自身的转单去向。
  // 整单 convertedOrderId 只表示首次转出的订单，不能证明包含本版；仅在历史整单转单（无任何条目级去向）时由 quoteLineConversionStatus 按“全部已转”回退。
  const orderIds = new Set<string>((state.orderLines || []).filter(line => (line as { sourceVersionId?: string }).sourceVersionId === version.id).map(line => line.orderId));
  for (const quote of quotations) for (const line of quote.lines) {
    if (line.sourceVersionId !== version.id) continue;
    const status = quoteLineConversionStatus(quote, line, state.orders || []);
    if (status.state === 'converted') orderIds.add(status.orderId);
  }
  return {
    product: (market?.products || []).find(product => product.sourceVersionId === version.id),
    samples: (fulfillment?.samples || []).filter(sample => fromVersion(sample.source as { kind: string; versionId?: string })),
    qcTasks: (fulfillment?.qcTasks || []).filter(task => fromVersion(task.source as { kind: string; versionId?: string })),
    quotations,
    orders: (state.orders || []).filter(order => orderIds.has(order.id)),
  };
}

/** 转产品档案的门槛：QC 通过或有保留通过即可，不要求需求方确认；放弃 / 重新打样的版本不可。 */
export function productConversionBlocker(version: MistVersion | undefined): string | null {
  if (!version) return '未选择版本';
  if (!version.qc) return '本版 QC 通过或有保留通过后才能转为产品档案';
  if (version.qc.result === 'reject' || version.qcDecision) return '本版 QC 不通过，不能转为产品档案';
  return null;
}

export function ToProductDialog({ open, version, busy, failure, onClose, onSubmit }: {
  open: boolean; version?: MistVersion; busy: boolean; failure: string; onClose: () => void; onSubmit: (input: { sku: string; supplierCode: string }) => void;
}) {
  const [form, setForm] = React.useState({ sku: '', supplierCode: '' });
  React.useEffect(() => { if (open) setForm({ sku: '', supplierCode: '' }); }, [open, version?.id]);
  return <Dialog open={open} onClose={() => !busy && onClose()} icon={Archive} title={`将 ${version?.label || ''} 转为产品档案`} description="按本版实物与 QC 结论建立数字档案；不要求需求方确认。建档后档案号回链到本版。" footer={<>
    <Button variant="quiet" disabled={busy} onClick={onClose}>取消</Button>
    <Button variant="primary" loading={busy} disabled={!form.sku.trim()} onClick={() => onSubmit({ sku: form.sku.trim(), supplierCode: form.supplierCode.trim() })}>建立产品档案</Button></>}>
    {failure && <Banner tone="bad" title="档案尚未建立">{failure}</Banner>}
    {version?.qc?.result === 'conditional' && <Banner tone="warn" title="需关注 · QC 有保留通过">{version.qc.opinion || '请查看 QC 报告'}</Banner>}
    <FormGrid>
      <Field label="公司产品编码" required><TextInput value={form.sku} onChange={event => setForm(previous => ({ ...previous, sku: event.target.value }))} placeholder="例如：GA-2711" /></Field>
      <Field label="供应商产品编码" hint={`供应商按本版工厂：${version?.factory || '—'}`}><TextInput value={form.supplierCode} onChange={event => setForm(previous => ({ ...previous, supplierCode: event.target.value }))} /></Field>
    </FormGrid>
  </Dialog>;
}
