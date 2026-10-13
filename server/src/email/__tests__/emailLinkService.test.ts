import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  normalizeAddress,
  firstToAddress,
  buildRelationAddressIndex,
  matchOrderBySubject,
  computeEmailLinkUpdates,
  applyEmailLink,
  autoLinkEmailById,
  backfillEmailLinks,
  type OrderCandidate,
} from '../emailLinkService';

vi.mock('../sync', () => ({ syncEmailReferences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn().mockResolvedValue('alog_link_1') }));
import { syncEmailReferences } from '../sync';
import { writeRouteAuditLog } from '../../audit/routeAudit';

// ────────────────────────────────────────────────────────────────
// 测试夹具
// ────────────────────────────────────────────────────────────────

const RELATIONS = [
  { id: 'REL__ORG1', name: 'Acme Corp', chineseName: '阿克米', email: 'sales@acme.com', primaryContactEmail: null, isOrganization: true, rating: 3 },
  { id: 'REL__CON1', name: 'John Doe', chineseName: null, email: 'john@acme.com', primaryContactEmail: null, isOrganization: false, rating: 4 },
  // 与组织同地址的联系人（联系人应优先）
  { id: 'REL__CON2', name: 'Jane Boss', chineseName: null, email: 'sales@acme.com', primaryContactEmail: null, isOrganization: false, rating: 5 },
  // 主联系人邮箱索引
  { id: 'REL__ORG2', name: 'Beta LLC', chineseName: null, email: null, primaryContactEmail: 'ceo@beta.com', isOrganization: true, rating: 2 },
];

const ORDERS: OrderCandidate[] = [
  { id: 'ORD__1', poNumber: 'PO-2026-001', customerRelationId: 'REL__ORG1' },
  { id: 'ORD__2', poNumber: 'PO-2026-001-EXT', customerRelationId: 'REL__ORG1' },
  { id: 'ORD__3', poNumber: 'BB100', customerRelationId: 'REL__ORG2' },
  { id: 'ORD__4', poNumber: 'AB', customerRelationId: 'REL__ORG1' }, // 过短，永不匹配
  { id: 'ORD__5', poNumber: 'NOOWNER99', customerRelationId: null },
];

function makeEmail(overrides: Record<string, any> = {}) {
  return {
    id: 'EML__T1',
    relationId: null,
    orderId: null,
    direction: 'inbound',
    fromAddress: 'John Doe <john@acme.com>',
    toAddresses: JSON.stringify(['me@bambook.com']),
    subject: 'Re: PO-2026-001-EXT shipment',
    snippet: null,
    ...overrides,
  };
}

function makePrisma(overrides: {
  emails?: any[]; email?: any; relations?: any[]; orders?: any[];
} = {}) {
  return {
    email: {
      findMany: vi.fn().mockResolvedValue(overrides.emails ?? []),
      findUnique: vi.fn().mockResolvedValue(overrides.email ?? null),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...makeEmail(), ...data })),
    },
    relation: { findMany: vi.fn().mockResolvedValue(overrides.relations ?? RELATIONS) },
    order: {
      findMany: vi.fn().mockResolvedValue(
        (overrides.orders ?? ORDERS).map(o => ({ id: o.id, poNumber: o.poNumber, customerRelationId: o.customerRelationId })),
      ),
    },
  } as any;
}

// ────────────────────────────────────────────────────────────────
// normalizeAddress / firstToAddress
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: normalizeAddress', () => {
  it('提取纯地址并小写化', () => {
    expect(normalizeAddress('Foo@Bar.COM')).toBe('foo@bar.com');
  });

  it('从显示名+尖括号中提取地址', () => {
    expect(normalizeAddress('"John Doe" <John@Acme.com>')).toBe('john@acme.com');
  });

  it('无 @ 视为非法 → null', () => {
    expect(normalizeAddress('not-an-address')).toBeNull();
  });

  it('空值 → null', () => {
    expect(normalizeAddress(null)).toBeNull();
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress('   ')).toBeNull();
  });
});

describe('emailLinkService: firstToAddress', () => {
  it('字符串数组取首个', () => {
    expect(firstToAddress(JSON.stringify(['a@x.com', 'b@x.com']))).toBe('a@x.com');
  });

  it('对象数组取 {address}', () => {
    expect(firstToAddress(JSON.stringify([{ name: 'J', address: 'J@Acme.com' }]))).toBe('j@acme.com');
  });

  it('非法 JSON → null', () => {
    expect(firstToAddress('not-json')).toBeNull();
  });

  it('空值/空数组 → null', () => {
    expect(firstToAddress(null)).toBeNull();
    expect(firstToAddress('[]')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// buildRelationAddressIndex
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: buildRelationAddressIndex', () => {
  const index = buildRelationAddressIndex(RELATIONS);

  it('email 与 primaryContactEmail 均入索引', () => {
    expect(index.get('john@acme.com')?.id).toBe('REL__CON1');
    expect(index.get('ceo@beta.com')?.id).toBe('REL__ORG2');
  });

  it('同地址联系人优先于组织', () => {
    expect(index.get('sales@acme.com')?.id).toBe('REL__CON2');
  });

  it('同级同 rating 时 id 字典序小者优先（确定性）', () => {
    const idx = buildRelationAddressIndex([
      { id: 'REL__B', name: 'B', chineseName: null, email: 'same@x.com', primaryContactEmail: null, isOrganization: true, rating: 1 },
      { id: 'REL__A', name: 'A', chineseName: null, email: 'same@x.com', primaryContactEmail: null, isOrganization: true, rating: 1 },
    ]);
    expect(idx.get('same@x.com')?.id).toBe('REL__A');
  });

  it('displayName 优先 chineseName', () => {
    expect(index.get('sales@acme.com')?.displayName).toBe('Jane Boss'); // CON2 无 chineseName → name
    const idx = buildRelationAddressIndex([
      { id: 'REL__C', name: 'Cn Org', chineseName: '中文名', email: 'cn@x.com', primaryContactEmail: null, isOrganization: true, rating: 0 },
    ]);
    expect(idx.get('cn@x.com')?.displayName).toBe('中文名');
  });
});

// ────────────────────────────────────────────────────────────────
// matchOrderBySubject
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: matchOrderBySubject', () => {
  it('主题包含 poNumber → 命中', () => {
    const hit = matchOrderBySubject(ORDERS, 'Please ship BB100 next week');
    expect(hit?.id).toBe('ORD__3');
  });

  it('大小写不敏感', () => {
    const hit = matchOrderBySubject(ORDERS, 're: po-2026-001-ext');
    expect(hit?.id).toBe('ORD__2');
  });

  it('poNumber 长度 < 4 不参与匹配', () => {
    expect(matchOrderBySubject(ORDERS, 'AB discussion')).toBeNull();
  });

  it('多命中取最长 poNumber（更具体优先）', () => {
    const hit = matchOrderBySubject(ORDERS, 'PO-2026-001-EXT details');
    expect(hit?.id).toBe('ORD__2');
  });

  it('已知客户时仅限该客户订单（防跨客户子串误配）', () => {
    // BB100 属于 REL__ORG2；以 REL__ORG1 过滤则不命中
    const hit = matchOrderBySubject(ORDERS, 'BB100 question', 'REL__ORG1');
    expect(hit).toBeNull();
  });

  it('已知客户时 customerRelationId 为 null 的订单也不匹配（严格口径）', () => {
    const hit = matchOrderBySubject(ORDERS, 'NOOWNER99 sample', 'REL__ORG1');
    expect(hit).toBeNull();
  });

  it('未知客户时可命中无主订单', () => {
    const hit = matchOrderBySubject(ORDERS, 'NOOWNER99 sample');
    expect(hit?.id).toBe('ORD__5');
  });

  it('空文本 → null', () => {
    expect(matchOrderBySubject(ORDERS, null)).toBeNull();
    expect(matchOrderBySubject(ORDERS, '')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// computeEmailLinkUpdates
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: computeEmailLinkUpdates', () => {
  const index = buildRelationAddressIndex(RELATIONS);

  it('inbound 按 fromAddress 匹配客户 + 主题 PO 匹配订单', () => {
    const updates = computeEmailLinkUpdates(makeEmail(), index, ORDERS);
    expect(updates.relationId).toBe('REL__CON1');
    expect(updates.relationName).toBe('John Doe');
    // 客户为 REL__CON1，该客户名下无订单 → 严格口径不匹配订单
    expect(updates.orderId).toBeUndefined();
  });

  it('inbound 组织发件人 + 同客户 PO → 客户与订单双命中', () => {
    const updates = computeEmailLinkUpdates(
      makeEmail({ fromAddress: 'sales@acme.com', subject: 'PO-2026-001 packing list' }),
      index,
      ORDERS,
    );
    expect(updates.relationId).toBe('REL__CON2'); // 同地址联系人优先
    // REL__CON2 名下无订单（订单挂在 ORG1）→ 严格过滤不命中
    expect(updates.orderId).toBeUndefined();
  });

  it('outbound 按首个 toAddress 匹配客户', () => {
    const updates = computeEmailLinkUpdates(
      makeEmail({ direction: 'outbound', fromAddress: 'me@bambook.com', toAddresses: JSON.stringify(['ceo@beta.com']), subject: 'BB100 quotation' }),
      index,
      ORDERS,
    );
    expect(updates.relationId).toBe('REL__ORG2');
    expect(updates.orderId).toBe('ORD__3');
    expect(updates.orderPo).toBe('BB100');
  });

  it('已有 relationId 不覆盖，且作为订单过滤条件', () => {
    const updates = computeEmailLinkUpdates(
      makeEmail({ relationId: 'REL__ORG1', fromAddress: 'stranger@nowhere.com', subject: 'PO-2026-001 update' }),
      index,
      ORDERS,
    );
    expect(updates.relationId).toBeUndefined();
    expect(updates.orderId).toBe('ORD__1');
  });

  it('已有 orderId 不覆盖', () => {
    const updates = computeEmailLinkUpdates(
      makeEmail({ orderId: 'ORD__X', subject: 'PO-2026-001 update' }),
      index,
      ORDERS,
    );
    expect(updates.orderId).toBeUndefined();
  });

  it('主题未命中时 snippet 兜底', () => {
    const updates = computeEmailLinkUpdates(
      makeEmail({ relationId: 'REL__ORG1', subject: 'hello', snippet: 'attaching PO-2026-001 details' }),
      index,
      ORDERS,
    );
    expect(updates.orderId).toBe('ORD__1');
  });

  it('无任何匹配 → 空 updates', () => {
    const updates = computeEmailLinkUpdates(
      makeEmail({ fromAddress: 'nobody@nowhere.com', subject: 'random hello' }),
      index,
      ORDERS,
    );
    expect(updates).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────
// applyEmailLink
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: applyEmailLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空 updates → 不写库，返回 false', async () => {
    const prisma = makePrisma();
    const wrote = await applyEmailLink(prisma, 'EML__T1', {}, { actorId: 'u1', source: 'test' });
    expect(wrote).toBe(false);
    expect(prisma.email.update).not.toHaveBeenCalled();
  });

  it('非空 updates → update + EntityLink 双写 + 审计', async () => {
    const prisma = makePrisma();
    const wrote = await applyEmailLink(prisma, 'EML__T1', { relationId: 'REL__CON1', relationName: 'John Doe' }, { actorId: 'u1', source: 'test' });
    expect(wrote).toBe(true);
    expect(prisma.email.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'EML__T1' },
      data: expect.objectContaining({ relationId: 'REL__CON1', relationName: 'John Doe' }),
    }));
    expect(syncEmailReferences).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'email_auto_link', targetType: 'Email', targetId: 'EML__T1',
    }));
  });
});

// ────────────────────────────────────────────────────────────────
// autoLinkEmailById
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: autoLinkEmailById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('邮件不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ email: null });
    const result = await autoLinkEmailById(prisma, 'EML__NOPE', { actorId: 'u1' });
    expect(result).toEqual({ error: 'NOT_FOUND' });
  });

  it('已删除邮件 → NOT_FOUND', async () => {
    const prisma = makePrisma({ email: { ...makeEmail(), deletedAt: BigInt(1) } });
    const result = await autoLinkEmailById(prisma, 'EML__T1', { actorId: 'u1' });
    expect(result).toEqual({ error: 'NOT_FOUND' });
  });

  it('客户+订单均已链接 → alreadyLinked，不写库', async () => {
    const prisma = makePrisma({ email: makeEmail({ relationId: 'REL__ORG1', orderId: 'ORD__1' }) });
    const result = await autoLinkEmailById(prisma, 'EML__T1', { actorId: 'u1' });
    expect(result).toMatchObject({ emailId: 'EML__T1', alreadyLinked: true, linked: false });
    expect(prisma.email.update).not.toHaveBeenCalled();
  });

  it('缺链接 → 计算并写入', async () => {
    const prisma = makePrisma({ email: makeEmail({ fromAddress: 'ceo@beta.com', subject: 'BB100 PI confirmation' }) });
    const result = await autoLinkEmailById(prisma, 'EML__T1', { actorId: 'u1' });
    expect(result).toMatchObject({ linked: true });
    expect(prisma.email.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ relationId: 'REL__ORG2', orderId: 'ORD__3' }),
    }));
  });
});

// ────────────────────────────────────────────────────────────────
// backfillEmailLinks
// ────────────────────────────────────────────────────────────────

describe('emailLinkService: backfillEmailLinks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('只处理缺链接邮件；统计口径正确', async () => {
    const emails = [
      makeEmail({ id: 'E1', fromAddress: 'john@acme.com', subject: 'no po here' }),               // 仅客户
      makeEmail({ id: 'E2', fromAddress: 'ceo@beta.com', subject: 'BB100 confirmation' }),         // 客户+订单
      makeEmail({ id: 'E3', fromAddress: 'nobody@nowhere.com', subject: 'unrelated' }),            // 无匹配
      makeEmail({ id: 'E4', relationId: 'REL__ORG1', orderId: 'ORD__1', subject: 'x' }),           // 已齐全
    ];
    const prisma = makePrisma({ emails });
    const result = await backfillEmailLinks(prisma, { actorId: 'u1' });
    expect(result.scanned).toBe(4);
    expect(result.relationLinked).toBe(2);
    expect(result.orderLinked).toBe(1);
    expect(result.linked).toBe(2);
    expect(result.unmatched).toBe(2);
    expect(prisma.email.update).toHaveBeenCalledTimes(2);
  });

  it('limit 夹紧到 [1, 2000]', async () => {
    const prisma = makePrisma({ emails: [] });
    await backfillEmailLinks(prisma, { limit: 99999, actorId: 'u1' });
    expect(prisma.email.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2000 }));
    await backfillEmailLinks(prisma, { limit: 0, actorId: 'u1' });
    expect(prisma.email.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it('查询条件覆盖 relationId 或 orderId 缺失', async () => {
    const prisma = makePrisma({ emails: [] });
    await backfillEmailLinks(prisma, { actorId: 'u1' });
    expect(prisma.email.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: null, OR: [{ relationId: null }, { orderId: null }] }),
    }));
  });
});
