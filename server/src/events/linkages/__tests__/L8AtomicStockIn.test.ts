import { beforeEach, describe, expect, it, vi } from 'vitest';
const { createItem, movement } = vi.hoisted(()=>({createItem:vi.fn(),movement:vi.fn()}));
vi.mock('../../../inventory/inventoryService',()=>({createInventoryService:()=>({createInventoryItem:createItem,createStockMovement:movement})}));
vi.mock('../../../config/automationConfig',()=>({isLinkageEnabled:()=>true}));
import { businessEventBus } from '../../businessEventBus';
import { registerL8AutoStockIn } from '../L8AutoStockIn';
let execute:any;
const event:any={id:'event',type:'MaterialReceived',sourceEntityId:'po',actorId:'actor',payload:{purchaseOrderId:'po',receiptId:'receipt',warehouseId:'wh',stockInLines:[{lineId:'l1',description:'fabric',unit:'M',quantity:10},{lineId:'l2',description:'buttons',unit:'PCS',quantity:20}]}};
function fixture(){
 let committed:any[]=[];
 let staged:any[]=[];
 let receipt:any={id:'receipt',purchaseOrderId:'po',totalAccepted:30,warehouseId:'wh',warehouseName:'主仓'};
 const tx:any={ $queryRaw:vi.fn(async(sql:any)=>sql.sql.includes('"Warehouse"')?[{id:'wh'}]:[receipt]),auditLog:{findFirst:vi.fn(async()=>null),create:vi.fn(async()=>({id:'AUD_L8'}))},stockMovement:{findMany:vi.fn(async()=>staged)},purchaseOrder:{findUnique:vi.fn(async()=>({id:'po',poNumber:'AUDIT',currency:'CNY',lines:[{id:'l1',unit:'M',unitPrice:1},{id:'l2',unit:'PCS',unitPrice:1}],deletedAt:null}))},warehouse:{findFirst:vi.fn(async()=>({id:'wh',name:'主仓'}))},inventoryItem:{findFirst:vi.fn(async()=>null)}};
 const db:any={$transaction:vi.fn(async(fn:any)=>{staged=[...committed];try{const result=await fn(tx);committed=[...staged];return result;}catch(e){staged=[...committed];throw e;}})};
 createItem.mockResolvedValue({id:'item'});
 movement.mockImplementation(async(input:any,_actor:any,opts:any)=>{expect(opts.tx).toBe(tx);const record={id:`m${staged.length}`,notes:input.notes,warehouseId:'wh'};staged.push(record);return record;});
 return {db,tx,rows:()=>committed,setReceipt:(row:any)=>{receipt={warehouseId:'wh',warehouseName:'主仓',...row};}};
}
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(businessEventBus,'registerLinkage').mockImplementation(h=>{execute=h.execute;});registerL8AutoStockIn();});
describe('L8 receipt atomicity',()=>{
 it('second-line failure rolls back all writes, retry processes both lines and replay skips only complete evidence',async()=>{
  const f=fixture();const write=movement.getMockImplementation()!;let calls=0;
  movement.mockImplementation(async(...args:any[])=>{if(++calls===2)throw Error('second line failure');return write(...args);});
  expect((await execute(f.db,event)).ok).toBe(false);expect(f.rows()).toHaveLength(0);
  expect((await execute(f.db,event)).ok).toBe(true);expect(f.rows()).toHaveLength(2);
  const count=movement.mock.calls.length;
  expect((await execute(f.db,event)).ok).toBe(true);expect(movement).toHaveBeenCalledTimes(count);
  expect(f.tx.$queryRaw).toHaveBeenCalledTimes(5); // Three receipt locks and two actual warehouse locks; completed replay needs no new destination.
 });
 it('explicit unavailable warehouse fails without fallback or writes',async()=>{
  const f=fixture();f.tx.warehouse.findFirst.mockResolvedValue(null);
  expect((await execute(f.db,event)).ok).toBe(false);expect(f.tx.warehouse.findFirst).toHaveBeenCalledTimes(1);expect(movement).not.toHaveBeenCalled();
 });
 it('old partial movement is a visible failure, never a successful whole-receipt skip',async()=>{
  const f=fixture();f.tx.stockMovement.findMany.mockResolvedValue([{id:'old',notes:'old first line'}]);
  expect((await execute(f.db,event)).ok).toBe(false);expect(movement).not.toHaveBeenCalled();
 });
 it('rejects duplicate source line identity before writing',async()=>{
  const f=fixture();const bad={...event,payload:{...event.payload,stockInLines:[event.payload.stockInLines[0],event.payload.stockInLines[0]]}};
  expect((await execute(f.db,bad)).ok).toBe(false);expect(movement).not.toHaveBeenCalled();
 });
 it('legacy single-line receipt stocks this receipt 20, never PO cumulative 100',async()=>{
  const f=fixture();f.setReceipt({id:'receipt',purchaseOrderId:'po',totalAccepted:20});f.tx.purchaseOrder.findUnique.mockResolvedValue({id:'po',poNumber:'AUDIT',currency:'CNY',lines:[{id:'l1',receivedQuantity:100,description:'fabric',unit:'M',unitPrice:1}]});
  const legacy={...event,payload:{...event.payload,stockInLines:undefined}};
  expect((await execute(f.db,legacy)).ok).toBe(true);expect(movement.mock.calls[0][0].quantity).toBe(20);
 });
 it('legacy multi-line without per-receipt evidence fails rather than guessing',async()=>{
  const f=fixture();expect((await execute(f.db,{...event,payload:{...event.payload,stockInLines:undefined}})).ok).toBe(false);expect(movement).not.toHaveBeenCalled();
 });
 it('legacy multi-line uses matching receipt audit accepted quantities',async()=>{
  const f=fixture();f.setReceipt({id:'receipt',purchaseOrderId:'po',totalAccepted:20});f.tx.auditLog.findFirst.mockResolvedValue({detail:{after:{lineReceipts:[{lineId:'l1',accepted:8},{lineId:'l2',accepted:12}]}}});
  f.tx.purchaseOrder.findUnique.mockResolvedValue({id:'po',poNumber:'AUDIT',currency:'CNY',lines:[{id:'l1',unit:'PC',unitPrice:1,receivedQuantity:100},{id:'l2',unit:'PC',unitPrice:1,receivedQuantity:100}]});
  expect((await execute(f.db,{...event,payload:{...event.payload,stockInLines:undefined}})).ok).toBe(true);
  expect(movement.mock.calls.map(c=>c[0].quantity)).toEqual([8,12]);
 });
 it('empty payload cannot silently discard accepted stock',async()=>{
  const f=fixture();expect((await execute(f.db,{...event,payload:{...event.payload,stockInLines:[]}})).ok).toBe(false);expect(movement).not.toHaveBeenCalled();
  f.setReceipt({id:'receipt',purchaseOrderId:'po',totalAccepted:0});
  expect((await execute(f.db,{...event,payload:{...event.payload,stockInLines:[]}})).ok).toBe(true);
 });
 it('same total but changed per-line quantities disagrees with receipt audit',async()=>{
  const f=fixture();f.tx.auditLog.findFirst.mockResolvedValue({detail:{after:{lineReceipts:[{lineId:'l1',accepted:15},{lineId:'l2',accepted:15}]}}});
  expect((await execute(f.db,event)).ok).toBe(false);expect(movement).not.toHaveBeenCalled();
 });
 it('changed material identity cannot redirect otherwise valid quantity',async()=>{
  const f=fixture();const tampered={...event,payload:{...event.payload,stockInLines:event.payload.stockInLines.map((l:any)=>({...l,materialCode:'wrong'}))}};
  expect((await execute(f.db,tampered)).ok).toBe(false);expect(movement).not.toHaveBeenCalled();
 });
 it('actual receipt destination rejects a forged payload warehouse before any inventory write',async()=>{
  const f=fixture();expect((await execute(f.db,{...event,payload:{...event.payload,warehouseId:'other'}})).ok).toBe(false);
  expect(f.tx.warehouse.findFirst).not.toHaveBeenCalled();expect(createItem).not.toHaveBeenCalled();expect(movement).not.toHaveBeenCalled();
 });
 it('complete real destination markers replay after warehouse withdrawal without selecting a new default',async()=>{
  const f=fixture();expect((await execute(f.db,event)).ok).toBe(true);f.tx.warehouse.findFirst.mockClear().mockResolvedValue(null);
  const count=movement.mock.calls.length;expect((await execute(f.db,event)).ok).toBe(true);
  expect(f.tx.warehouse.findFirst).not.toHaveBeenCalled();expect(movement).toHaveBeenCalledTimes(count);expect(f.rows()).toHaveLength(2);
 });
 it('native USD purchase price retains USD on the item and MaterialReceipt on the movement',async()=>{
  const f=fixture();const po=await f.tx.purchaseOrder.findUnique();f.tx.purchaseOrder.findUnique.mockResolvedValue({...po,currency:'USD'});
  expect((await execute(f.db,event)).ok).toBe(true);expect(createItem).toHaveBeenCalledWith(expect.objectContaining({unitCost:1,currency:'USD'}),'actor');
  expect(movement).toHaveBeenCalledWith(expect.objectContaining({referenceType:'MaterialReceipt',referenceId:'receipt'}),'actor',expect.objectContaining({tx:f.tx}));
  expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({action:'stock_in_material_receipt',detail:expect.objectContaining({after:expect.objectContaining({currency:'USD'})})})}));
 });
 it('second-line mixed currency refuses the whole batch rather than leaving a first-line stock prefix',async()=>{
  const f=fixture();const po=await f.tx.purchaseOrder.findUnique();
  f.tx.purchaseOrder.findUnique.mockResolvedValue({...po,lines:po.lines.map((line:any)=>({...line,materialCode:line.id}))});
  f.tx.inventoryItem.findFirst.mockImplementation(async({where}:any)=>where.materialCode==='l2'?{id:'other',currency:'USD'}:null);
  const sourced={...event,payload:{...event.payload,stockInLines:event.payload.stockInLines.map((line:any)=>({...line,materialCode:line.lineId}))}};
  const result=await execute(f.db,sourced);expect(result.ok).toBe(false);expect(result.error).toContain('币种');expect(f.rows()).toHaveLength(0);
  expect(movement).toHaveBeenCalledTimes(1); // First native line staged; the second-line refusal rolls it back.
 });
});
it('加工服务不能通过伪造收料事件入库',async()=>{const f=fixture();f.tx.purchaseOrder.findUnique.mockResolvedValue({id:'po',lines:[{id:'l1',kind:'ProcessingService',unit:'M',unitPrice:1},{id:'l2',unit:'PCS',unitPrice:1}]});expect((await execute(f.db,event)).ok).toBe(false);expect(movement).not.toHaveBeenCalled();});
