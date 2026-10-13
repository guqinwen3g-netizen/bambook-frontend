import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// 统一 seed 脚本环境加载约定（与 seed-demo-data-v2.ts 一致）：
// .env.local 优先，.env 兜底；显式传入的 DATABASE_URL 环境变量优先级最高（dotenv 不覆盖已有值）。
const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local') });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const prisma = new PrismaClient();

const now = Date.now();
const repoRoot = join(process.cwd(), '..');

const items = [
  {
    id: 'core-bambook-agent-identity',
    title: 'Bambook Agent 身份与职责',
    category: 'AgentCore',
    content: [
      'Bambook Enterprise Agent OS 是 Bambook 内置的企业 AI assistant。',
      '它运行在 Bambook 后端 AI runtime 中，客户端只负责输入和展示。',
      '它的职责是基于 Bambook 数据中心、权限规则和知识检索上下文，协助用户理解业务数据、查询知识、分析订单、关系、产品和系统建设问题。',
      '它不能假装知道没有进入上下文的公司事实、客户信息、内部制度或文档内容。',
      '当上下文不足时，它应该明确说明需要补充知识、上传文档或连接相应数据源。',
    ].join('\n'),
  },
  {
    id: 'core-bambook-product-overview',
    title: 'Bambook 项目基础认知',
    category: 'ProjectCore',
    content: [
      'Bambook 是一个企业业务协作和数据中心应用。',
      '当前代码库包含订单管理、关系管理、产品管理、知识库、洞察、邮件、后台权限、系统资产、AI assistant 和 AI runtime 等模块。',
      'Bambook 的长期方向是让业务数据、知识、权限和 Agent 能力统一经过公司数据中心管理。',
      '当前开发环境只应本地运行前端；账号、业务数据、知识库和 Agent API 应统一走 Bambook 数据中心。',
    ].join('\n'),
  },
  {
    id: 'core-bambook-knowledge-roadmap',
    title: 'Bambook 自建 AI Knowledge Base 路线',
    category: 'KnowledgeCore',
    content: [
      'Bambook 的知识库目标是自建 AI Knowledge Base，而不是长期依赖第三方知识库。',
      '目标链路是：前端上传文档，Bambook 后端保存原文，解析文本，切片，生成 embedding，写入向量索引，检索后把上下文提供给模型回答。',
      '文档原件、权限、版本、审计和下载应由 Bambook 数据中心管理。',
      '火山引擎当前可作为模型调用通道；长期主知识库应由 Bambook 本地或公司数据中心部署。',
      '在自建知识库完成前，Agent 应该清楚区分已实现能力、测试能力和规划能力。',
    ].join('\n'),
  },
  {
    id: 'core-bambook-agent-guardrails',
    title: 'Bambook Agent 回答边界',
    category: 'AgentPolicy',
    content: [
      'Agent 回答业务问题时必须优先使用当前检索上下文。',
      'Agent 不应编造订单、客户、产品标准、公司制度或文档内容。',
      'Agent 不应绕过权限；权限不足时应说明需要更高权限或审批。',
      'Agent 可以说明系统当前能力和建设建议，但必须区分事实、推断和建议。',
      '当用户询问 Bambook 系统自身时，Agent 应以 Bambook 当前代码和已连接数据为准。',
    ].join('\n'),
  },
];

async function main() {
  const docItems = [
    ...loadMarkdownDoc('docs/Bambook-Agent-OS-使用说明书.md', 'Bambook Agent OS 使用说明书', 'AgentManual'),
    ...loadMarkdownDoc('docs/archive/legacy/Bambook-项目基准手册-v1.0.md', 'Bambook 项目基准手册 (历史归档)', 'ProjectManual'),
    ...loadMarkdownDoc('docs/ARCHITECTURE.md', 'Bambook 系统架构说明', 'Architecture'),
  ];

  const allItems = [...items, ...docItems];

  for (const item of allItems) {
    await prisma.knowledgeItem.upsert({
      where: { id: item.id },
      create: {
        ...item,
        sourceUrl: item.sourceUrl || 'bambook://agent-core',
        updatedAt: now,
      },
      update: {
        title: item.title,
        category: item.category,
        content: item.content,
        sourceUrl: item.sourceUrl || 'bambook://agent-core',
        updatedAt: now,
        deletedAt: null,
      },
    });
  }

  console.log(`Seeded ${allItems.length} Bambook agent memory items (${items.length} core, ${docItems.length} doc chunks).`);
}

function loadMarkdownDoc(relativePath: string, title: string, category: string) {
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) return [];

  const markdown = readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!markdown) return [];

  return splitMarkdown(markdown).map((content, index) => ({
    id: `doc-${slug(relativePath)}-${String(index + 1).padStart(3, '0')}`,
    title: `${title} #${index + 1}`,
    category,
    content,
    sourceUrl: `bambook://${relativePath}`,
  }));
}

function splitMarkdown(markdown: string) {
  const sections = markdown
    .split(/\n(?=##\s+)/g)
    .map(section => section.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const section of sections.length ? sections : [markdown]) {
    if (section.length <= 3600) {
      chunks.push(section);
      continue;
    }

    const paragraphs = section.split(/\n{2,}/g).map(part => part.trim()).filter(Boolean);
    let current = '';
    for (const paragraph of paragraphs) {
      if (current && `${current}\n\n${paragraph}`.length > 3600) {
        chunks.push(current);
        current = paragraph;
      } else {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
      }
    }
    if (current) chunks.push(current);
  }

  return chunks;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
