import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError, readBusinessErrorMint } from '../shared/errorCodes';
import { SupplierContractError, supplierFingerprint, supplierObject } from '../procurement/supplierContractPolicy';
import { supplierSnapshot } from '../procurement/supplierContractStore';
import { createFinanceSourceAccess } from './financeSourceAccess';
import { createSupplierVatRegistrationReader, readSupplierVatRegistrations, type SupplierVatRegistration } from './supplierVatPayableCapacity';
import { SUPPLIER_VAT_PAYABLE_SOURCE, assertSupplierVatCapacity, readSupplierVatApprovedLine, supplierVatOriginal, supplierVatLineIdentity,
  makeSupplierVatSnapshot, supplierVatAuthorizationOrderIds, type SupplierVatAmountBasis, type SupplierVatOriginal,
  type SupplierVatSourceLine } from './supplierVatPayableSource';

type Kind = 'purchase' | 'processing';
type Access = Awaited<ReturnType<typeof createFinanceSourceAccess>>;
type Cursor = { version: 1; binding: string; contractKind: Kind; contractId: string; lineId: string;
  commitmentRevisionId: string; commitmentFingerprint: string };
export type SupplierVatCandidateQuery = { amountBasis: SupplierVatAmountBasis; search: string; limit: number; cursor: Cursor | null };
export type SupplierVatPayableCandidate = Pick<SupplierVatSourceLine, 'contractKind' | 'contractId' | 'commitmentRevisionId' |
  'lineId' | 'contractNumber' | 'orderId' | 'orderLineId' | 'approvedLineAmount' | 'paymentTerms'> & {
    registeredAmount: string; remainingAmount: string; registeredAmountBasis: SupplierVatAmountBasis | null;
    selectable: boolean; unavailableReason?: string };
export type SupplierVatPayableCandidatePage = { items: SupplierVatPayableCandidate[]; nextCursor: string | null; hasMore: boolean };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const changed = (): never => { throw businessError('CONFLICT', '原票、准确已批来源或当前可见范围已变化，请重新读取候选合同行。'); };
const invisible = (): never => { throw businessError('NOT_FOUND', '供应商原票不存在，或不在当前财务数据范围。'); };
const kinds: readonly Kind[] = ['processing', 'purchase'];
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function decodeSupplierVatCandidateCursor(value: string): Cursor {
  if (!value || value.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid('候选分页凭据无效，请重新读取。');
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return invalid('候选分页凭据无效，请重新读取。'); }
  const row = supplierObject(decoded);
  if (Object.keys(row).some(key => !['version', 'binding', 'contractKind', 'contractId', 'lineId', 'commitmentRevisionId', 'commitmentFingerprint'].includes(key))
    || row.version !== 1 || !sha(row.binding) || (row.contractKind !== 'purchase' && row.contractKind !== 'processing')
    || !id(row.contractId) || !id(row.lineId) || !id(row.commitmentRevisionId) || !sha(row.commitmentFingerprint))
    return invalid('候选分页凭据缺少准确来源，请重新读取。');
  return { version: 1, binding: row.binding, contractKind: row.contractKind, contractId: row.contractId,
    lineId: row.lineId, commitmentRevisionId: row.commitmentRevisionId, commitmentFingerprint: row.commitmentFingerprint };
}
export const encodeSupplierVatCandidateCursor = (value: Cursor): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function normalizeSupplierVatCandidateQuery(input: unknown): SupplierVatCandidateQuery {
  const row = supplierObject(input);
  if (Object.keys(row).some(key => !['amountBasis', 'search', 'cursor', 'limit'].includes(key))) return invalid('候选查询含不支持的字段。');
  if (row.amountBasis !== 'net' && row.amountBasis !== 'gross') return invalid('请明确本票按净价或含税价登记，不进行自动换算。');
  if (row.search !== undefined && (typeof row.search !== 'string' || row.search.trim().length > 100)) return invalid('合同号搜索须为不超过100字的文字。');
  const search = typeof row.search === 'string' ? row.search.trim() : '';
  const rawLimit = row.limit === undefined ? '25' : typeof row.limit === 'number' ? String(row.limit) : row.limit;
  if (typeof rawLimit !== 'string' || !/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) return invalid('每页须为1至100条。');
  if (row.cursor !== undefined && row.cursor !== '' && typeof row.cursor !== 'string') return invalid('候选分页凭据无效。');
  return { amountBasis: row.amountBasis, search, limit: Number(rawLimit), cursor: typeof row.cursor === 'string' && row.cursor ? decodeSupplierVatCandidateCursor(row.cursor) : null };
}

/** Unlike units are never added. Values stay in the explicitly reported
 * registered basis even when the caller asks to use another basis. */
export function supplierVatCandidateCapacity(capacity: string, basis: SupplierVatAmountBasis,
  prior: ReadonlyArray<Pick<SupplierVatRegistration, 'amountBasis' | 'contractAmount'>>) {
  const bases = new Set(prior.map(row => row.amountBasis));
  if (bases.size > 1 || [...bases].some(value => value !== 'net' && value !== 'gross'))
    throw businessError('CONFLICT', '同一稳定合同行的原登记税价基准不一致，请先核对原账。');
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(capacity)) return changed();
  const registered = prior.reduce((sum, row) => {
    if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(row.contractAmount) || new Prisma.Decimal(row.contractAmount).lte(0)) return changed();
    return sum.plus(row.contractAmount);
  }, new Prisma.Decimal(0));
  const remaining = new Prisma.Decimal(capacity).minus(registered);
  const registeredAmountBasis = prior.length ? prior[0].amountBasis : null;
  const unavailableReason = registeredAmountBasis && registeredAmountBasis !== basis
    ? '已有登记采用不同税价基准；请核清原票，不能混加净价与含税价。'
    : remaining.lt(0) ? '原累计登记已超过当前准确已批行金额，请核对原应付。'
      : remaining.eq(0) ? '本准确合同行已无可登记余额。' : undefined;
  // Reuse the write gate on the actual remaining amount; zero/exceeded lines
  // are shown as unavailable rather than manufacturing a positive request.
  if (!unavailableReason) assertSupplierVatCapacity(capacity, remaining.toFixed(4), basis, [...prior]);
  return { registeredAmount: registered.toFixed(4), remainingAmount: remaining.toFixed(4), registeredAmountBasis,
    selectable: unavailableReason === undefined, ...(unavailableReason ? { unavailableReason } : {}) };
}

function sourceParents(original: SupplierVatOriginal, source: SupplierVatSourceLine): string[] {
  return supplierVatAuthorizationOrderIds(makeSupplierVatSnapshot(original,
    { amountBasis: 'net', dueDate: null, sources: [source] }, [source]));
}
async function parentsVisible(access: Access, orderIds: Iterable<string>) {
  for (const orderId of new Set(orderIds)) if (!await access.order(orderId)) return false;
  return true;
}
function eligibilityError(error: unknown): boolean {
  if (error instanceof SupplierContractError) return true;
  const mint = readBusinessErrorMint(error);
  return mint?.code === 'CONFLICT' || mint?.code === 'INVALID_INPUT';
}
type EligibleContract = { sources: SupplierVatSourceLine[]; parents: string[] };
async function readEligibleContract(tx: Prisma.TransactionClient, access: Access, original: SupplierVatOriginal,
  currentNames: ReadonlySet<string>, kind: Kind, contractId: string, revisionId: string): Promise<EligibleContract | null> {
  const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: revisionId } });
  if (!revision || revision.status !== 'approved' || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint) return null;
  let snapshot: ReturnType<typeof supplierSnapshot>;
  try { snapshot = supplierSnapshot(revision.snapshot, kind); } catch (error) { if (eligibilityError(error)) return null; throw error; }
  const parents: string[] = [];
  for (const proof of snapshot.sourceProofs) { if (!id(proof.orderId)) return null; parents.push(proof.orderId); }
  if (!parents.length || !await parentsVisible(access, parents)) return null;
  const party = supplierObject(snapshot.supplierParty), names = new Set(currentNames);
  for (const name of [party.name, party.chineseName, party.englishName]) if (typeof name === 'string' && name) names.add(name);
  if (!names.has(original.sellerName) || (original.sellerTaxNo && typeof party.taxId === 'string' && party.taxId && original.sellerTaxNo !== party.taxId)) return null;
  const sources: SupplierVatSourceLine[] = [];
  try {
    for (const line of [...snapshot.lines].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) {
      if (!id(line.id)) return null;
      sources.push(await readSupplierVatApprovedLine(tx, { contractKind: kind, contractId, commitmentRevisionId: revisionId,
        lineId: line.id, contractAmount: line.amount }, { current: true, supplierId: original.relationId, currency: original.currency }));
    }
    if (!sources.length || !await parentsVisible(access, sourceParents(original, sources[0]))) return null;
  } catch (error) { if (eligibilityError(error)) return null; throw error; }
  return { sources, parents: [...new Set(parents)].sort() };
}
const candidateDto = (source: SupplierVatSourceLine, capacity: ReturnType<typeof supplierVatCandidateCapacity>): SupplierVatPayableCandidate => ({
  contractKind: source.contractKind, contractId: source.contractId, commitmentRevisionId: source.commitmentRevisionId,
  lineId: source.lineId, contractNumber: source.contractNumber, orderId: source.orderId, orderLineId: source.orderLineId,
  approvedLineAmount: source.approvedLineAmount, paymentTerms: source.paymentTerms, ...capacity });

export async function listSupplierVatPayableSources(prisma: PrismaClient, prior: TokenPayload | null | undefined,
  vatInvoiceId: string, input: unknown): Promise<SupplierVatPayableCandidatePage> {
  const query = normalizeSupplierVatCandidateQuery(input);
  return prisma.$transaction(async tx => {
    const access = await createFinanceSourceAccess(tx, prior, ['invoices:read', 'vat:read']);
    const readOriginal = async () => {
      const vat = await tx.vatInvoice.findFirst({ where: { id: vatInvoiceId, deletedAt: null } });
      if (!vat || !await access.vat(vat)) return invisible();
      if (!['Received', 'Verified', 'Declared'].includes(vat.status)) throw businessError('CONFLICT', '原票已作废或红冲，不能登记新的应付。');
      if (vat.invoiceId || await tx.invoice.findFirst({ where: { sourceType: SUPPLIER_VAT_PAYABLE_SOURCE, sourceId: vatInvoiceId, deletedAt: null } }))
        throw businessError('CONFLICT', '本原票已经登记应付，请回看原应付及原准确来源。');
      return { vat, original: supplierVatOriginal(vat) };
    };
    const { vat, original } = await readOriginal();
    const supplier = await tx.relation.findFirst({ where: { id: original.relationId, deletedAt: null, isOrganization: true, category: 'Supplier' } });
    if (!supplier) throw businessError('CONFLICT', '原票供应商身份无效，请先核对原票。');
    const partyIdentity = (value: typeof supplier) => supplierFingerprint({ id: value.id, name: value.name, chineseName: value.chineseName,
      englishName: value.englishName, taxId: value.taxId, isOrganization: value.isOrganization, category: value.category, deletedAt: value.deletedAt });
    const originalPartyIdentity = partyIdentity(supplier);
    const currentNames = new Set([supplier.name, supplier.chineseName, supplier.englishName].filter((value): value is string => typeof value === 'string' && !!value));
    const actor = access.actor;
    const binding = supplierFingerprint({ vat: original, amountBasis: query.amountBasis, search: query.search.toLowerCase(),
      actorId: actor.userId, roles: [...actor.roles].sort(), roleIds: [...(actor.roleIds ?? [])].sort(), permissions: [...actor.permissions].sort(),
      ceiling: actor.permissionCeiling === undefined ? null : [...actor.permissionCeiling].sort(), departments: [...actor.departmentIds].sort() });
    if (query.cursor && query.cursor.binding !== binding) return changed();
    const watched = new Map<string, EligibleContract>();
    if (query.cursor) {
      const cursor = query.cursor;
      const current = await readEligibleContract(tx, access, original, currentNames, cursor.contractKind, cursor.contractId, cursor.commitmentRevisionId);
      const line = current?.sources.find(row => row.lineId === cursor.lineId);
      if (!current || !line || line.commitmentFingerprint !== cursor.commitmentFingerprint
        || query.search && !line.contractNumber.toLowerCase().includes(query.search.toLowerCase())) return changed();
      watched.set(`${cursor.contractKind}:${cursor.contractId}`, current);
    }
    const visible: Array<{ source: SupplierVatSourceLine; item: SupplierVatPayableCandidate; registrations: SupplierVatRegistration[] }> = [];
    const readRegistrations = createSupplierVatRegistrationReader(tx);
    let sellerMatched = currentNames.has(original.sellerName);
    for (const kind of kinds) {
      if (query.cursor && kinds.indexOf(kind) < kinds.indexOf(query.cursor.contractKind)) continue;
      let after: string | null = null;
      const from = query.cursor?.contractKind === kind ? query.cursor : null;
      while (visible.length <= query.limit) {
        const common: { deletedAt: null; currency: string; approvedCommitmentRevisionId: { not: null }; id?: { gt: string } | { gte: string } } =
          { deletedAt: null, currency: original.currency, approvedCommitmentRevisionId: { not: null },
          ...(after ? { id: { gt: after } } : from ? { id: { gte: from.contractId } } : {}) };
        const contracts: Array<{ id: string; approvedCommitmentRevisionId: string | null }> = kind === 'purchase'
          ? await tx.purchaseOrder.findMany({ where: { ...common, supplierRelationId: original.relationId,
            ...(query.search ? { poNumber: { contains: query.search, mode: 'insensitive' } } : {}) }, select: { id: true, approvedCommitmentRevisionId: true }, orderBy: { id: 'asc' }, take: 100 })
          : await tx.outsourcingOrder.findMany({ where: { ...common, supplierId: original.relationId,
            ...(query.search ? { orderNumber: { contains: query.search, mode: 'insensitive' } } : {}) }, select: { id: true, approvedCommitmentRevisionId: true }, orderBy: { id: 'asc' }, take: 100 });
        if (!contracts.length) break;
        for (const contract of contracts) {
          if (!contract.approvedCommitmentRevisionId) continue;
          const exact = await readEligibleContract(tx, access, original, currentNames, kind, contract.id, contract.approvedCommitmentRevisionId);
          if (!exact) continue;
          sellerMatched = true;
          const sources = exact.sources.filter(source => !from || source.contractId !== from.contractId || source.lineId > from.lineId);
          if (!sources.length) continue;
          const registrations = await readRegistrations(new Set(sources.map(supplierVatLineIdentity)));
          let used = false;
          for (const source of sources) {
            const priorRows = registrations.get(supplierVatLineIdentity(source)) ?? [];
            // Capacity from an older mixed source must not reveal hidden order
            // participation or be silently omitted to overstate the balance.
            if (!await parentsVisible(access, priorRows.flatMap(row => row.orderIds))) continue;
            visible.push({ source, item: candidateDto(source, supplierVatCandidateCapacity(source.approvedLineAmount, query.amountBasis, priorRows)), registrations: priorRows });
            used = true;
            if (visible.length > query.limit) break;
          }
          if (used) watched.set(`${kind}:${contract.id}`, exact);
          if (visible.length > query.limit) break;
        }
        if (visible.length > query.limit || contracts.length < 100) break;
        after = contracts[contracts.length - 1].id;
      }
      if (visible.length > query.limit) break;
    }
    if (!sellerMatched) throw businessError('CONFLICT', '原票销方名称与准确供应商身份不一致，请先核对原票。');
    // ReadCommitted is deliberate: current grants and each frozen parent are
    // checked again, rather than being hidden behind an old transaction view.
    for (const exact of watched.values()) {
      const first = exact.sources[0];
      const current = await readEligibleContract(tx, access, original, currentNames, first.contractKind, first.contractId, first.commitmentRevisionId);
      if (!current || supplierFingerprint(current) !== supplierFingerprint(exact)) return changed();
    }
    const latestRegistrations = await readSupplierVatRegistrations(tx, new Set(visible.map(row => supplierVatLineIdentity(row.source))));
    for (const row of visible) {
      const latest = latestRegistrations.get(supplierVatLineIdentity(row.source)) ?? [];
      if (!await parentsVisible(access, latest.flatMap(value => value.orderIds)) || supplierFingerprint(latest) !== supplierFingerprint(row.registrations)) return changed();
    }
    const latest = await readOriginal();
    if (supplierFingerprint(latest.original) !== supplierFingerprint(original) || String(latest.vat.updatedAt) !== String(vat.updatedAt)) return changed();
    const currentSupplier = await tx.relation.findFirst({ where: { id: original.relationId, deletedAt: null, isOrganization: true, category: 'Supplier' } });
    if (!currentSupplier || partyIdentity(currentSupplier) !== originalPartyIdentity) return changed();
    await access.finish();
    const hasMore = visible.length > query.limit, page = visible.slice(0, query.limit), last = page[page.length - 1]?.source;
    return { items: page.map(row => row.item), hasMore, nextCursor: hasMore && last ? encodeSupplierVatCandidateCursor({ version: 1, binding,
      contractKind: last.contractKind, contractId: last.contractId, commitmentRevisionId: last.commitmentRevisionId,
      lineId: last.lineId, commitmentFingerprint: last.commitmentFingerprint }) : null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}
