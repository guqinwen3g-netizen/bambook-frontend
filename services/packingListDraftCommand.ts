import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import type { DocumentVersionRecord } from '../types';

type JsonRow = Record<string, any>;
export type PackingListDraftInput = { requestKey: string; expectedLatestVersion: number; expectedContentHash: string; expectedSourceFingerprint: string; reason: string };
export type PackingListPending = { actorId: string; endpoint: string; documentId: string; shipmentId: string; input: PackingListDraftInput };
export type PackingListSource = { documentId: string; shipmentId: string; source: JsonRow; sourceFingerprint: string; latest: { id: string; version: number; contentHash: string; protocol: 1 | 2 } };
const operation = 'append_packing_list_draft_version';
const hashText = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const invalid = (): never => { throw new Error('原装箱单来源或保存回执不完整，请核对本次保存。'); };
const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])])) : v;
export async function packingListDigest(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(v)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function context() {
  const state = getAuthState(), user = state.user;
  if (!state.isAuthenticated || state.isLoading || !user?.id) throw new Error('请重新登录后核对原单据。');
  return { actorId: user.id, endpoint: apiService.getStoredConfig().cloudEndpoint,
    identity: JSON.stringify([apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders(), state.isLoading, user.id, user.roles, user.roleIds, user.permissions, user.permissionCeiling, user.departmentIds, user.department]) };
}
export async function withPackingListContext<T>(write: boolean, work: (current: () => boolean) => Promise<T>, isCurrent: () => boolean = () => true): Promise<T> {
  const before = context();
  if (!hasPermission('customs:read') || write && !hasPermission('customs:write')) throw new Error('当前账号无权操作本单据。');
  let invalidated = false;
  const check = () => { try { if (context().identity !== before.identity || !isCurrent()) invalidated = true; } catch { invalidated = true; } return !invalidated; };
  const unsubscribe = subscribe(check);
  window.addEventListener('storage', check); window.addEventListener('focus', check);
  try { const result = await work(check); if (!check()) throw new Error('账号、权限或服务地址已变化，请重新打开原单据。'); return result; }
  finally { unsubscribe(); window.removeEventListener('storage', check); window.removeEventListener('focus', check); }
}
function storageKey(documentId: string) { const c = context(); return 'bambook_pl_draft_pending:' + JSON.stringify([c.endpoint, c.actorId, documentId]); }
function parsePending(v: any, documentId: string): PackingListPending {
  const c = context(), i = v?.input;
  if (v?.actorId !== c.actorId || v?.endpoint !== c.endpoint || v?.documentId !== documentId || !text(v.shipmentId) || !i || Object.keys(i).length !== 5
    || !uuid(i.requestKey) || !positive(i.expectedLatestVersion) || !hashText(i.expectedContentHash) || !hashText(i.expectedSourceFingerprint)
    || typeof i.reason !== 'string' || !i.reason.trim() || i.reason !== i.reason.trim() || i.reason.length > 2000) invalid();
  return v;
}
export function readPackingListPending(documentId: string): PackingListPending | null {
  const raw = localStorage.getItem(storageKey(documentId)); if (raw === null) return null;
  try { return parsePending(JSON.parse(raw), documentId); } catch { return invalid(); }
}
export function stagePackingListPending(source: PackingListSource, reason: string): PackingListPending {
  if (readPackingListPending(source.documentId)) throw new Error('请先核对本次保存结果，不能另建一次保存。');
  if (!reason.trim() || reason.length > 2000) throw new Error('请填写追加版本说明（不超过 2000 字）。');
  const c = context(); if (!hasPermission('customs:write')) throw new Error('当前账号无权追加版本。');
  const pending = parsePending({ actorId: c.actorId, endpoint: c.endpoint, documentId: source.documentId, shipmentId: source.shipmentId,
    input: { requestKey: crypto.randomUUID(), expectedLatestVersion: source.latest.version, expectedContentHash: source.latest.contentHash, expectedSourceFingerprint: source.sourceFingerprint, reason: reason.trim() } }, source.documentId);
  const key = storageKey(source.documentId); localStorage.setItem(key, JSON.stringify(pending));
  if (localStorage.getItem(key) !== JSON.stringify(pending)) throw new Error('本次保存意图无法保留，请勿提交。');
  return pending;
}
async function envelope(value: any, documentId: string, shipmentId: string) {
  const s = value?.packingListSource;
  if (value?.plSourceProtocol !== 2 || !hashText(value.packingListHash) || s?.schemaVersion !== 2 || s.document?.id !== documentId
    || !text(s.document.documentNumber) || s.source?.shipmentId !== shipmentId || !text(s.shipment?.shipmentNumber)
    || !Array.isArray(s.lines) || !Array.isArray(s.cartons) || !Array.isArray(s.warnings) || s.warnings.some((v: any) => typeof v !== 'string')
    || !Array.isArray(s.source.orderIds) || typeof s.source.cartonCoverageComplete !== 'boolean'
    || !s.summaries || await packingListDigest(s) !== value.packingListHash) invalid();
  const ids = new Set<string>(), lines = new Map<string, any>();
  for (const line of s.lines) { if (!text(line.shipmentLineId) || ids.has(line.shipmentLineId) || !Number.isSafeInteger(line.lineNumber) || line.lineNumber < 0 || !(line.description === null || typeof line.description === 'string') || !(line.productCode === null || typeof line.productCode === 'string') || !(line.quantity === null || typeof line.quantity === 'string') || !(line.unit === null || typeof line.unit === 'string')) invalid(); ids.add(line.shipmentLineId); lines.set(line.shipmentLineId, line); }
  const cartonIds = new Set<string>();
  for (const carton of s.cartons) {
    if (!text(carton.id) || cartonIds.has(carton.id) || !text(carton.cartonNo) || !Array.isArray(carton.items)) invalid(); cartonIds.add(carton.id);
    for (const key of ['length', 'width', 'height', 'grossWeight', 'netWeight', 'volume']) if (!(carton[key] === null || typeof carton[key] === 'string')) invalid();
    for (const item of carton.items) { const line = lines.get(item.shipmentLineId); if (!text(item.id) || !line || item.orderId !== line.orderId || item.orderLineId !== line.orderLineId || item.unit !== line.unit || typeof item.quantity !== 'string' || !(item.unit === null || typeof item.unit === 'string')) invalid(); }
  }
}
export async function readPackingListSource(documentId: string, shipmentId: string, current?: () => boolean): Promise<PackingListSource> {
  return withPackingListContext(false, async () => {
    const row: any = await apiService.getPackingListDraftSource(documentId);
    if (row?.documentId !== documentId || row?.shipmentId !== shipmentId || !hashText(row.sourceFingerprint) || !text(row.latest?.id)
      || !positive(row.latest.version) || !hashText(row.latest.contentHash) || ![1, 2].includes(row.latest.protocol)) invalid();
    await envelope(row.source, documentId, shipmentId);
    if (await packingListDigest(row.source) !== row.sourceFingerprint) invalid();
    return row;
  }, current);
}
async function verifiedResult(row: any, pending: PackingListPending): Promise<DocumentVersionRecord> {
  const r = row?.receipt, v = row?.version, i = pending.input;
  const parameterHash = await packingListDigest({ operation, actorId: pending.actorId, documentId: pending.documentId, input: i });
  if (r?.operation !== operation || r.protocol !== 2 || !uuid(r.commandId) || r.actorId !== pending.actorId || r.documentId !== pending.documentId || r.shipmentId !== pending.shipmentId
    || r.requestKey !== i.requestKey || r.parameterHash !== parameterHash || r.previousVersion !== i.expectedLatestVersion || r.previousContentHash !== i.expectedContentHash
    || r.sourceFingerprint !== i.expectedSourceFingerprint || r.version !== i.expectedLatestVersion + 1 || !text(r.versionId) || !hashText(r.contentHash)
    || !Array.isArray(r.auditIds) || r.auditIds.length !== 2 || r.auditIds.some((id: any) => !text(id)) || new Set(r.auditIds).size !== 2
    || v?.id !== r.versionId || v.documentId !== pending.documentId || v.version !== r.version || v.changedBy !== pending.actorId
    || v.changeReason !== i.reason || v.content?.plDraftProtocol !== 2 || Object.keys(v.content).length !== 3
    || await packingListDigest(v.content) !== r.contentHash
    || await packingListDigest(v.content.command) !== await packingListDigest({ commandId: r.commandId, requestKey: i.requestKey, actorId: pending.actorId, parameterHash, versionId: r.versionId })) invalid();
  await envelope(v.content.packingList, pending.documentId, pending.shipmentId);
  if (await packingListDigest(v.content.packingList) !== i.expectedSourceFingerprint) invalid();
  return v;
}
export async function resolvePackingListPending(pending: PackingListPending, submit: boolean, current?: () => boolean): Promise<DocumentVersionRecord> {
  const saved = readPackingListPending(pending.documentId);
  if (JSON.stringify(saved) !== JSON.stringify(pending)) invalid();
  return withPackingListContext(submit, async check => {
    const row = submit ? await apiService.appendPackingListDraftVersion(pending.documentId, pending.input)
      : await apiService.getPackingListDraftCommand(pending.documentId, pending.input.requestKey);
    const version = await verifiedResult(row, pending);
    if (!check()) throw new Error('账号、权限或服务地址已变化，请重新打开原单据。');
    if (JSON.stringify(readPackingListPending(pending.documentId)) !== JSON.stringify(pending)) invalid();
    localStorage.removeItem(storageKey(pending.documentId)); return version;
  }, current);
}
export type PackingListArchiveIntent = { documentId: string; version: number };
function archiveKey() { const c = context(); return 'bambook_pl_archive_pending:' + JSON.stringify([c.endpoint, c.actorId]); }
export function readPackingListArchiveIntents(): PackingListArchiveIntent[] {
  const raw = localStorage.getItem(archiveKey()); if (raw === null) return [];
  try { const v = JSON.parse(raw); if (!Array.isArray(v) || v.some(i => !text(i.documentId) || !positive(i.version))) invalid(); return v; } catch { return invalid(); }
}
export function keepPackingListArchiveIntent(intent: PackingListArchiveIntent) {
  if (!text(intent.documentId) || !positive(intent.version)) invalid();
  const rows = readPackingListArchiveIntents(); if (!rows.some(r => r.documentId === intent.documentId && r.version === intent.version)) rows.push(intent);
  localStorage.setItem(archiveKey(), JSON.stringify(rows));
}
export function clearPackingListArchiveIntent(intent: PackingListArchiveIntent) {
  localStorage.setItem(archiveKey(), JSON.stringify(readPackingListArchiveIntents().filter(r => r.documentId !== intent.documentId || r.version !== intent.version)));
}
export function checkPackingListArchiveAck(row: any, version: number) {
  if (row?.version !== version || typeof row.replayed !== 'boolean' || !text(row.fileName) || !text(row.filePath) || !positive(row.fileSize)) invalid();
}


// Multi-ticket commands remain distinct from single-ticket PL append intents.
// Local storage retains only the explicit request, never a substitute source.
export type MergedPackingListInput = { requestKey: string; sourceIds: string[]; expectedSourceFingerprint: string; reason: string; expectedLatestVersion: number; expectedContentHash: string | null };
export type MergedPackingListPending = { actorId: string; endpoint: string; documentId: string | null; input: MergedPackingListInput };
export type MergedPackingListSource = { sourceIds: string[]; sourceFingerprint: string; source: JsonRow; latest: { version: number; contentHash: string | null }; existingDocument: { id: string; documentNumber: string; status: string; version: number; versionId: string; contentHash: string } | null };
const mergedOperation = 'save_merged_packing_list_version';
const mergedInvalid = (): never => { throw new Error('合并装箱单来源或保存回执不完整，请核对本次保存。'); };
function mergedIds(value: any): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 200 || value.some(id => !text(id) || id.trim() !== id) || new Set(value).size !== value.length) mergedInvalid();
  return [...value].sort();
}
const same = (a: any, b: any) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
function mergedStorageKey(documentId: string | null) { const c = context(); return 'bambook_merged_pl_pending:' + JSON.stringify([c.endpoint, c.actorId, documentId]); }
function mergedPending(value: any, documentId: string | null): MergedPackingListPending {
  const c = context(), i = value?.input;
  if (value?.actorId !== c.actorId || value.endpoint !== c.endpoint || value.documentId !== documentId || documentId !== null && !text(documentId)
    || !i || Object.keys(i).length !== 6 || !uuid(i.requestKey) || !hashText(i.expectedSourceFingerprint)
    || typeof i.reason !== 'string' || !i.reason.trim() || i.reason !== i.reason.trim() || i.reason.length > 2000
    || (documentId === null ? i.expectedLatestVersion !== 0 || i.expectedContentHash !== null : !positive(i.expectedLatestVersion) || !hashText(i.expectedContentHash))
    || !same(i.sourceIds, mergedIds(i.sourceIds))) mergedInvalid();
  return value;
}
export function readMergedPackingListPending(documentId: string | null): MergedPackingListPending | null {
  const raw = localStorage.getItem(mergedStorageKey(documentId)); if (raw === null) return null;
  try { return mergedPending(JSON.parse(raw), documentId); } catch { return mergedInvalid(); }
}
export function stageMergedPackingListPending(source: MergedPackingListSource, documentId: string | null, reason: string): MergedPackingListPending {
  if (readMergedPackingListPending(documentId)) throw new Error('请先核对本次保存，不能另建一次操作。');
  if (!hasPermission('customs:write')) throw new Error('当前账号无权登记或追加合并装箱单。');
  if (!reason.trim() || reason.length > 2000) throw new Error('请填写保存说明（不超过 2000 字）。');
  const c = context(), pending = mergedPending({ actorId: c.actorId, endpoint: c.endpoint, documentId,
    input: { requestKey: crypto.randomUUID(), sourceIds: mergedIds(source.sourceIds), expectedSourceFingerprint: source.sourceFingerprint,
      reason: reason.trim(), expectedLatestVersion: source.latest.version, expectedContentHash: source.latest.contentHash } }, documentId);
  const key = mergedStorageKey(documentId); localStorage.setItem(key, JSON.stringify(pending));
  if (localStorage.getItem(key) !== JSON.stringify(pending)) throw new Error('本次保存意图无法保留，请勿提交。');
  return pending;
}
async function mergedEnvelope(value: any, sourceIds: string[], documentId: string) {
  const s = value?.mergedPackingListSource;
  if (value?.mergedPlSourceProtocol !== 1 || !hashText(value.mergedPackingListHash) || s?.schemaVersion !== 1
    || s.document?.id !== documentId || !text(s.document.documentNumber) || !Array.isArray(s.shipments) || !same(s.shipments.map((c: any) => c.source?.shipmentId), sourceIds)
    || !s.summaries || !Array.isArray(s.warnings) || s.warnings.some((v: any) => typeof v !== 'string')
    || await packingListDigest(s) !== value.mergedPackingListHash) mergedInvalid();
  const used = new Set<string>();
  for (const child of s.shipments) {
    const p = child.parties;
    if (!Array.isArray(child.orders) || child.orders.some((o: any) => !text(o.id) || typeof o.customer !== 'string' || !(o.poNumber === null || typeof o.poNumber === 'string'))) mergedInvalid();
    const nullable = (v: any) => v === null || typeof v === 'string';
    if (!p || !Array.isArray(child.orders) || !Array.isArray(p.customerRelationIds) || p.customerRelationIds.length !== child.orders.length || p.customerRelationIds.some((v: any) => !nullable(v))
      || !Array.isArray(p.businessLines) || p.businessLines.length !== child.orders.length || p.businessLines.some((v: any) => !nullable(v))
      || ['consigneeRelationId','consigneeName','docRecipientRelationId','docRecipientName'].some(k => !nullable(p[k]))
      || child.consignee?.name !== p.consigneeName || child.source?.cartonCoverageComplete !== true || !child.cartons?.length || child.cartons.some((c: any) => !c.items?.length)
      || !hashText(child.source.fingerprint)) mergedInvalid();
    const { parties, ...projection } = child;
    const snapshot = { ...projection, document: s.document, exporter: s.exporter };
    await envelope({ plSourceProtocol: 2, packingListHash: await packingListDigest(snapshot), packingListSource: snapshot }, documentId, child.source.shipmentId);
    for (const id of [...child.lines.map((l: any) => l.shipmentLineId), ...child.cartons.map((c: any) => c.id), ...child.cartons.flatMap((c: any) => c.items.map((i: any) => i.id))]) {
      if (used.has(id)) mergedInvalid(); used.add(id);
    }
  }
  return packingListDigest({ sources: s.shipments.map((c: any) => ({ shipmentId: c.source.shipmentId, fingerprint: c.source.fingerprint })), exporter: s.exporter });
}
export async function readMergedPackingListSource(sourceIds: string[], documentId: string | null, current?: () => boolean): Promise<MergedPackingListSource> {
  return withPackingListContext(false, async () => {
    if (!hasPermission('shipments:read')) throw new Error('当前账号无权读取原运单来源。');
    const selected = documentId === null ? mergedIds(sourceIds) : null;
    const row: any = documentId === null ? await apiService.getMergedPackingListSelection(selected!) : await apiService.getPackingListDraftSource(documentId);
    const fixedIds = mergedIds(documentId === null ? row?.sourceIds : row?.shipmentIds);
    if (selected && !same(selected, fixedIds) || documentId !== null && row?.documentId !== documentId || !hashText(row?.sourceFingerprint)) mergedInvalid();
    const existing = documentId === null ? row.existingDocument : null;
    const expectedId = documentId ?? existing?.id ?? 'unregistered-preview';
    if (!text(expectedId) || await mergedEnvelope(row.source, fixedIds, expectedId) !== row.sourceFingerprint) mergedInvalid();
    if (documentId !== null) {
      if (!text(row.latest?.id) || !positive(row.latest.version) || !hashText(row.latest.contentHash) || row.latest.protocol !== 2) mergedInvalid();
    } else if (existing === null) {
      if (row.latest?.version !== 0 || row.latest.contentHash !== null) mergedInvalid();
    } else if (!existing || !text(existing.id) || existing.documentNumber !== row.source.mergedPackingListSource.document.documentNumber
      || !['Draft','Issued','Submitted','Accepted','Rejected','Cancelled'].includes(existing.status) || !positive(existing.version) || !text(existing.versionId) || !hashText(existing.contentHash)
      || row.latest?.version !== existing.version || row.latest.contentHash !== existing.contentHash) mergedInvalid();
    return { sourceIds: fixedIds, sourceFingerprint: row.sourceFingerprint, source: row.source, latest: row.latest, existingDocument: existing };
  }, current);
}
async function mergedResult(row: any, pending: MergedPackingListPending) {
  const r = row?.receipt, v = row?.version, d = row?.document, i = pending.input;
  const parameterHash = await packingListDigest({ operation: mergedOperation, actorId: pending.actorId, documentId: pending.documentId, input: i });
  if (r?.operation !== mergedOperation || r.protocol !== 1 || !uuid(r.commandId) || r.requestKey !== i.requestKey || r.actorId !== pending.actorId
    || !text(r.documentId) || pending.documentId !== null && r.documentId !== pending.documentId || !same(r.sourceIds, i.sourceIds)
    || r.parameterHash !== parameterHash || r.sourceFingerprint !== i.expectedSourceFingerprint || r.previousVersion !== i.expectedLatestVersion
    || r.previousContentHash !== i.expectedContentHash || r.version !== i.expectedLatestVersion + 1 || !text(r.versionId) || !hashText(r.contentHash)
    || !Array.isArray(r.auditIds) || r.auditIds.length !== 2 || r.auditIds.some((id: any) => !text(id)) || new Set(r.auditIds).size !== 2
    || v?.id !== r.versionId || v.documentId !== r.documentId || v.version !== r.version || v.changedBy !== pending.actorId || v.changeReason !== i.reason
    || v.content?.mergedPlDraftProtocol !== 1 || Object.keys(v.content).length !== 3 || await packingListDigest(v.content) !== r.contentHash
    || !d || d.id !== r.documentId || d.type !== 'PackingList' || d.domain !== 'customs' || d.shipmentId !== null || d.orderId !== null || d.deletedAt !== null
    || !['Draft','Issued','Submitted','Accepted','Rejected','Cancelled'].includes(d.status) || typeof row.replayed !== 'boolean'
    || d.sourceRef !== 'merged-pl:v1:' + await packingListDigest(i.sourceIds)
    || await packingListDigest(v.content.command) !== await packingListDigest({ commandId: r.commandId, requestKey: i.requestKey, actorId: pending.actorId, parameterHash, versionId: r.versionId })) mergedInvalid();
  if (await mergedEnvelope(v.content.mergedPackingList, i.sourceIds, r.documentId) !== i.expectedSourceFingerprint
    || d.documentNumber !== v.content.mergedPackingList.mergedPackingListSource.document.documentNumber) mergedInvalid();
  return { documentId: r.documentId as string, version: v as DocumentVersionRecord };
}
export async function resolveMergedPackingListPending(pending: MergedPackingListPending, submit: boolean, current?: () => boolean) {
  if (!same(readMergedPackingListPending(pending.documentId), pending)) mergedInvalid();
  return withPackingListContext(submit, async () => {
    const row: any = submit ? pending.documentId === null ? await apiService.createMergedPackingListDraft(pending.input)
      : await apiService.appendPackingListDraftVersion(pending.documentId, pending.input) : await apiService.getMergedPackingListCommand(pending.input.requestKey);
    if (!submit && (row?.protocol !== 2 || row?.provenance !== 'native' || row?.replayed !== true)) mergedInvalid();
    return mergedResult(row, pending);
  }, current);
}
export function clearMergedPackingListPending(pending: MergedPackingListPending) {
  if (!same(readMergedPackingListPending(pending.documentId), pending)) mergedInvalid();
  localStorage.removeItem(mergedStorageKey(pending.documentId));
}
