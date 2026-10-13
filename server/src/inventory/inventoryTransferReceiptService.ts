import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { qcReportSourceFingerprint as fingerprint } from '../qc/qcReportAuthority';
import { exactJsonValue } from '../lib/exactJsonValue';
import { businessError } from '../shared/errorCodes';
const json = (value:any):any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const same = (a:any,b:any) => a!==undefined && b!==undefined && fingerprint(a)===fingerprint(b);
const conflict = (message:string):never => { throw businessError('CONFLICT',message); };
export const TRANSFER_RECEIPT_OPERATION='receive_inventory_transfer_stock';

/** A warehouse receipt carries the original controlled production scope; it is not new production. */
export async function acknowledgeTransferredProductionStock(tx:any, task:any, stock:any, movement:any, quantity:Prisma.Decimal, date:string, note:string, actorId:string, requestKey:string){
 const source=await tx.productionStockReceipt.findFirst({where:{inventoryItemId:task.sourceItemId}});
 if(!source)return;
 const now=BigInt(Date.now()), id='PSR_'+randomUUID();
 const command={operation:TRANSFER_RECEIPT_OPERATION,sourceReceiptId:source.id,transferId:task.id,sourceInventoryItemId:task.sourceItemId,inventoryItemId:stock.id,warehouseId:stock.warehouseId,quantity:quantity.toString(),date,note,requestKey};
 const commandHash=fingerprint({operation:TRANSFER_RECEIPT_OPERATION,receiptId:id,actorId,command});
 const receipt=await tx.productionStockReceipt.create({data:{id,productionBatchId:source.productionBatchId,productionBatchRevision:source.productionBatchRevision,orderId:source.orderId,orderLineId:source.orderLineId,warehouseId:stock.warehouseId,inventoryItemId:stock.id,stockMovementId:movement.id,quantity,unit:source.unit,scopeFingerprint:source.scopeFingerprint,scopeSnapshot:source.scopeSnapshot,movementDate:date,receiptReference:note,requestKey:'transfer:'+task.id+':'+requestKey,commandHash,commandSnapshot:command,receiptSnapshot:{},createdBy:actorId,createdAt:now}});
 const ack={receipt:json(receipt),inventoryItem:json(stock),movement:json(movement),replayed:false};
 await tx.productionStockReceipt.update({where:{id},data:{receiptSnapshot:ack}});
 await tx.auditLog.create({data:{id:'alog_'+randomUUID(),actorId,action:TRANSFER_RECEIPT_OPERATION,targetType:'ProductionStockReceipt',targetId:id,operationType:'create',detail:{commandHash,command,ack}}});
}

/** Verify the immutable original receipt plus every actual transfer receipt in its ancestry. */
export async function verifyTransferredProductionReceipt(tx:any, receipt:any, batch:any, scopeFingerprint:string, rootReader:(id:string)=>Promise<any>, ancestors:Set<string>, historical=false){
 if(ancestors.has(receipt.id)||ancestors.size>32)return conflict('调拨收货来源循环或过长，请核查原凭据');
 const next=new Set(ancestors);next.add(receipt.id);
 const cmd=receipt.commandSnapshot,ack=receipt.receiptSnapshot;
 if(!cmd||cmd.operation!==TRANSFER_RECEIPT_OPERATION||!cmd.sourceReceiptId||!cmd.transferId||!ack?.receipt||!ack.inventoryItem||!ack.movement||ack.replayed!==false
  ||receipt.commandHash!==fingerprint({operation:TRANSFER_RECEIPT_OPERATION,receiptId:receipt.id,actorId:receipt.createdBy,command:cmd})
  ||receipt.requestKey!=='transfer:'+cmd.transferId+':'+cmd.requestKey||cmd.inventoryItemId!==receipt.inventoryItemId||cmd.warehouseId!==receipt.warehouseId||cmd.quantity!==String(receipt.quantity)||cmd.date!==receipt.movementDate||cmd.note!==receipt.receiptReference)return conflict('调拨收货命令或冻结回执不完整');
 const {receiptSnapshot:_a,...persisted}=json(receipt),{receiptSnapshot:_b,...frozen}=ack.receipt;
 if(!same(persisted,frozen))return conflict('调拨收货凭据偏离其原始回执');
 const origin=await rootReader(cmd.sourceReceiptId);
 if(origin.receipt.inventoryItemId!==cmd.sourceInventoryItemId||origin.receipt.productionBatchId!==receipt.productionBatchId||origin.receipt.orderId!==receipt.orderId||origin.receipt.orderLineId!==receipt.orderLineId||origin.receipt.unit!==receipt.unit)return conflict('调拨收货没有真实的同批次来源');
 const task=await tx.inventoryTransfer.findUnique({where:{id:cmd.transferId}});
 const entry=(Array.isArray(task?.history)?task.history:[]).find((h:any)=>h.action==='receive'&&h.inventoryItemId===receipt.inventoryItemId&&h.requestKey===cmd.requestKey);
 if(!task||task.sourceItemId!==cmd.sourceInventoryItemId||task.targetWarehouseId!==receipt.warehouseId||!entry||entry.quantity!==cmd.quantity||entry.date!==cmd.date||entry.actorId!==receipt.createdBy)return conflict('调拨收货缺少实际签收记录');
 const audits=await tx.auditLog.findMany({where:{action:TRANSFER_RECEIPT_OPERATION,targetType:'ProductionStockReceipt',targetId:receipt.id}});
 if(audits.length!==1||audits[0].actorId!==receipt.createdBy||!same(audits[0].detail?.command,cmd)||!same(audits[0].detail?.ack,ack)||audits[0].detail?.commandHash!==receipt.commandHash)return conflict('调拨收货缺少准确创建审计');
 const item=await tx.inventoryItem.findUnique({where:{id:receipt.inventoryItemId}}),warehouse=await tx.warehouse.findUnique({where:{id:receipt.warehouseId}}),movement=await tx.stockMovement.findUnique({where:{id:receipt.stockMovementId}});
 const old=ack.inventoryItem;const originalStock=origin.receipt.receiptSnapshot?.inventoryItem;
 if(!originalStock||['orderId','unit','ownership','materialCode','batchNumber','productAssetId'].some(k=>old[k]!==originalStock[k]))return conflict('调拨收货的货品、货权或订单偏离原实物来源');
 if(!item||!warehouse||(!historical&&(item.deletedAt!=null||warehouse.deletedAt!=null||!warehouse.isActive||item.warehouseId!==receipt.warehouseId||item.orderId!==receipt.orderId||item.unit!==receipt.unit||item.ownership!==old.ownership||item.materialCode!==old.materialCode||item.batchNumber!==old.batchNumber||item.productAssetId!==old.productAssetId))||!same(json(movement),ack.movement)||movement.type!=='Inbound'||movement.itemId!==item.id||movement.referenceType!=='InventoryTransfer'||movement.referenceId!==task.id||movement.warehouseId!==receipt.warehouseId||movement.operator!==receipt.createdBy||!new Prisma.Decimal(movement.quantity).eq(receipt.quantity)||!new Prisma.Decimal(movement.balanceBefore).eq(0)||!new Prisma.Decimal(movement.balanceAfter).eq(receipt.quantity))return conflict('调拨后实际库存身份或签收流水已变化');
 const qty=new Prisma.Decimal(item.quantity),locked=new Prisma.Decimal(item.lockedQuantity);if(qty.lt(0)||locked.lt(0)||locked.gt(qty))return conflict('调拨库存可用数量无法核验');
 return {receipt,item,available:qty.minus(locked),identity:{stockReceiptId:receipt.id,warehouseId:receipt.warehouseId,inventoryItemId:receipt.inventoryItemId,stockMovementId:receipt.stockMovementId,productionBatchRevision:receipt.productionBatchRevision,receivedQuantity:String(receipt.quantity),unit:receipt.unit,receiptScopeFingerprint:scopeFingerprint,receiptCommandHash:receipt.commandHash}};
}

export async function assertTransferUnreserved(tx:any,itemId:string,quantity:Prisma.Decimal){
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem" WHERE "id"=${itemId} FOR UPDATE`);
 const item=await tx.inventoryItem.findUnique({where:{id:itemId}});if(!item||item.deletedAt)throw new Error('调拨来源库存不存在');
 const origin=await tx.productionStockReceipt.findFirst({where:{inventoryItemId:itemId}});if(origin){const frozen=(origin.receiptSnapshot as any)?.inventoryItem;if(!frozen||['orderId','unit','ownership','materialCode','batchNumber','productAssetId'].some(k=>(item as any)[k]!==frozen[k]))throw new Error('生产库存来源身份已变化，请核对原收货凭据');}
 const reservations=await tx.shipmentProductionBatchAllocation.findMany({where:{state:'reserved'},select:{scopeSnapshot:true}});
 let reserved=new Prisma.Decimal(0);
 for(const r of reservations)for(const row of (r.scopeSnapshot as any)?.receiptAllocations||[])if(row.inventoryItemId===itemId)reserved=reserved.plus(row.actualQty||0);
 if(quantity.gt(new Prisma.Decimal(item.quantity).minus(item.lockedQuantity).minus(reserved)))throw new Error('调拨数量占用了已预留出运的实物，请先调整原出运计划');
}
