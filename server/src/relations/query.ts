import { PrismaClient, Prisma } from '@prisma/client';

export type StructuredRelationQueryInput = Record<string, unknown>;

export async function queryRelations(prisma: PrismaClient, input: StructuredRelationQueryInput = {}) {
  const normalized = normalizeRelationQuery(input);
  const where = buildRelationQueryWhere(normalized);
  const orderBy = relationQueryOrderBy(normalized.sort);

  if (normalized.aggregate === 'count') {
    const count = await (prisma as any).relation.count({ where });
    return {
      dataSource: 'bambook-data-center',
      entity: 'Relation',
      aggregate: 'count',
      count,
      filters: normalized.filters,
      sort: normalized.sort,
    };
  }

  const [relations, total] = await Promise.all([
    (prisma as any).relation.findMany({
      where,
      orderBy,
      take: normalized.limit,
      skip: normalized.offset,
    }),
    (prisma as any).relation.count({ where }),
  ]);

  return {
    dataSource: 'bambook-data-center',
    entity: 'Relation',
    aggregate: normalized.aggregate,
    query: normalized.query,
    filters: normalized.filters,
    sort: normalized.sort,
    total,
    count: relations.length,
    limit: normalized.limit,
    offset: normalized.offset,
    hasMore: normalized.offset + relations.length < total,
    items: relations.map((relation: any) => formatRelation(relation, normalized.aggregate === 'detail')),
  };
}

export async function getRelation(prisma: PrismaClient, input: StructuredRelationQueryInput = {}) {
  const id = cleanText(input.id);
  const name = cleanText(input.name);
  const where = id
    ? {
      deletedAt: null,
      OR: [
        { id },
        { name: { equals: id, mode: 'insensitive' as const } },
        { englishName: { equals: id, mode: 'insensitive' as const } },
        { chineseName: { equals: id, mode: 'insensitive' as const } },
      ],
    }
    : name
      ? { name: { equals: name, mode: 'insensitive' as const }, deletedAt: null }
      : null;
  if (!where) return { dataSource: 'bambook-data-center', found: false, reason: 'MISSING_RELATION_IDENTIFIER', input };
  const relation = await (prisma as any).relation.findFirst({ where });
  return relation
    ? { dataSource: 'bambook-data-center', found: true, item: formatRelation(relation, true) }
    : { dataSource: 'bambook-data-center', found: false, input };
}

export async function expandRelation(prisma: PrismaClient, input: StructuredRelationQueryInput = {}) {
  const id = cleanText(input.id || input.relationId);
  const name = cleanText(input.name);
  const limit = numberInput(input.limit, 10, 1, 50);
  const include = normalizeRelationExpandInclude(input.include);
  const organization = await findRelationOrganization(prisma, { id, name });
  if (!organization) {
    return { dataSource: 'bambook-data-center', found: false, reason: 'RELATION_ORGANIZATION_NOT_FOUND', input };
  }

  const domains = relationEmailDomains(organization);
  const names = [organization.name, organization.chineseName, organization.englishName].map(cleanText).filter(Boolean);
  const people = include.includes('people') ? await findRelationPeople(prisma, organization, { domains, names, limit }) : [];

  return {
    dataSource: 'bambook-data-center',
    found: true,
    include,
    organization: include.includes('profile') ? formatContactOrganization(organization) : { id: organization.id },
    lookup: {
      relationId: organization.id,
      names,
      domains,
    },
    profileContacts: include.includes('contacts') ? await relationProfileContacts(prisma, organization) : [],
    people: people.map(formatPersonContact),
    count: people.length,
  };
}

export function describeRelationSchema() {
  return {
    entity: 'Relation',
    sourceOfTruth: 'Bambook backend database',
    purpose: '让 Agent 像关系智库页面一样按客户/供应商/联系人/地址/付款条件/币种/标签/互动时间做只读查询。',
    tools: {
      query: { id: 'relations.query', useWhen: '需要 count/list/detail 模式、筛选、排序和分页读取关系智库。' },
      get: { id: 'relations.get', useWhen: '已有 relation id 或唯一名称，需要读取完整关系档案。' },
      expand: { id: 'relations.expand', useWhen: '已有公司 relation id 或名称，需要展开档案联系人和通讯录人物。' },
    },
    fields: [
      'id', 'name', 'category', 'type', 'isOrganization', 'tags', 'summary',
      'primaryContactName', 'primaryContactEmail', 'primaryContactPhone',
      'billingAddress', 'shippingAddress', 'officialAddress', 'paymentTerms',
      'paymentPreference', 'currency', 'email', 'phone', 'mobile',
      'lastInteraction',
    ],
    aggregateModes: ['count', 'list', 'detail'],
    writableNow: false,
  };
}

function normalizeRelationQuery(input: StructuredRelationQueryInput) {
  const filters = input && typeof input.filters === 'object' && input.filters ? input.filters as Record<string, unknown> : {};
  const sort = input && typeof input.sort === 'object' && input.sort ? input.sort as Record<string, unknown> : {};
  return {
    aggregate: cleanText(input.aggregate) === 'count' ? 'count' : cleanText(input.aggregate) === 'detail' ? 'detail' : 'list',
    query: cleanText(input.query),
    filters: {
      categories: arrayOfText(filters.categories || filters.category),
      tags: arrayOfText(filters.tags),
      name: cleanText(filters.name),
      contactEmail: cleanText(filters.primaryContactEmail || filters.email),
      paymentTerms: cleanText(filters.paymentTerms),
      currency: cleanText(filters.currency),
      address: cleanText(filters.address || filters.country),
      lastInteractionFrom: finiteNumber(filters.lastInteractionFrom),
      lastInteractionTo: finiteNumber(filters.lastInteractionTo),
      fieldFilters: normalizeFieldFilters(filters.fieldFilters),
    },
    sort: {
      field: cleanText(sort.field) || 'lastInteraction',
      direction: cleanText(sort.direction).toLowerCase() === 'asc' ? 'asc' : 'desc',
    },
    limit: numberInput(input.limit, cleanText(input.aggregate) === 'detail' ? 1 : 20, 1, 200),
    offset: numberInput(input.offset, 0, 0, 1_000_000),
  };
}

function buildRelationQueryWhere(input: ReturnType<typeof normalizeRelationQuery>) {
  const and: any[] = [{ deletedAt: null }];
  const textContains = (value: string) => ({ contains: value, mode: 'insensitive' as const });

  if (input.query) {
    and.push({
      OR: [
        { id: input.query },
        { name: textContains(input.query) },
        { chineseName: textContains(input.query) },
        { englishName: textContains(input.query) },
        { summary: textContains(input.query) },
        { contactInfo: textContains(input.query) },
        { primaryContactEmail: textContains(input.query) },
        { primaryContactName: textContains(input.query) },
        { officialAddress: textContains(input.query) },
        { billingAddress: textContains(input.query) },
        { shippingAddress: textContains(input.query) },
      ],
    });
  }
  if (input.filters.name) {
    and.push({
      OR: [
        { name: textContains(input.filters.name) },
        { chineseName: textContains(input.filters.name) },
        { englishName: textContains(input.filters.name) },
      ],
    });
  }
  if (input.filters.categories.length) {
    and.push({ OR: input.filters.categories.map(category => ({ category: textContains(category) })) });
  }
  for (const tag of input.filters.tags) and.push({ tags: { has: tag } });
  if (input.filters.contactEmail) {
    and.push({
      OR: [
        { primaryContactEmail: textContains(input.filters.contactEmail) },
        { email: textContains(input.filters.contactEmail) },
        { contactInfo: textContains(input.filters.contactEmail) },
      ],
    });
  }
  if (input.filters.paymentTerms) and.push({ paymentTerms: textContains(input.filters.paymentTerms) });
  if (input.filters.currency) and.push({ currency: { equals: input.filters.currency, mode: 'insensitive' as const } });
  if (input.filters.address) {
    and.push({
      OR: [
        { officialAddress: textContains(input.filters.address) },
        { billingAddress: textContains(input.filters.address) },
        { shippingAddress: textContains(input.filters.address) },
        { warehouseAddress: textContains(input.filters.address) },
      ],
    });
  }
  const lastInteraction: any = {};
  if (input.filters.lastInteractionFrom != null) lastInteraction.gte = BigInt(input.filters.lastInteractionFrom);
  if (input.filters.lastInteractionTo != null) lastInteraction.lte = BigInt(input.filters.lastInteractionTo);
  if (Object.keys(lastInteraction).length) and.push({ lastInteraction });
  for (const filter of input.filters.fieldFilters) {
    const where = relationFieldFilterWhere(filter);
    if (where) and.push(where);
  }
  return and.length === 1 ? and[0] : { AND: and };
}

function relationFieldFilterWhere(filter: { path: string; operator: string; value: unknown }) {
  const mapped = RELATION_QUERY_FIELDS[filter.path] || filter.path;
  if (!SAFE_RELATION_FIELDS.has(mapped)) return null;
  const value = cleanText(filter.value);
  if (!value) return null;
  if (filter.operator === 'equals') return { [mapped]: { equals: value, mode: 'insensitive' as const } };
  if (filter.operator === 'missing') return { OR: [{ [mapped]: null }, { [mapped]: '' }] };
  return { [mapped]: { contains: value, mode: 'insensitive' as const } };
}

function relationQueryOrderBy(sort: { field: string; direction: string }) {
  const direction = sort.direction === 'asc' ? 'asc' : 'desc';
  const field = RELATION_SORT_FIELDS.has(sort.field) ? sort.field : 'lastInteraction';
  return [{ [field]: direction }, { name: 'asc' as const }, { id: 'asc' as const }];
}

function formatRelation(row: any, full = false) {
  const compact = serializeBigInts({
    id: row.id,
    name: row.name,
    chineseName: row.chineseName,
    englishName: row.englishName,
    category: row.category,
    type: row.type,
    tags: row.tags,
    summary: row.summary,
    primaryContactName: row.primaryContactName,
    primaryContactEmail: row.primaryContactEmail,
    primaryContactPhone: row.primaryContactPhone,
    billingAddress: row.billingAddress,
    shippingAddress: row.shippingAddress,
    officialAddress: row.officialAddress,
    paymentTerms: row.paymentTerms,
    paymentPreference: row.paymentPreference,
    currency: row.currency,
    email: row.email,
    phone: row.phone,
    lastInteraction: row.lastInteraction,
  });
  return full ? serializeBigInts(row) : compact;
}

async function findRelationOrganization(prisma: PrismaClient, input: { id?: string; name?: string }) {
  if (input.id) {
    const byId = await (prisma as any).relation.findFirst({
      where: { id: input.id, deletedAt: null },
    });
    if (byId) return byId;
  }
  if (!input.name) return null;
  return (prisma as any).relation.findFirst({
    where: {
      deletedAt: null,
      isOrganization: true,
      OR: [
        { name: { equals: input.name, mode: 'insensitive' as const } },
        { chineseName: { equals: input.name, mode: 'insensitive' as const } },
        { englishName: { equals: input.name, mode: 'insensitive' as const } },
        { name: { contains: input.name, mode: 'insensitive' as const } },
        { chineseName: { contains: input.name, mode: 'insensitive' as const } },
        { englishName: { contains: input.name, mode: 'insensitive' as const } },
      ],
    },
    orderBy: [{ lastInteraction: 'desc' }, { name: 'asc' }],
  });
}

async function findRelationPeople(prisma: PrismaClient, organization: any, input: { domains: string[]; names: string[]; limit: number }) {
  const or: any[] = [
    { parentId: organization.id },
    { reportsToId: organization.id },
    ...input.domains.flatMap(domain => [
      { email: { contains: domain, mode: 'insensitive' as const } },
      { contactInfo: { contains: domain, mode: 'insensitive' as const } },
    ]),
    ...input.names.flatMap(value => [
      { summary: { contains: value, mode: 'insensitive' as const } },
      { contactInfo: { contains: value, mode: 'insensitive' as const } },
    ]),
  ];

  return (prisma as any).relation.findMany({
    where: {
      deletedAt: null,
      isOrganization: false,
      OR: or,
    },
    orderBy: [{ lastInteraction: 'desc' }, { name: 'asc' }],
    take: input.limit,
  });
}

function normalizeRelationExpandInclude(value: unknown) {
  const allowed = new Set(['profile', 'contacts', 'people']);
  const raw = Array.isArray(value) ? value.map(String) : ['profile', 'contacts', 'people'];
  const include = raw.filter(item => allowed.has(item));
  return include.length ? Array.from(new Set(include)) : ['profile'];
}

// 联系人体系统一：档案联系人优先读 Contact 表（结构化真源，与通讯录 CRUD/completeness「联系人」维度同源），
// source 标记 'contact'；零行时回退 primaryContact/backupContacts/otherContacts/contactInfo 文本解析（旧数据兜底）。
async function relationProfileContacts(prisma: PrismaClient, relation: any) {
  const contactRows = await (prisma as any).contact.findMany({
    where: { relationId: relation.id, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  });
  if (contactRows.length) {
    return contactRows.map((row: any) => ({
      source: 'contact',
      ...compactObject({
        name: row.name,
        title: row.title,
        email: row.email,
        phone: row.phone,
        mobile: row.mobile,
        isPrimary: row.isPrimary,
        decisionMaker: row.isDecisionMaker,
      }),
    }));
  }

  const contacts: any[] = [];
  const push = (source: string, value: any) => {
    if (!value) return;
    if (typeof value === 'string') {
      contacts.push({ source, text: value });
      return;
    }
    if (typeof value === 'object') contacts.push({ source, ...compactObject(value) });
  };
  if (relation.primaryContactName || relation.primaryContactEmail || relation.primaryContactPhone) {
    push('primaryContact', {
      name: relation.primaryContactName,
      email: relation.primaryContactEmail,
      phone: relation.primaryContactPhone,
    });
  }
  if (relation.contactInfo) push('contactInfo', relation.contactInfo);
  for (const contact of arrayJson(relation.backupContacts)) push('backupContacts', contact);
  for (const contact of arrayJson(relation.otherContacts)) push('otherContacts', contact);
  return contacts;
}

function formatContactOrganization(relation: any) {
  return compactObject({
    id: relation.id,
    name: relation.name,
    chineseName: relation.chineseName,
    englishName: relation.englishName,
    category: relation.category,
    role: relation.role,
    website: relation.website,
    email: relation.email,
    contactInfo: relation.contactInfo,
  });
}

function formatPersonContact(person: any) {
  return compactObject({
    id: person.id,
    name: person.name,
    chineseName: person.chineseName,
    englishName: person.englishName,
    category: person.category,
    type: person.type,
    role: person.role,
    department: person.department,
    parentId: person.parentId,
    reportsToId: person.reportsToId,
    email: person.email,
    phone: person.phone,
    mobile: person.mobile,
    wechat: person.wechat,
    whatsapp: person.whatsapp,
    contactInfo: person.contactInfo,
    summary: person.summary,
    lastInteraction: person.lastInteraction,
  });
}

function relationEmailDomains(relation: any) {
  const text = [
    relation.email,
    relation.primaryContactEmail,
    relation.contactInfo,
    relation.website,
    ...arrayJson(relation.backupContacts).flatMap((contact: any) => [contact.email, contact.text]),
    ...arrayJson(relation.otherContacts).flatMap((contact: any) => [contact.email, contact.text]),
  ].filter(Boolean).join(' ');
  const domains = new Set<string>();
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) domains.add(match[1].toLowerCase());
  for (const match of text.matchAll(/(?:https?:\/\/)?(?:www\.)?([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    const domain = match[1].toLowerCase();
    if (!COMMON_CONTACT_DOMAINS.has(domain)) domains.add(domain);
  }
  return Array.from(domains).slice(0, 5);
}

function arrayJson(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeFieldFilters(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter(Boolean)
    .map(item => ({
      path: cleanText(item!.path),
      operator: cleanText(item!.operator) || 'contains',
      value: item!.value,
    }))
    .filter(item => item.path)
    .slice(0, 20);
}

function arrayOfText(value: unknown) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.map(cleanText).filter(Boolean).slice(0, 20);
}

function cleanText(value: unknown) {
  return String(value ?? '').trim();
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberInput(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function serializeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Prisma.Decimal.isDecimal(value)) return Number(value) as T;
  if (Array.isArray(value)) return value.map(serializeBigInts) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = serializeBigInts(item);
    return out as T;
  }
  return value;
}

function compactObject(value: any): any {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(compactObject).filter(item => item !== undefined);
  if (typeof value !== 'object') return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, compactObject(item)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}

const RELATION_QUERY_FIELDS: Record<string, string> = {
  contactEmail: 'primaryContactEmail',
  billing: 'billingAddress',
  shipping: 'shippingAddress',
  address: 'officialAddress',
};

const SAFE_RELATION_FIELDS = new Set([
  'id', 'name', 'chineseName', 'englishName', 'category', 'type', 'summary',
  'primaryContactName', 'primaryContactEmail', 'primaryContactPhone',
  'paymentTerms', 'paymentPreference', 'currency', 'officialAddress',
  'billingAddress', 'shippingAddress', 'warehouseAddress', 'email', 'phone',
  'mobile', 'language', 'timezone',
]);

const RELATION_SORT_FIELDS = new Set(['lastInteraction', 'name', 'category', 'rating']);
const COMMON_CONTACT_DOMAINS = new Set(['example.com', 'test.com', 'email.com']);
