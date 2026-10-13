import { it, expect } from 'vitest';
import { ensureDefaultAgentTools } from '../tools';
import { DEFAULT_AGENT_TOOLS, type DefaultToolDefinition } from '../defaults';

type Row = Record<string, unknown> & { id: string };
type PermissionRow = Row & { toolId: string; roleId: string; access: string; riskMode: string };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Persistence adapter for this pure service control. It stores opaque values
 * supplied by the actual service, selects the real create/update branch, and
 * checks unique/FK identities. It never interprets risk or approvalRoles and
 * never imports, constructs, mocks or connects a Prisma client. */
class MemoryDefaultToolStore {
  private readonly roles = new Map<string, Row>();
  private readonly tools = new Map<string, Row>();
  private readonly permissions = new Map<string, PermissionRow>();
  permissionCreates = 0;
  permissionUpdates = 0;

  readonly role = {
    upsert: async ({ where, create, update }: { where: { id: string }; create: Row; update: Partial<Row> }) => {
      const previous = this.roles.get(where.id);
      const row = previous ? { ...previous, ...copy(update) } : copy(create);
      if (row.id !== where.id) throw Error('Role upsert identity mismatch');
      this.roles.set(row.id, row);
      return copy(row);
    },
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in
      .filter(id => this.roles.has(id)).map(id => ({ id })),
    create: async ({ data }: { data: Row }) => {
      if (this.roles.has(data.id)) throw Error('Duplicate Role identity');
      this.roles.set(data.id, copy(data));
      return copy(data);
    },
  };
  readonly agentTool = {
    upsert: async ({ where, create, update }: { where: { id: string }; create: Row; update: Partial<Row> }) => {
      const previous = this.tools.get(where.id);
      const row = previous ? { ...previous, ...copy(update) } : copy(create);
      if (row.id !== where.id) throw Error('Tool upsert identity mismatch');
      this.tools.set(row.id, row);
      return copy(row);
    },
  };
  readonly agentToolPermission = {
    upsert: async ({ where, create, update }: { where: { toolId_roleId: { toolId: string; roleId: string } };
      create: PermissionRow; update: Partial<PermissionRow> }) => {
      const { toolId, roleId } = where.toolId_roleId;
      const key = JSON.stringify([toolId, roleId]);
      if (!this.tools.has(toolId) || !this.roles.has(roleId)) throw Error('Permission FK mismatch');
      const previous = this.permissions.get(key);
      const row = previous ? { ...previous, ...copy(update) } : copy(create);
      if (row.toolId !== toolId || row.roleId !== roleId || !row.id) throw Error('Permission composite identity mismatch');
      if (!previous && [...this.permissions.values()].some(value => value.id === row.id)) throw Error('Duplicate Permission identity');
      if (previous) this.permissionUpdates++; else this.permissionCreates++;
      this.permissions.set(key, row);
      return copy(row);
    },
  };
  permissionSnapshot(): PermissionRow[] {
    return [...this.permissions.values()].map(copy).sort((left, right) => left.id.localeCompare(right.id));
  }
}

// Independent explicit business defaults: do not derive expected approval
// values from the production predicate or a generated defaults filter.
const MEDIUM_APPROVAL_DEFAULTS = {
  'knowledge.ingest': 3,
  'shipping.update_tracking_status': 4,
  'email.link_to_order': 6,
  'order_changes.withdraw': 4,
  'payment_requests.cancel': 4,
  'samples.submit_to_customer': 5,
  'samples.register_customer_confirmation': 5,
  'procurement.update_status': 4,
} as const;
const MEDIUM_APPROVAL_MODES = {
  'knowledge.ingest': ['approval'],
  'shipping.update_tracking_status': ['approval'],
  'email.link_to_order': ['approval'],
  'order_changes.withdraw': ['approval'],
  'payment_requests.cancel': ['approval'],
  'samples.submit_to_customer': ['approval'],
  'samples.register_customer_confirmation': ['approval'],
  'procurement.update_status': ['approval'],
};
const syntheticId = 'regression.medium_without_approval';

function mediumApprovalModes(rows: PermissionRow[]) {
  const value: Record<string, string[]> = {};
  for (const id of Object.keys(MEDIUM_APPROVAL_DEFAULTS))
    value[id] = [...new Set(rows.filter(row => row.toolId === id).map(row => row.riskMode))].sort();
  return value;
}
function mode(rows: PermissionRow[], id: string) {
  const matching = rows.filter(row => row.toolId === id);
  expect(matching.length, id + ' has persisted permission rows').toBeGreaterThan(0);
  return [...new Set(matching.map(row => row.riskMode))].sort();
}

it('keeps all default tool permission values stable across actual create and update initialization', async () => {
  expect(DEFAULT_AGENT_TOOLS).toHaveLength(107);
  const originalDefinitions = JSON.stringify(DEFAULT_AGENT_TOOLS);
  const originalLength = DEFAULT_AGENT_TOOLS.length;
  // All current declared medium defaults have approvalRoles. This one local
  // input exercises medium without approval; files and the original107/613
  // defaults stay exact. The single fixture definition is restored in finally.
  const synthetic: DefaultToolDefinition = { id: syntheticId, name: 'Synthetic medium no approval', scope: 'regression',
    risk: 'medium', allowedRoles: ['owner'] };
  DEFAULT_AGENT_TOOLS.push(synthetic);
  const store = new MemoryDefaultToolStore();
  const serviceStore = store as unknown as Parameters<typeof ensureDefaultAgentTools>[0];
  try {
    await ensureDefaultAgentTools(serviceStore);
    const firstAll = store.permissionSnapshot();
    const first = firstAll.filter(row => row.toolId !== syntheticId);
    expect(first).toHaveLength(613);
    expect(firstAll).toHaveLength(614); // 613 real defaults + one isolated control.
    expect(store.permissionCreates).toBe(614);
    expect(store.permissionUpdates).toBe(0);
    for (const [id, count] of Object.entries(MEDIUM_APPROVAL_DEFAULTS))
      expect(first.filter(row => row.toolId === id), id + ' declared role count').toHaveLength(count);
    expect(mediumApprovalModes(first), 'initial medium defaults require approval').toEqual(MEDIUM_APPROVAL_MODES);
    expect(mode(firstAll, syntheticId)).toEqual(['direct']);
    expect(mode(first, 'production.advance_stage')).toEqual(['approval']); // High, no approvalRoles.
    expect(mode(first, 'products.count')).toEqual(['direct']);

    await ensureDefaultAgentTools(serviceStore);
    const secondAll = store.permissionSnapshot();
    const second = secondAll.filter(row => row.toolId !== syntheticId);
    expect(store.permissionCreates, 'second initialization creates no extra permission').toBe(614);
    expect(store.permissionUpdates, 'real existing rows take update branch').toBe(614);
    expect(mediumApprovalModes(second), 'restart must preserve the eight declared approval defaults').toEqual(MEDIUM_APPROVAL_MODES);
    expect(mode(secondAll, syntheticId)).toEqual(['direct']);
    expect(mode(second, 'production.advance_stage')).toEqual(['approval']);
    expect(mode(second, 'products.count')).toEqual(['direct']);
    expect(second, 'all613 default permission columns remain exact, not just riskMode or counts').toEqual(first);
    expect(secondAll, 'synthetic control is also stable').toEqual(firstAll);
  } finally {
    DEFAULT_AGENT_TOOLS.splice(originalLength);
    expect(JSON.stringify(DEFAULT_AGENT_TOOLS), 'test restores actual declarations').toBe(originalDefinitions);
  }
});
