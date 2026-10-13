import type { PrismaClient } from '@prisma/client';

type OrderLike = Record<string, any> & { id: string };

const ORDER_RELATION_FIELDS = [
  { fieldKey: 'customer', relationIdKey: 'customerRelationId', targetType: 'relation.organization', linkKind: 'orderedBy' },
  { fieldKey: 'millName', relationIdKey: 'millRelationId', targetType: 'relation.organization', linkKind: 'suppliedBy' },
  { fieldKey: 'consigneeName', relationIdKey: 'consigneeRelationId', targetType: 'relation.organization', linkKind: 'shipsTo' },
  { fieldKey: 'billToName', relationIdKey: 'billToRelationId', targetType: 'relation.organization', linkKind: 'billTo' },
  { fieldKey: 'salesPerson', relationIdKey: 'salesPersonRelationId', targetType: 'relation.person', linkKind: 'handledBy' },
  { fieldKey: 'merchandiser', relationIdKey: 'merchandiserRelationId', targetType: 'relation.person', linkKind: 'merchandisedBy' },
  { fieldKey: 'supervisor', relationIdKey: 'supervisorRelationId', targetType: 'relation.person', linkKind: 'supervisedBy' },
] as const;

export async function syncOrderEntityReferences(
  prisma: PrismaClient,
  order: OrderLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,
): Promise<void> {
  const ctx = tx || prisma;
  if (!order?.id) return;
  const now = options.now?.() ?? Date.now();
  const ops: any[] = [];

  for (const spec of ORDER_RELATION_FIELDS) {
    const relationId = stringOrNull(order[spec.relationIdKey]);
    if (!relationId) continue;
    const snapshot = compact({
      label: order[spec.fieldKey],
      relationId,
      fieldKey: spec.fieldKey,
    });
    const referenceId = referenceIdFor('order', order.id, spec.fieldKey, spec.targetType, relationId);
    const linkId = linkIdFor('order', order.id, spec.targetType, relationId, spec.linkKind);

    ops.push((ctx as any).entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot,
        confidence: 1,
        source: options.source,
        status: 'active',
        updatedAt: BigInt(now),
        deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'order',
        ownerId: order.id,
        fieldKey: spec.fieldKey,
        targetType: spec.targetType,
        targetId: relationId,
        snapshot,
        confidence: 1,
        source: options.source,
        status: 'active',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    }));

    ops.push((ctx as any).entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1,
        source: options.source,
        status: 'active',
        updatedAt: BigInt(now),
        deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'order',
        fromId: order.id,
        toType: spec.targetType,
        toId: relationId,
        linkKind: spec.linkKind,
        confidence: 1,
        source: options.source,
        status: 'active',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    }));
  }

  if (ops.length > 0) {
    if (tx) {
      for (const op of ops) await op;
    } else {
      await (prisma as any).$transaction(ops);
    }
  }
}

// ---------------------------------------------------------------------------
// DevelopmentCase ↔ Relation / Product sync
//
// Mirrors the Order pattern so the cross-module entity graph stays consistent.
// linkKinds: developFor (customer), developBy (supplier), aboutProduct.
// ---------------------------------------------------------------------------

const DEV_CASE_RELATION_FIELDS = [
  { fieldKey: 'customerName', relationIdKey: 'customerRelationId', targetType: 'relation.organization', linkKind: 'developFor' },
  { fieldKey: 'supplierName', relationIdKey: 'supplierRelationId', targetType: 'relation.organization', linkKind: 'developBy' },
] as const;

type DevCaseLike = Record<string, any> & { id: string };

export async function syncDevelopmentCaseReferences(
  prisma: PrismaClient,
  devCase: DevCaseLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,
): Promise<void> {
  const ctx = tx || prisma;
  if (!devCase?.id) return;
  const now = options.now?.() ?? Date.now();
  const ops: any[] = [];

  for (const spec of DEV_CASE_RELATION_FIELDS) {
    const relationId = stringOrNull(devCase[spec.relationIdKey]);
    if (!relationId) continue;
    const snapshot = compact({
      label: devCase[spec.fieldKey],
      relationId,
      fieldKey: spec.fieldKey,
    });
    const referenceId = referenceIdFor('development-case', devCase.id, spec.fieldKey, spec.targetType, relationId);
    const linkId = linkIdFor('development-case', devCase.id, spec.targetType, relationId, spec.linkKind);

    ops.push((ctx as any).entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'development-case', ownerId: devCase.id,
        fieldKey: spec.fieldKey,
        targetType: spec.targetType, targetId: relationId,
        snapshot, confidence: 1, source: options.source,
        status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push((ctx as any).entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'development-case', fromId: devCase.id,
        toType: spec.targetType, toId: relationId,
        linkKind: spec.linkKind,
        confidence: 1, source: options.source,
        status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  // productAssetId → product (any subtype)
  const productAssetId = stringOrNull(devCase.productAssetId);
  if (productAssetId) {
    const snapshot = compact({
      label: devCase.productName,
      productAssetId,
      fieldKey: 'productAssetId',
    });
    const referenceId = referenceIdFor('development-case', devCase.id, 'productAssetId', 'product', productAssetId);
    const linkId = linkIdFor('development-case', devCase.id, 'product', productAssetId, 'aboutProduct');

    ops.push((ctx as any).entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'development-case', ownerId: devCase.id,
        fieldKey: 'productAssetId',
        targetType: 'product', targetId: productAssetId,
        snapshot, confidence: 1, source: options.source,
        status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push((ctx as any).entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'development-case', fromId: devCase.id,
        toType: 'product', toId: productAssetId,
        linkKind: 'aboutProduct',
        confidence: 1, source: options.source,
        status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  if (ops.length > 0) {
    if (tx) {
      for (const op of ops) await op;
    } else {
      await (prisma as any).$transaction(ops);
    }
  }
}

// ---------------------------------------------------------------------------
// OrderLine ↔ Product sync
//
// linkKind: 'aboutMaterial' for fabric lines, 'aboutGarment' for garment lines.
// We resolve product reference via materialCode (= productAssetId) when present.
// ---------------------------------------------------------------------------

type OrderLineLike = Record<string, any> & { id: string; orderId: string };

export async function syncOrderLineEntityReferences(
  prisma: PrismaClient,
  line: OrderLineLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!line?.id) return;
  const productAssetId = stringOrNull(line.materialCode);
  if (!productAssetId) return;
  const now = options.now?.() ?? Date.now();
  const linkKind = line.type === 'garment' ? 'aboutGarment' : 'aboutMaterial';
  const snapshot = compact({
    label: line.description,
    productAssetId,
    fieldKey: 'materialCode',
    orderId: line.orderId,
    lineNumber: line.lineNumber,
  });
  const referenceId = referenceIdFor('orderLine', line.id, 'materialCode', 'product', productAssetId);
  const linkId = linkIdFor('orderLine', line.id, 'product', productAssetId, linkKind);

  if (tx) {
    // tx 模式：逐个 await（Prisma 禁止嵌套 $transaction）
    await tx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId,
        ownerType: 'orderLine', ownerId: line.id,
        fieldKey: 'materialCode',
        targetType: 'product', targetId: productAssetId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    });
    await tx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId,
        fromType: 'orderLine', fromId: line.id,
        toType: 'product', toId: productAssetId,
        linkKind,
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    });
  } else {
    // 非 tx 模式：$transaction([promise, promise]) 批量
    await (prisma as any).$transaction([
      (prisma as any).entityReference.upsert({
        where: { id: referenceId },
        update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
        create: {
          id: referenceId,
          ownerType: 'orderLine', ownerId: line.id,
          fieldKey: 'materialCode',
          targetType: 'product', targetId: productAssetId,
          snapshot, confidence: 1, source: options.source, status: 'active',
          createdAt: BigInt(now), updatedAt: BigInt(now),
        },
      }),
      (prisma as any).entityLink.upsert({
        where: { id: linkId },
        update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
        create: {
          id: linkId,
          fromType: 'orderLine', fromId: line.id,
          toType: 'product', toId: productAssetId,
          linkKind,
          confidence: 1, source: options.source, status: 'active',
          createdAt: BigInt(now), updatedAt: BigInt(now),
        },
      }),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Contact (relation.contact) ↔ Organization (relation.organization) sync
//
// linkKind: 'belongsTo'. We rely on Relation.parentId to express the
// hierarchy (contact's parent is its organization).
// ---------------------------------------------------------------------------

type RelationLike = Record<string, any> & { id: string };

export async function syncRelationEntityReferences(
  prisma: PrismaClient,
  relation: RelationLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,  // task: relations-audit-entitylink-contract: 可选事务上下文
): Promise<void> {
  if (!relation?.id) return;
  // Treat as contact if it has a parent organization. Don't rely on the
  // `type` field casing (DB has 'Contact', UI sometimes uses 'contact').
  if (relation.isOrganization === true) return;
  const parentId = stringOrNull(relation.parentId);
  if (!parentId) return;
  const now = options.now?.() ?? Date.now();
  // task: relations-audit-entitylink-contract: 有 tx 用 tx 构建 ops（事务内执行）
  const ctx = tx || prisma;
  const snapshot = compact({
    label: relation.name,
    parentId,
    fieldKey: 'parentId',
    role: relation.role,
  });
  const referenceId = referenceIdFor('relation.contact', relation.id, 'parentId', 'relation.organization', parentId);
  const linkId = linkIdFor('relation.contact', relation.id, 'relation.organization', parentId, 'belongsTo');

  const ops = [
    ctx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId,
        ownerType: 'relation.contact', ownerId: relation.id,
        fieldKey: 'parentId',
        targetType: 'relation.organization', targetId: parentId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }),
    ctx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId,
        fromType: 'relation.contact', fromId: relation.id,
        toType: 'relation.organization', toId: parentId,
        linkKind: 'belongsTo',
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }),
  ];

  if (tx) {
    // task: 事务内逐个 await（tx 无 $transaction，禁止嵌套）
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

// ---------------------------------------------------------------------------
// Invoice ↔ Order / Relation sync
//
// linkKinds: aboutOrder (orderId→order), billTo (customerRelationId→relation.organization).
// Mirrors the Order/DevCase pattern — dual-write EntityReference + EntityLink.
// ---------------------------------------------------------------------------

const INVOICE_RELATION_FIELDS = [
  { fieldKey: 'customerName', relationIdKey: 'customerRelationId', targetType: 'relation.organization', linkKind: 'billTo' },
] as const;

type InvoiceLike = Record<string, any> & { id: string };

/**
 * 构建 invoice 的 entityReference/entityLink ops（aboutOrder + billTo 两维度）。
 * 供 commitTransaction 在同一 $transaction 内执行，避免 syncInvoiceReferences 内部嵌套 $transaction。
 * 返回的 ops 是 PrismaPromise，caller 用 await Promise.all(ops) 或逐个 await。
 */
export function buildInvoiceReferenceOps(
  prisma: PrismaClient,
  invoice: InvoiceLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
): any[] {
  if (!invoice?.id) return [];
  const now = options.now?.() ?? Date.now();
  const ops: any[] = [];

  // 1) aboutOrder link — orderId → order
  const orderId = stringOrNull(invoice.orderId);
  if (orderId) {
    const snapshot = compact({
      orderId,
      fieldKey: 'orderId',
      invoiceNumber: invoice.invoiceNumber,
    });
    const referenceId = referenceIdFor('invoice', invoice.id, 'orderId', 'order', orderId);
    const linkId = linkIdFor('invoice', invoice.id, 'order', orderId, 'aboutOrder');

    ops.push((prisma as any).entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId, ownerType: 'invoice', ownerId: invoice.id, fieldKey: 'orderId',
        targetType: 'order', targetId: orderId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
    ops.push((prisma as any).entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId, fromType: 'invoice', fromId: invoice.id, toType: 'order', toId: orderId,
        linkKind: 'aboutOrder', confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  // 2) billTo link — customerRelationId → relation.organization
  for (const spec of INVOICE_RELATION_FIELDS) {
    const relationId = stringOrNull((invoice as any)[spec.relationIdKey]);
    if (!relationId) continue;
    const snapshot = compact({
      label: (invoice as any)[spec.fieldKey],
      relationId,
      fieldKey: spec.fieldKey,
    });
    const referenceId = referenceIdFor('invoice', invoice.id, spec.fieldKey, spec.targetType, relationId);
    const linkId = linkIdFor('invoice', invoice.id, spec.targetType, relationId, spec.linkKind);

    ops.push((prisma as any).entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId, ownerType: 'invoice', ownerId: invoice.id, fieldKey: spec.fieldKey,
        targetType: spec.targetType, targetId: relationId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
    ops.push((prisma as any).entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId, fromType: 'invoice', fromId: invoice.id, toType: spec.targetType, toId: relationId,
        linkKind: spec.linkKind, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  return ops;
}

export async function syncInvoiceReferences(
  prisma: PrismaClient,
  invoice: InvoiceLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,  // task_mqxxxu1g: 可选事务上下文，传入则在事务内逐个 await ops（不嵌套 $transaction）
): Promise<void> {
  // 复用 buildInvoiceReferenceOps（aboutOrder + billTo 两维度），避免逻辑漂移
  // task_mqxxxu1g: 有 tx 时用 tx 构建 ops（事务内执行），无 tx 保持原 $transaction 逻辑
  const ctx = tx || prisma;
  const ops = buildInvoiceReferenceOps(ctx, invoice, options);
  if (ops.length === 0) return;
  if (tx) {
    // 事务内：逐个 await（Prisma 禁止嵌套 $transaction）
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

// ---------------------------------------------------------------------------
// PaymentVoucher ↔ Order / Invoice / Relation sync
//
// linkKinds: aboutOrder (orderId→order), billTo (customerRelationId→relation.organization),
//            settlesInvoice (invoiceId→invoice).
// ---------------------------------------------------------------------------

const PAYMENT_VOUCHER_RELATION_FIELDS = [
  { fieldKey: 'customerName', relationIdKey: 'customerRelationId', targetType: 'relation.organization', linkKind: 'billTo' },
] as const;

type PaymentVoucherLike = Record<string, any> & { id: string };

export async function syncPaymentVoucherReferences(
  prisma: PrismaClient,
  voucher: PaymentVoucherLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,  // task_mqxxxu1g: 可选事务上下文
): Promise<void> {
  if (!voucher?.id) return;
  const now = options.now?.() ?? Date.now();
  const ctx = tx || prisma;  // task_mqxxxu1g: 有 tx 用 tx 构建 ops
  const ops: any[] = [];

  // 1) aboutOrder link — orderId → order
  const orderId = stringOrNull(voucher.orderId);
  if (orderId) {
    const snapshot = compact({
      orderId,
      fieldKey: 'orderId',
      voucherNumber: voucher.voucherNumber,
    });
    const referenceId = referenceIdFor('paymentVoucher', voucher.id, 'orderId', 'order', orderId);
    const linkId = linkIdFor('paymentVoucher', voucher.id, 'order', orderId, 'aboutOrder');

    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'paymentVoucher', ownerId: voucher.id,
        fieldKey: 'orderId',
        targetType: 'order', targetId: orderId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'paymentVoucher', fromId: voucher.id,
        toType: 'order', toId: orderId,
        linkKind: 'aboutOrder',
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  // 2) settlesInvoice link — invoiceId → invoice
  const invoiceId = stringOrNull(voucher.invoiceId);
  if (invoiceId) {
    const snapshot = compact({
      invoiceId,
      fieldKey: 'invoiceId',
      appliedAmount: voucher.appliedAmount,
      voucherNumber: voucher.voucherNumber,
    });
    const referenceId = referenceIdFor('paymentVoucher', voucher.id, 'invoiceId', 'invoice', invoiceId);
    const linkId = linkIdFor('paymentVoucher', voucher.id, 'invoice', invoiceId, 'settlesInvoice');

    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'paymentVoucher', ownerId: voucher.id,
        fieldKey: 'invoiceId',
        targetType: 'invoice', targetId: invoiceId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'paymentVoucher', fromId: voucher.id,
        toType: 'invoice', toId: invoiceId,
        linkKind: 'settlesInvoice',
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  // 3) billTo link — customerRelationId → relation.organization
  for (const spec of PAYMENT_VOUCHER_RELATION_FIELDS) {
    const relationId = stringOrNull(voucher[spec.relationIdKey]);
    if (!relationId) continue;
    const snapshot = compact({
      label: voucher[spec.fieldKey],
      relationId,
      fieldKey: spec.fieldKey,
    });
    const referenceId = referenceIdFor('paymentVoucher', voucher.id, spec.fieldKey, spec.targetType, relationId);
    const linkId = linkIdFor('paymentVoucher', voucher.id, spec.targetType, relationId, spec.linkKind);

    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'paymentVoucher', ownerId: voucher.id,
        fieldKey: spec.fieldKey,
        targetType: spec.targetType, targetId: relationId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'paymentVoucher', fromId: voucher.id,
        toType: spec.targetType, toId: relationId,
        linkKind: spec.linkKind,
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  if (ops.length === 0) return;
  if (tx) {
    // task_mqxxxu1g: 事务内逐个 await（tx 无 $transaction，禁止嵌套）
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

// ---------------------------------------------------------------------------
// 阶段 F / F2：FxSettlement（结汇水单）图谱链接
//   settlesVoucher — voucherId → paymentVoucher（核销勾稽主干）
//   aboutOrder     — orderId → order
//   billTo         — customerRelationId → relation.organization
// ---------------------------------------------------------------------------

type FxSettlementLike = Record<string, any> & { id: string };

export async function syncFxSettlementReferences(
  prisma: PrismaClient,
  settlement: FxSettlementLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!settlement?.id) return;
  const now = options.now?.() ?? Date.now();
  const ctx = tx || prisma;
  const ops: any[] = [];

  const push = (fieldKey: string, targetType: string, targetId: string, linkKind: string, extraSnapshot: Record<string, any> = {}) => {
    const snapshot = compact({ targetId, fieldKey, settlementNumber: settlement.settlementNumber, ...extraSnapshot });
    const referenceId = referenceIdFor('fxSettlement', settlement.id, fieldKey, targetType, targetId);
    const linkId = linkIdFor('fxSettlement', settlement.id, targetType, targetId, linkKind);
    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId,
        ownerType: 'fxSettlement', ownerId: settlement.id,
        fieldKey, targetType, targetId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId,
        fromType: 'fxSettlement', fromId: settlement.id,
        toType: targetType, toId: targetId,
        linkKind, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  };

  const voucherId = stringOrNull(settlement.voucherId);
  if (voucherId) push('voucherId', 'paymentVoucher', voucherId, 'settlesVoucher', { foreignAmount: settlement.foreignAmount, currency: settlement.currency });
  const orderId = stringOrNull(settlement.orderId);
  if (orderId) push('orderId', 'order', orderId, 'aboutOrder');
  const relationId = stringOrNull(settlement.customerRelationId);
  if (relationId) push('customerRelationId', 'relation.organization', relationId, 'billTo');

  if (ops.length === 0) return;
  if (tx) {
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

// ---------------------------------------------------------------------------
// OutwardRemittance ↔ PaymentVoucher / Order / Relation sync（阶段 C6，镜像 fxSettlement）
// linkKinds: paysVoucher / aboutOrder / billTo
// ---------------------------------------------------------------------------

type OutwardRemittanceLike = Record<string, any> & { id: string };

export async function syncOutwardRemittanceReferences(
  prisma: PrismaClient,
  remittance: OutwardRemittanceLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!remittance?.id) return;
  const now = options.now?.() ?? Date.now();
  const ctx = tx || prisma;
  const ops: any[] = [];

  const push = (fieldKey: string, targetType: string, targetId: string, linkKind: string, extraSnapshot: Record<string, any> = {}) => {
    const snapshot = compact({ targetId, fieldKey, remittanceNumber: remittance.remittanceNumber, ...extraSnapshot });
    const referenceId = referenceIdFor('outwardRemittance', remittance.id, fieldKey, targetType, targetId);
    const linkId = linkIdFor('outwardRemittance', remittance.id, targetType, targetId, linkKind);
    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId,
        ownerType: 'outwardRemittance', ownerId: remittance.id,
        fieldKey, targetType, targetId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId,
        fromType: 'outwardRemittance', fromId: remittance.id,
        toType: targetType, toId: targetId,
        linkKind, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  };

  const voucherId = stringOrNull(remittance.voucherId);
  if (voucherId) push('voucherId', 'paymentVoucher', voucherId, 'paysVoucher', { foreignAmount: remittance.foreignAmount, currency: remittance.currency });
  const orderId = stringOrNull(remittance.orderId);
  if (orderId) push('orderId', 'order', orderId, 'aboutOrder');
  const relationId = stringOrNull(remittance.customerRelationId);
  if (relationId) push('customerRelationId', 'relation.organization', relationId, 'billTo');

  if (ops.length === 0) return;
  if (tx) {
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

// ---------------------------------------------------------------------------
// VatInvoice ↔ Invoice / Order / Relation / TaxRefund sync（阶段 C6）
// linkKinds: settlesInvoice / aboutOrder / billTo / declaredInRefund
// ---------------------------------------------------------------------------

type VatInvoiceLike = Record<string, any> & { id: string };

export async function syncVatInvoiceReferences(
  prisma: PrismaClient,
  vatInvoice: VatInvoiceLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!vatInvoice?.id) return;
  const now = options.now?.() ?? Date.now();
  const ctx = tx || prisma;
  const ops: any[] = [];

  const push = (fieldKey: string, targetType: string, targetId: string, linkKind: string, extraSnapshot: Record<string, any> = {}) => {
    const snapshot = compact({ targetId, fieldKey, vatNumber: vatInvoice.vatNumber, ...extraSnapshot });
    const referenceId = referenceIdFor('vatInvoice', vatInvoice.id, fieldKey, targetType, targetId);
    const linkId = linkIdFor('vatInvoice', vatInvoice.id, targetType, targetId, linkKind);
    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId,
        ownerType: 'vatInvoice', ownerId: vatInvoice.id,
        fieldKey, targetType, targetId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId,
        fromType: 'vatInvoice', fromId: vatInvoice.id,
        toType: targetType, toId: targetId,
        linkKind, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  };

  const invoiceId = stringOrNull(vatInvoice.invoiceId);
  if (invoiceId) push('invoiceId', 'invoice', invoiceId, 'settlesInvoice', { totalAmount: vatInvoice.totalAmount });
  const orderId = stringOrNull(vatInvoice.orderId);
  if (orderId) push('orderId', 'order', orderId, 'aboutOrder');
  const relationId = stringOrNull(vatInvoice.relationId);
  if (relationId) push('relationId', 'relation.organization', relationId, 'billTo');
  const taxRefundId = stringOrNull(vatInvoice.taxRefundId);
  if (taxRefundId) push('taxRefundId', 'taxRefund', taxRefundId, 'declaredInRefund');

  if (ops.length === 0) return;
  if (tx) {
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

export function referenceIdFor(ownerType: string, ownerId: string, fieldKey: string, targetType: string, targetId: string): string {
  return ['REF', ownerType, ownerId, fieldKey, targetType, targetId].map(safeIdPart).join('__');
}

export function linkIdFor(fromType: string, fromId: string, toType: string, toId: string, linkKind: string): string {
  return ['LINK', fromType, fromId, linkKind, toType, toId].map(safeIdPart).join('__');
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeIdPart(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
}

export function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

// ---------------------------------------------------------------------------
// Shipment ↔ Order / Relation sync
//
// linkKinds:
//   - aboutOrder (orderId→order): 运单关联订单
//   - billTo (customerRelationId→relation.organization): 运单的收货方/结算对象
//   - shipsVia (carrierRelationId→relation.organization): 运单的货运代理/船公司
//     注：schema 字段为 carrierRelationId/carrierName（与 route/toolRuntime 一致）
// ---------------------------------------------------------------------------

const SHIPMENT_RELATION_FIELDS = [
  { fieldKey: 'customerName', relationIdKey: 'customerRelationId', targetType: 'relation.organization', linkKind: 'billTo' },
  { fieldKey: 'carrierName', relationIdKey: 'carrierRelationId', targetType: 'relation.organization', linkKind: 'shipsVia' },
] as const;

type ShipmentLike = Record<string, any> & { id: string };

export async function syncShipmentReferences(
  prisma: PrismaClient,
  shipment: ShipmentLike,
  options: { source: string; now?: () => number } = { source: 'manual' },
  tx?: any,  // task_mqxxxu3k: 可选事务上下文
): Promise<void> {
  if (!shipment?.id) return;
  const now = options.now?.() ?? Date.now();
  const ctx = tx || prisma;  // task_mqxxxu3k: 有 tx 用 tx 构建 ops
  const ops: any[] = [];

  // 1) aboutOrder link — orderId → order
  const orderId = stringOrNull(shipment.orderId);
  if (orderId) {
    const snapshot = compact({
      orderId,
      fieldKey: 'orderId',
      shipmentNumber: shipment.shipmentNumber,
    });
    const referenceId = referenceIdFor('shipment', shipment.id, 'orderId', 'order', orderId);
    const linkId = linkIdFor('shipment', shipment.id, 'order', orderId, 'aboutOrder');

    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'shipment', ownerId: shipment.id,
        fieldKey: 'orderId',
        targetType: 'order', targetId: orderId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'shipment', fromId: shipment.id,
        toType: 'order', toId: orderId,
        linkKind: 'aboutOrder',
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  // 2) billTo + shipsVia links — customerRelationId / carrierRelationId → relation.organization
  for (const spec of SHIPMENT_RELATION_FIELDS) {
    const relationId = stringOrNull(shipment[spec.relationIdKey]);
    if (!relationId) continue;
    const snapshot = compact({
      label: shipment[spec.fieldKey],
      relationId,
      fieldKey: spec.fieldKey,
    });
    const referenceId = referenceIdFor('shipment', shipment.id, spec.fieldKey, spec.targetType, relationId);
    const linkId = linkIdFor('shipment', shipment.id, spec.targetType, relationId, spec.linkKind);

    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'shipment', ownerId: shipment.id,
        fieldKey: spec.fieldKey,
        targetType: spec.targetType, targetId: relationId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'shipment', fromId: shipment.id,
        toType: spec.targetType, toId: relationId,
        linkKind: spec.linkKind,
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  if (ops.length === 0) return;
  if (tx) {
    // task_mqxxxu3k: 事务内逐个 await（tx 无 $transaction，禁止嵌套）
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}


/**
 * ERP-P1-order-lifecycle: 共享 helper（把 owner 发出的所有 active EntityLink + EntityReference 置 inactive）。
 * order/finance 软删共用，避免逻辑漂移。
 */
export async function deactivateEntityLinks(tx: any, ownerType: string, ownerId: string, now: bigint): Promise<void> {
  const links = await tx.entityLink.findMany({
    where: { fromType: ownerType, fromId: ownerId, status: 'active' },
    select: { id: true },
  });
  for (const link of links) {
    await tx.entityLink.update({
      where: { id: link.id },
      data: { status: 'inactive', updatedAt: now, deletedAt: now },
    });
  }
  const refs = await tx.entityReference.findMany({
    where: { ownerType, ownerId, status: 'active' },
    select: { id: true },
  });
  for (const ref of refs) {
    await tx.entityReference.update({
      where: { id: ref.id },
      data: { status: 'inactive', updatedAt: now, deletedAt: now },
    });
  }
}

// ---------------------------------------------------------------------------
// 阶段 D / D1.1a：主链路实体图谱补缺
//
// Quotation / BOM / PurchaseOrder / CustomsDeclaration / TaxRefund / Opportunity
// 六类主链路实体此前零图谱覆盖。以下 sync 函数与既有 Order/Invoice/Shipment
// 模式语义完全一致（entityReference + entityLink 双写、确定性 ID、tx 感知），
// 通过共享的 spec 驱动 helper 消除六份重复。
//
// 服务挂载点（create/update 事务内调用，软删走 deactivateEntityLinks）：
//   quotationService / bomService / procurementService / customsService / crm服务
// 手动操作与 L6-L10 自动联动共享同一 service 入口，单点修复双路受益。
// ---------------------------------------------------------------------------

type EntityLinkSpec = {
  /** EntityReference.fieldKey（快照键） */
  fieldKey: string;
  /** 人类可读标签（冗余快照名） */
  label?: unknown;
  /** 目标实体类型，如 'order' / 'relation.organization' / 'product' / 'bom' / 'quotation' / 'shipment' / 'customsDeclaration' */
  targetType: string;
  /** FK 值（空则跳过该条） */
  targetId: unknown;
  linkKind: string;
  /** 额外快照字段（如单号） */
  snapshotExtra?: Record<string, unknown>;
};

type SyncOptions = { source: string; now?: () => number };

function buildEntitySyncOps(
  ctx: any,
  ownerType: string,
  ownerId: string,
  specs: EntityLinkSpec[],
  options: SyncOptions,
): any[] {
  const now = options.now?.() ?? Date.now();
  const ops: any[] = [];
  for (const spec of specs) {
    const targetId = stringOrNull(spec.targetId);
    if (!targetId) continue;
    const snapshot = compact({
      label: spec.label,
      fieldKey: spec.fieldKey,
      targetId,
      ...(spec.snapshotExtra ?? {}),
    });
    const referenceId = referenceIdFor(ownerType, ownerId, spec.fieldKey, spec.targetType, targetId);
    const linkId = linkIdFor(ownerType, ownerId, spec.targetType, targetId, spec.linkKind);

    ops.push(ctx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId,
        ownerType, ownerId,
        fieldKey: spec.fieldKey,
        targetType: spec.targetType, targetId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
    ops.push(ctx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId,
        fromType: ownerType, fromId: ownerId,
        toType: spec.targetType, toId: targetId,
        linkKind: spec.linkKind,
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }
  return ops;
}

async function runEntitySyncOps(prisma: PrismaClient, ops: any[], tx?: any): Promise<void> {
  if (ops.length === 0) return;
  if (tx) {
    for (const op of ops) await op;
  } else {
    await (prisma as any).$transaction(ops);
  }
}

type QuotationLike = Record<string, any> & { id: string };

/** Quotation → Relation(quotedFor) / Order(convertedToOrder) */
export async function syncQuotationReferences(
  prisma: PrismaClient,
  quotation: QuotationLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!quotation?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'quotation', quotation.id, [
    {
      fieldKey: 'customerRelationId', label: quotation.customerName,
      targetType: 'relation.organization', targetId: quotation.customerRelationId, linkKind: 'quotedFor',
      snapshotExtra: { quotationNumber: quotation.quotationNumber },
    },
    {
      fieldKey: 'convertedOrderId', label: quotation.quotationNumber,
      targetType: 'order', targetId: quotation.convertedOrderId, linkKind: 'convertedToOrder',
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type BomLike = Record<string, any> & { id: string };

/** BOM → Order(forOrder) / Product(aboutProduct) / Quotation(fromQuotation) */
export async function syncBomReferences(
  prisma: PrismaClient,
  bom: BomLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!bom?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'bom', bom.id, [
    {
      fieldKey: 'orderId', label: bom.bomNumber,
      targetType: 'order', targetId: bom.orderId, linkKind: 'forOrder',
      snapshotExtra: { bomNumber: bom.bomNumber },
    },
    {
      fieldKey: 'productAssetId', label: bom.description,
      targetType: 'product', targetId: bom.productAssetId, linkKind: 'aboutProduct',
      snapshotExtra: { bomNumber: bom.bomNumber },
    },
    {
      fieldKey: 'quotationId', label: bom.bomNumber,
      targetType: 'quotation', targetId: bom.quotationId, linkKind: 'fromQuotation',
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type PurchaseOrderLike = Record<string, any> & { id: string };

/** PurchaseOrder → Relation(purchasedFrom) / Order(forOrder) / BOM(fromBom) / Quotation(fromQuotation) */
export async function syncPurchaseOrderReferences(
  prisma: PrismaClient,
  po: PurchaseOrderLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!po?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'purchaseOrder', po.id, [
    {
      fieldKey: 'supplierRelationId', label: po.supplierName,
      targetType: 'relation.organization', targetId: po.supplierRelationId, linkKind: 'purchasedFrom',
      snapshotExtra: { poNumber: po.poNumber },
    },
    {
      fieldKey: 'orderId', label: po.poNumber,
      targetType: 'order', targetId: po.orderId, linkKind: 'forOrder',
    },
    {
      fieldKey: 'bomId', label: po.poNumber,
      targetType: 'bom', targetId: po.bomId, linkKind: 'fromBom',
    },
    {
      fieldKey: 'quotationId', label: po.poNumber,
      targetType: 'quotation', targetId: po.quotationId, linkKind: 'fromQuotation',
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type CustomsDeclarationLike = Record<string, any> & { id: string };

/** CustomsDeclaration → Shipment(clearsShipment) / Order(aboutOrder) / Relation(declaredFor) */
export async function syncCustomsDeclarationReferences(
  prisma: PrismaClient,
  declaration: CustomsDeclarationLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!declaration?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'customsDeclaration', declaration.id, [
    {
      fieldKey: 'shipmentId', label: declaration.declarationNumber,
      targetType: 'shipment', targetId: declaration.shipmentId, linkKind: 'clearsShipment',
      snapshotExtra: { declarationNumber: declaration.declarationNumber },
    },
    {
      fieldKey: 'orderId', label: declaration.declarationNumber,
      targetType: 'order', targetId: declaration.orderId, linkKind: 'aboutOrder',
    },
    {
      fieldKey: 'relationId', label: declaration.declarationNumber,
      targetType: 'relation.organization', targetId: declaration.relationId, linkKind: 'declaredFor',
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type TaxRefundLike = Record<string, any> & { id: string };

/** TaxRefund → CustomsDeclaration(refundsDeclaration) / Order(aboutOrder) / Relation(refundTo) */
export async function syncTaxRefundReferences(
  prisma: PrismaClient,
  refund: TaxRefundLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!refund?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'taxRefund', refund.id, [
    {
      fieldKey: 'declarationId', label: refund.refundNumber,
      targetType: 'customsDeclaration', targetId: refund.declarationId, linkKind: 'refundsDeclaration',
      snapshotExtra: { refundNumber: refund.refundNumber },
    },
    {
      fieldKey: 'orderId', label: refund.refundNumber,
      targetType: 'order', targetId: refund.orderId, linkKind: 'aboutOrder',
    },
    {
      fieldKey: 'relationId', label: refund.refundNumber,
      targetType: 'relation.organization', targetId: refund.relationId, linkKind: 'refundTo',
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type LetterOfCreditLike = Record<string, any> & { id: string };

/** LetterOfCredit → Relation(creditOpenedBy 开证客户) / Order(aboutOrder)（F1 图谱收口） */
export async function syncLetterOfCreditReferences(
  prisma: PrismaClient,
  lc: LetterOfCreditLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!lc?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'letterOfCredit', lc.id, [
    {
      fieldKey: 'relationId', label: lc.lcNumber,
      targetType: 'relation.organization', targetId: lc.relationId, linkKind: 'creditOpenedBy',
      snapshotExtra: { lcNumber: lc.lcNumber, status: lc.status },
    },
    {
      fieldKey: 'orderId', label: lc.lcNumber,
      targetType: 'order', targetId: lc.orderId, linkKind: 'aboutOrder',
      snapshotExtra: { lcNumber: lc.lcNumber, status: lc.status },
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type OpportunityLike = Record<string, any> & { id: string };

/** Opportunity → Relation(opportunityFor) / Order(convertedToOrder，成交后) */
export async function syncOpportunityReferences(
  prisma: PrismaClient,
  opportunity: OpportunityLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!opportunity?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'opportunity', opportunity.id, [
    {
      fieldKey: 'relationId', label: opportunity.title,
      targetType: 'relation.organization', targetId: opportunity.relationId, linkKind: 'opportunityFor',
      snapshotExtra: { stage: opportunity.stage },
    },
    {
      fieldKey: 'orderId', label: opportunity.title,
      targetType: 'order', targetId: opportunity.orderId, linkKind: 'convertedToOrder',
      snapshotExtra: { stage: opportunity.stage },
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

// ---------------------------------------------------------------------------
// 阶段 D / D2：ProductAsset ↔ Relation 图谱（关系完整性收口）
//
// 面料 mill / 成衣 customer+factory / 辅料 supplier 由裸文本升级为
// snapshot + FK 双写（与 Order.customerRelationId 模式一致），FK 入图：
//   product → relation.organization
//   linkKind: suppliedBy（面料 mill / 辅料 supplier）
//             producedFor（成衣客户）/ manufacturedBy（成衣工厂）
// 挂载点：products route POST/PATCH 事务内（profile upsert 之后）。
// ---------------------------------------------------------------------------

type ProductAssetLike = Record<string, any> & { id: string };

/** ProductAsset → Relation(suppliedBy / producedFor / manufacturedBy) */
export async function syncProductAssetReferences(
  prisma: PrismaClient,
  product: ProductAssetLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!product?.id) return;
  const ctx = tx || prisma;
  const label = product.name ?? product.sku;
  const fabric = product.fabricProfile;
  const garment = product.garmentProfile;
  const trimming = product.trimmingProfile;
  const ops = buildEntitySyncOps(ctx, 'product', product.id, [
    {
      fieldKey: 'fabricProfile.millOrganizationId', label,
      targetType: 'relation.organization', targetId: fabric?.millOrganizationId, linkKind: 'suppliedBy',
      snapshotExtra: { mainCategory: 'Fabric', millName: fabric?.millName, sku: product.sku },
    },
    {
      fieldKey: 'garmentProfile.customerRelationId', label,
      targetType: 'relation.organization', targetId: garment?.customerRelationId, linkKind: 'producedFor',
      snapshotExtra: { mainCategory: 'Garment', customer: garment?.customer, sku: product.sku },
    },
    {
      fieldKey: 'garmentProfile.factoryRelationId', label,
      targetType: 'relation.organization', targetId: garment?.factoryRelationId, linkKind: 'manufacturedBy',
      snapshotExtra: { mainCategory: 'Garment', factory: garment?.factory, sku: product.sku },
    },
    {
      fieldKey: 'trimmingProfile.supplierRelationId', label,
      targetType: 'relation.organization', targetId: trimming?.supplierRelationId, linkKind: 'suppliedBy',
      snapshotExtra: { mainCategory: 'Trimmings', supplier: trimming?.supplier, sku: product.sku },
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

// ---------------------------------------------------------------------------
// 阶段 D / D5：OutsourcingOrder ↔ Relation/Order/BOM sync
// 外协单 FK 入图（D1.1a 豁免项在此落地）：
//   outsourcedTo（supplierId→relation.organization）
//   forOrder（orderId→order）/ fromBom（bomId→bom）
// 挂载点：mesService createOutsourcingOrder / updateOutsourcingOrder 事务内。
// ---------------------------------------------------------------------------

type OutsourcingOrderLike = Record<string, any> & { id: string };

/** OutsourcingOrder → Relation(outsourcedTo) / Order(forOrder) / BOM(fromBom) */
export async function syncOutsourcingOrderReferences(
  prisma: PrismaClient,
  outsourcingOrder: OutsourcingOrderLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!outsourcingOrder?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'outsourcingOrder', outsourcingOrder.id, [
    {
      fieldKey: 'supplierId', label: outsourcingOrder.orderNumber,
      targetType: 'relation.organization', targetId: outsourcingOrder.supplierId, linkKind: 'outsourcedTo',
      snapshotExtra: { orderNumber: outsourcingOrder.orderNumber, processType: outsourcingOrder.processType },
    },
    {
      fieldKey: 'orderId', label: outsourcingOrder.orderNumber,
      targetType: 'order', targetId: outsourcingOrder.orderId, linkKind: 'forOrder',
    },
    {
      fieldKey: 'bomId', label: outsourcingOrder.orderNumber,
      targetType: 'bom', targetId: outsourcingOrder.bomId, linkKind: 'fromBom',
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

// ---------------------------------------------------------------------------
// W-C 功能修复任务包 A1：采购→收货→库存追溯链断链修复（S2 三击追溯铁律）
//
// MaterialReceipt / StockMovement 此前零图谱覆盖，三击追溯在
// 「采购→收货→库存」链查不到。以下 sync 函数与既有 spec 驱动模式语义一致
// （entityReference + entityLink 双写、确定性 ID、tx 感知）。
//
// linkKinds:
//   MaterialReceipt: forPurchaseOrder（purchaseOrderId→purchaseOrder）
//                    stockedAs（stockItemId→inventoryItem，如有则入图）
//   StockMovement:   movesItem（itemId→inventoryItem）
//                    inWarehouse（warehouseId→warehouse）
//                    referencesDocument（referenceType+referenceId→关联单据，如有）
// 挂载点：procurementService.createMaterialReceipt 事务内；
//         inventoryService 三处 stockMovement.create 之后（同事务）。
// ---------------------------------------------------------------------------

type MaterialReceiptLike = Record<string, any> & { id: string };

/** MaterialReceipt → PurchaseOrder(forPurchaseOrder) / InventoryItem(stockedAs，如有) */
export async function syncMaterialReceiptReferences(
  prisma: PrismaClient,
  receipt: MaterialReceiptLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!receipt?.id) return;
  const ctx = tx || prisma;
  const ops = buildEntitySyncOps(ctx, 'materialReceipt', receipt.id, [
    {
      fieldKey: 'purchaseOrderId', label: receipt.receiptNumber,
      targetType: 'purchaseOrder', targetId: receipt.purchaseOrderId, linkKind: 'forPurchaseOrder',
      snapshotExtra: { receiptNumber: receipt.receiptNumber, status: receipt.status },
    },
    {
      // schema 无此列（MaterialReceipt 为 PO 级汇总口径）；调用方携带时入图，缺省跳过
      fieldKey: 'stockItemId', label: receipt.receiptNumber,
      targetType: 'inventoryItem', targetId: receipt.stockItemId, linkKind: 'stockedAs',
      snapshotExtra: { receiptNumber: receipt.receiptNumber },
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}

type StockMovementLike = Record<string, any> & { id: string };

/** referenceType（schema 注释口径）→ 图谱目标实体类型；Manual/Adjustment 等非单据来源不入图 */
const STOCK_MOVEMENT_REFERENCE_TARGET_TYPES: Record<string, string> = {
  PurchaseOrder: 'purchaseOrder',
  MaterialReceipt: 'materialReceipt',
  Order: 'order',
  Shipment: 'shipment',
  ProductionStage: 'productionStage',
  Transfer: 'stockMovement',
  InventoryTransfer: 'inventoryTransfer',
};

/** StockMovement → InventoryItem(movesItem) / Warehouse(inWarehouse) / 关联单据(referencesDocument，如有) */
export async function syncStockMovementReferences(
  prisma: PrismaClient,
  movement: StockMovementLike,
  options: SyncOptions = { source: 'manual' },
  tx?: any,
): Promise<void> {
  if (!movement?.id) return;
  const ctx = tx || prisma;
  const referenceTargetType = STOCK_MOVEMENT_REFERENCE_TARGET_TYPES[String(movement.referenceType ?? '')];
  const ops = buildEntitySyncOps(ctx, 'stockMovement', movement.id, [
    {
      fieldKey: 'itemId', label: movement.movementNumber,
      targetType: 'inventoryItem', targetId: movement.itemId, linkKind: 'movesItem',
      snapshotExtra: { movementNumber: movement.movementNumber, type: movement.type },
    },
    {
      fieldKey: 'warehouseId', label: movement.movementNumber,
      targetType: 'warehouse', targetId: movement.warehouseId, linkKind: 'inWarehouse',
    },
    {
      fieldKey: 'referenceId', label: movement.movementNumber,
      targetType: referenceTargetType ?? 'document',
      targetId: referenceTargetType ? movement.referenceId : null,
      linkKind: 'referencesDocument',
      snapshotExtra: { referenceType: movement.referenceType },
    },
  ], options);
  await runEntitySyncOps(prisma, ops, tx);
}
