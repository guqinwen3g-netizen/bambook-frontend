import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as contract from './mistWorkspace';
import {type PlatformClaimGoodsSource} from './mistPlatform';
import {createClaimReturnReceipt,getClaimGoodsReceivedQuantity,assertClaimGoodsFullyReturned,assertClaimGoodsInventorySettled,type ClaimInventoryCommand} from './mistClaimInventory';
import {MistRepository} from '../mist/repository';
import {MistPrivateFiles} from '../mist/files';
import {MemoryMistDatabase,testActor,testAuthority} from '../mist/__tests__/support';

function fixture(destination:'Scrap'|'Repair'|'Replace'='Scrap',quantity=2,unit='件'){
 let sequence=0,numbers=0;const ctx={id:()=>`inventory-${++sequence}`,now:'2026-10-13T10:00:00.000Z',actorId:'business',actorName:'经手业务员',consumeBusinessNumber:(_prefix:string)=>`RT-2026-${String(++numbers).padStart(5,'0')}`};
 let state=contract.createMistState(ctx,'empty');state.customers.push({id:'customer',code:'CUS',name:'实际来源客户',country:'CN',city:'',industry:'成衣',owner:'经手业务员',grade:'A',currency:'USD',terms:'OA',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'});
 state.files.push({id:'proof',name:'actual-return.pdf',mimeType:'application/pdf',size:10,storageKey:'fixture/proof',createdAt:ctx.now});
 const source:PlatformClaimGoodsSource={schemaVersion:1,claimId:'case',dispositionId:'disposition',invoiceId:'invoice',documentId:'document',orderId:'order',lineId:'line',shipmentId:'shipment',productionId:'production',customerId:'customer',currency:'USD',name:'实际退回成衣',style:'RETURN-M',unit,quantity,unitPrice:15,sourceQuantity:4,sourceAmount:60,orderApprovedVersion:1};
 const disposition={id:'disposition',kind:'ReturnRefund' as const,amount:30,quantity,unit,returnDisposition:destination,basis:'真实批准退回处置',fileIds:['proof'],state:'Executed' as const,reviewDecision:'approved' as const,requesterId:'business',reviewerId:'leader',submittedAt:ctx.now,goodsSource:structuredClone(source),snapshot:JSON.stringify({kind:'ReturnRefund',amount:30,quantity,unit,destination,basis:'真实批准退回处置',goodsSource:source}),goodsId:'goods'};
 state.platform.claims.push({id:'case',code:'CLM-2026-00001',orderId:'order',invoiceId:'invoice',problem:'实际客户退回',fileIds:['proof'],state:'Processing',createdAt:ctx.now,dispositions:[disposition]});state.platform.claimGoods.push({id:'goods',claimId:'case',dispositionId:'disposition',orderId:'order',quantity,unit,destination,source:structuredClone(source),state:'AwaitingReturn',events:[]});
 const run=(command:ClaimInventoryCommand)=>{const result=contract.applyMistCommand(state,command,ctx);state=result.state;return result.result;};
 const warehouseId=run({type:'fulfillment.claimInventory.warehouse.save',payload:{code:'WH-SH',name:'上海真实仓库',address:'上海实际地址',active:true}}).id!;
 const receipt=createClaimReturnReceipt(state,'goods',warehouseId,ctx);
 const receive=(quantity=1,batch='RETURN-LOT-1',ownership:'Owned'|'Transferred'='Owned')=>({type:'fulfillment.claimInventory.receive' as const,payload:{goodsId:'goods',quantity,unit,warehouseId,location:'退货隔离区A',batchNumber:batch,ownership,ownershipDate:'2026-10-13',ownershipEvidence:'实际货权确认原文',receivedAt:'2026-10-13',basis:'现场点数与交接确认',fileIds:['proof']}});
 const scrap=(id:string)=>({type:'fulfillment.claimInventory.scrap' as const,payload:{goodsId:'goods',receivedEventId:id,basis:'按批准去向实际报废',fileIds:['proof']}});
 return{ctx,source,run,receive,scrap,receipt,warehouseId,get state(){return state;},get numberCount(){return numbers;}};
}

it('aggregates one numbered RT per case, binds each executed goods line to the approved warehouse and never creates stock at execution',()=>{
 const f=fixture();expect(f.receipt).toMatchObject({code:'RT-2026-00001',warehouseId:f.warehouseId,goodsIds:['goods']});expect(f.state.fulfillment.stock).toEqual([]);expect(f.state.fulfillment.stockMovements).toEqual([]);
 const source={...f.source,dispositionId:'second'},first=f.state.platform.claims[0].dispositions[0],second={...structuredClone(first),id:'second',goodsId:'second-goods',goodsSource:source,snapshot:JSON.stringify({...JSON.parse(first.snapshot!),goodsSource:source})};f.state.platform.claims[0].dispositions.push(second);f.state.platform.claimGoods.push({...structuredClone(f.state.platform.claimGoods[0]),id:'second-goods',dispositionId:'second',source});
 const same=createClaimReturnReceipt(f.state,'second-goods',f.warehouseId,f.ctx);expect(same.id).toBe(f.receipt.id);expect(same.goodsIds).toEqual(['goods','second-goods']);expect(f.numberCount).toBe(1);
 const secondWarehouse=f.run({type:'fulfillment.claimInventory.warehouse.save',payload:{code:'WH-2',name:'第二仓库',address:'实际地址2',active:true}}).id!;expect(()=>createClaimReturnReceipt(f.state,'second-goods',secondWarehouse,f.ctx)).toThrow(/第二个仓库/);
});

it('receives two pieces in separate one-piece batches, isolates each, scraps each and retains the original inbound history',()=>{
 const f=fixture();f.state.fulfillment.stock.push({id:'purchase-stock',purchaseId:'purchase',receiptId:'purchase-receipt',orderId:'other',lineId:'other-line',name:'原采购库存',unit:'件',quantity:10,available:10,owner:'公司',location:'原区',createdAt:f.ctx.now});
 const first=f.run(f.receive()),firstId=first.receivedEventId!;expect(f.state.platform.claimGoods[0]).toMatchObject({state:'PartiallyReceived',receivedQuantity:1});expect(()=>assertClaimGoodsFullyReturned(f.state,'goods')).toThrow(/完整实际收货/);
 expect(f.state.fulfillment.stock[1]).toMatchObject({sourceKind:'claimReturn',quantity:1,onHand:1,locked:1,available:0,warehouseId:f.warehouseId});expect(f.state.fulfillment.stock[1].purchaseId).toBeUndefined();expect(f.state.fulfillment.stockMovements.map(row=>row.kind)).toEqual(['receive','lock']);
 f.run(f.scrap(firstId));expect(f.state.fulfillment.stock[1]).toMatchObject({quantity:1,onHand:0,locked:0,available:0});expect(f.state.platform.claimGoods[0].state).toBe('PartiallyReceived');
 const second=f.run(f.receive(1,'RETURN-LOT-2'));expect(f.state.platform.claimGoods[0]).toMatchObject({state:'Received',receivedQuantity:2});expect(()=>assertClaimGoodsFullyReturned(f.state,'goods')).not.toThrow();expect(()=>assertClaimGoodsInventorySettled(f.state,'goods')).toThrow(/隔离货物/);
 f.run(f.scrap(second.receivedEventId!));expect(f.state.platform.claimGoods[0].state).toBe('Scrapped');expect(()=>assertClaimGoodsInventorySettled(f.state,'goods')).not.toThrow();expect(getClaimGoodsReceivedQuantity(f.state,'goods')).toBe(2);
 expect(f.state.fulfillment.stock.slice(1).map(row=>[row.quantity,row.onHand,row.locked,row.available])).toEqual([[1,0,0,0],[1,0,0,0]]);expect(f.state.fulfillment.stock[0].available).toBe(10);expect(f.state.fulfillment.stockMovements).toHaveLength(8);expect(f.state.fulfillment.receivedRecords).toHaveLength(2);expect(f.state.tasks.find(task=>task.kind==='claim-inventory:goods')?.done).toBe(true);
 f.state.platform.claims[0].state='Closed';expect(getClaimGoodsReceivedQuantity(f.state,'goods')).toBe(2);expect(f.state.fulfillment.receivedRecords[0].fileIds).toEqual(['proof']);
});

it.each(['issue','return','move'] as const)('blocks generic %s from consuming or relocating isolated return inventory',kind=>{
 const f=fixture(),saved=f.run(f.receive()),before=structuredClone(f.state);expect(()=>contract.applyMistCommand(f.state,{type:'fulfillment.inventory.move',payload:{id:saved.stockId!,kind,quantity:1,location:'别处',person:'经手业务员',note:'不能越过隔离',issueId:'fake'}},f.ctx)).toThrow(/隔离库存/);expect(f.state).toEqual(before);
});

it.each(['quantity','unit','warehouse','ownership','date','file'] as const)('refuses invalid %s receipt without changing stock, goods or history',field=>{
 const f=fixture(),command=f.receive(),before=structuredClone(f.state);if(field==='quantity')command.payload.quantity=3;if(field==='unit')command.payload.unit='米';if(field==='warehouse')command.payload.warehouseId='unknown';if(field==='ownership')(command.payload as any).ownership='automatic';if(field==='date')command.payload.receivedAt='2026-02-30';if(field==='file')command.payload.fileIds=['foreign-file'];expect(()=>f.run(command)).toThrow();expect(f.state).toEqual(before);
});

it('does not default a warehouse or ownership, and cannot deactivate a warehouse while returned goods remain isolated',()=>{
 const f=fixture(),payload={code:'WH-X',name:'无库存仓',address:'实址',active:false},inactive=f.run({type:'fulfillment.claimInventory.warehouse.save',payload}).id!;
 expect(()=>createClaimReturnReceipt(f.state,'goods','not-a-location-id',f.ctx)).toThrow(/真实启用/);expect(()=>createClaimReturnReceipt(f.state,'goods',inactive,f.ctx)).toThrow(/真实启用/);
 const before=structuredClone(f.state),blank=f.receive();(blank.payload as any).ownership='';expect(()=>f.run(blank)).toThrow(/明确选择/);expect(f.state).toEqual(before);
 f.run(f.receive());expect(()=>f.run({type:'fulfillment.claimInventory.warehouse.save',payload:{id:f.warehouseId,code:'WH-SH',name:'上海真实仓库',address:'原实址',active:false}})).toThrow(/隔离数量/);
});

it.each(['Closed','Cancelled'] as const)('refuses new receipt or disposal on a %s case',state=>{
 const f=fixture(),saved=f.run(f.receive());f.state.platform.claims[0].state=state;const before=structuredClone(f.state);expect(()=>f.run(f.receive(1,'next'))).toThrow();expect(()=>f.run(f.scrap(saved.receivedEventId!))).toThrow();expect(f.state).toEqual(before);
});

it.each(['Repair','Replace'] as const)('keeps %s stock isolated and refuses an invented Scrap or settled status',destination=>{
 const f=fixture(destination);const saved=f.run(f.receive(2));expect(()=>f.run(f.scrap(saved.receivedEventId!))).toThrow(/批准退回去向/);expect(()=>assertClaimGoodsInventorySettled(f.state,'goods')).toThrow(/真实放行/);expect(f.state.fulfillment.stock[0]).toMatchObject({onHand:2,locked:2,available:0});
});

it('preserves explicitly confirmed customer ownership, and keeps decimal fabric quantities in the approved unit',()=>{
 const f=fixture('Scrap',1.25,'米');f.run(f.receive(0.5,'FABRIC-1','Transferred'));f.run(f.receive(0.75,'FABRIC-2','Transferred'));expect(getClaimGoodsReceivedQuantity(f.state,'goods')).toBe(1.25);expect(f.state.fulfillment.stock.map(row=>[row.unit,row.onHand,row.locked,row.available,row.ownership,row.ownerCustomerId])).toEqual([['米',0.5,0.5,0,'Transferred','customer'],['米',0.75,0.75,0,'Transferred','customer']]);
});

it.each(['lock','balance','source','actor','unbound'] as const)('fails closed on damaged %s stock facts rather than refunding or scrapping them',damage=>{
 const f=fixture(),saved=f.run(f.receive(2));if(damage==='lock')f.state.fulfillment.stockMovements.pop();if(damage==='balance')f.state.fulfillment.stock[0].locked=0;if(damage==='source')f.state.fulfillment.stock[0].invoiceId='other-invoice';if(damage==='actor')f.state.fulfillment.stockMovements[0].actor='forged actor';if(damage==='unbound')f.state.fulfillment.stockMovements.push({...f.state.fulfillment.stockMovements[0],id:'unbound'});const before=structuredClone(f.state);expect(()=>assertClaimGoodsFullyReturned(f.state,'goods')).toThrow();expect(()=>f.run(f.scrap(saved.receivedEventId!))).toThrow();expect(f.state).toEqual(before);
});

it('refuses duplicate or another goods batch disposal without changing completed stock history',()=>{
 const f=fixture(),saved=f.run(f.receive(2));expect(()=>f.run(f.scrap('foreign-received-event'))).toThrow(/真实收货批次/);f.run(f.scrap(saved.receivedEventId!));const before=structuredClone(f.state);expect(()=>f.run(f.scrap(saved.receivedEventId!))).toThrow(/已经报废/);expect(f.state).toEqual(before);
});

const temporaryDirectories:string[]=[];afterEach(async()=>{await Promise.all(temporaryDirectories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
it('enforces inventory permission and original request/revision receipts without double-counting physical returns',async()=>{
 const f=fixture(),directory=await mkdtemp(path.join(tmpdir(),'mist-claim-inventory-'));temporaryDirectories.push(directory);const db=new MemoryMistDatabase(),auth=testAuthority();auth.users.get('owner')!.permissions=['inventory:write'];const repo=new MistRepository(db,{...contract,createMistState:()=>structuredClone(f.state)},new MistPrivateFiles(directory),auth.authorize),workspace=await repo.create(testActor(),{name:'Isolated return ledger',seed:'empty'});
 const input={requestId:'receive-first',expectedRevision:0,command:f.receive()};const result=await repo.execute(testActor(),workspace.id,input);expect(result.workspace.state.platform.claimGoods[0].receivedQuantity).toBe(1);expect((await repo.execute(testActor(),workspace.id,input)).replayed).toBe(true);expect((await repo.get(testActor(),workspace.id)).state.fulfillment.stock).toHaveLength(1);
 await expect(repo.execute(testActor(),workspace.id,{...input,command:f.receive(2)})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});await expect(repo.execute(testActor(),workspace.id,{...input,requestId:'stale'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 auth.users.get('owner')!.permissions=['aftersales:write'];await expect(repo.execute(testActor(),workspace.id,{requestId:'wrong-role',expectedRevision:1,command:f.receive()})).rejects.toMatchObject({status:403});auth.users.get('owner')!.permissions=['inventory:write'];auth.users.get('other')!.permissions=['inventory:write'];await expect(repo.execute(testActor('other'),workspace.id,{requestId:'cross-workspace',expectedRevision:1,command:f.receive()})).rejects.toMatchObject({status:404});expect(await readdir(directory)).toEqual([]);
});
