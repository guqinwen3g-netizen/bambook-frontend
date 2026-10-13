import {describe,it,expect,vi} from 'vitest';
import {Prisma} from '@prisma/client';
import {createPurchaseServiceDeliveryService} from '../purchaseServiceDeliveryService';
vi.mock('../../entities/sync',()=>({syncInvoiceReferences:vi.fn(async()=>{})}));
vi.mock('../../shared/businessNumberService',()=>({nextBusinessNumber:vi.fn(async()=> 'INV-2026-1')}));
const D=(n:number|string)=>new Prisma.Decimal(n);
function setup(){
 const line:any={id:'L',orderLineId:'OL',kind:'ProcessingService',unit:'m',quantity:D(100),receivedQuantity:D(0),rejectedQuantity:D(0),unitPrice:D(2)};
 const po:any={id:'PO',orderId:'O',status:'Confirmed',supplierRelationId:'SUP',supplierName:'Factory',currency:'CNY',lines:[line]};
 const deliveries:any[]=[],invoices:any[]=[],audits:any[]=[];
 let locked=false;
 const tx:any={
  $queryRaw:vi.fn(async()=>{locked=true;return [{id:'PO'}]}),
  purchaseOrder:{findUnique:async()=>po,update:async({data}:any)=>Object.assign(po,data)},
  order:{findUnique:async()=>({id:'O'})},orderLine:{findUnique:async()=>({id:'OL',orderId:'O'})},
  purchaseLine:{update:async({data}:any)=>{line.receivedQuantity=line.receivedQuantity.plus(data.receivedQuantity.increment);line.rejectedQuantity=line.rejectedQuantity.plus(data.rejectedQuantity.increment)}},
  purchaseServiceDelivery:{findUnique:async({where}:any)=>deliveries.find(d=>where.id?d.id===where.id:d.requestKey===where.requestKey),findMany:async()=>deliveries,create:async({data}:any)=>{expect(locked).toBe(true);deliveries.push(data);return data}},
  invoice:{findFirst:async({where}:any)=>invoices.find(i=>where.invoiceNumber?i.invoiceNumber===where.invoiceNumber:i.sourceType===where.sourceType&&i.sourceId===where.sourceId),create:async({data}:any)=>{invoices.push(data);return data}},
  auditLog:{create:async({data}:any)=>{audits.push(data);return data}},inventoryItem:{create:vi.fn()},stockMovement:{create:vi.fn()}
 };
 let queue=Promise.resolve();
 const db={...tx,$transaction:async(fn:any)=>{const before=queue;let release!:()=>void;queue=new Promise<void>(r=>release=r);await before;locked=false;try{return await fn(tx);}finally{release();}}};
 return {service:createPurchaseServiceDeliveryService(db as any),line,po,deliveries,invoices,audits,tx};
}
const input={requestKey:'K',purchaseLineId:'L',deliveryNumber:'D1',deliveredAt:'2026-09-30',acceptedQuantity:60,rejectedQuantity:40,evidenceReference:'QC-1'};
describe('服务交付事实',()=>{
 it('合格60拒收40只形成120金额，补合格40达到Received，无库存副作用',async()=>{
  const x=setup();const first=await x.service.create('PO',input,'u',['O']);
  expect(Number(first.delivery.acceptedAmount)).toBe(120);expect(x.po.status).toBe('PartiallyReceived');
  await x.service.create('PO',{...input,requestKey:'K2',acceptedQuantity:40,rejectedQuantity:0},'u',['O']);
  expect(x.po.status).toBe('Received');expect(Number(x.line.receivedQuantity)).toBe(100);expect(Number(x.line.rejectedQuantity)).toBe(40);
  expect(x.tx.stockMovement.create).not.toHaveBeenCalled();expect(x.tx.inventoryItem.create).not.toHaveBeenCalled();
 });
 it('同请求并发只有一份事实；Closed后原请求仍返回原事实；异payload冲突',async()=>{
  const x=setup();const results=await Promise.all([x.service.create('PO',input,'u',['O']),x.service.create('PO',input,'u',['O'])]);
  expect(results.map(r=>r.replayed)).toEqual([false,true]);expect(x.deliveries).toHaveLength(1);expect(x.audits).toHaveLength(1);
  x.po.status='Closed';expect((await x.service.create('PO',input,'u',['O'])).replayed).toBe(true);
  await expect(x.service.create('PO',{...input,acceptedQuantity:59},'u',['O'])).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('并发不同请求重新核对剩余量，不能各自通过旧快照',async()=>{
  const x=setup();const results=await Promise.allSettled([x.service.create('PO',{...input,rejectedQuantity:0},'u',['O']),x.service.create('PO',{...input,requestKey:'B',rejectedQuantity:0},'u',['O'])]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(x.deliveries).toHaveLength(1);expect(Number(x.line.receivedQuantity)).toBe(60);
 });
 it('旧请求也必须检查范围，物料行/错误产品归属均阻止',async()=>{
  const x=setup();await expect(x.service.create('PO',input,'u',[])).rejects.toMatchObject({status:404});
  x.line.kind='Material';await expect(x.service.create('PO',input,'u',['O'])).rejects.toMatchObject({code:'INVALID_LINE'});
  x.line.kind='ProcessingService';x.tx.orderLine.findUnique=async()=>({orderId:'OTHER'});await expect(x.service.create('PO',input,'u',['O'])).rejects.toMatchObject({code:'INVALID_SOURCE'});
 });
 it.each([-1,NaN,Infinity,0.00001])('无效合格量 %s 不创建事实',async(qty)=>{const x=setup();await expect(x.service.create('PO',{...input,acceptedQuantity:qty},'u',['O'])).rejects.toMatchObject({code:'INVALID_INPUT'});expect(x.deliveries).toHaveLength(0)});
 it('纯拒收允许后续补货但不生成零应付；正金额应付草稿来源唯一，未支付',async()=>{
  const x=setup();const rejected=await x.service.create('PO',{...input,acceptedQuantity:0,rejectedQuantity:100},'u',['O']);
  await expect(x.service.createPayableDraft(rejected.delivery.id,'u',['O'])).rejects.toMatchObject({code:'NO_PAYABLE_AMOUNT'});
  const accepted=await x.service.create('PO',{...input,requestKey:'B',acceptedQuantity:100,rejectedQuantity:0},'u',['O']);
  const values=await Promise.all([x.service.createPayableDraft(accepted.delivery.id,'u',['O']),x.service.createPayableDraft(accepted.delivery.id,'u',['O'])]);
  expect(values.map(v=>v.replayed)).toEqual([false,true]);expect(x.invoices).toHaveLength(1);expect(x.invoices[0]).toMatchObject({type:'Payable',status:'Draft',sourceType:'PurchaseServiceDelivery'});expect(Number(x.invoices[0].amount)).toBe(200);
  expect((await x.service.list('PO',['O'])).items.find(d=>d.id===accepted.delivery.id).invoice.id).toBe(x.invoices[0].id);
 });
});
it('混合采购仅服务行完结不结束未收物料，来源供应商缺失不能建应付',async()=>{
 const x=setup();x.po.lines.push({id:'M',kind:'Material',quantity:D(50),receivedQuantity:D(0),rejectedQuantity:D(0)});
 const result=await x.service.create('PO',{...input,acceptedQuantity:100,rejectedQuantity:0},'u',['O']);
 expect(x.po.status).toBe('PartiallyReceived');x.po.supplierRelationId=null;
 await expect(x.service.createPayableDraft(result.delivery.id,'u',['O'])).rejects.toMatchObject({code:'SUPPLIER_REQUIRED'});
 expect(x.invoices).toHaveLength(0);
});
it('重复请求也不能越scope，已作废应付来源不能另建第二张',async()=>{
 const x=setup();const result=await x.service.create('PO',input,'u',['O']);
 await expect(x.service.create('PO',input,'u',[])).rejects.toMatchObject({status:404});
 await expect(x.service.list('PO',[])).rejects.toMatchObject({status:404});
 await x.service.createPayableDraft(result.delivery.id,'u',['O']);x.invoices[0].status='Cancelled';
 await expect(x.service.createPayableDraft(result.delivery.id,'u',['O'])).rejects.toMatchObject({code:'SOURCE_INVOICE_VOIDED'});expect(x.invoices).toHaveLength(1);
});
