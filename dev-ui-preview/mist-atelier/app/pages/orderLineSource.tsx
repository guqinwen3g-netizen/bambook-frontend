/** BB-ORD-2：条目来源（开发案号 · 版本 / 产品码），可点开来源记录。只读展示。 */
import React from 'react';
import type { MistOrderLine, MistState } from '../../../../server/src/shared/mistWorkspace';
import { Button } from '../../../../components/mist';

type Go = (view: string, id?: string, target?: Record<string, string | undefined>) => void;
export function lineSource(state: MistState, line: MistOrderLine, go: Go) {
  const row = line as MistOrderLine & { sourceDevId?: string; sourceVersionId?: string; sourceProductId?: string };
  if (row.sourceProductId) { const product = state.market?.products.find(item => item.id === row.sourceProductId); return { kind: 'product', label: `产品档案 ${product?.sku || row.sourceProductId}${product?.status === 'archived' ? '（已归档）' : ''}`, open: () => go('products', row.sourceProductId) }; }
  if (row.sourceVersionId) { const version = state.versions.find(item => item.id === row.sourceVersionId), dev = state.devs.find(item => item.id === (row.sourceDevId || version?.devId)); return { kind: 'version', label: `开发案 ${dev?.code || row.sourceDevId || '未知'} · ${version?.label || row.sourceVersionId}`, open: () => go('development/detail', dev?.id || row.sourceDevId, { versionId: row.sourceVersionId }) }; }
  return null;
}
export function OrderLineSourceValue({ state, line, go }: { state: MistState; line: MistOrderLine; go: Go }) {
  const source = lineSource(state, line, go);
  return source ? <Button variant="quiet" size="sm" data-line-source={source.kind} onClick={source.open}>{source.label}</Button> : <span className="mist-muted">手工新建 · 无来源记录</span>;
}
