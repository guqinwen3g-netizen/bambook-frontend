/**
 * 模板渲染引擎 — Phase 6 Compiled Templates
 *
 * 设计原则：
 *   1. 模板注册表（registry）：每个模板由 id 唯一标识，含 schemaVersion + render 函数
 *   2. 纯函数渲染：data → html，不接 DB、不写文件，保持可测试
 *   3. 可扩展：未来加 PI / PL / CI 时只需 registerTemplate
 *
 * 不在本模块的：
 *   - HTTP 路由（见 ./route.ts）
 *   - PDF 转换（见 ./pdf.ts）
 *   - 持久化（见 ./store.ts，将写 RenderedDoc）
 */

import crypto from 'crypto';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../shared/routeError';
import {
  generatePdasSampleInvoiceHtml,
  type PdasSampleInvoiceDocument,
} from './invoice/pdas-sample';
import {
  generateFabricSampleInvoiceHtml,
  type SampleInvoiceDocument as FabricSampleInvoiceDocument,
} from './invoice/fabric-sample';

export type TemplateId =
  | 'invoice.sample.pdas'
  | 'invoice.sample.fabric';

export interface TemplateMeta {
  id: TemplateId;
  /** 业务域，用于 manifest 分组 */
  domain: 'invoice';
  /** 人类可读名称 */
  title: string;
  /** 模板格式版本，破坏性变更时升 */
  schemaVersion: number;
  /** 数据来源说明 */
  sourceNote: string;
}

interface TemplateEntry<T> {
  meta: TemplateMeta;
  render: (data: T) => string;
}

const REGISTRY = new Map<TemplateId, TemplateEntry<unknown>>();

const registerTemplate = <T>(entry: TemplateEntry<T>) => {
  REGISTRY.set(entry.meta.id, entry as TemplateEntry<unknown>);
};

registerTemplate<PdasSampleInvoiceDocument>({
  meta: {
    id: 'invoice.sample.pdas',
    domain: 'invoice',
    title: 'PDAS 样品发票（通用）',
    schemaVersion: 1,
    sourceNote: 'Migrated from components/tools/SampleInvoiceGenerator.tsx (lines 130-237).',
  },
  render: data => generatePdasSampleInvoiceHtml(data),
});

registerTemplate<FabricSampleInvoiceDocument>({
  meta: {
    id: 'invoice.sample.fabric',
    domain: 'invoice',
    title: 'Fabric 面料样品发票',
    schemaVersion: 1,
    sourceNote: 'Migrated from components/tools/sampleInvoiceTemplate.ts (generateFabricSampleInvoiceHtml).',
  },
  render: data => generateFabricSampleInvoiceHtml(data),
});

export interface RenderResult {
  templateId: TemplateId;
  schemaVersion: number;
  html: string;
  /** sha256(html) 前 16 字符，用于幂等去重 */
  sha: string;
  bytes: number;
  generatedAt: string;
}

type TemplateRefusalTuple = Readonly<{ code: 'TemplateNotFound' | 'TemplateRenderFailed'; statusCode: 404 | 422; message: string }>;
const templateRefusalTuples = new WeakMap<object, TemplateRefusalTuple>();
export const readTemplateRefusalTuple = (error: unknown): TemplateRefusalTuple | undefined =>
  typeof error === 'object' && error !== null ? templateRefusalTuples.get(error) : undefined;

const templateRefusals = new WeakMap<object, string>();
export const readTemplateRefusal = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? templateRefusals.get(error) : undefined;

export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Template not found: ${id}`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateRenderError extends Error {
  constructor(id: string, cause: unknown) {
    super(GENERIC_ROUTE_ERROR_MESSAGE);
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    this.name = 'TemplateRenderError';
  }
}

export const listTemplates = (): TemplateMeta[] =>
  Array.from(REGISTRY.values()).map(entry => entry.meta);

export const getTemplateMeta = (id: TemplateId): TemplateMeta | undefined =>
  REGISTRY.get(id)?.meta;

export const renderTemplate = <T = unknown>(id: TemplateId, data: T): RenderResult => {
  const entry = REGISTRY.get(id) as TemplateEntry<T> | undefined;
  if (!entry) {
    const error = new TemplateNotFoundError(id);
    templateRefusals.set(error, error.message);
    templateRefusalTuples.set(error, Object.freeze({ code: 'TemplateNotFound', statusCode: 404, message: error.message }));
    throw error;
  }

  let html: string;
  try {
    html = entry.render(data);
  } catch (err) {
    const error = new TemplateRenderError(id, err);
    templateRefusals.set(error, GENERIC_ROUTE_ERROR_MESSAGE);
    templateRefusalTuples.set(error, Object.freeze({ code: 'TemplateRenderFailed', statusCode: 422, message: GENERIC_ROUTE_ERROR_MESSAGE }));
    throw error;
  }

  const sha = crypto.createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);

  return {
    templateId: id,
    schemaVersion: entry.meta.schemaVersion,
    html,
    sha,
    bytes: Buffer.byteLength(html, 'utf8'),
    generatedAt: new Date().toISOString(),
  };
};
