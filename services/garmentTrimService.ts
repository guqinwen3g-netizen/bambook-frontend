import { apiService } from './apiService';
export interface TrimAttachment { name: string; url: string }
export interface GarmentTrimTask { id: string; developmentCaseId: string; requirements: string; supplierRelationId: string; supplierName: string | null; quantity: string; unit: string; dueDate: string | null; attachments: TrimAttachment[]; confirmedAt: string | null; confirmedBy: string | null; finalDetails: Record<string, any> | null; productAssetId: string | null; revision: number }
export interface GarmentMaterialUse { id: string; developmentCaseId: string; sampleVersionId: string | null; trimTaskId: string | null; productAssetId: string; position: string; specification: string | null; color: string | null; perPiece: string | null; unit: string | null; provider: 'company' | 'factory'; colorMode: 'dtm' | 'specified' | 'contrast' | 'unspecified'; colorReference: string | null; sourceNature: 'existing' | 'developed' | 'substitute'; snapshot: { catalog: { id: string; sku: string; name: string; imageUrl?: string; trimmingProfile: Record<string, any> }; usage: Record<string, any> }; revision: number }
export interface GarmentTrimCommand { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> }
export class GarmentTrimError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function request<T>(caseId: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/${path}`, apiService.getStoredConfig().cloudEndpoint), {
    method, headers: apiService.getAuthHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new GarmentTrimError(data?.error?.message || '辅料操作未完成，请核对后重试', response.status, data?.error?.code);
  if (!data) throw new Error('辅料响应不完整，请核对原请求');
  return data;
}
export const garmentTrimService = {
  read: (caseId: string) => request<{ tasks: GarmentTrimTask[]; materialUses: GarmentMaterialUse[] }>(caseId, 'garment-trims'),
  execute: (caseId: string, command: GarmentTrimCommand) => request<{ task?: GarmentTrimTask; materialUse?: GarmentMaterialUse }>(caseId, command.path, command.method, command.body),
  notice: (caseId: string, taskId: string) => request<{ notice: Record<string, any> }>(caseId, `garment-trim-tasks/${encodeURIComponent(taskId)}/notice`),
};
