/**
 * fabricExclusivityClient — P1-3 客户专属面料行级即时预检（前端薄封装）
 *
 * 后端契约：server/src/products/route.ts POST /api/v1/products/fabric-exclusivity/check
 * 校验真源：server/src/products/fabricExclusivityService.ts（四入口 fail-closed 单一真源）
 *
 * 定位边界：
 *   - 仅用于「行内面料字段编辑时的提前警示」，宽语义预检（端点固定 clientCodeGlobalFallback=false，
 *     不做全局客供品号兜底，防异义碰撞误报）；
 *   - 警示不放行、不阻断提交 —— 提交仍由后端 assertFabricAllowed fail-closed 兜底（409 EXCLUSIVE_FABRIC_BLOCKED）；
 *   - API 不可达 / 网络失败时本封装抛错，调用方应静默降级（不阻塞录入、不打扰用户）。
 *
 * 产品锚解析键（与后端 resolveProductAssets 对齐，传并集即可）：
 *   productAssetId（直查）> sku > articleNo/millQuality > clientCode（宽键 fabricCode 会同时填充 sku/articleNo/clientCode）
 */
import { apiService } from './apiService';

/** 违规条目（与后端 ExclusivityViolation 同构） */
export interface FabricExclusivityViolation {
  productAssetId: string;
  sku: string | null;
  productName: string | null;
  ownerCustomerName: string | null;
  ownerRelationId: string | null;
  clientCode: string | null;
}

export interface FabricExclusivityCheckInput {
  /** 宽键：sku/厂号/品色号/客供品号皆可（QuotationLine.fabricCode 语义） */
  fabricCode?: string | null;
  /** 产品档案直锚（选中档案面料时优先传） */
  productAssetId?: string | null;
  /** ProductAsset.sku */
  sku?: string | null;
  /** FabricProfile.articleNo */
  articleNo?: string | null;
  /** FabricProfile.millQuality（工厂品色号） */
  millQuality?: string | null;
  /** FabricCustomerCode.clientCode（客供品号；OrderLine.materialCode 语义） */
  clientCode?: string | null;
  /** 当前单据客户（relation 优先，名称快照兜底匹配） */
  customerRelationId?: string | null;
  customerName?: string | null;
}

export interface FabricExclusivityCheckResult {
  allowed: boolean;
  violations: FabricExclusivityViolation[];
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined);
  const rawMessage = data?.error?.message || data?.message || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

/**
 * 客户专属面料预检（只读）。返回 allowed=false 时 violations 含属主客户名与产品名，
 * 供 UI 渲染行级警示文案；网络/API 失败直接抛错（由调用方静默降级处理）。
 */
export async function checkFabricExclusivity(
  input: FabricExclusivityCheckInput,
  endpoint?: string,
): Promise<FabricExclusivityCheckResult> {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  const res = await fetch(apiService.buildApiUrl('/v1/products/fabric-exclusivity/check', base), {
    method: 'POST',
    headers: apiService.getAuthHeaders(),
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) await readError(res, 'fabric exclusivity check failed');
  const data = await res.json();
  return {
    allowed: data?.allowed !== false,
    violations: Array.isArray(data?.violations) ? data.violations : [],
  };
}
