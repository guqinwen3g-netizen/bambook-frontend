/** Shared fulfillment page helpers: exact sources, files, positions and editor plumbing. */
import React from 'react';
import { Download } from 'lucide-react';
import { Banner, Button, DataTable, Pill, TextLink, Timeline, UploadZone } from '../../../../../components/mist';
import type { MistState, MistFile } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentSource, FulfillmentSample, FulfillmentShipment, FulfillmentStock } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentSourceLabel, fulfillmentPositions } from '../../../../../server/src/shared/mistFulfillment';
import { useMistWorkspace } from '../../runtime/workspace';
import { useNav } from '../../nav';
import { useRouteDraft } from './useRouteDraft';
import { ModuleEditorDialog, ModuleEditorPage, downloadModuleCsv, type ModuleEditorSpec, type ModuleField, type ModuleValues } from './ModuleWorkbench';
export const today = () => new Date().toISOString().slice(0, 10);
export const localNow = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const status: Record<string, string> = { draft: '草稿', pending: '待审批', approved: '已批准', rejected: '已退回', preparing: '单证处理中', ready: '待实际出运', departed: '已出运', cancelled: '已取消', submitted: '已申报', cleared: '已清关', issued: '已签发', void: '已作废', working: '处理中', reported: '报告已回传', blocked: '质量阻断', awaiting_business: '待业务恢复' };
export const pill = (s: string) => <Pill tone={['approved', 'issued', 'cleared', 'departed', 'reported'].includes(s) ? 'ok' : ['rejected', 'blocked', 'void'].includes(s) ? 'bad' : ['pending', 'awaiting_business'].includes(s) ? 'warn' : 'neutral'}>{status[s] || s}</Pill>;
export const field = (key: string, label: string, type: ModuleField['type'] = 'text', required = true, options?: ModuleField['options']): ModuleField => ({ key, label, type, required, ...(type === 'number' ? { min: 0, step: '0.0001' } : {}), ...(options ? { options } : {}) });
export const choices = (values: string[]) => values.map(value => ({ value, label: value }));
export const emptyOption = { value: '', label: '请选择' };
export const text = (v: ModuleValues, key: string) => String(v[key] ?? '');
export const number = (v: ModuleValues, key: string) => Number(v[key]);
export function useEditor() { const [spec, set] = useRouteDraft<ModuleEditorSpec | null>(null); return { open: set, view: spec ? (spec.fields.length > 3 ? <ModuleEditorPage spec={spec} onClose={() => set(null)}/> : <ModuleEditorDialog spec={spec} onClose={() => set(null)}/>) : null, spec }; }
export function sourceOptions(s: MistState | null, versions = true) { return [emptyOption, ...(versions ? s?.versions.filter(v => v.returnedAt).map(v => ({ value: 'version:' + v.id, label: `${s.devs.find(d => d.id === v.devId)?.code} · ${v.label} · ${v.factory}` })) || [] : []), ...(s?.orderLines.map(l => ({ value: 'line:' + l.id, label: `${s.orders.find(o => o.id === l.orderId)?.code} · ${l.style} · ${l.name}` })) || []), ...(s?.productions.map(p => ({ value: 'production:' + p.id, label: `${p.order} · ${p.code} · ${p.factory}` })) || [])]; }
export function parseSource(s: MistState, value: string): Exclude<FulfillmentSource, {
    kind: 'manual';
}> { const [type, id] = value.split(':'); if (type === 'version') {
    const v = s.versions.find(v => v.id === id);
    if (v)
        return { kind: 'version', devId: v.devId, versionId: v.id };
} if (type === 'line') {
    const l = s.orderLines.find(l => l.id === id);
    if (l)
        return { kind: 'orderLine', orderId: l.orderId, lineId: l.id };
} if (type === 'production') {
    const p = s.productions.find(p => p.id === id);
    if (p)
        return { kind: 'orderLine', orderId: p.orderId, lineId: p.lineId, productionId: p.id };
} throw new Error('请重新选择当前工作区的准确来源'); }
export function sourceValue(source: FulfillmentSource) { return source.kind === 'version' ? 'version:' + source.versionId : source.kind === 'orderLine' ? source.productionId ? 'production:' + source.productionId : 'line:' + source.lineId : 'manual'; }
export function SourceLink({ source }: {
    source: FulfillmentSource;
}) { const { state } = useMistWorkspace(), { go } = useNav(); if (!state)
    return null; if (source.kind === 'manual') return <span>{source.description}</span>; return <TextLink onClick={() => source.kind === 'version' ? go('development/detail', source.devId, { versionId: source.versionId }) : go('orders/detail', source.orderId, { orderLineId: source.lineId, productionId: source.productionId })}>{fulfillmentSourceLabel(state, source)}</TextLink>; }
export function shipmentReturnTarget(state:MistState|null,shipment:FulfillmentShipment){
    const orderIds=new Set(shipment.lines.map(line=>line.orderId));
    const order=state?.orders.find(order=>orderIds.size===1&&orderIds.has(order.id)&&order.customerId===shipment.customerId);
    return order?{section:'order:'+order.id,customerId:order.customerId}:{customerId:shipment.customerId};
}
export function RecordFiles({ ids, onAttach }: {
    ids: string[];
    onAttach?: (ids: string[]) => Promise<unknown>;
}) { const { state, uploadFile, downloadFile, pending, saving } = useMistWorkspace(); const [failure, setFailure] = useRouteDraft(''), [busy, setBusy] = React.useState(false), [staged, setStaged] = useRouteDraft<MistFile[]>([]); const add = async (files: File[]) => { setBusy(true); setFailure(''); try {
    const added = [...staged];
    for (const file of files) {
        added.push(await uploadFile(file));
        setStaged([...added]);
    }
    setStaged(added);
    await onAttach?.([...ids, ...added.map(f => f.id)]);
    setStaged([]);
}
catch (e) {
    setFailure(e instanceof Error ? e.message : '附件保存失败');
}
finally {
    setBusy(false);
} }; return <div className="mist-section">{failure && <Banner tone="bad" title="附件未完成保存">{failure}</Banner>}{ids.map(id => { const f = state?.files.find(f => f.id === id); return f ? <div className="mist-row" key={id}><span>{f.name}</span><TextLink icon={Download} onClick={() => void downloadFile(f).catch(e => setFailure(String(e)))}>下载</TextLink></div> : null; })}{onAttach && <UploadZone hint="上传当前记录的原始照片或附件" onFiles={files => { if (!busy && !saving && !pending)
    void add(files); }}/>} {!!staged.length && <Button disabled={busy || saving || !!pending} onClick={() => void add([])}>重试关联已上传附件</Button>}</div>; }
export function Events({ entity, id }: {
    entity: string;
    id: string;
}) { const { state } = useMistWorkspace(); return <Timeline events={(state?.events || []).filter(e => e.entityType === entity && e.entityId === id).map(e => ({ who: e.actor, when: new Date(e.at).toLocaleString(), text: e.text }))}/>; }
export function PositionSummary({ row }: { row: FulfillmentSample | FulfillmentStock }) {
    const positions = fulfillmentPositions(row);
    if (positions.length < 2) return null;
    return <DataTable ariaLabel="实际位置余额" rows={positions} rowKey={position => position.location} columns={[
        { key: 'location', header: '实际位置', render: position => position.location || '位置未记录' },
        { key: 'available', header: '可用数量', align: 'right', render: position => `${position.available} ${row.unit}` },
    ]}/>;
}
export function exportRecords(name: string, headers: string[], rows: unknown[][]) { downloadModuleCsv(name + '.csv', headers, rows); }
