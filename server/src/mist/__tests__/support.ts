import { randomUUID } from 'node:crypto';
import type { TokenPayload } from '../../auth/service';
import { MistApiError } from '../errors';
import type { MistContract } from '../repository';
/** In-memory transactional test fixture only. It never connects to a database. */
export class MemoryMistDatabase {
  workspaces = new Map<string, any>(); receipts = new Map<string, any>(); businessSequences = new Map<string, any>(); failReceipt = false;
  /** 账号表（包 A 成员目录）：未登记的账号视为在职账号、显示名为账号编号；测试可登记停用 / 删除状态。 */
  accounts = new Map<string, { displayName?: string; status?: string; deletedAt?: Date | null }>();
  private queue = Promise.resolve();
  private delegates(workspaces: Map<string, any>, receipts: Map<string, any>, businessSequences = this.businessSequences) {
    return {
      $queryRawUnsafe: async () => [],
      userAccount: {
        findMany: async ({ where }: any) => ((where?.id?.in ?? []) as string[]).map(id => { const a = this.accounts.get(id); return { id, displayName: a?.displayName ?? id, status: a?.status ?? 'active', deletedAt: a?.deletedAt ?? null }; }),
      },
      mistWorkspace: {
        findFirst: async ({ where }: any) => [...workspaces.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null,
        findMany: async ({ where }: any = {}) => [...workspaces.values()].filter(row => !where || !Object.keys(where).length ? true : where.OR ? where.OR.some((rule:any)=>rule.ownerId===row.ownerId || (rule.state && (row.state[rule.state.path?.[0]||'reviewerIds']||[]).includes(rule.state.array_contains[0]))) : row.ownerId === where.ownerId),
        findUnique: async ({ where }: any) => [...workspaces.values()].find(row => row.ownerId === where.ownerId_slug.ownerId && row.slug === where.ownerId_slug.slug) ?? null,
        create: async ({ data }: any) => {
          if ([...workspaces.values()].some(row => row.ownerId === data.ownerId && row.slug === data.slug)) throw Object.assign(new Error('unique'), { code: 'P2002' });
          const row = { createdAt: new Date(), updatedAt: new Date(), ...data }; workspaces.set(row.id, row); return row;
        },
        update: async ({ where, data }: any) => { const original=workspaces.get(where.id);const row = { ...original, ...data, ...(typeof data.revision==='object'?{revision:original.revision+data.revision.increment}:{}), updatedAt: new Date() }; workspaces.set(row.id, row); return row; },
      },
      mistCommandReceipt: {
        findUnique: async ({ where }: any) => receipts.get(`${where.workspaceId_requestId.workspaceId}:${where.workspaceId_requestId.requestId}`) ?? null,
        create: async ({ data }: any) => { if (this.failReceipt) throw new Error('transaction failed'); receipts.set(`${data.workspaceId}:${data.requestId}`, data); return data; },
      },
      businessSequence: {
        upsert: async ({where,create}:any) => { if(!businessSequences.has(where.id))businessSequences.set(where.id,structuredClone(create));return structuredClone(businessSequences.get(where.id)); },
        update: async ({where,data}:any) => {const prior=businessSequences.get(where.id);if(!prior)throw new Error('Sequence not found');const increment=data.seq?.increment;if(!Number.isSafeInteger(increment)||increment<1)throw new Error('Invalid sequence increment');const next={...prior,...data,seq:prior.seq+increment};businessSequences.set(where.id,next);return structuredClone(next);},
        findUnique: async ({where}:any) => structuredClone(businessSequences.get(where.id)??null),
      },
    };
  }
  get mistCommandReceipt() { return this.delegates(this.workspaces, this.receipts).mistCommandReceipt; }
  async $transaction<T>(run: (tx: any) => Promise<T>) {
    const previous = this.queue; let release!: () => void; this.queue = new Promise<void>(resolve => { release = resolve; }); await previous;
    const workspaces = structuredClone(this.workspaces), receipts = structuredClone(this.receipts), businessSequences = structuredClone(this.businessSequences);
    try { const result = await run(this.delegates(workspaces, receipts, businessSequences)); this.workspaces = workspaces; this.receipts = receipts; this.businessSequences = businessSequences; return result; }
    finally { release(); }
  }
}
/** 只统计业务请求回执；不含服务端为并发合并记录的版本标记。 */
export const requestReceiptCount = (db: MemoryMistDatabase) => [...db.receipts.values()].filter(row => !String(row.requestId).startsWith('mist-revision:')).length;
export const testActor = (id = 'owner'): TokenPayload => ({ userId: id, displayName: id, roles: ['owner'], departmentIds: [], permissions: ['products:write', 'finance:write', 'vouchers:write', 'invoices:reconcile', 'invoices:write'] });
export function testAuthority() {
  const users = new Map([['owner', { active: true, permissions: ['products:write', 'finance:write', 'vouchers:write', 'invoices:reconcile', 'invoices:write'] }], ['other', { active: true, permissions: ['products:write'] }]]);
  return { users, authorize: async (_db: any, prior: TokenPayload, permission?: string | null) => {
    const current = users.get(prior?.userId);
    if (!current?.active) throw new MistApiError('ACCOUNT_DISABLED', '账号已失效', 401);
    if (permission && (!current.permissions.includes(permission) || prior.permissionCeiling && !prior.permissionCeiling.includes(permission) && !prior.permissionCeiling.includes('*'))) throw new MistApiError('FORBIDDEN', '权限不足', 403);
    return { ...prior, permissions: current.permissions };
  } };
}
export const testContract: MistContract = {
  createMistState: (_context, seed) => ({ money: { cents: seed === 'empty' ? 0 : 100 }, files: [], notes: [], settings: { workspaceName: 'Test workspace' } } as any),
  mistCommandPermission: (command: any) => command.type === 'money.add' ? 'finance:write' : 'products:write',
  applyMistCommand: (state: any, command: any) => {
    if (command.type === 'money.add') {
      const cents = command.payload.cents;
      if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(state.money.cents + cents)) throw new MistApiError('INVALID_AMOUNT', '金额无效');
      state.money.cents += cents; return { state, result: { cents: state.money.cents } };
    }
    if (command.type === 'notes.add') { const id = randomUUID(); state.notes.push({ id, text: command.payload.text }); return { state, result: { id } }; }
    if (command.type === 'files.add') { state.files.push(command.payload.file); return { state, result: { id: command.payload.file.id } }; }
    throw new MistApiError('VALIDATION', '未知命令');
  },
};
