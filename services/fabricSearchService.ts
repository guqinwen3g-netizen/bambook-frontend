import { apiService } from './apiService';
export type BusinessPersonnel = { users: { id: string; displayName: string; teams: { id: string; name: string; family: 'fabric' | 'garment' }[] }[]; requestTeams: { id: string; name: string; family: string }[]; routingTeams?: { id: string; name: string; headId: string | null }[] };
export type FabricSearchTask = { id: string; code: string; name: string; initiator: string; requesterId: string; assigneeId: string | null; routingTeamId?: string | null; responsibleHeadId?: string | null; routingTeam?: { id: string; name: string } | null; responsibleHead?: { id: string; displayName: string } | null; canClaim?: boolean; canAssign?: boolean; requestTeamId: string | null; customerRelationId: string | null; customerName: string | null; requestText: string; targetDate: string | null; status: string; revision: number; feedbackNote?: string; completionNote?: string; flowHistory?: {action:string;actorName:string;at:string;note:string}[]; requester: {displayName: string}; assignee: {displayName: string} | null; results: {assetId: string; recommendation?: string; asset: {id: string; name: string; sku: string}}[] };
export async function fabricSearchRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const auth = JSON.stringify(apiService.getAuthHeaders());
  const endpoint = apiService.buildApiUrl(`/v1/development/${path}`);
  const response = await fetch(apiService.buildApiUrl(`/v1/development/${path}`), { method, headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (auth !== JSON.stringify(apiService.getAuthHeaders()) || endpoint !== apiService.buildApiUrl(`/v1/development/${path}`)) throw new Error('账号或开发环境已切换，请重新打开任务。');
  if (!response.ok || !result.ok) throw new Error(result.error?.message || '操作未完成，请重试。');
  return result.data;
}
