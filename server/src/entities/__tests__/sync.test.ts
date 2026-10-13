import { describe, expect, it, vi } from 'vitest';
import { referenceIdFor, syncOrderEntityReferences } from '../sync';

describe('entity sync', () => {
  it('writes order relation references and graph links without touching source profiles', async () => {
    const ops: any[] = [];
    const prisma = {
      entityReference: {
        upsert: vi.fn((op) => ({ kind: 'reference', op })),
      },
      entityLink: {
        upsert: vi.fn((op) => ({ kind: 'link', op })),
      },
      $transaction: vi.fn(async (items) => {
        ops.push(...items);
      }),
    };

    await syncOrderEntityReferences(prisma as any, {
      id: 'ORDER-1',
      customer: 'Peerless Clothing',
      customerRelationId: 'REL-PEERLESS',
      millName: 'Panda Mill',
      millRelationId: 'REL-MILL',
    }, { source: 'manual', now: () => 1234 });

    expect(prisma.entityReference.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.entityLink.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ops[0].op.create).toEqual(expect.objectContaining({
      id: referenceIdFor('order', 'ORDER-1', 'customer', 'relation.organization', 'REL-PEERLESS'),
      ownerType: 'order',
      ownerId: 'ORDER-1',
      fieldKey: 'customer',
      targetType: 'relation.organization',
      targetId: 'REL-PEERLESS',
      source: 'manual',
      status: 'active',
    }));
    expect(ops[1].op.create).toEqual(expect.objectContaining({
      fromType: 'order',
      fromId: 'ORDER-1',
      toType: 'relation.organization',
      toId: 'REL-PEERLESS',
      linkKind: 'orderedBy',
    }));
  });
});

describe('syncShipmentReferences — shipsVia link uses carrierRelationId (task_mqxwgae9)', () => {
  it('生成 shipsVia link 用 carrierRelationId/carrierName（非 forwarder）', async () => {
    const { syncShipmentReferences } = await import('../sync');
    const ops: any[] = [];
    const prisma = {
      entityReference: { upsert: vi.fn((op) => ({ kind: 'reference', op })) },
      entityLink: { upsert: vi.fn((op) => ({ kind: 'link', op })) },
      $transaction: vi.fn(async (items) => { ops.push(...items); }),
    };

    await syncShipmentReferences(prisma as any, {
      id: 'SHP-1',
      shipmentNumber: 'SH-001',
      orderId: 'ORDER-1',
      customerRelationId: 'REL-CUST',
      customerName: 'ACME',
      carrierRelationId: 'REL-CARRIER',
      carrierName: 'FastShip Co',
    } as any, { source: 'manual', now: () => 1234 });

    // 应有 aboutOrder(1) + billTo(1) + shipsVia(1) 各 1 ref + 1 link = 6 ops
    const linkOps = ops.filter(o => o.kind === 'link');
    const shipsViaLinks = linkOps.filter(o => o.op.create?.linkKind === 'shipsVia');
    expect(shipsViaLinks).toHaveLength(1);
    // shipsVia link 的 toId 必须是 carrierRelationId 的值
    expect(shipsViaLinks[0].op.create).toEqual(expect.objectContaining({
      fromType: 'shipment',
      fromId: 'SHP-1',
      toType: 'relation.organization',
      toId: 'REL-CARRIER',
      linkKind: 'shipsVia',
    }));
    // shipsVia reference 的 fieldKey 必须是 carrierName
    const shipsViaRefs = ops.filter(o => o.kind === 'reference' && o.op.create?.fieldKey === 'carrierName');
    expect(shipsViaRefs).toHaveLength(1);
    expect(shipsViaRefs[0].op.create.targetId).toBe('REL-CARRIER');
  });

  it('carrierRelationId 缺失时不生成 shipsVia link', async () => {
    const { syncShipmentReferences } = await import('../sync');
    const ops: any[] = [];
    const prisma = {
      entityReference: { upsert: vi.fn((op) => ({ kind: 'reference', op })) },
      entityLink: { upsert: vi.fn((op) => ({ kind: 'link', op })) },
      $transaction: vi.fn(async (items) => { ops.push(...items); }),
    };

    await syncShipmentReferences(prisma as any, {
      id: 'SHP-2',
      orderId: 'ORDER-2',
      customerRelationId: 'REL-CUST',
      customerName: 'ACME',
      carrierRelationId: null,
      carrierName: null,
    } as any, { source: 'manual', now: () => 1234 });

    const shipsViaLinks = ops.filter(o => o.kind === 'link' && o.op.create?.linkKind === 'shipsVia');
    expect(shipsViaLinks).toHaveLength(0);
    // 仍生成 aboutOrder + billTo
    const linkKinds = ops.filter(o => o.kind === 'link').map(o => o.op.create?.linkKind);
    expect(linkKinds).toContain('aboutOrder');
    expect(linkKinds).toContain('billTo');
  });

  it('forwarderRelationId/forwarderName 不再触发 shipsVia（回归保护，字段已废弃）', async () => {
    const { syncShipmentReferences } = await import('../sync');
    const ops: any[] = [];
    const prisma = {
      entityReference: { upsert: vi.fn((op) => ({ kind: 'reference', op })) },
      entityLink: { upsert: vi.fn((op) => ({ kind: 'link', op })) },
      $transaction: vi.fn(async (items) => { ops.push(...items); }),
    };

    // 传 forwarderRelationId（旧字段，应被忽略，不生成 shipsVia）
    await syncShipmentReferences(prisma as any, {
      id: 'SHP-3',
      orderId: 'ORDER-3',
      customerRelationId: 'REL-CUST',
      customerName: 'ACME',
      forwarderRelationId: 'REL-OLD',
      forwarderName: 'OldForwarder',
    } as any, { source: 'manual', now: () => 1234 });

    const shipsViaLinks = ops.filter(o => o.kind === 'link' && o.op.create?.linkKind === 'shipsVia');
    expect(shipsViaLinks).toHaveLength(0); // forwarder 已废弃，不生成
  });
});

describe('manifest 字段契约对齐 schema（task_mqxwgae9）', () => {
  it('manifest 源码不含废弃的 forwarderRelationId/forwarderName', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const manifestSrc = fs.readFileSync(
      path.resolve(__dirname, '../../agent/mcp/manifest.ts'), 'utf-8'
    );
    expect(manifestSrc).not.toContain('forwarderRelationId');
    expect(manifestSrc).not.toContain('forwarderName');
  });

  it('manifest shipping 段含 carrierRelationId/carrierName', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const manifestSrc = fs.readFileSync(
      path.resolve(__dirname, '../../agent/mcp/manifest.ts'), 'utf-8'
    );
    expect(manifestSrc).toContain('carrierRelationId');
    expect(manifestSrc).toContain('carrierName');
  });
});

// ---------------------------------------------------------------------------
// 阶段 D / D1.1a：六类主链路实体 sync 函数
// ---------------------------------------------------------------------------

/** mock prisma：upsert 返回标记对象，$transaction 收集 ops */
function makeSyncPrisma() {
  const ops: any[] = [];
  const prisma = {
    entityReference: { upsert: vi.fn((op) => ({ kind: 'reference', op })) },
    entityLink: { upsert: vi.fn((op) => ({ kind: 'link', op })) },
    $transaction: vi.fn(async (items: any[]) => { ops.push(...items); }),
  };
  return { prisma, ops };
}

const linkKindsOf = (ops: any[]) => ops.filter(o => o.kind === 'link').map(o => o.op.create?.linkKind);

describe('阶段 D / D1.1a 主链路实体 sync', () => {
  it('syncQuotationReferences：quotedFor + convertedToOrder', async () => {
    const { syncQuotationReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncQuotationReferences(prisma as any, {
      id: 'QT-1', quotationNumber: 'QT-20260807-001',
      customerRelationId: 'REL-CUST', customerName: 'ACME',
      convertedOrderId: 'ORD-1',
    }, { source: 'api:quotation', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['quotedFor', 'convertedToOrder']);
    const ref = ops.find(o => o.kind === 'reference' && o.op.create?.fieldKey === 'customerRelationId');
    expect(ref.op.create).toEqual(expect.objectContaining({
      ownerType: 'quotation', ownerId: 'QT-1',
      targetType: 'relation.organization', targetId: 'REL-CUST',
      source: 'api:quotation', status: 'active',
    }));
    expect(ref.op.create.snapshot).toEqual(expect.objectContaining({ quotationNumber: 'QT-20260807-001' }));
  });

  it('syncQuotationReferences：无 FK 时不产生任何 ops', async () => {
    const { syncQuotationReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncQuotationReferences(prisma as any, {
      id: 'QT-2', quotationNumber: 'QT-20260807-002',
      customerRelationId: null, convertedOrderId: null,
    }, { source: 'api:quotation' });

    expect(ops).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('syncBomReferences：forOrder / aboutProduct / fromQuotation', async () => {
    const { syncBomReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncBomReferences(prisma as any, {
      id: 'BOM-1', bomNumber: 'BOM-001', description: '夹克 BOM',
      orderId: 'ORD-1', productAssetId: 'PROD-1', quotationId: 'QT-1',
    }, { source: 'api:bom', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['forOrder', 'aboutProduct', 'fromQuotation']);
    const productLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'aboutProduct');
    expect(productLink.op.create).toEqual(expect.objectContaining({
      fromType: 'bom', fromId: 'BOM-1', toType: 'product', toId: 'PROD-1',
    }));
  });

  it('syncPurchaseOrderReferences：purchasedFrom / forOrder / fromBom / fromQuotation', async () => {
    const { syncPurchaseOrderReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncPurchaseOrderReferences(prisma as any, {
      id: 'PO-1', poNumber: 'PO-001', supplierName: 'Panda Mill',
      supplierRelationId: 'REL-MILL', orderId: 'ORD-1', bomId: 'BOM-1', quotationId: 'QT-1',
    }, { source: 'api:procurement', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['purchasedFrom', 'forOrder', 'fromBom', 'fromQuotation']);
    const supplierRef = ops.find(o => o.kind === 'reference' && o.op.create?.fieldKey === 'supplierRelationId');
    expect(supplierRef.op.create.snapshot).toEqual(expect.objectContaining({ poNumber: 'PO-001' }));
  });

  it('syncCustomsDeclarationReferences：clearsShipment / aboutOrder / declaredFor', async () => {
    const { syncCustomsDeclarationReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncCustomsDeclarationReferences(prisma as any, {
      id: 'CD-1', declarationNumber: 'DEC-001',
      shipmentId: 'SHP-1', orderId: 'ORD-1', relationId: 'REL-CUST',
    }, { source: 'api:customs', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['clearsShipment', 'aboutOrder', 'declaredFor']);
    const shipLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'clearsShipment');
    expect(shipLink.op.create).toEqual(expect.objectContaining({
      fromType: 'customsDeclaration', fromId: 'CD-1', toType: 'shipment', toId: 'SHP-1',
    }));
  });

  it('syncTaxRefundReferences：refundsDeclaration / aboutOrder / refundTo', async () => {
    const { syncTaxRefundReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncTaxRefundReferences(prisma as any, {
      id: 'TR-1', refundNumber: 'TR-001',
      declarationId: 'CD-1', orderId: 'ORD-1', relationId: 'REL-CUST',
    }, { source: 'api:customs', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['refundsDeclaration', 'aboutOrder', 'refundTo']);
    const declLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'refundsDeclaration');
    expect(declLink.op.create).toEqual(expect.objectContaining({
      fromType: 'taxRefund', fromId: 'TR-1', toType: 'customsDeclaration', toId: 'CD-1',
    }));
  });

  it('syncOpportunityReferences：opportunityFor + convertedToOrder（orderId 成交后）', async () => {
    const { syncOpportunityReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncOpportunityReferences(prisma as any, {
      id: 'OPP-1', title: '2026 春季夹克', stage: 'ClosedWon',
      relationId: 'REL-CUST', orderId: 'ORD-1',
    }, { source: 'api:crm', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['opportunityFor', 'convertedToOrder']);
    const ref = ops.find(o => o.kind === 'reference' && o.op.create?.fieldKey === 'relationId');
    expect(ref.op.create.snapshot).toEqual(expect.objectContaining({ stage: 'ClosedWon' }));
  });

  it('tx 模式：传入事务上下文时不走 prisma.$transaction，逐个 await', async () => {
    const { syncQuotationReferences } = await import('../sync');
    const { prisma } = makeSyncPrisma();
    const txOps: any[] = [];
    const tx = {
      entityReference: { upsert: vi.fn((op) => { txOps.push({ kind: 'reference', op }); return Promise.resolve({}); }) },
      entityLink: { upsert: vi.fn((op) => { txOps.push({ kind: 'link', op }); return Promise.resolve({}); }) },
    };

    await syncQuotationReferences(prisma as any, {
      id: 'QT-3', quotationNumber: 'QT-20260807-003',
      customerRelationId: 'REL-CUST', customerName: 'ACME',
    }, { source: 'api:quotation', now: () => 1234 }, tx);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.entityReference.upsert).toHaveBeenCalledTimes(1);
    expect(tx.entityLink.upsert).toHaveBeenCalledTimes(1);
    expect(linkKindsOf(txOps)).toEqual(['quotedFor']);
  });
});

// ---------------------------------------------------------------------------
// 阶段 D / D2：ProductAsset ↔ Relation sync
// ---------------------------------------------------------------------------

describe('阶段 D / D2 产品档案 Relation sync', () => {
  it('syncProductAssetReferences：面料 mill → suppliedBy', async () => {
    const { syncProductAssetReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncProductAssetReferences(prisma as any, {
      id: 'PROD-F1', name: '精纺羊毛面料', sku: 'FAB-001',
      fabricProfile: { millOrganizationId: 'REL-MILL', millName: 'Panda Mill' },
    }, { source: 'api:products', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['suppliedBy']);
    const ref = ops.find(o => o.kind === 'reference');
    expect(ref.op.create).toEqual(expect.objectContaining({
      ownerType: 'product', ownerId: 'PROD-F1',
      fieldKey: 'fabricProfile.millOrganizationId',
      targetType: 'relation.organization', targetId: 'REL-MILL',
    }));
    expect(ref.op.create.snapshot).toEqual(expect.objectContaining({ millName: 'Panda Mill', mainCategory: 'Fabric' }));
  });

  it('syncProductAssetReferences：成衣 customer/factory → producedFor / manufacturedBy', async () => {
    const { syncProductAssetReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncProductAssetReferences(prisma as any, {
      id: 'PROD-G1', name: '西装夹克', sku: 'GAR-001',
      garmentProfile: {
        customer: 'ACME', customerRelationId: 'REL-CUST',
        factory: 'Panda Garment', factoryRelationId: 'REL-FACT',
      },
    }, { source: 'api:products', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['producedFor', 'manufacturedBy']);
  });

  it('syncProductAssetReferences：辅料 supplier → suppliedBy；无 FK 时不产生 ops', async () => {
    const { syncProductAssetReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncProductAssetReferences(prisma as any, {
      id: 'PROD-T1', name: 'YKK 拉链', sku: 'TRM-001',
      trimmingProfile: { supplier: 'YKK 中国', supplierRelationId: 'REL-SUP' },
    }, { source: 'api:products', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['suppliedBy']);
    const link = ops.find(o => o.kind === 'link');
    expect(link.op.create).toEqual(expect.objectContaining({
      fromType: 'product', fromId: 'PROD-T1', toType: 'relation.organization', toId: 'REL-SUP',
    }));

    // 纯文本（无 FK）不入图
    const { prisma: prisma2, ops: ops2 } = makeSyncPrisma();
    await syncProductAssetReferences(prisma2 as any, {
      id: 'PROD-T2', name: '无 FK 辅料', sku: 'TRM-002',
      trimmingProfile: { supplier: '某供应商' },
    }, { source: 'api:products' });
    expect(ops2).toHaveLength(0);
    expect(prisma2.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W-C 功能修复任务包 A1：MaterialReceipt / StockMovement 图谱 sync
// ---------------------------------------------------------------------------

describe('W-C A1 采购库存链 sync', () => {
  it('syncMaterialReceiptReferences：forPurchaseOrder 恒入图；stockItemId 携带时 stockedAs 入图', async () => {
    const { syncMaterialReceiptReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncMaterialReceiptReferences(prisma as any, {
      id: 'MR-1', receiptNumber: 'RPT-001', purchaseOrderId: 'PO-1', status: 'Accepted',
      stockItemId: 'INV-1',
    }, { source: 'api:procurement', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['forPurchaseOrder', 'stockedAs']);
    const poLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'forPurchaseOrder');
    expect(poLink.op.create).toEqual(expect.objectContaining({
      fromType: 'materialReceipt', fromId: 'MR-1', toType: 'purchaseOrder', toId: 'PO-1',
    }));
    const poRef = ops.find(o => o.kind === 'reference' && o.op.create?.fieldKey === 'purchaseOrderId');
    expect(poRef.op.create).toEqual(expect.objectContaining({
      ownerType: 'materialReceipt', ownerId: 'MR-1',
      targetType: 'purchaseOrder', targetId: 'PO-1',
      source: 'api:procurement', status: 'active',
    }));
    expect(poRef.op.create.snapshot).toEqual(expect.objectContaining({ receiptNumber: 'RPT-001', status: 'Accepted' }));
    const stockLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'stockedAs');
    expect(stockLink.op.create).toEqual(expect.objectContaining({
      fromType: 'materialReceipt', fromId: 'MR-1', toType: 'inventoryItem', toId: 'INV-1',
    }));
  });

  it('syncMaterialReceiptReferences：无 stockItemId 仅 forPurchaseOrder；无 purchaseOrderId 零 ops', async () => {
    const { syncMaterialReceiptReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncMaterialReceiptReferences(prisma as any, {
      id: 'MR-2', receiptNumber: 'RPT-002', purchaseOrderId: 'PO-2', status: 'Accepted',
    }, { source: 'api:procurement', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['forPurchaseOrder']);

    const { prisma: prisma2, ops: ops2 } = makeSyncPrisma();
    await syncMaterialReceiptReferences(prisma2 as any, {
      id: 'MR-3', receiptNumber: 'RPT-003', purchaseOrderId: null,
    }, { source: 'api:procurement' });
    expect(ops2).toHaveLength(0);
    expect(prisma2.$transaction).not.toHaveBeenCalled();
  });

  it('syncStockMovementReferences：movesItem / inWarehouse / referencesDocument（L8 契约 referenceType=PurchaseOrder）', async () => {
    const { syncStockMovementReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncStockMovementReferences(prisma as any, {
      id: 'SM-1', movementNumber: 'SM-20260810-AB12', type: 'Inbound',
      itemId: 'INV-1', warehouseId: 'WH-1',
      referenceType: 'PurchaseOrder', referenceId: 'MR-1',
    }, { source: 'api:inventory', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['movesItem', 'inWarehouse', 'referencesDocument']);
    const itemLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'movesItem');
    expect(itemLink.op.create).toEqual(expect.objectContaining({
      fromType: 'stockMovement', fromId: 'SM-1', toType: 'inventoryItem', toId: 'INV-1',
    }));
    const whLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'inWarehouse');
    expect(whLink.op.create).toEqual(expect.objectContaining({
      fromType: 'stockMovement', fromId: 'SM-1', toType: 'warehouse', toId: 'WH-1',
    }));
    const docLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'referencesDocument');
    expect(docLink.op.create).toEqual(expect.objectContaining({
      fromType: 'stockMovement', fromId: 'SM-1', toType: 'purchaseOrder', toId: 'MR-1',
    }));
    const itemRef = ops.find(o => o.kind === 'reference' && o.op.create?.fieldKey === 'itemId');
    expect(itemRef.op.create.snapshot).toEqual(expect.objectContaining({ movementNumber: 'SM-20260810-AB12', type: 'Inbound' }));
  });

  it('syncStockMovementReferences：referenceType=Manual/Adjustment 等非单据来源不出 referencesDocument', async () => {
    const { syncStockMovementReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncStockMovementReferences(prisma as any, {
      id: 'SM-2', movementNumber: 'SM-INIT-1', type: 'Inbound',
      itemId: 'INV-2', warehouseId: 'WH-1',
      referenceType: 'Manual', referenceId: null,
    }, { source: 'api:inventory', now: () => 1234 });

    expect(linkKindsOf(ops)).toEqual(['movesItem', 'inWarehouse']);
  });

  it('syncStockMovementReferences：Transfer 目标流水 referencesDocument → stockMovement（配对互链）', async () => {
    const { syncStockMovementReferences } = await import('../sync');
    const { prisma, ops } = makeSyncPrisma();

    await syncStockMovementReferences(prisma as any, {
      id: 'SM-3', movementNumber: 'SM-20260810-CD34', type: 'Inbound',
      itemId: 'INV-3', warehouseId: 'WH-2',
      referenceType: 'Transfer', referenceId: 'SM-1',
    }, { source: 'api:inventory', now: () => 1234 });

    const docLink = ops.find(o => o.kind === 'link' && o.op.create?.linkKind === 'referencesDocument');
    expect(docLink.op.create).toEqual(expect.objectContaining({
      fromType: 'stockMovement', fromId: 'SM-3', toType: 'stockMovement', toId: 'SM-1',
    }));
  });

  it('tx 模式：传入事务上下文时不走 prisma.$transaction，逐个 await', async () => {
    const { syncStockMovementReferences, syncMaterialReceiptReferences } = await import('../sync');
    const { prisma } = makeSyncPrisma();
    const txOps: any[] = [];
    const tx = {
      entityReference: { upsert: vi.fn((op) => { txOps.push({ kind: 'reference', op }); return Promise.resolve({}); }) },
      entityLink: { upsert: vi.fn((op) => { txOps.push({ kind: 'link', op }); return Promise.resolve({}); }) },
    };

    await syncMaterialReceiptReferences(prisma as any, {
      id: 'MR-9', receiptNumber: 'RPT-009', purchaseOrderId: 'PO-9', status: 'Accepted',
    }, { source: 'api:procurement', now: () => 1234 }, tx);
    await syncStockMovementReferences(prisma as any, {
      id: 'SM-9', movementNumber: 'SM-9', type: 'Inbound',
      itemId: 'INV-9', warehouseId: 'WH-9', referenceType: null, referenceId: null,
    }, { source: 'api:inventory', now: () => 1234 }, tx);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    // MR: 1 ref + 1 link；SM: 2 ref + 2 link（无 referencesDocument）
    expect(tx.entityReference.upsert).toHaveBeenCalledTimes(3);
    expect(tx.entityLink.upsert).toHaveBeenCalledTimes(3);
    expect(linkKindsOf(txOps)).toEqual(['forPurchaseOrder', 'movesItem', 'inWarehouse']);
  });
});
