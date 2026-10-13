import { describe, expect, it, vi } from 'vitest';
import { getMcpManifest } from './manifest';
import { runMcpPlan } from './executor';
import { ActorContext } from '../types';

const ownerActor: ActorContext = {
  userId: 'kevin',
  displayName: 'Kevin',
  roles: ['owner'],
  departmentIds: ['company'],
  permissionScopes: ['admin'],
  memoryScopes: ['company', 'personal:kevin'],
  knowledgeScopes: ['company', 'owner', 'products'],
  toolScopes: ['admin', 'products', 'orders', 'relations', 'knowledge'],
};

describe('Bambook MCP-like agent tools', () => {
  it('returns the first read-only business query manifest', () => {
    const ids = getMcpManifest().map(tool => tool.id);

    expect(ids).toEqual(expect.arrayContaining([
      'products.query',
      'products.get',
      'products.expand',
      'products.describe_schema',
      'relations.query',
      'relations.get',
      'relations.expand',
      'orders.query',
      'orders.get',
      'orders.expand',
      'knowledge.search',
      'entities.search',
      'entities.hydrate',
    ]));
    expect(ids).not.toEqual(expect.arrayContaining([
      'products.count',
      'dictionary.query',
      'records.query',
    ]));
  });

  it('continues from a unique relation search hit to the full relation profile when contacts are requested', async () => {
    const prisma = {
      userAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'kevin' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      relation: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            {
              id: 'panda001',
              name: 'Jiangsu Panda Clothing Co., Ltd.',
              chineseName: '江苏庞大纺织服饰有限公司',
              category: 'Supplier',
              type: 'Supplier',
              tags: [],
              summary: '供应商',
              primaryContactName: null,
              primaryContactEmail: null,
              primaryContactPhone: null,
              billingAddress: null,
              shippingAddress: null,
              officialAddress: null,
              paymentTerms: null,
              paymentPreference: null,
              currency: 'CNY',
              email: null,
              phone: null,
              lastInteraction: BigInt(1780000000000),
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'person_victor',
              name: 'Victor Chu',
              category: 'Contact',
              type: 'Person',
              isOrganization: false,
              parentId: 'panda001',
              reportsToId: null,
              role: 'Sales Director',
              department: 'Sales',
              tags: [],
              summary: 'Main commercial contact',
              contactInfo: 'victor.chu@pandaclothing.cn',
              email: 'victor.chu@pandaclothing.cn',
              phone: '+86 25 0000 0001',
              mobile: null,
              wechat: null,
              whatsapp: null,
              lastInteraction: BigInt(1780000000000),
            },
            {
              id: 'person_merch',
              name: 'Merchandiser Zhang',
              category: 'Contact',
              type: 'Person',
              isOrganization: false,
              parentId: 'panda001',
              reportsToId: null,
              role: 'Merchandiser',
              department: 'Merchandising',
              tags: [],
              summary: 'Order follow-up contact',
              contactInfo: 'merch@pandaclothing.cn',
              email: 'merch@pandaclothing.cn',
              phone: null,
              mobile: '+86 13800000000',
              wechat: null,
              whatsapp: null,
              lastInteraction: BigInt(1770000000000),
            },
          ]),
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue({
          id: 'panda001',
          name: 'Jiangsu Panda Clothing Co., Ltd.',
          chineseName: '江苏庞大纺织服饰有限公司',
          category: 'Supplier',
          type: 'Supplier',
          primaryContactName: '王经理',
          primaryContactEmail: 'wang@example.com',
          contactInfo: 'victor.chu@pandaclothing.cn',
          website: 'www.pandaclothing.cn',
          backupContacts: [{ name: '李助理', email: 'li@example.com' }],
          otherContacts: [{ name: '赵经理', phone: '+86 13800000000' }],
        }),
      },
      agentTool: { upsert: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      // 联系人体系统一：relations.expand 的 profileContacts 优先读 Contact 表（零行 → 文本兜底）
      contact: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const hits = await runMcpPlan({
      prisma,
      actor: ownerActor,
      plan: {
        planner: 'rules',
        degraded: false,
        steps: [{
          id: 'step_1',
          toolId: 'relations.query',
          input: { query: '江苏庞大纺织服饰有限公司', limit: 20, followUp: { getFullProfile: true } },
          reason: '查公司并继续找联系人',
          dependsOn: [],
          expectedUse: '先确认关系档案，再读取完整联系人明细',
        }],
      },
      sessionId: 'as_relation_followup_test',
      requestSource: 'api-key',
    });

    expect(prisma.relation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([{ id: 'panda001' }]),
      }),
    }));
    expect(hits.map(hit => hit.source)).toContain('agent-tool/relations.get');
    expect(hits.map(hit => hit.source)).toContain('agent-tool/relations.expand');
    expect(hits.at(-1)?.content).toContain('王经理');
    expect(hits.at(-1)?.content).toContain('Victor Chu');
    expect(hits.at(-1)?.content).toContain('Merchandiser Zhang');
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolId: 'relations.expand',
        userId: 'kevin',
        sessionId: 'as_relation_followup_test',
        status: 'success',
      }),
    });
  });

  it('continues relation follow-up when the data center query returns relations instead of items', async () => {
    const previousBase = process.env.BAMBOOK_AGENT_DATA_API_BASE;
    const previousKey = process.env.BAMBOOK_AGENT_DATA_API_KEY;
    process.env.BAMBOOK_AGENT_DATA_API_BASE = 'https://data-center.test/api';
    process.env.BAMBOOK_AGENT_DATA_API_KEY = 'test-key';
    const fetchSpy = vi.fn(async (url: URL | string, init?: any) => {
      const href = String(url);
      expect(init?.headers?.['X-Bambook-API-Key']).toBe('test-key');
      if (href.endsWith('/v1/relations/query')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            total: 1,
            count: 1,
            relations: [{ id: 'panda001', name: 'Jiangsu Panda Clothing Co., Ltd.', chineseName: '江苏庞大纺织服饰有限公司' }],
          }),
        } as any;
      }
      if (href.endsWith('/v1/relations/panda001')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            relation: { id: 'panda001', name: 'Jiangsu Panda Clothing Co., Ltd.', primaryContactName: '王经理' },
          }),
        } as any;
      }
      if (href.includes('/v1/relations/panda001/expand')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            found: true,
            include: ['profile', 'contacts', 'people'],
            profileContacts: [{ source: 'primaryContact', name: '王经理' }],
            people: [{ id: 'person_merch', name: 'Merchandiser Zhang', role: 'Merchandiser' }],
            count: 1,
          }),
        } as any;
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const prisma = {
      userAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'kevin' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentTool: { upsert: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    try {
      const hits = await runMcpPlan({
        prisma,
        actor: ownerActor,
        plan: {
          planner: 'rules',
          degraded: false,
          steps: [{
            id: 'step_1',
            toolId: 'relations.query',
            input: { query: '江苏庞大纺织服饰有限公司', limit: 5, followUp: { getFullProfile: true } },
            reason: '查公司并继续找联系人',
            dependsOn: [],
            expectedUse: '先确认关系档案，再读取完整联系人明细',
          }],
        },
        sessionId: 'as_remote_relation_followup_test',
        requestSource: 'api-key',
      });

      expect(hits.map(hit => hit.source)).toEqual(expect.arrayContaining([
        'agent-tool/relations.query',
        'agent-tool/relations.get',
        'agent-tool/relations.expand',
      ]));
      expect(hits.at(-1)?.content).toContain('Merchandiser Zhang');
    } finally {
      if (previousBase === undefined) delete process.env.BAMBOOK_AGENT_DATA_API_BASE;
      else process.env.BAMBOOK_AGENT_DATA_API_BASE = previousBase;
      if (previousKey === undefined) delete process.env.BAMBOOK_AGENT_DATA_API_KEY;
      else process.env.BAMBOOK_AGENT_DATA_API_KEY = previousKey;
      vi.unstubAllGlobals();
    }
  });

  it('continues from a unique product lookup to expanded product context', async () => {
    const product = {
      id: 'PDML-FAB-10039184',
      sku: '10039184',
      name: 'Wool twill fabric',
      mainCategory: 'Fabric',
      subCategoryId: 'PDML-FAB-CAT',
      season: 'SS27',
      techPackUrl: null,
      imageUrl: '/images/fabric.jpg',
      cost: 12.5,
      status: 'Active',
      updatedAt: BigInt(1780000000000),
      fabricProfile: {
        articleNo: 'CW30.068.0094',
        millOrganizationId: 'panda001',
        millQuality: 'Q-100',
        millColorCode: 'NAVY',
        composition: null,
      },
      garmentProfile: null,
      trimmingProfile: null,
      fabricCustomerCodes: [{ id: 'fcc_1', customerOrganizationId: 'peerless001', customerNameSnapshot: 'Peerless', clientCode: 'P-100' }],
      fabricPrices: [{ id: 'price_1', priceType: 'bulk', amount: 12.5, currency: 'USD', unit: 'm' }],
      fabricCertifications: [{ id: 'cert_1', certification: 'RWS', certificateNo: 'RWS-1' }],
      compositionLines: [{ id: 'comp_1', fiberName: 'Wool', percentage: 100, term: { labelEn: 'Wool' } }],
      images: [{ id: 'img_1', filePath: '/images/fabric.jpg', isPrimary: true }],
    };
    const prisma = {
      userAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'kevin' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      productAsset: {
        findMany: vi.fn().mockResolvedValue([product]),
      },
      agentTool: { upsert: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const hits = await runMcpPlan({
      prisma,
      actor: ownerActor,
      plan: {
        planner: 'rules',
        degraded: false,
        steps: [{
          id: 'step_1',
          toolId: 'products.get',
          input: {
            sku: '10039184',
            followUp: { expand: true, include: ['profile', 'pricing', 'certifications', 'composition', 'images', 'customerCodes', 'relations'] },
          },
          reason: '读取并展开数字档案',
          dependsOn: [],
          expectedUse: '先读取唯一档案，再展开上下文',
        }],
      },
      sessionId: 'as_product_expand_test',
      requestSource: 'api-key',
    });

    expect(hits.map(hit => hit.source)).toContain('agent-tool/products.get');
    expect(hits.map(hit => hit.source)).toContain('agent-tool/products.expand');
    expect(hits.at(-1)?.content).toContain('output.pricing');
    expect(hits.at(-1)?.content).toContain('RWS');
    expect(hits.at(-1)?.content).toContain('peerless001');
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolId: 'products.expand',
        userId: 'kevin',
        sessionId: 'as_product_expand_test',
        status: 'success',
      }),
    });
  });

  it('continues from a unique order lookup to expanded order context', async () => {
    const order = {
      id: 'order_1',
      poNumber: '4500159423',
      customer: 'Peerless',
      customerCode: 'PEERLESS',
      customerRelationId: 'peerless001',
      product: 'Wool fabric',
      type: 'Fabric',
      quantity: 100,
      status: 'Pending',
      dueDate: '2026-06-18',
      clientDate: '2026-06-15',
      productionDate: '2026-06-10',
      shipmentDate: '',
      invoiceNumber: '',
      supplierInvoiceNumber: 'SUP-INV-1',
      millName: 'Jiangsu Panda',
      millRelationId: 'panda001',
      billToName: 'Peerless Billing',
      consigneeName: 'Peerless Warehouse',
      paymentTerms: 'Net 30',
      salesCurrency: 'USD',
      purchaseCurrency: 'CNY',
      sampleSentDate: '2026-05-01',
      fabricSampleSentDate: '',
      productionBatch: 'BATCH-1',
      fabricCode: 'FAB-1',
      fabricContent: 'Wool',
      updatedAt: BigInt(1780000000000),
      importedAt: BigInt(1770000000000),
      lines: [{
        id: 'line_1',
        lineNumber: 1,
        itemNo: '10',
        materialCode: 'MAT-1',
        millQuality: 'Q-1',
        description: 'Wool fabric',
        deliveryDate: '2026-06-18',
        quantity: 100,
        status: 'Pending',
        invoiceNumber: '',
      }],
    };
    const prisma = {
      userAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'kevin' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      order: {
        findFirst: vi.fn().mockResolvedValue(order),
      },
      agentTool: { upsert: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const hits = await runMcpPlan({
      prisma,
      actor: ownerActor,
      plan: {
        planner: 'rules',
        degraded: false,
        steps: [{
          id: 'step_1',
          toolId: 'orders.get',
          input: {
            poNumber: '4500159423',
            followUp: { expand: true, include: ['summary', 'lines', 'parties', 'dates', 'invoices', 'samples', 'production', 'missingFields', 'currencies'] },
          },
          reason: '读取并展开订单',
          dependsOn: [],
          expectedUse: '先读取唯一订单，再展开上下文',
        }],
      },
      sessionId: 'as_order_expand_test',
      requestSource: 'api-key',
    });

    expect(hits.map(hit => hit.source)).toContain('agent-tool/orders.get');
    expect(hits.map(hit => hit.source)).toContain('agent-tool/orders.expand');
    expect(hits.at(-1)?.content).toContain('output.parties');
    expect(hits.at(-1)?.content).toContain('supplierInvoiceNumber');
    expect(hits.at(-1)?.content).toContain('invoiceNumber');
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolId: 'orders.expand',
        userId: 'kevin',
        sessionId: 'as_order_expand_test',
        status: 'success',
      }),
    });
  });

  it('executes a low-risk read tool and returns auditable agent-tool context', async () => {
    const prisma = {
      userAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'kevin' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      order: {
        findMany: vi.fn().mockResolvedValue([{ id: 'ORD-1', poNumber: 'PO-1', customer: 'Peerless', product: 'Wool', type: 'Fabric', quantity: 1, status: 'Pending', dueDate: '2026-06-18', lines: [] }]),
        count: vi.fn().mockResolvedValue(1),
      },
      agentTool: { upsert: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const hits = await runMcpPlan({
      prisma,
      actor: ownerActor,
      plan: {
        planner: 'rules',
        degraded: false,
        steps: [{
          id: 'step_1',
          toolId: 'orders.query',
          input: { query: 'Peerless', limit: 20 },
          reason: '测试订单查询',
          dependsOn: [],
          expectedUse: '读取订单候选',
        }],
      },
      sessionId: 'as_mcp_test',
      requestSource: 'api-key',
    });

    expect(hits[0].source).toBe('agent-tool/orders.query');
    expect(hits[0].content).toContain('tool_id = orders.query');
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolId: 'orders.query',
        userId: 'kevin',
        sessionId: 'as_mcp_test',
        status: 'success',
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'agent_tool_success',
        targetId: 'orders.query',
      }),
    });
  });
});
