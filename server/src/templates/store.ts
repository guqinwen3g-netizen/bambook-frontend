/**
 * RenderedDoc 持久化层 — Phase 6-6
 *
 * 职责：
 *   1. 生成 RenderedDoc ID（RND__{base64url}）
 *   2. 写 RenderedDoc 记录到 DB
 *   3. PDF 文件落盘到 storage/rendered/<id>.pdf
 *
 * 设计：
 *   - 所有函数都是"选调"——调用方可决定是否落库
 *   - 不直接在 render.ts/pdf.ts 中调用，由 route.ts / toolRuntime.ts 按需调用
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

const STORAGE_ROOT = path.resolve(__dirname, '../../storage/rendered');

function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_ROOT)) {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  }
}

/** 生成 RenderedDoc 主键：RND__{8字节base64url} */
export function generateRenderedDocId(): string {
  const short = crypto.randomBytes(6).toString('base64url').toUpperCase();
  return `RND__${short}`;
}

/** 将 PDF Buffer 落盘到 storage/rendered/<id>.pdf，返回绝对路径 */
export function savePdfFile(pdfBuffer: Buffer, id: string): string {
  ensureStorageDir();
  const filePath = path.join(STORAGE_ROOT, `${id}.pdf`);
  fs.writeFileSync(filePath, pdfBuffer);
  return filePath;
}

export interface SaveRenderedDocParams {
  prisma: PrismaClient;
  templateId: string;
  schemaVersion: number;
  inputJson: Record<string, unknown>;
  htmlSha: string;
  htmlBytes: number;
  pdfSha?: string;
  pdfBytes?: number;
  pdfPath?: string;
  format?: string;
  landscape?: boolean;
  invoiceId?: string;
  orderRelationId?: string;
  customerRelationId?: string;
  actorId?: string;
  actorRoles?: string[];
  source?: string;
  notes?: string;
}

/**
 * 写一条 RenderedDoc 记录到 DB。
 * 返回生成的 id；不抛错，调用方负责 catch（日志降级）
 */
export async function saveRenderedDoc(params: SaveRenderedDocParams): Promise<string> {
  const id = generateRenderedDocId();
  const now = Date.now();

  await params.prisma.renderedDoc.create({
    data: {
      id,
      templateId: params.templateId,
      schemaVersion: params.schemaVersion,
      inputJson: params.inputJson as any,
      htmlSha: params.htmlSha,
      htmlBytes: params.htmlBytes,
      pdfSha: params.pdfSha ?? null,
      pdfBytes: params.pdfBytes ?? null,
      pdfPath: params.pdfPath ?? null,
      format: params.format ?? null,
      landscape: params.landscape ?? false,
      invoiceId: params.invoiceId ?? null,
      orderRelationId: params.orderRelationId ?? null,
      customerRelationId: params.customerRelationId ?? null,
      actorId: params.actorId ?? null,
      actorRoles: params.actorRoles === undefined ? Prisma.JsonNull : (params.actorRoles as any),
      source: params.source ?? 'api',
      notes: params.notes ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return id;
}