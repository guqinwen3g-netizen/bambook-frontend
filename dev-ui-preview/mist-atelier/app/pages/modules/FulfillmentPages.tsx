import React from 'react';
import { useRouteDraft } from './useRouteDraft';
import { Plus, RefreshCw } from 'lucide-react';
import { BackLink, Banner, Button, Card, CardHeader, Checklist, DataTable, EmptyState, Field, FormGrid, FormSection, KeyValue, MistPage, Mono, PageHeader, Pill, Select, TextArea, TextInput, TextLink, Timeline, VerticalSteps } from '../../../../../components/mist';
import type { Column } from '../../../../../components/mist';
import type { FulfillmentShipment, FulfillmentDocument, FulfillmentStock } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentSourceLabel, fulfillmentPositions, stockIssueRemaining } from '../../../../../server/src/shared/mistFulfillment';
import type { ClaimInventoryWarehouse } from '../../../../../server/src/shared/mistClaimInventory';
import { apiService } from '../../../../../services/apiService';
import { View, type OutsourcingOrder } from '../../../../../types';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { Nav, useNav } from '../../nav';
import { ModuleWorkbench, type ModuleEditorSpec } from './ModuleWorkbench';
import { today, localNow, status, pill, field, choices, emptyOption, text, number, useEditor, sourceOptions, parseSource, SourceLink, RecordFiles, Events, PositionSummary, exportRecords } from './fulfillmentKit';
import { SamplesPage } from './SamplesPage';
import { QcWorkbenchPage } from './QcWorkbenchPage';
import { ProcurementPage } from './ProcurementPage';
import { InventoryPage } from './InventoryPage';
import { ShipmentsPage } from './ShipmentsPage';
import { CustomsPage } from './CustomsPage';
import { DocumentCenterPage } from './DocumentCenterPage';
export { SamplesPage, QcWorkbenchPage, ProcurementPage, InventoryPage, ShipmentsPage, CustomsPage, DocumentCenterPage };

export function MesHistoryPage() { const session = useMistSession(), { route, go } = useNav(); const [rows, setRows] = React.useState<OutsourcingOrder[]>([]), [loading, setLoading] = React.useState(true), [error, setError] = React.useState(''), [offset, setOffset] = React.useState(0), [total, setTotal] = React.useState(0), [retry, setRetry] = React.useState(0); React.useEffect(() => { let alive = true; setRows([]); setLoading(true); setError(''); void apiService.listOutsourcingOrders({ limit: 100, offset }).then(page => { if (alive) {
    setRows(page.items);
    setTotal(page.total);
} }).catch(e => { if (alive)
    setError(e instanceof Error ? e.message : '历史记录读取失败'); }).finally(() => { if (alive)
    setLoading(false); }); return () => { alive = false; }; }, [session.sessionKey, offset, retry]); return <MistPage><PageHeader title="历史加工记录" description="只读保留原加工单据。当前业务从采购和生产跟单继续，不再新建独立MES工作流。" actions={<Button icon={RefreshCw} onClick={() => setRetry(v => v + 1)}>重新读取</Button>}/>{error && <Banner tone="bad" title="原生历史接口读取失败">{error}。未使用演示记录替代。</Banner>}<Card><DataTable loading={loading} rows={rows} rowKey={r => r.id} columns={[{ key: 'code', header: '历史单号', render: r => <Mono>{r.orderNumber}</Mono> }, { key: 'supplier', header: '加工方', render: r => r.supplierId ? '原系统关联供应商' : '历史未关联' }, { key: 'order', header: '来源订单', render: r => r.orderId ? '原系统关联订单' : '历史未关联' }, { key: 'state', header: '历史状态', render: r => r.status }, { key: 'quantity', header: '数量', align: 'right', render: r => r.quantity }]} empty={<EmptyState title={error ? '历史记录暂不可读' : '没有可见历史加工记录'}/>} onRowClick={r => go('mes', r.id)} footer={<div className="mist-row"><span>{total} 条历史记录</span><Button disabled={!offset} onClick={() => setOffset(o => Math.max(0, o - 100))}>上一批</Button><Button disabled={offset + rows.length >= total} onClick={() => setOffset(o => o + 100)}>下一批</Button></div>}/></Card>{rows.find(r => r.id === route.id) && <Card className="mist-section"><KeyValue items={Object.entries(rows.find(r => r.id === route.id)!).filter(([k, v]) => ['orderNumber', 'status', 'processType', 'quantity', 'unit', 'plannedDeliveryDate', 'actualDeliveryDate', 'notes'].includes(k) && ['string', 'number'].includes(typeof v)).map(([key, value]) => ({ label: ({ orderNumber: '历史单号', status: '原系统状态', processType: '加工类型', quantity: '数量', unit: '单位', plannedDeliveryDate: '计划交付日', actualDeliveryDate: '实际交付日', notes: '备注' } as Record<string, string>)[key], value: String(value) }))}/></Card>}</MistPage>; }
export const FULFILLMENT_PAGES: Record<string, React.FC> = { 'samples': SamplesPage, 'qc-workbench': QcWorkbenchPage, 'shipments': ShipmentsPage, 'procurement': ProcurementPage, 'inventory': InventoryPage, 'customs': CustomsPage, 'document-center': DocumentCenterPage, 'mes': MesHistoryPage };
