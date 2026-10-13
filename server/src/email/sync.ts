/**
 * Email Entity Sync — EntityReference + EntityLink 双写
 * Phase 4a
 *
 * linkKind 注册：
 *   - sentBy:        email → relation (发件人/收件人联系人)
 *   - aboutOrder:    email → order   (邮件涉及某订单)
 *   - aboutInvoice:  email → invoice (邮件涉及某发票)
 */

import type { PrismaClient } from '@prisma/client';
import { referenceIdFor, linkIdFor } from '../entities/sync';

type EmailLike = Record<string, any> & { id: string };

const EMAIL_LINKS = [
  { fieldKey: 'relationId', targetType: 'relation', linkKind: 'sentBy', labelKey: 'relationName' },
  { fieldKey: 'orderId', targetType: 'order', linkKind: 'aboutOrder', labelKey: 'orderPo' },
  { fieldKey: 'invoiceId', targetType: 'invoice', linkKind: 'aboutInvoice', labelKey: 'invoiceNumber' },
] as const;

export async function syncEmailReferences(
  prisma: PrismaClient,
  email: EmailLike,
  options: { source: string; now?: () => number; tx?: any } = { source: 'email-sync' },
): Promise<void> {
  if (!email?.id) return;
  const now = options.now?.() ?? Date.now();
  const client = options.tx || prisma;
  const ops: any[] = [];

  for (const spec of EMAIL_LINKS) {
    const targetId = stringOrNull(email[spec.fieldKey]);
    if (!targetId) continue;

    const snapshot = compact({
      label: email[spec.labelKey],
      [spec.fieldKey]: targetId,
    });

    const referenceId = referenceIdFor('email', email.id, spec.fieldKey, spec.targetType, targetId);
    const linkId = linkIdFor('email', email.id, spec.targetType, targetId, spec.linkKind);

    ops.push((client as any).entityReference.upsert({
      where: { id: referenceId },
      update: {
        snapshot, confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: referenceId,
        ownerType: 'email', ownerId: email.id,
        fieldKey: spec.fieldKey,
        targetType: spec.targetType, targetId,
        snapshot, confidence: 1, source: options.source,
        status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));

    ops.push((client as any).entityLink.upsert({
      where: { id: linkId },
      update: {
        confidence: 1, source: options.source,
        status: 'active', updatedAt: BigInt(now), deletedAt: null,
      },
      create: {
        id: linkId,
        fromType: 'email', fromId: email.id,
        toType: spec.targetType, toId: targetId,
        linkKind: spec.linkKind,
        confidence: 1, source: options.source,
        status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    }));
  }

  if (ops.length > 0) {
    if (options.tx) {
      await Promise.all(ops);
    } else {
      await (prisma as any).$transaction(ops);
    }
  }
}

function stringOrNull(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}
