/** Local processing history comes from this workspace's approved commitments only. */
import React from 'react';
import { Button,DataTable,KeyValue,Pill } from '../../../../../components/mist';
import {useMistWorkspace} from '../../runtime/workspace';import {useNav} from '../../nav';
import {ModuleWorkbench,downloadModuleCsv} from './ModuleWorkbench';
export function LocalMesPage(){
 const {state}=useMistWorkspace(),{go}=useNav();
 const rows=(state?.fulfillment?.purchases||[]).filter(p=>p.kind==='processing'&&p.state==='approved');
 return <ModuleWorkbench title="历史加工记录" eyebrow="平台 · 加工履行" description="当前本地工作空间中已批准的加工合同及实际交付记录。" rows={rows} searchText={p=>[p.code,p.supplier,p.description].join(' ')}
  columns={[{key:'code',header:'加工合同',render:p=>p.code},{key:'supplier',header:'加工方',render:p=>p.supplier},{key:'name',header:'加工内容',render:p=>p.description},{key:'qty',header:'合同数量',render:p=>`${p.quantity} ${p.unit}`},{key:'received',header:'已交付',render:p=>`${p.received} ${p.unit}`},{key:'due',header:'交期',render:p=>p.due},{key:'state',header:'状态',render:p=><Pill tone={p.received>p.quantity?'warn':p.received===p.quantity?'ok':'accent'}>{p.received>p.quantity?'数量差异待处理':p.received===p.quantity?'已交付':'履行中'}</Pill>}]}
  exportRows={filtered=>downloadModuleCsv('加工履行记录.csv',['合同','加工方','加工内容','合同数量','单位','已交付','交期'],filtered.map(p=>[p.code,p.supplier,p.description,p.quantity,p.unit,p.received,p.due]))}
  detail={p=><><KeyValue items={[{label:'加工合同',value:p.code},{label:'加工方',value:p.supplier},{label:'实际交付',value:`${p.received} / ${p.quantity} ${p.unit}`},{label:'交付地点',value:p.destination},{label:'条款',value:p.terms}]}/><DataTable ariaLabel="加工实际交付" rows={(state?.fulfillment.receipts||[]).filter(receipt=>receipt.purchaseId===p.id)} rowKey={receipt=>receipt.id} columns={[{key:'date',header:'日期',render:receipt=>receipt.date},{key:'quantity',header:'实收 / 拒收',render:receipt=>`${receipt.quantity} / ${receipt.rejected} ${p.unit}`},{key:'location',header:'实际地点',render:receipt=>receipt.location},{key:'evidence',header:'交付依据',render:receipt=>receipt.evidence}]}/><div className="mist-row"><Button onClick={()=>go('procurement',p.id)}>打开加工合同</Button><Button onClick={()=>go('orders/detail',p.orderId,{orderLineId:p.lineId,productionId:state?.productions.find(production=>production.sourcePurchaseId===p.id)?.id})}>返回来源条目</Button><Button onClick={()=>go('production-board',undefined,{productionId:state?.productions.find(production=>production.sourcePurchaseId===p.id)?.id})}>查看生产跟单</Button></div></>}/>;
}
