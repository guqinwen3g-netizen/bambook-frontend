import { hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { isEntityType } from '../entities/registry';
import type { ActorContext, ToolAccessTarget } from './types';
import { graphReadScope, graphSource } from '../entities/entityAccessDeclarations';

export type ToolActionDeclaration = {
  sideEffects: boolean;
  allOf?: readonly PermissionScope[];
  source: string;
  constraint?: 'entity-search' | 'entity-hydrate' | 'product-expand' | 'order-expand' | 'actor-memory-write' | 'actor-memory-read' | 'authenticated-read' | 'entity-links';
  blockedReason?: string;
};

// This is an action declaration, not a risk classifier. A low-risk action can
// write (template rendering persists RenderedDoc/PDF); approval remains in the
// runtime's existing approval arbiter, after this authorization boundary.
const declarations: Record<string, ToolActionDeclaration> = {};
function declare(ids: string[], sideEffects: boolean, scopes: PermissionScope[], source: string) {
  for (const id of ids) declarations[id] = { sideEffects, allOf: scopes, source };
}

declare(['products.count', 'products.search', 'products.query', 'products.describe_schema', 'products.get', 'dictionary.query', 'records.query'], false, ['products:read'], 'products/route.ts; toolRuntime.queryBusinessRecords supports only ProductAsset');
declare(['product_asset.create', 'product_asset.update', 'product_asset.delete'], true, ['products:write'], 'products/route.ts');
declare(['orders.search', 'orders.query', 'orders.get', 'orders.list_by_status', 'orders.get_timeline', 'orders.kanban', 'order_changes.query'], false, ['orders:read'], 'orders/route.ts; orderChanges/orderChangeRoute.ts');
declare(['orders.update_status', 'orders.batch_status', 'garment.update_size_breakdown', 'garment.update_production_steps', 'order.status_transition', 'order.line_update'], true, ['orders:write'], 'orders/route.ts; orders/orderLinesRoute.ts; _shared/rolePermissionMatrix VIEW Orders');
declare(['order.delete'], true, ['orders:delete'], '_shared/rolePermissionMatrix VIEW Orders.delete; orders/route.ts legacy high-risk role gate');
declare(['order.confirm'], true, ['orders:write', 'invoices:write'], 'orders/route.ts; finance/route.ts; orderConfirm process composes order confirmation and invoice creation');
declare(['order.ship'], true, ['shipments:write'], 'shipping/route.ts; orderShip flow uses shipment service and its order projection');
declare(['relations.search', 'relations.query', 'relations.get', 'relations.expand'], false, ['relations:read'], '_shared/rolePermissionMatrix VIEW Relations; relations/route.ts');
declare(['relations.create', 'relation.update', 'relation.onboard'], true, ['relations:write'], 'relations/route.ts');
declare(['relation.delete'], true, ['relations:delete'], '_shared/rolePermissionMatrix VIEW Relations.delete; relations/route.ts legacy high-risk role gate');
declare(['development.query', 'development.get'], false, ['products:read'], 'development/route.ts requireDevRead');
declare(['development.update_stage', 'development.create', 'development.convert_to_order', 'samples.create_round', 'samples.submit_to_customer', 'samples.register_customer_confirmation'], true, ['products:write'], 'development/route.ts requireDevWrite; samples/sampleRoute.ts requireGarmentWrite');
declare(['finance.list_invoices', 'finance.get_invoice', 'finance.query_outstanding', 'finance.query_allocations'], false, ['invoices:read'], 'finance/route.ts invoices and allocations read');
declare(['finance.list_vouchers', 'finance.get_voucher'], false, ['vouchers:read'], 'finance/route.ts');
declare(['finance.get_aging', 'finance.get_statement'], false, ['finance:read'], 'finance/route.ts reports');
declare(['finance.create_invoice', 'invoice.create', 'invoice.update', 'invoice.issue', 'invoice.cancel', 'invoice.delete'], true, ['invoices:write'], 'finance/route.ts invoice mutations');
declare(['finance.create_voucher', 'payment_voucher.create', 'payment_voucher.update', 'payment_voucher.delete'], true, ['vouchers:write'], 'finance/route.ts voucher mutations');
declare(['finance.apply_voucher_to_invoice'], true, ['invoices:reconcile'], 'finance/route.ts POST /allocations; reconcileFlow allocation service');
declare(['payment.receive_and_reconcile'], true, ['invoices:reconcile'], 'finance/route.ts POST /allocations; reconcileFlow commit reads an existing voucher and applies allocations (old create-voucher comment is stale)');
declare(['statement.send'], true, ['finance:read', 'emails:write'], 'finance/route.ts statement read; email/route.ts draft write; statementSendFlow persists email/outbox, not SMTP');
declare(['shipping.list_shipments', 'shipping.get_shipment', 'shipping.scan_delays'], false, ['shipments:read'], 'shipping/route.ts; _shared/rolePermissionMatrix VIEW Shipments');
declare(['shipping.create_shipment', 'shipping.update_tracking_status'], true, ['shipments:write'], 'shipping/route.ts');
declare(['email.list', 'email.get', 'email.search'], false, ['emails:read'], 'email/route.ts');
declare(['email.sync', 'email.link_to_order', 'email.ai_extract', 'email.reply_and_send', 'email.send'], true, ['emails:write'], 'email/route.ts (automation tool-domain aliases are not permissions)');
declare(['knowledge.search'], false, ['knowledge:read'], 'knowledge/knowledgeRoute.ts');
declare(['knowledge.ingest'], true, ['knowledge:write'], 'knowledge/knowledgeRoute.ts; ai/knowledgeDocumentsRoute.ts');
declare(['production.get_pipeline', 'production.scan_alerts'], false, ['production:read'], 'production/route.ts; production/routeV2.ts');
declare(['production.advance_stage', 'production.save_checklist', 'production.save_inspection', 'production.sign_stage'], true, ['production:write'], 'production/routeV2.ts');
declare(['quotations.query', 'quotations.get'], false, ['quotations:read'], 'quotations/quotationRoute.ts');
declare(['quotation.create', 'quotation.update'], true, ['quotations:write'], 'quotations/quotationRoute.ts');
declare(['customs.query_lc', 'customs.get_lc', 'customs.query_tax_refunds', 'customs.query_declarations'], false, ['customs:read'], 'customs/customsRouteV2.ts');
declare(['customs.register_lc', 'customs.update_declaration'], true, ['customs:write'], 'customs/customsRouteV2.ts');
declare(['qc.query_reports'], false, ['qc:read'], 'qc/qcRoute.ts');
declare(['qc.review_garment_sample'], true, ['qc:garment_chain:write'], 'qc/qcRoute.ts /chain/garment/:orderId/review');
declare(['qc.review_fabric_sample'], true, ['qc:fabric_chain:write'], 'qc/qcRoute.ts /chain/fabric/:orderId/review');
declare(['qc.sign_report'], true, ['qc:write'], 'qc/qcRoute.ts sign report');
declare(['samples.query'], false, ['products:read'], '_shared/rolePermissionMatrix Development products domain; samples/sampleRoute.ts');
declare(['credit.query_status'], false, ['risk:read'], '_shared/rolePermissionMatrix risk:read includes credit risk');
declare(['credit.freeze'], true, ['credit:freeze:write'], 'credit/creditRoute.ts');
declare(['credit.thaw'], true, ['credit:thaw:write'], 'credit/creditRoute.ts');
declare(['internal_trade.query'], false, ['orders:read'], '_shared/rolePermissionMatrix Orders read; internalTrade/internalTradeRoute.ts');
declare(['internal_trade.create', 'internal_trade.confirm'], true, ['order:internal_trade:write'], 'internalTrade/internalTradeRoute.ts WRITE_SCOPE');
declare(['purchase_orders.query'], false, ['procurement:read'], 'procurement/procurementRoute.ts');
declare(['procurement.create', 'procurement.update_status'], true, ['procurement:write'], 'procurement/procurementRoute.ts');
declare(['inventory.adjust_stock'], true, ['inventory:write'], 'inventory/inventoryRoute.ts');
declare(['bom.query'], false, ['bom:read'], 'bom/bomRoute.ts');
declare(['order_changes.create', 'order_changes.withdraw'], true, ['order:change_request:create'], 'orderChanges/orderChangeRoute.ts');
declare(['payment_requests.create', 'payment_requests.cancel'], true, ['finance:payment_request:create'], 'paymentRequests/paymentRequestRoute.ts');
declare(['template.render', 'template.render_pdf'], true, ['tools:execute'], '_shared/rolePermissionMatrix VIEW BusinessTools; toolRuntime persists RenderedDoc/PDF. Candidate capability closure: human templates route currently only requires JWT for writes.');

declarations['products.expand'] = { sideEffects: false, allOf: ['products:read'], constraint: 'product-expand', source: 'toolRuntime.expandProductAssetContext include selectors; pricing and relation read scopes from shared matrix' };
declarations['orders.expand'] = { sideEffects: false, allOf: ['orders:read'], constraint: 'order-expand', source: 'toolRuntime.expandOrderContext include selectors; finance/production read routes' };
declarations['entities.search'] = { sideEffects: false, constraint: 'entity-search', source: 'entities/search.ts normalizeEntityTypes and actual query buckets; entities/registry.ts' };
declarations['entities.hydrate'] = { sideEffects: false, constraint: 'entity-hydrate', source: 'entities/search.ts hydrateEntities actual branches' };
declarations['memory.recall'] = { sideEffects: false, constraint: 'actor-memory-read', source: 'agent/memory.ts actor.memoryScopes ownership guard' };
declarations['memory.write'] = { sideEffects: true, constraint: 'actor-memory-write', source: 'agent/memory.ts existing personal/role/department/company contract; toolRuntime verifies current active account and shared-scope membership before remember' };
for (const id of ['moq.query_config', 'template.list']) declarations[id] = { sideEffects: false, constraint: 'authenticated-read', source: 'moq/moqRoute.ts GET config/history; templates/route.ts GET list: authenticated metadata without action scope' };
for (const id of ['links.query', 'links.expand_neighbors']) declarations[id] = { sideEffects: false, constraint: 'entity-links', source: 'entities/agentLinksService.ts authorizes both endpoints using corresponding human read scopes and canonical row resolvers; never returns arbitrary snapshots' };
declarations['payment_requests.query'] = { sideEffects: false, constraint: 'authenticated-read', source: 'paymentRequests/paymentRequestRoute.ts GET: authenticated + three-way resolver and appointed reviewer row visibility; no finance-read gate' };
declarations['exceptions.query'] = { sideEffects: false, constraint: 'authenticated-read', source: 'exceptions/exceptionRoute.ts GET: authenticated; exceptionService pure get/list project committed approval facts without writes' };

/** Complete declarations are still not row-level or sensitive-output proof.
 * Payment-request queries pass a trusted actor to the human data-scope resolver.
 * Links authorize both endpoints and return canonical identifiers only; graph
 * types without an existing read contract are still a capability gap. Exceptions
 * read committed facts without writing; callback/retry persists the projection.
 * Salary is not a supported records.query/entity-hydrate model; future salary
 * tools must declare BOTH hr:salary:read and sensitive:salary, then mask outputs.
 * Other existing handlers still need human-API ownership/data-scope + sensitive
 * field checks (and remote data-center actor propagation); these are not fixed
 * by the action scope map. Shared-memory writes revalidate current DB membership.
 */
export const AGENT_TOOL_ACTIONS: Readonly<Record<string, ToolActionDeclaration>> = Object.freeze(declarations);

export function isTechnicalSuperAdmin(actor: ActorContext): boolean {
  if (actor.permissionCeiling && !actor.permissionCeiling.includes('*')) return false;
  // Empty marked permissions isolate the shared service's existing technical
  // shortcut; there is no second handwritten owner/SuperAdmin role matrix here.
  return hasScope({ userId: actor.userId, roles: actor.roles, departmentIds: actor.departmentIds, permissions: [], authorizationLoaded: true }, 'tools:execute');
}

function entityScope(type: string): PermissionScope | undefined {
  if (type === 'relation.organization' || type === 'relation.person') return 'relations:read';
  if (['product.asset', 'product.fabricProfile', 'product.customerCode'].includes(type)) return 'products:read';
  if (type === 'order.line') return 'orders:read';
  return undefined; // Other registry labels have no search/hydrate branch.
}

function expandedScopes(id: string, input: Record<string, unknown>): PermissionScope[] {
  if (id === 'entities.search') {
    const types = Array.isArray(input.entityTypes) ? input.entityTypes.map(String).filter(isEntityType) : [];
    const effective = types.length ? types : ['relation.organization', 'relation.person', 'product.customerCode', 'product.fabricProfile', 'product.asset', 'order.line'];
    return [...new Set(effective.map(entityScope).filter((s): s is PermissionScope => Boolean(s)))];
  }
  if (id === 'entities.hydrate') {
    const refs = Array.isArray(input.refs) ? input.refs : [];
    return [...new Set(refs.map(ref => entityScope(String((ref as any)?.entityType || ''))).filter((s): s is PermissionScope => Boolean(s)))];
  }
  const scopes: PermissionScope[] = [];
  // Optional outbox creation is a separate concrete write, not a permission
  // required merely because this tool has a high-risk or finance label.
  if (id === 'invoice.issue' && input.email) scopes.push('emails:write');
  const include = Array.isArray(input.include) ? input.include.map(String) : undefined;
  if (id === 'products.expand') {
    if (!include || include.includes('pricing')) scopes.push('pricing:read');
    if (!include || include.includes('relations')) scopes.push('relations:read');
  }
  if (id === 'orders.expand') {
    if (!include || include.includes('invoices')) scopes.push('invoices:read');
    if (!include || include.includes('production')) scopes.push('production:read');
  }
  return scopes;
}

export function authorizeToolAction(actor: ActorContext, target: ToolAccessTarget): { allowed: boolean; reason?: string } {
  const declaration = AGENT_TOOL_ACTIONS[target.toolId];
  if (!declaration) return { allowed: false, reason: 'TOOL_ACTION_UNDECLARED' };
  if (declaration.sideEffects && !declaration.allOf?.length && !declaration.blockedReason
    && declaration.constraint !== 'actor-memory-write') {
    return { allowed: false, reason: 'TOOL_WRITE_SCOPE_UNDECLARED' };
  }
  if (isTechnicalSuperAdmin(actor)) return { allowed: true };
  if (declaration.blockedReason) return { allowed: false, reason: declaration.blockedReason };
  const input = target.input ?? {};
  if (declaration.constraint === 'actor-memory-write') {
    const scope = String(input.scope || `personal:${actor.userId}`);
    return actor.memoryScopes.includes(scope) && (!scope.startsWith('personal:') || scope === `personal:${actor.userId}`)
      ? { allowed: true }
      : { allowed: false, reason: 'MEMORY_SCOPE_NOT_ALLOWED' };
  }
  if (declaration.constraint === 'actor-memory-read') {
    return !input.scope || actor.memoryScopes.includes(String(input.scope))
      ? { allowed: true }
      : { allowed: false, reason: 'MEMORY_SCOPE_NOT_ALLOWED' };
  }
  if (declaration.constraint === 'authenticated-read') return { allowed: Boolean(actor.userId), reason: actor.userId ? undefined : 'ACTOR_REQUIRED' };
  if (declaration.constraint === 'entity-links') {
    const source = graphSource(input);
    if (!source || !graphReadScope(source.type)) return { allowed: false, reason: 'ENTITY_TYPE_NOT_AUTHORIZED' };
  }
  const permissionActor: TokenPayload = { userId: actor.userId, roles: actor.roles, departmentIds: actor.departmentIds, permissions: actor.permissionScopes, permissionCeiling: actor.permissionCeiling, authorizationLoaded: true };
  const required = [...(declaration.allOf ?? []), ...expandedScopes(target.toolId, input), ...(declaration.constraint === 'entity-links' ? [graphReadScope(graphSource(input)!.type)!] : [])];
  const missing = required.filter(scope => !hasScope(permissionActor, scope));
  return missing.length ? { allowed: false, reason: `INSUFFICIENT_SCOPE: ${missing.join(',')}` } : { allowed: true };
}
