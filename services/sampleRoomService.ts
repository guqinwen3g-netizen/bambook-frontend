/**
 * SampleRoom API service — REQ2-16 样品间管理（DR-057 v2 库存联动）。
 * Communicates with /api/v1/samples/room endpoints:
 *   POST /room/items            — 样卡登记（编号自动 SC-YYYYMMDD-NNN，二维码载荷）
 *   GET  /room/items            — 列表（状态/类型/搜索/编号直达；附活跃借出与逾期派生）
 *   GET  /room/items/:id        — 详情（含借还历史正序）
 *   POST /room/items/:id/retire — 退役（终态）
 *   POST /room/items/:id/loans  — 借出（borrow）/ 看样登记（viewing）
 *   POST /room/loans/:id/return — 归还（append-only 补记）
 *   GET  /room/loans            — 借还流水（在借/逾期/历史/看样）
 *   GET  /room/low-stock        — 低库存预警（v2 新增）
 *
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品间管理.md
 */
import { apiService } from './apiService';
import { subscribe, getAuthState } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';
import type { SampleLibraryMetadata } from '../server/src/shared/sampleLibraryMetadata';

export type SampleRoomScope = 'fabric' | 'garment' | 'review';
export type SampleRoomBusinessContext = { status: 'resolved' | 'unresolved' | 'conflict'; businessLine: 'fabric' | 'garment' | null; reasons: string[] };
export type SampleRoomListParams = {
  status?: string; cardType?: string; search?: string; code?: string;
  warehouseId?: string; devCaseId?: string; orderId?: string; productAssetId?: string; sampleId?: string; sampleIds?: string[];
  lowStock?: boolean; limit?: number; offset?: number; scope?: SampleRoomScope;
};
export type SampleRoomList = { items: SampleCardItemView[]; total: number; scope?: SampleRoomScope; listVersion?: number; moveVersion?: number; pagination?: { limit: number; offset: number }; snapshotAt?: string };

export type SampleCardType = 'fabric' | 'garment' | 'colorcard' | 'trim' | 'other';
export type SampleCardStatus = 'in_stock' | 'borrowed' | 'retired';
export type SampleLoanType = 'borrow' | 'viewing';

/** Original server-authored receipt; current stock is a separate mutable fact. */
export interface DevelopmentSampleCardReceiptSnapshot {
  version: 1 | 2;
  batchId: string;
  batchCode: string;
  developmentCaseId: string;
  sampleType: string;
  actualQuantity: string | null;
  actualUnit: string | null;
  batchUpdatedAt: string;
  initialPhysicalCardCount: number;
  physicalUnit: string;
  receivedAt: string;
  receivedBy: string;
  /** Only V2 supplies this precise source proof; V1 stays unverified. */
  nativeFamily?: 'fabric-batch' | 'garment-round';
  sourceRound?: number;
  factoryId?: string;
  cardType?: SampleCardType;
  sourceSnapshot?: Record<string, any>;
  sourceFingerprint?: string;
  colorRating?: number | null;
}

export interface NativeOrderSampleCardReceiptSnapshot {
  version:3; kind:'order-native'; physicalReceiptVersion:1;
  source:import('./orderSampleService').NativeRecord['source'];
  initialPhysicalCardCount:number; physicalUnit:'PC'; actualMeasuredQuantity:string|null; actualMeasuredUnit:string|null;
  receivedDate:string; receivedAt:string; receivedBy:string; warehouse:{id:string;code:string;name:string;type:string};location:string|null;
}
export type SampleCardReceiptSnapshot = DevelopmentSampleCardReceiptSnapshot | NativeOrderSampleCardReceiptSnapshot;

export interface SampleCardLoanView {
  id: string;
  itemId: string;
  loanType: SampleLoanType | string;
  loanQuantity: number; // v2：借出数量
  loanLength?: string | number | null;
  returnedLengthQty?: string | number | null;
  lengthReturnHistory?: Array<{requestKey:string;commandHash:string;length?:string;quantity?:number;operatorId:string;returnedAt:string;conditionNote:string|null}> | null;
  countReturnHistory?: Array<{requestKey:string;commandHash:string;quantity:number;operatorId:string;returnedAt:string;conditionNote:string|null}>;
  returnedQuantity?: number | null;
  outstandingQuantity?: number | null;
  borrowerName: string;
  borrowerUserId?: string | null;
  relationId?: string | null;
  relationName?: string | null;
  loanedAt: number;
  dueAt?: number | null;
  returnedAt?: number | null;
  conditionNote?: string | null;
  operatorId?: string | null;
  meterRequestKey?: string | null;
  meterCommandHash?: string | null;
  active: boolean;
  overdue: boolean;
  item?: { id: string; code: string; name: string } | null;
}

export interface SampleCardItemView {
  id: string;
  code: string;
  name: string;
  libraryMetadata?: SampleLibraryMetadata | null; customerRelationId?: string | null; customerName?: string | null; custodianUserId?: string | null;
  businessContext?: SampleRoomBusinessContext;
  cardType: SampleCardType | string;
  colorCardCode?: string | null;
  location?: string | null;
  locationDetail?: { zone: string | null; shelf: string | null; level: string | null; bin: string | null } | null;
  /** 仅实物本身照片；产品参考图与业务证据使用各自来源字段。 */
  photos?: Array<{ id: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; size: number; uploadedAt: string; signature: string; url: string }> | null;
  status: SampleCardStatus | string;
  notes?: string | null;
  createdAt: number;
  // v2 库存字段
  quantity: number;
  availableQty: number;
  physicalLengthQty?: string | number | null;
  availableLengthQty?: string | number | null;
  minStock?: number | null;
  maxStock?: number | null;
  unit?: string | null;
  // v2 软关联
  warehouseId?: string | null;
  devCaseId?: string | null;
  orderId?: string | null;
  productAssetId?: string | null;
  // DR-052 §10#3 迁入对齐：关联统一样品对象（Sample）
  sampleId?: string | null;
  // DR-054 阶段 B/C：批次归属 + 封样实物级 tag（标准批次 reference）
  batchId?: string | null;
  receiptStatus?: 'verified' | 'legacyUnverified' | 'manual';
  receiptSnapshot?: SampleCardReceiptSnapshot | null;
  sealedStatus?: string | null;
  sealedAt?: number | null;
  sealedBy?: string | null;
  standardBatchNo?: string | null;
  // v2 关联单据摘要（列表 join）
  devCaseCode?: string | null;
  devCaseName?: string | null;
  orderPoNumber?: string | null;
  orderCustomer?: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  productAssetSku?: string | null;
  productAssetName?: string | null;
  productAssetCategory?: string | null;
  // 关联样品摘要（DR-052 迁入对齐）
  sampleCode?: string | null;
  sampleType?: string | null;
  // 派生
  activeLoan: SampleCardLoanView | null;
  /** 全部未归还借出（部分借出多笔并行时逐笔可独立归还） */
  activeLoans?: SampleCardLoanView[];
  overdue: boolean;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined);
  const rawMessage = data?.error?.message || data?.message || data?.error || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function roomUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/samples/room${path}`, base);
}

const custodyCanonical=(value:any):any=>Array.isArray(value)?value.map(custodyCanonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,custodyCanonical(value[key])])):value;
async function custodyDigest(value:unknown,sort=true) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(sort?custodyCanonical(value):value)))))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function custodyContext() {return {identity:dashboardReadIdentity(),actorId:getAuthState().user?.id};}
function assertCustodyContext(context:ReturnType<typeof custodyContext>) {
  if(!context.actorId||context.actorId!==getAuthState().user?.id||context.identity!==dashboardReadIdentity())
    throw new Error('当前会话已变化，原实物登记仍需核对。');
}
function receiptFailure():never {throw new Error('实物登记回执与原请求不一致，请保留原登记并重新核对。');}
function normalizedMeters(value:unknown):string {
  const raw=String(value??'').trim();if(!/^\d{1,14}(?:\.\d{1,4})?$/.test(raw))return receiptFailure();
  const [whole,fraction='']=raw.split('.'),left=whole.replace(/^0+(?=\d)/,''),right=fraction.replace(/0+$/,'');return right?`${left}.${right}`:left;
}
async function verifyCustodyMove(data:any,itemId:string,operation:'borrow'|'viewing'|'ship',input:any,context:ReturnType<typeof custodyContext>) {
  assertCustodyContext(context);
  const loan=data?.loan,item=data?.item,meter=operation!=='viewing'&&(input.loanLength!==undefined||input.shipLength!==undefined);
  const name=String(operation==='ship'?input.recipientName??'':input.borrowerName??'').trim();
  const dueAt=operation==='viewing'||input.dueAt==null?null:Number(input.dueAt),relationId=operation==='borrow'?null:input.relationId??null;
  const borrowerUserId=operation==='borrow'?input.borrowerUserId??null:null;
  const quantity=operation==='ship'?input.shipQuantity:input.loanQuantity??1;
  const length=meter?normalizedMeters(operation==='ship'?input.shipLength:input.loanLength):null;
  const command=meter?{operation,itemId,length,name,dueAt,relationId,borrowerUserId:input.borrowerUserId??null}
    :{stockVersion:1,operation,itemId,quantity,unit:item?.unit??null,name,dueAt,relationId,borrowerUserId};
  const hash=await custodyDigest(command,!meter);assertCustodyContext(context);
  if(!loan?.id||item?.id!==itemId||loan.itemId!==itemId||loan.loanType!==operation||loan.operatorId!==context.actorId
    ||loan.meterRequestKey!==input.requestKey||loan.meterCommandHash!==hash||loan.borrowerName!==name
    ||(loan.dueAt==null?null:Number(loan.dueAt))!==dueAt||(loan.relationId??null)!==relationId
    ||(loan.borrowerUserId??null)!==(meter?input.borrowerUserId??null:borrowerUserId)
    ||(meter?normalizedMeters(loan.loanLength)!==length:loan.loanLength!=null||loan.loanQuantity!==quantity))receiptFailure();
}
async function verifyCustodyReturn(data:any,loanId:string,input:any,context:ReturnType<typeof custodyContext>) {
  assertCustodyContext(context);
  const meter=input.returnLength!==undefined,note=String(input.conditionNote??'').trim().slice(0,500),length=meter?normalizedMeters(input.returnLength):null;
  const hash=await custodyDigest(meter?{loanId,length,note}:{loanId,returnQuantity:input.returnQuantity,conditionNote:note||null},!meter);
  assertCustodyContext(context);
  const records=meter?data?.loan?.lengthReturnHistory:data?.loan?.countReturnHistory;
  const event=Array.isArray(records)?records.find(row=>row.requestKey===input.requestKey&&row.operatorId===context.actorId):null;
  if(data?.loan?.id!==loanId||!data.item?.id||data.loan.itemId!==data.item.id||!event||event.commandHash!==hash
    ||(event.conditionNote??null)!==(note||null)||(meter?normalizedMeters(event.length)!==length:event.quantity!==input.returnQuantity))receiptFailure();
}

export const sampleRoomService = {
  /** Upload one private physical-item photo. The server validates and stores bytes outside public uploads. */
  async uploadPhoto(itemId: string, file: File, endpoint?: string): Promise<{ item: SampleCardItemView; photo: NonNullable<SampleCardItemView['photos']>[number] }> {
    const form = new FormData(); form.append('photos', file, file.name || 'sample-photo');
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(itemId)}/photos`, endpoint), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: form,
    });
    if (!res.ok) await readError(res, 'sample room uploadPhoto failed');
    const data = await res.json();
    if (!data?.item || !Array.isArray(data.item.photos)) throw Error('样品照片登记响应不完整，请重新读取');
    data.item.photos = data.item.photos.map((photo: any) => ({ ...photo, url: typeof photo?.url === 'string' ? apiService.buildApiUrl(photo.url, endpoint) : photo?.url }));
    const photo = data.item.photos.find((row: any) => row && typeof row.id === 'string' && typeof row.url === 'string');
    if (!photo) throw Error('样品照片登记结果缺少照片记录，请重新读取');
    return { item: data.item, photo };
  },
  /** Read a private sample photo with the current bearer credentials; never hand signed URLs to the browser image loader. */
  async loadPrivatePhoto(url: string, endpoint?: string, signal?: AbortSignal): Promise<Blob> {
    if (typeof url !== 'string' || !(url.startsWith('/api/v1/samples/room/items/') || /^https?:\/\//i.test(url))) throw Error('样品照片地址无效');
    const base = new URL(apiService.buildApiUrl('/v1/samples/room/items', endpoint));
    const target = new URL(/^https?:\/\//i.test(url) ? url : apiService.buildApiUrl(url, endpoint));
    const routePrefix = base.pathname.replace(/\/v1\/samples\/room\/items\/?$/, '').replace(/\/$/, '');
    if (target.origin !== base.origin || !new RegExp(`^${routePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v1/samples/room/items/[^/]+/photos/[^/]+$`).test(target.pathname)) throw Error('样品照片来源无效');
    const res = await fetch(target.toString(), { headers: apiService.getAuthHeaders(), signal, cache: 'no-store' });
    if (!res.ok) await readError(res, 'sample room loadPrivatePhoto failed');
    if (!/^image\/(jpeg|png|webp)$/i.test(res.headers.get('content-type') || '')) throw Error('样品照片类型无效');
    const blob = await res.blob();
    if (!blob.size) throw Error('样品照片内容为空');
    return blob;
  },
  /** 样卡登记（编号自动生成，二维码载荷 = code） */
  async createItem(input: {
    name: string; cardType?: string; colorCardCode?: string; location?: string; notes?: string;
    quantity?: number; physicalLengthQty?: string | number; minStock?: number | null; maxStock?: number | null; unit?: string;
    warehouseId?: string; devCaseId?: string; orderId?: string; productAssetId?: string;
    sampleId?: string; libraryMetadata?: SampleLibraryMetadata | null; customerRelationId?: string;
    locationDetail?: SampleCardItemView['locationDetail']; clientRequestId?: string;
  }, endpoint?: string): Promise<SampleCardItemView> {
    const res = await fetch(roomUrl('/items', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'sample room createItem failed');
    const data = await res.json();
    return data.item;
  },

  async updateLibrary(id: string, input: { productAssetId?: string; name?: string; notes?: string; libraryMetadata?: SampleLibraryMetadata | null; location?: string | null; locationDetail?: SampleCardItemView['locationDetail']; warehouseId?: string | null }, endpoint?: string): Promise<SampleCardItemView> {
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(id)}/library`, endpoint), { method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) await readError(res, '样品档案保存失败');
    const data = await res.json(); if (!data?.item?.id) throw Error('样品档案保存结果未能确认，请重新读取'); return data.item;
  },

  /** 列表（状态/类型/搜索/编号直达 + v2 关联过滤 + lowStock + productAssetId/sampleId；v3 样品库 sampleIds 批量） */
  async listItems(params: SampleRoomListParams = {}, endpoint?: string, options: { signal?: AbortSignal; current?: () => boolean } = {}): Promise<SampleRoomList> {
    if (params.sampleIds !== undefined && (!Array.isArray(params.sampleIds) || params.sampleIds.length === 0 || params.sampleIds.some(id => typeof id !== 'string' || !id || id.trim() !== id))) throw Error('样品筛选目标为空或编号不规范，请清除筛选后重新读取');
    const query = new URLSearchParams();
    const filters: any = {};
    for (const key of ['status', 'cardType', 'search', 'code', 'warehouseId', 'devCaseId', 'orderId', 'productAssetId', 'sampleId'] as const) {
      filters[key] = params[key] || null; if (params[key]) query.set(key, params[key]!);
    }
    filters.sampleIds = [...new Set(params.sampleIds || [])].sort();
    filters.lowStock = params.lowStock === true;
    if (filters.sampleIds.length) query.set('sampleIds', filters.sampleIds.join(','));
    if (params.lowStock !== undefined) query.set('lowStock', String(params.lowStock));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.scope !== undefined) query.set('scope', params.scope);
    const qs = query.toString(), url = `${roomUrl('/items', endpoint)}${qs ? `?${qs}` : ''}`;
    const headers = apiService.getAuthHeaders();
    const scoped = params.scope !== undefined, identity = scoped ? dashboardReadIdentity() : null;
    const controller = new AbortController(); let invalid = false;
    const check = () => { if (invalid || options.signal?.aborted || options.current?.() === false || scoped && dashboardReadIdentity() !== identity) throw Error('账号、权限、服务或样品间筛选已变化，请重新读取'); };
    const watch = () => { if (scoped && dashboardReadIdentity() !== identity || options.current?.() === false) { invalid = true; controller.abort(); } };
    const abort = () => { invalid = true; controller.abort(); };
    const stop = scoped ? subscribe(watch) : () => {};
    options.signal?.addEventListener('abort', abort, { once: true });
    if (scoped && typeof window !== 'undefined') for (const event of ['storage', 'focus', 'bambook:email-context-changed']) window.addEventListener(event, watch);
    try {
      check();
      const res = await fetch(url, { headers, signal: controller.signal }); check();
      if (!res.ok) await readError(res, 'sample room listItems failed');
      const data = await res.json(); check();
      if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw Error('样品间列表响应不完整，请重新读取');
      if (scoped) {
        const limit = params.limit ?? 50, offset = params.offset ?? 0;
        const validContext = (item: any) => {
          const c = item?.businessContext;
          return typeof item?.id === 'string' && typeof item.name === 'string' && typeof item.code === 'string' && c && Array.isArray(c.reasons) && c.reasons.every((r: any) => typeof r === 'string')
            && (params.scope === 'review' ? ['unresolved', 'conflict'].includes(c.status) && c.businessLine === null : c.status === 'resolved' && c.businessLine === params.scope);
        };
        if (data.listVersion !== 2 || data.scope !== params.scope || data.pagination?.limit !== limit || data.pagination?.offset !== offset
          || typeof data.snapshotAt !== 'string' || !/^\d+$/.test(data.snapshotAt)
          || Object.keys(filters).some(k => JSON.stringify(data.filters?.[k]) !== JSON.stringify(filters[k]))
          || data.items.length !== Math.min(limit, Math.max(0, data.total - offset)) || !data.items.every(validContext)) throw Error('样品间服务尚未提供正确的业务分线与分页，请更新服务后重试');
      }
      return { items: data.items, total: data.total, scope: data.scope, listVersion: data.listVersion, pagination: data.pagination, snapshotAt: data.snapshotAt, moveVersion:data.moveVersion };
    } finally {
      stop(); options.signal?.removeEventListener('abort', abort);
      if (scoped && typeof window !== 'undefined') for (const event of ['storage', 'focus', 'bambook:email-context-changed']) window.removeEventListener(event, watch);
    }
  },

  /** 详情（含借还历史正序） */
  async getItem(id: string, endpoint?: string): Promise<{ item: SampleCardItemView; loans: SampleCardLoanView[] }> {
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(id)}`, endpoint), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'sample room getItem failed');
    const data = await res.json();
    if (data?.item && Array.isArray(data.item.photos)) data.item.photos = data.item.photos.map((photo: any) => ({ ...photo, url: typeof photo?.url === 'string' ? apiService.buildApiUrl(photo.url, endpoint) : photo?.url }));
    return data;
  },

  /** 退役（终态；在借不可退役） */
  async retireItem(id: string, note?: string, endpoint?: string): Promise<SampleCardItemView> {
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(id)}/retire`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ note }),
    });
    if (!res.ok) await readError(res, 'sample room retireItem failed');
    const data = await res.json();
    return data.item;
  },

  /** 借出（borrow）/ 看样登记（viewing，relationId 挂客户） */
  async createLoan(itemId: string, input: {
    loanType: SampleLoanType; loanQuantity?: number; loanLength?: string; requestKey?: string; borrowerName: string; borrowerUserId?: string; relationId?: string; dueAt?: number;
  }, endpoint?: string): Promise<{ loan: SampleCardLoanView; item: SampleCardItemView }> {
    const context=input.requestKey?custodyContext():null;
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(itemId)}/loans`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'sample room createLoan failed');
    const data=await res.json();if(context)await verifyCustodyMove(data,itemId,input.loanType,input,context);return data;
  },

  /** DR-054 阶段 C：寄出出样（ship）——寄出=扣减数量+终态归档，不可归还 */
  async shipItem(itemId: string, input: { shipQuantity?: number; shipLength?: string; requestKey?: string; recipientName: string; relationId?: string; dueAt?: number }, endpoint?: string): Promise<{ loan: SampleCardLoanView; item: SampleCardItemView; archived?: boolean }> {
    const context=input.requestKey?custodyContext():null;
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(itemId)}/ship`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'sample room shipItem failed');
    const data=await res.json();if(context)await verifyCustodyMove(data,itemId,'ship',input,context);return data;
  },

  /** DR-054 阶段 C：封样 = 实物级 tag（记录标准批次 reference） */
  async sealCard(id: string, input: { standardBatchNo?: string; notes?: string }, endpoint?: string): Promise<SampleCardItemView> {
    const res = await fetch(roomUrl(`/items/${encodeURIComponent(id)}/seal`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'sample room sealCard failed');
    const data = await res.json();
    return data.item;
  },

  /** 归还（append-only：只补 returnedAt/conditionNote） */
  async returnLoan(loanId: string, conditionNote?: string | {returnLength?:string;returnQuantity?:number;requestKey:string;conditionNote?:string}, endpoint?: string): Promise<{ loan: SampleCardLoanView; item: SampleCardItemView }> {
    const context=typeof conditionNote==='object'&&conditionNote?.requestKey?custodyContext():null;
    const res = await fetch(roomUrl(`/loans/${encodeURIComponent(loanId)}/return`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(typeof conditionNote === 'object' ? conditionNote : { conditionNote }),
    });
    if (!res.ok) await readError(res, 'sample room returnLoan failed');
    const data=await res.json();if(context)await verifyCustodyReturn(data,loanId,conditionNote,context);return data;
  },

  /** 借还流水（在借/逾期/历史/看样） */
  async listLoans(params: { active?: boolean; overdue?: boolean; loanType?: string; limit?: number } = {}, endpoint?: string): Promise<{ loans: SampleCardLoanView[] }> {
    const query = new URLSearchParams();
    if (params.active === true) query.set('active', 'true');
    if (params.active === false) query.set('active', 'false');
    if (params.overdue === true) query.set('overdue', 'true');
    if (params.loanType) query.set('loanType', params.loanType);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    const res = await fetch(`${roomUrl('/loans', endpoint)}${qs ? `?${qs}` : ''}`, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'sample room listLoans failed');
    const data = await res.json();
    return { loans: Array.isArray(data.loans) ? data.loans : [] };
  },

  /** 低库存预警（v2 新增） */
  async listLowStock(limit?: number, endpoint?: string): Promise<{ items: SampleCardItemView[]; total: number }> {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    const qs = query.toString();
    const res = await fetch(`${roomUrl('/low-stock', endpoint)}${qs ? `?${qs}` : ''}`, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'sample room listLowStock failed');
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [], total: Number(data.total ?? 0) };
  },
};
