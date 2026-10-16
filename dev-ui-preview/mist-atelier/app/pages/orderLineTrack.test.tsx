// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAllByRole, getByRole, getByText } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { createMistState, type MistOrder, type MistOrderLine, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { OrderLineFulfillment } from './OrderLineFulfillment';
import { currentLineStage, lineStages, lineTrackLabel, orderLineFlags } from './orderLineTrack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, s: MistState;
const context = { id: () => crypto.randomUUID(), now: '2026-10-16T02:00:00.000Z', actorName: '业务员甲' };
const order = (type: 'garment' | 'fabric') => ({ id: 'o-' + type, code: 'SO-' + type, type, customer: '客户甲' }) as unknown as MistOrder;
const line = (type: 'garment' | 'fabric') => ({ id: 'l-' + type, orderId: 'o-' + type, name: type === 'fabric' ? '双面呢面料' : '大衣', style: 'S1', img: 'coat', qty: 100, unit: type === 'fabric' ? '米' : '件', price: 1, made: 0, qc: 0 }) as unknown as MistOrderLine;
const job = (type: 'garment' | 'fabric', col: 'cut' | 'sew' | 'finish' | 'qc' | 'done', id = 'p-' + type) => ({ id, code: id, orderId: 'o-' + type, lineId: 'l-' + type, order: 'SO-' + type, name: 'x', factory: '甲厂', qty: 100, due: '2026-11-01', pct: 10, img: 'coat', col }) as MistState['productions'][number];
const task = (type: 'garment' | 'fabric', id: string, kind: 'sample' | 'production', state = 'reported') => ({ id, code: id, kind, domain: type, source: { kind: 'orderLine', orderId: 'o-' + type, lineId: 'l-' + type, ...(kind === 'production' ? { productionId: 'p-' + type } : {}) }, factory: '甲厂', location: '', contact: '', due: '', requestedBy: '', assignee: '', state, reportIds: state === 'reported' ? [id + 'r'] : [], createdAt: '' }) as never;
const report = (taskId: string, result: 'pass' | 'reject') => ({ id: taskId + 'r', taskId, result }) as never;
const purchase = (type: 'garment' | 'fabric', state = 'approved', received = 100) => ({ id: 'pu-' + type, code: 'PU-' + type, lineId: 'l-' + type, kind: 'material', state, quantity: 100, received }) as never;
const keys = (type: 'garment' | 'fabric') => lineStages(s, order(type), line(type)).map(stage => [stage.key, stage.state]);
beforeEach(() => { s = createMistState(context, 'empty'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('BB-ORD-1 fabric line uses the 5-step track without cutting; garment keeps 6 steps', () => {
  const fabric = lineStages(s, order('fabric'), line('fabric')), garment = lineStages(s, order('garment'), line('garment'));
  expect(fabric.map(stage => stage.label)).toEqual(['坯布 / 染整', '色样确认', '生产检验', '完工', '出运']);
  expect(garment.map(stage => stage.label)).toEqual(['产前样', '面辅料', '开裁', '生产检验', '完工登记', '出运']);
  expect(currentLineStage(fabric)?.key).toBe('material');
  expect(currentLineStage(garment)?.key).toBe('pp');
  expect(lineTrackLabel(order('fabric'))).toBe('面料：' + fabric.map(stage => stage.label).join(' → '));
  expect(lineTrackLabel(order('garment'))).toBe('成衣：' + garment.map(stage => stage.label).join(' → '));
});

it('BB-ORD-1 fabric "in production" comes from open production branches, not from the cut column', () => {
  s.fulfillment.purchases.push(purchase('fabric'));
  s.fulfillment.qcTasks.push(task('fabric', 'qs', 'sample'));
  s.fulfillment.qcReports.push(report('qs', 'pass'));
  expect(keys('fabric')).toEqual([['material', 'done'], ['pp', 'done'], ['inspection', 'todo'], ['completion', 'todo'], ['shipment', 'todo']]);
  expect(lineStages(s, order('fabric'), line('fabric'))[2].caption).toBe('未开立生产');
  for (const col of ['sew', 'finish', 'qc', 'cut'] as const) {
    s.productions = [job('fabric', col)];
    const stages = lineStages(s, order('fabric'), line('fabric')), current = currentLineStage(stages)!;
    expect(stages.some(stage => stage.key === 'cut')).toBe(false);
    expect(current).toMatchObject({ key: 'inspection', state: 'now', caption: '生产中 · 1 个分支 · 未发起检验', target: { view: 'production-board', id: 'p-fabric' } });
  }
  s.productions = [job('fabric', 'done')];
  expect(currentLineStage(lineStages(s, order('fabric'), line('fabric')))).toMatchObject({ key: 'inspection', caption: '生产已完成 · 未发起检验' });
  // 成衣不受影响：仍由开裁步表示是否开立生产
  s.productions = [];
  expect(lineStages(s, order('garment'), line('garment'))[3]).toMatchObject({ key: 'inspection', state: 'todo', caption: '未发起检验' });
});

it('BB-ORD-1 fabric blocked reasons, entry points and list counters stay consistent', () => {
  s.orders.push(order('fabric') as never); s.orderLines.push(line('fabric') as never);
  s.productions = [job('fabric', 'qc')];
  s.fulfillment.purchases.push(purchase('fabric'));
  s.fulfillment.qcTasks.push(task('fabric', 'qs', 'sample'), task('fabric', 'qp', 'production'));
  s.fulfillment.qcReports.push(report('qs', 'pass'), report('qp', 'reject'));
  const current = currentLineStage(lineStages(s, order('fabric'), line('fabric')))!;
  expect(current).toMatchObject({ key: 'inspection', state: 'blocked', caption: 'QC NOK', target: { view: 'qc-workbench', id: 'qp' } });
  expect(orderLineFlags(s, order('fabric'))).toMatchObject({ nok: 1, toShip: 0 });
  // 复验通过并登记完工后：NOK 清零，计入待出运
  (s.fulfillment.qcReports as Array<{ result: string }>)[1].result = 'pass';
  s.fulfillment.productionFacts = [{ productionId: 'p-fabric', completion: { quantity: 100 } }] as never;
  expect(orderLineFlags(s, order('fabric'))).toMatchObject({ nok: 0, toShip: 1 });
  expect(currentLineStage(lineStages(s, order('fabric'), line('fabric')))).toMatchObject({ key: 'shipment', state: 'todo' });
  // 色样不通过：受阻在第 2 步，去处理指向样品评审
  (s.fulfillment.qcReports as Array<{ result: string }>)[0].result = 'reject';
  expect(currentLineStage(lineStages(s, order('fabric'), line('fabric')))).toMatchObject({ key: 'pp', state: 'blocked', caption: '色样未通过', target: { view: 'qc-workbench', id: 'qs' } });
});

it('BB-ORD-1 line fulfillment panel shows the fabric track, matching mode text and the handle entry', async () => {
  s.productions = [job('fabric', 'sew')];
  s.fulfillment.purchases.push(purchase('fabric', 'rejected', 0));
  const go = vi.fn();
  act(() => root.render(<MistRoot><ToastProvider><OrderLineFulfillment state={s} order={order('fabric')} line={line('fabric')} go={go} /></ToastProvider></MistRoot>));
  const nav = getByRole(host, 'navigation', { name: '条目阶段' });
  expect(getAllByRole(nav, 'button').map(button => button.querySelector('b')!.textContent)).toEqual(['坯布 / 染整', '色样确认', '生产检验', '完工', '出运']);
  expect(nav.textContent).not.toContain('开裁');
  expect(getByText(host, '面料：坯布 / 染整 → 色样确认 → 生产检验 → 完工 → 出运')).toBeTruthy();
  expect(host.textContent).toContain('当前：坯布 / 染整');
  expect(getByRole(nav, 'button', { name: /坯布 \/ 染整/ }).getAttribute('aria-current')).toBe('step');
  await act(async () => getByRole(host, 'button', { name: '去处理' }).click());
  expect(go).toHaveBeenCalledWith('procurement', 'pu-fabric', { orderLineId: 'l-fabric' });
  await act(async () => getByRole(nav, 'button', { name: /生产检验/ }).click());
  expect(host.querySelector('[data-stage-open="inspection"]')!.textContent).toContain('生产中 · 1 个分支');
  await act(async () => getByRole(host, 'button', { name: '查看来源记录' }).click());
  expect(go).toHaveBeenLastCalledWith('production-board', undefined, { orderLineId: 'l-fabric', productionId: 'p-fabric' });
});

it.each(['garment', 'fabric'] as const)('shows completed %s shipping without inventing missing upstream records', type => {
  const o=order(type),l=line(type);
  s.fulfillment.shipments.push({id:'sent',code:'SHP-SENT',state:'departed',plannedDate:'2026-10-16',lines:[{orderId:o.id,lineId:l.id,quantity:100}]} as never);
  const stages=lineStages(s,o,l);
  expect(stages.find(stage=>stage.key==='material')?.state).toBe('todo');
  expect(currentLineStage(stages)).toBeNull();
  act(()=>root.render(<MistRoot><ToastProvider><OrderLineFulfillment state={s} order={o} line={l} go={vi.fn()}/></ToastProvider></MistRoot>));
  expect(host.textContent).toContain('已完成出运');
  expect(host.textContent).not.toContain('当前：');
});

it('keeps a passed production retest blocked until business explicitly resumes it',()=>{
  const o=order('garment'),l=line('garment');s.orders.push(o);s.orderLines.push(l);s.productions.push(job('garment','qc'));
  const waiting={...task('garment','retest','production') as any,state:'awaiting_business',reportIds:['retestr']};
  s.fulfillment.qcTasks.push(waiting);s.fulfillment.qcReports.push(report('retest','pass'));
  expect(currentLineStage(lineStages(s,o,l))).toMatchObject({key:'inspection',state:'blocked',caption:'待业务恢复'});
  expect(orderLineFlags(s,o)).toMatchObject({business:1,nok:0});
  waiting.state='reported';waiting.businessContinued={reportId:'retestr'};
  expect(lineStages(s,o,l).find(stage=>stage.key==='inspection')).toMatchObject({state:'done'});
});

it('still surfaces a current quality blocker even when stored shipments have departed',()=>{
  const o=order('fabric'),l=line('fabric');s.productions.push(job('fabric','qc'));
  s.fulfillment.shipments.push({id:'sent',code:'SHP-SENT',state:'departed',lines:[{orderId:o.id,lineId:l.id,quantity:100}]} as never);
  s.fulfillment.qcTasks.push(task('fabric','nok','production'));s.fulfillment.qcReports.push(report('nok','reject'));
  expect(currentLineStage(lineStages(s,o,l))).toMatchObject({key:'inspection',state:'blocked',caption:'QC NOK'});
});
