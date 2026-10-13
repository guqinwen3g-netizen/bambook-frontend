/**
 * techPackService.ts — REQ2-18 Tech Pack 结构化解析（DR-059）。
 * Communicates with /api/v2/orders/:id/techpack endpoints:
 *   POST /:id/techpack/parse — 解析预览（multipart PDF 或 JSON { text }，不落库）
 *   POST /:id/techpack       — 保存快照 + 显式 apply 回填
 *   GET  /:id/techpack       — 现快照
 *   GET  /:id/techpack/file  — 附件下载
 */
import { apiService } from './apiService';

export interface TechPackSnapshot {
  styleNo?: string | null;
  season?: string | null;
  fabricComposition?: Array<{ pct: number; fiber: string }> | null;
  colors?: string[] | null;
  sizeBreakdown?: Record<string, number> | null;
  totalQty?: number | null;
  deliveryDate?: string | null;
  confidence?: Record<string, 'high' | 'low' | 'absent'>;
  pages?: number;
  textLength?: number;
  uploadedAt?: number;
}

export interface TechPackApply {
  product?: string;
  quantity?: number;
  dueDate?: string;
  fabricContent?: string;
  productColorCode?: string;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = data?.error ?? (typeof data?.error === 'string' ? data.error : undefined);
  const rawMessage = data?.message || data?.error || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function techpackUrl(orderId: string, path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v2/orders/${encodeURIComponent(orderId)}/techpack${path}`, base);
}

export const techPackService = {
  /** 解析预览（PDF multipart 或粘贴文本；不落库不回填） */
  async parse(orderId: string, input: { file?: File; text?: string }, endpoint?: string): Promise<{ parsed: TechPackSnapshot; fileName: string | null; sourceType: string }> {
    let res: Response;
    if (input.file) {
      const form = new FormData();
      form.append('file', input.file);
      // multipart 必须剔除 Content-Type（浏览器自动带 boundary），仅保留鉴权头
      const { 'Content-Type': _drop, ...authOnly } = apiService.getAuthHeaders();
      res = await fetch(techpackUrl(orderId, '/parse', endpoint), {
        method: 'POST',
        headers: authOnly,
        body: form,
      });
    } else {
      res = await fetch(techpackUrl(orderId, '/parse', endpoint), {
        method: 'POST',
        headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.text }),
      });
    }
    if (!res.ok) await readError(res, 'techpack parse failed');
    return await res.json();
  },

  /** 保存快照 + 显式勾选回填（applied 返回实际回填字段名） */
  async save(orderId: string, input: { parsed: TechPackSnapshot; fileName?: string | null; apply?: TechPackApply }, endpoint?: string): Promise<{ order: any; applied: string[] }> {
    const res = await fetch(techpackUrl(orderId, '', endpoint), {
      method: 'POST',
      headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'techpack save failed');
    return await res.json();
  },

  /** 现快照 */
  async get(orderId: string, endpoint?: string): Promise<{ techPack: TechPackSnapshot | null; techPackFileName: string | null }> {
    const res = await fetch(techpackUrl(orderId, '', endpoint), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'techpack get failed');
    return await res.json();
  },

  /** 附件下载 URL（浏览器直开） */
  fileUrl(orderId: string, endpoint?: string): string {
    return techpackUrl(orderId, '/file', endpoint);
  },
};
