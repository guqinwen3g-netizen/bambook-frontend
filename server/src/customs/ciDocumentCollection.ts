import { readPackingListVersionInTx, isPackingListCandidateInTx } from './shipmentPackingListCommand';
import { readBusinessErrorMint } from '../shared/errorCodes';
/** CI visibility is resolved over the complete original filtered query before
 * pagination. Native history authority remains the only row eligibility rule.
 * Reads are bounded; no guessed orderId-only substitute or permission cache. */
import { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { currentDocumentActor, documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { createCustomsService } from './customsService';
import { readHistoricalCiDocumentInTx } from './ciInvoiceSource';
import { packTradeDocumentsByOrder } from './tradeDocumentLifecycleService';
import { isSupplierContractDocumentCandidate } from './supplierContractDocumentPolicy';
import { readSupplierDocumentHistoryInTx } from './supplierContractDocumentHistory';
import { SupplierContractError } from '../procurement/supplierContractPolicy';
import crypto from 'crypto';

export const CI_COLLECTION_CHUNK_SIZE = 200;
type ListParams = Parameters<ReturnType<typeof createCustomsService>['listTradeDocuments']>[0];
type Page = { items: any[]; total: number };
type PageReader = (offset: number) => Promise<Page>;
const ciType = 'CommercialInvoice';
const ordinaryInvisible = (error: unknown) => { const minted = readBusinessErrorMint(error); return error instanceof SupplierContractError
  ? [403, 404].includes(error.statusCode) : !!minted && ['NOT_FOUND', 'FORBIDDEN', 'INSUFFICIENT_SCOPE'].includes(minted.code); };
function changed(): never { throw businessError('CONFLICT', '单据集合或当前可见范围在读取时变化，请刷新后重试。'); }

/** Original createdAt remains primary; id only resolves its native ties. */
function stableCiOrderBy(orderBy: any) {
  const primary = Array.isArray(orderBy) ? orderBy : [orderBy];
  return primary.some(part => part?.id !== undefined) ? orderBy : [...primary, { id: 'asc' }];
}

function stableCiPagedClient(tx: any) {
  return new Proxy(tx, { get(target, key) {
    if (key !== 'tradeDocument') return Reflect.get(target, key);
    return new Proxy(target.tradeDocument, { get(delegate, method) {
      if (method !== 'findMany') return Reflect.get(delegate, method);
      return (args: any) => delegate.findMany({ ...args, orderBy: stableCiOrderBy(args.orderBy) });
    } });
  } });
}

/** Compare actual native policy outputs, never build a new visibility policy.
 * The strict adapter detects the original resolver's compatibility catches. */
async function authorityStamp(tx: any, trustedActor: TokenPayload | null): Promise<string> {
  const actor = await currentDocumentActor(tx, trustedActor, ['customs:read']);
  const orders = await freshOrderLineScope(tx, actor);
  let failed = false;
  const strict = new Proxy(tx, { get(target, key) {
    if (key !== 'teamMember') return Reflect.get(target, key);
    if (!target.teamMember) { failed = true; throw businessError('AUTHORIZATION_UNAVAILABLE', '当前单据范围暂时无法核验。'); }
    return new Proxy(target.teamMember, { get(delegate, method) {
      if (method !== 'findMany') return Reflect.get(delegate, method);
      return async (...args: any[]) => { try { return await delegate.findMany(...args); } catch (error) { failed = true; throw error; } };
    } });
  } });
  const finance = await createPermissionService({ prisma: strict }).getDataScopeResolver(actor, 'finance');
  if (failed) throw businessError('AUTHORIZATION_UNAVAILABLE', '当前单据范围暂时无法核验。');
  const finalActor = await currentDocumentActor(tx, trustedActor, ['customs:read']);
  return documentSourceFingerprint({ actor, orders, finance, finalActor });
}

async function sweep(tx: any, trustedActor: TokenPayload | null, readPage: PageReader, limit: number, offset: number, orderId?: string, requestedType?: string, shipmentId?: string) {
  const before = await authorityStamp(tx, trustedActor), digest = crypto.createHash('sha256'), seen = new Set<string>();
  let sourceTotal: number | undefined, visibleTotal = 0; const items: any[] = [];
  for (let sourceOffset = 0; ; sourceOffset += CI_COLLECTION_CHUNK_SIZE) {
    const page = await readPage(sourceOffset);
    if (!Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.items)
      || page.items.length > CI_COLLECTION_CHUNK_SIZE || sourceTotal !== undefined && sourceTotal !== page.total) changed();
    sourceTotal = page.total;
    for (const row of page.items) {
      if (typeof row.id !== 'string' || seen.has(row.id)) changed();
      seen.add(row.id); digest.update(documentSourceFingerprint(row));
      const packingList = await isPackingListCandidateInTx(tx, row);
      digest.update(packingList ? 'packing-list-lineage' : 'ordinary-lineage');
      // Query type filters cannot erase native lineage. Other ordinary rows
      // still use their original header type and never inherit PL authority.
      if (requestedType && row.type !== requestedType && !(requestedType === 'PackingList' && packingList)) continue;
      let visible = true, history: any;
      const supplier = isSupplierContractDocumentCandidate(row);
      if (supplier) {
        try {
          const exact = await readSupplierDocumentHistoryInTx(tx, row.id, trustedActor);
          history = { fingerprint: exact.fingerprint, orderIds: exact.orderIds, supplierDocumentProof: exact.proofState };
        } catch (error) { if (!ordinaryInvisible(error)) throw error; visible = false; }
      } else if (packingList) {
        try { history = await readPackingListVersionInTx(tx, { documentId: row.id, trustedActor }); }
        catch (error) { if (!ordinaryInvisible(error)) throw error; visible = false; }
      } else if (row.type === ciType) {
        try { history = await readHistoricalCiDocumentInTx(tx, row.id, { trustedActor }); }
        catch (error) { if (!ordinaryInvisible(error)) throw error; visible = false; }
      }
      if (orderId && row.orderId !== orderId && !((packingList || supplier) && history?.orderIds.includes(orderId))) visible = false;
      if (shipmentId && row.shipmentId !== shipmentId && !(packingList && history?.shipmentIds?.includes(shipmentId))) visible = false;
      digest.update(visible ? 'visible' : 'hidden');
      if (history) digest.update(documentSourceFingerprint({ fingerprint: history.fingerprint, invoice: history.currentInvoice, orders: history.orderIds }));
      if (visible) { if (visibleTotal >= offset && items.length < limit) items.push(packingList ? { ...row, totalAmount: null, currency: null } : supplier ? { ...row, supplierDocumentProof: history?.supplierDocumentProof } : row); visibleTotal++; }
    }
    if (sourceOffset + page.items.length >= sourceTotal) break;
    if (page.items.length !== CI_COLLECTION_CHUNK_SIZE) changed();
  }
  if (seen.size !== sourceTotal) changed();
  const after = await authorityStamp(tx, trustedActor);
  return { items, total: visibleTotal, stamp: after, stable: before === after, fingerprint: digest.digest('hex') };
}

async function stableCollection(tx: any, trustedActor: TokenPayload | null, readPage: PageReader, limit: number, offset: number, orderId?: string, requestedType?: string, shipmentId?: string) {
  // Two complete stable native sweeps also cover permissions withdrawn on rows
  // outside the requested page. A changing set is never reported as empty.
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await sweep(tx, trustedActor, readPage, limit, offset, orderId, requestedType, shipmentId);
    if (!first.stable) continue;
    const second = await sweep(tx, trustedActor, readPage, limit, offset, orderId, requestedType, shipmentId);
    if (second.stable && first.stamp === second.stamp && first.fingerprint === second.fingerprint) return second;
  }
  changed();
}

export async function listCiVisibleTradeDocuments(prisma: PrismaClient, params: ListParams, trustedActor: TokenPayload | null): Promise<Page> {
  return prisma.$transaction(async tx => {
    const pagedService = createCustomsService(stableCiPagedClient(tx) as PrismaClient);
    const limit = params?.limit ?? 100, offset = params?.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0)
      throw businessError('VALIDATION_FAILED', '非法单据分页参数。');
    const result = await stableCollection(tx, trustedActor, sourceOffset => pagedService.listTradeDocuments({ ...params, type: undefined, orderId: undefined, shipmentId: undefined, limit: CI_COLLECTION_CHUNK_SIZE, offset: sourceOffset }), limit, offset, params?.orderId, params?.type, params?.shipmentId);
    return { items: result.items, total: result.total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function packCiVisibleTradeDocumentsByOrder(prisma: PrismaClient, orderId: string, trustedActor: TokenPayload | null): Promise<Awaited<ReturnType<typeof packTradeDocumentsByOrder>>> {
  return prisma.$transaction(async tx => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let collection: Awaited<ReturnType<typeof stableCollection>> | undefined;
      // The original pack supplies its exact original where/sort and projection.
      // Only its document enumeration is replaced with bounded native reads.
      const client = new Proxy(tx, { get(target, key) {
        if (key !== 'tradeDocument') return Reflect.get(target, key);
        return new Proxy(target.tradeDocument, { get(delegate, method) {
          if (method !== 'findMany') return Reflect.get(delegate, method);
          return async (args: any) => {
            collection = await stableCollection(tx, trustedActor, async offset => ({
              items: await delegate.findMany({ ...args, where: { deletedAt: null }, orderBy: stableCiOrderBy(args.orderBy), take: CI_COLLECTION_CHUNK_SIZE, skip: offset }),
              total: await delegate.count({ where: { deletedAt: null } }),
            }), Number.MAX_SAFE_INTEGER, 0, orderId);
            return collection.items;
          };
        } });
      } });
      const result = await packTradeDocumentsByOrder(client as unknown as PrismaClient, orderId);
      for (const row of result.items) if (await isPackingListCandidateInTx(tx, row)) { const exact = await readPackingListVersionInTx(tx, { documentId: row.id, trustedActor, ...(row.latestVersion !== null ? { version: row.latestVersion } : {}) });
        if (row.latestVersion === null || documentSourceFingerprint(row.content) !== documentSourceFingerprint(exact.item.content)) changed();
        row.totalAmount = null; row.currency = null; }
      for (const row of result.items) if (row.type === ciType) await readHistoricalCiDocumentInTx(tx, row.id, { trustedActor, ...(row.latestVersion !== null ? { version: row.latestVersion } : {}) });
      for (const row of result.items) if (isSupplierContractDocumentCandidate(row)) {
        const exact = await readSupplierDocumentHistoryInTx(tx, row.id, trustedActor, row.latestVersion ?? undefined);
        if (exact.native && (row.latestVersion !== 1 || !exact.version || documentSourceFingerprint(row.content) !== documentSourceFingerprint(exact.version.content))) changed();
        row.supplierDocumentProof = exact.proofState;
      }
      if (collection && collection.stamp === await authorityStamp(tx, trustedActor)) return result;
    }
    changed();
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
