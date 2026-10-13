/**
 * Phase C2 — 邮件自动归档服务（邮件 → 客户/订单）
 *
 * 业务背景：外贸"邮件即档案"——进出邮件应按收发地址自动归入客户档案，
 * 主题含 PO 号时自动关联订单，业务/财务/跟单可在任意实体侧追溯邮件。
 *
 * 匹配口径（确定性、可解释、无 AI 猜测）：
 *   - 客户匹配：inbound 取 fromAddress，outbound 取首个 toAddress；
 *     与 Relation.email（联系人）/ Relation.primaryContactEmail（组织主联系人）
 *     小写精确比对；联系人优先于组织，其次 rating 高者，最后 id 字典序
 *   - 订单匹配：主题（snippet 兜底）包含 poNumber（长度 ≥4 防误配），
 *     已知客户时仅在该客户订单内匹配；多个命中取最长 poNumber
 *   - 手工优先：已有 relationId/orderId 的邮件绝不覆盖
 *
 * 性能：backfill / IMAP sync 批量场景先建内存索引，避免逐封全表扫描
 */

import type { PrismaClient } from '@prisma/client';
import { syncEmailReferences } from './sync';
import { writeRouteAuditLog } from '../audit/routeAudit';

// ────────────────────────────────────────────────────────────────
// 地址与客户匹配
// ────────────────────────────────────────────────────────────────

export interface RelationCandidate {
  id: string;
  displayName: string;
  isOrganization: boolean;
  rating: number;
}

export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const angle = s.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : s).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

/** 从 toAddresses JSON 数组取首个有效地址 */
export function firstToAddress(toAddressesJson: string | null | undefined): string | null {
  if (!toAddressesJson) return null;
  try {
    const arr = JSON.parse(toAddressesJson);
    if (!Array.isArray(arr)) return null;
    for (const item of arr) {
      const addr = normalizeAddress(typeof item === 'string' ? item : (item as any)?.address);
      if (addr) return addr;
    }
  } catch { /* 非法 JSON 视为无地址 */ }
  return null;
}

/** 建地址 → 客户 索引（每封邮件 O(1) 查询） */
export function buildRelationAddressIndex(
  relations: Array<{ id: string; name: string; chineseName: string | null; email: string | null; primaryContactEmail: string | null; isOrganization: boolean; rating: number }>,
): Map<string, RelationCandidate> {
  const index = new Map<string, RelationCandidate>();
  for (const r of relations) {
    const candidate: RelationCandidate = {
      id: r.id,
      displayName: r.chineseName || r.name,
      isOrganization: r.isOrganization,
      rating: r.rating ?? 0,
    };
    for (const raw of [r.email, r.primaryContactEmail]) {
      const addr = normalizeAddress(raw);
      if (!addr) continue;
      const existing = index.get(addr);
      if (!existing) { index.set(addr, candidate); continue; }
      // 联系人优先于组织；同级 rating 高者优先；再 id 字典序保证确定性
      if (existing.isOrganization && !candidate.isOrganization) index.set(addr, candidate);
      else if (existing.isOrganization === candidate.isOrganization) {
        if (candidate.rating > existing.rating) index.set(addr, candidate);
        else if (candidate.rating === existing.rating && candidate.id < existing.id) index.set(addr, candidate);
      }
    }
  }
  return index;
}

export async function loadRelationAddressIndex(prisma: PrismaClient): Promise<Map<string, RelationCandidate>> {
  const relations = await prisma.relation.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, chineseName: true, email: true, primaryContactEmail: true, isOrganization: true, rating: true },
  });
  return buildRelationAddressIndex(relations);
}

// ────────────────────────────────────────────────────────────────
// 订单 PO 匹配
// ────────────────────────────────────────────────────────────────

export interface OrderCandidate {
  id: string;
  poNumber: string;
  customerRelationId: string | null;
}

const MIN_PO_MATCH_LENGTH = 4;

/**
 * 主题（或 snippet）包含 poNumber 即命中；已知客户时仅在该客户订单内匹配
 * （防跨客户 PO 子串误配）；多命中取最长 poNumber（更具体的编号优先）
 */
export function matchOrderBySubject(
  orders: OrderCandidate[],
  text: string | null | undefined,
  customerRelationId?: string | null,
): OrderCandidate | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  let best: OrderCandidate | null = null;
  for (const o of orders) {
    if (!o.poNumber || o.poNumber.length < MIN_PO_MATCH_LENGTH) continue;
    if (customerRelationId && o.customerRelationId !== customerRelationId) continue;
    if (!haystack.includes(o.poNumber.toLowerCase())) continue;
    if (!best || o.poNumber.length > best.poNumber.length) best = o;
  }
  return best;
}

export async function loadOrderCandidates(prisma: PrismaClient): Promise<OrderCandidate[]> {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, poNumber: { not: null } },
    select: { id: true, poNumber: true, customerRelationId: true },
  });
  return orders.filter(o => o.poNumber).map(o => ({ id: o.id, poNumber: o.poNumber!, customerRelationId: o.customerRelationId }));
}

// ────────────────────────────────────────────────────────────────
// 链接计算与应用
// ────────────────────────────────────────────────────────────────

export interface EmailLinkUpdate {
  relationId?: string;
  relationName?: string;
  orderId?: string;
  orderPo?: string;
}

/** 纯计算：给定邮件当前状态，求应补充的链接（不覆盖已有值） */
export function computeEmailLinkUpdates(
  email: {
    relationId: string | null; orderId: string | null;
    direction: string; fromAddress: string; toAddresses: string | null;
    subject: string; snippet: string | null;
  },
  relationIndex: Map<string, RelationCandidate>,
  orders: OrderCandidate[],
): EmailLinkUpdate {
  const updates: EmailLinkUpdate = {};

  let relationId = email.relationId;
  if (!relationId) {
    const addr = email.direction === 'inbound'
      ? normalizeAddress(email.fromAddress)
      : firstToAddress(email.toAddresses);
    const rel = addr ? relationIndex.get(addr) : undefined;
    if (rel) {
      relationId = rel.id;
      updates.relationId = rel.id;
      updates.relationName = rel.displayName;
    }
  }

  if (!email.orderId) {
    const hit = matchOrderBySubject(orders, email.subject, relationId)
      ?? matchOrderBySubject(orders, email.snippet, relationId);
    if (hit) {
      updates.orderId = hit.id;
      updates.orderPo = hit.poNumber;
    }
  }

  return updates;
}

/** 应用链接：DB 更新 + EntityLink 双写 + 审计（手工优先——调用方保证只传空缺字段） */
export async function applyEmailLink(
  prisma: PrismaClient,
  emailId: string,
  updates: EmailLinkUpdate,
  opts: { actorId: string; source: string },
): Promise<boolean> {
  if (Object.keys(updates).length === 0) return false;

  const now = BigInt(Date.now());
  const email = await prisma.email.update({
    where: { id: emailId },
    data: { ...updates, updatedAt: now },
  });

  await syncEmailReferences(prisma, email, { source: opts.source });

  await writeRouteAuditLog({
    prisma, actorId: opts.actorId, source: opts.source,
    operation: 'email_auto_link', targetType: 'Email', targetId: emailId,
    after: { ...updates },
  });
  return true;
}

// ────────────────────────────────────────────────────────────────
// 单封自动匹配（路由用）与批量回填
// ────────────────────────────────────────────────────────────────

export interface AutoLinkResult {
  emailId: string;
  alreadyLinked: boolean; // 客户+订单均已存在，无需处理
  linked: boolean;        // 本次是否写入了新链接
  updates: EmailLinkUpdate;
}

export async function autoLinkEmailById(
  prisma: PrismaClient,
  emailId: string,
  opts: { actorId: string },
): Promise<AutoLinkResult | { error: 'NOT_FOUND' }> {
  const email = await prisma.email.findUnique({ where: { id: emailId } });
  if (!email || email.deletedAt) return { error: 'NOT_FOUND' };

  if (email.relationId && email.orderId) {
    return { emailId, alreadyLinked: true, linked: false, updates: {} };
  }

  const [relationIndex, orders] = await Promise.all([
    loadRelationAddressIndex(prisma),
    loadOrderCandidates(prisma),
  ]);
  const updates = computeEmailLinkUpdates(email, relationIndex, orders);
  const linked = await applyEmailLink(prisma, emailId, updates, { actorId: opts.actorId, source: 'route:email:auto-link' });
  return { emailId, alreadyLinked: false, linked, updates };
}

export interface BackfillResult {
  scanned: number;
  linked: number;
  relationLinked: number;
  orderLinked: number;
  unmatched: number;
}

export async function backfillEmailLinks(
  prisma: PrismaClient,
  opts: { limit?: number; actorId: string },
): Promise<BackfillResult> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

  const emails = await prisma.email.findMany({
    where: { deletedAt: null, OR: [{ relationId: null }, { orderId: null }] },
    select: {
      id: true, relationId: true, orderId: true, direction: true,
      fromAddress: true, toAddresses: true, subject: true, snippet: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const [relationIndex, orders] = await Promise.all([
    loadRelationAddressIndex(prisma),
    loadOrderCandidates(prisma),
  ]);

  let linked = 0, relationLinked = 0, orderLinked = 0;
  for (const email of emails) {
    const updates = computeEmailLinkUpdates(email, relationIndex, orders);
    const wrote = await applyEmailLink(prisma, email.id, updates, { actorId: opts.actorId, source: 'route:email:backfill-links' });
    if (wrote) {
      linked++;
      if (updates.relationId) relationLinked++;
      if (updates.orderId) orderLinked++;
    }
  }

  return { scanned: emails.length, linked, relationLinked, orderLinked, unmatched: emails.length - linked };
}
