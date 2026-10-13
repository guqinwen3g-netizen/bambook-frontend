/**
 * Current inventory is pinned below by AST: 26 direct exits (one finite handoff adapter), 2 packing adapters and 17 complete
 * result-object carriers. Historical 21/12 labels are retained as original test
 * identifiers, not current endpoint counts or browser/runtime evidence.
 *
 * §9 B22 第 5 域 · `shipping/route.ts`（21 处）收敛后的**执行**覆盖
 *
 * 这一族之前被我记成"有前置约束不能收"（`docs/R5-专业评审-S0A1批次-2026-09-20.md:98` 引 S0-A spec §3.3：
 * 出运 409 的门禁明细是前端门禁面板的唯一输入，而管道会把键名归一成 `details`）。
 * **本批没有"消除"那条前置，只是查清它落在哪条通道上**（12:19 实测）：门禁明细走的是
 * **返回值通道**（`if (!result.ok) res.status(map[code]||500).json({ error: result.error })`，整包转发，
 * 键名仍是 `gateDetails`），本批收敛的 21 处全在**抛出通道**（`catch` ⇒ 键名 `details`）⇒ 两条通道不重叠，
 * 面板的输入没有被换键。这个"不重叠"今天成立，**但它是会被人顺手改没的** ⇒
 * 下面第三组用例把它从文字声称换成可证伪的钉子（谁把返回值通道也接进管道，谁就红）。
 *
 * 判据来源（外部，不抄实现现值）：
 *   ① 未预期异常 ⇒ 500，且响应体不含内部原文（G6.5 / RFC 9110 §15.6.1）；
 *   ② 抛出的业务错误（自带 code + statusCode）⇒ 认它自己的档位与文案，并原样带上明细（G6.5 透传口径）；
 *   ③ 响应形状 nested `{error:{code,message[,details]}}` 与码名不变 —— 前端按 `error.code` 分支；
 *   ④ 收敛前这些抛出型业务错误一律被答成 **500**（本批的有意行为变更，与 HR / 财务两域同一口径）。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';
import { createShippingRouter } from '../route';
import { storageReader } from './shippingSourceStorageFixture';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../../auth/tokenHelpers';
import ts from 'typescript';
import { financialFailure } from '../shipmentFinancialAuthority';
import { safeRouteError } from '../../shared/routeError';

/** 本域源码（剥注释后）—— 两条通道的计数都从这里取，口径与 B22 棘轮那张表一致 */
function routeSrc(): string {
  return stripComments(fs.readFileSync(path.join(__dirname, '..', 'route.ts'), 'utf8'));
}



// Finite source inventory: direct safeRouteError calls and the two verified
// packingCommandError adapters are separate channels, not a combined regex cap.
// Historical test titles stay fixed; result.error remains a separate full-object
// channel with its seventeen exact sites.
const SAFE_EXIT_SITES = [
  "physicalAllocationWrite 'INTERNAL_ERROR'",
  "handoffError 'INTERNAL_ERROR'",
  "get /order-batches 'LIST_FAILED'",
  "get /order-batches/overdue-final 'LIST_FAILED'",
  "post /order-batches 'CREATE_FAILED'",
  "put /order-batches/:batchId 'UPDATE_FAILED'",
  "post /order-batches/:batchId/mark-shipped 'SHIP_FAILED'",
  "post /order-batches/:batchId/recalc 'RECALC_FAILED'",
  "get /booking-reminders 'BOOKING_REMINDERS_FAILED'",
  "get / 'LIST_FAILED'",
  "get /stats/on-time 'STATS_FAILED'",
  "get /stats/containers 'CONTAINER_STATS_FAILED'",
  "get /:id 'GET_FAILED'",
  "get /:id/schedule-history 'SCHEDULE_HISTORY_FAILED'",
  "get /:id/document-set 'ASSEMBLE_FAILED'",
  "get /:id/ci-sources 'ASSEMBLE_FAILED'",
  "get /stats/by-method 'STATS_FAILED'",
  "get /:id/lines 'LIST_FAILED'",
  "get /:id/land-transport 'GET_FAILED'",
  "put /:id/land-transport 'UPSERT_FAILED'",
  "get /:id/cartons 'LIST_FAILED'",
  "get /:id/events 'LIST_FAILED'",
  "get /:id/physical-context 'LIST_FAILED'",
  "get /:id/allocations 'LIST_FAILED'",
  "delete /:id/allocations/:allocId 'INTERNAL_ERROR'",
  "get /allocations/by-order/:orderId 'LIST_FAILED'"
];
// The shared handoff carrier has six finite caught-error callers. The action
// factory is bounded separately by its five actual registrations.
const HANDOFF_ERROR_SITES = [
  'post /handoffs/eligibility', 'get /handoffs', 'get /handoffs/:handoffId',
  'post /handoffs', 'handoffActionRoute', 'post /handoffs/:handoffId/confirm-departure',
];
const HANDOFF_ACTION_SITES = [
  ["'start'", "'start'"], ["'return-to-business'", "'return-to-business'"],
  ["'return-to-logistics'", "'return-to-logistics'", 'true'],
  ["'complete'", "'complete'"], ["'cancel'", "'cancel'", 'true'],
];
const PACKING_ADAPTER_SITES = [
  "get /:id/packing 'SAVE_FAILED'",
  "put /:id/packing 'SAVE_FAILED'",
];
const RESULT_ERROR_SITES = [
  "physicalAllocationWrite",
  "batchRespond",
  "post /order-batches",
  "put /order-batches/:batchId",
  "post /order-batches/:batchId/mark-shipped",
  "post /order-batches/:batchId/recalc",
  "get /:id/document-set",
  "put /:id/lines",
  "post /:id/lines/pull-from-order",
  "put /:id/cartons",
  "post /",
  "post /:id/export-declaration-completion",
  "patch /:id",
  "delete /:id",
  "post /:id/allocations",
  "patch /:id/allocations/:allocId",
  "delete /:id/allocations/:allocId"
];
function packingProviderSrc(): string {
  return stripComments(fs.readFileSync(path.join(__dirname, '..', 'shipmentPackingCommand.ts'), 'utf8'));
}

// This is a finite source-wiring guard, not an execution or database proof.
// The checker supplies local symbol identity; imports are checked against the
// actual module/export, and the packing provider is checked before crediting it.
function channelCensus(text = routeSrc(), providerText = packingProviderSrc()) {
  const files = new Map([
    ['route.ts', ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true)],
    ['shipmentPackingCommand.ts', ts.createSourceFile('shipmentPackingCommand.ts', providerText, ts.ScriptTarget.Latest, true)],
  ]);
  const host: ts.CompilerHost = {
    getSourceFile: name => files.get(name), writeFile: () => { throw new Error('B22_NO_EMIT'); },
    getDefaultLibFileName: () => '', getCurrentDirectory: () => '', getDirectories: () => [],
    fileExists: name => files.has(name), readFile: name => files.get(name)?.text,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([...files.keys()], { noResolve: true, noLib: true }, host);
  const checker = program.getTypeChecker(), source = files.get('route.ts')!, provider = files.get('shipmentPackingCommand.ts')!;
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const same = (left: ts.Node, right: ts.Node) => !!symbol(left) && symbol(left) === symbol(right);
  const propertyName = (node: ts.PropertyName) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const prop = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find(
    node => ts.isPropertyAssignment(node) && propertyName(node.name) === name) as ts.PropertyAssignment | undefined;
  const directFallback = (call: ts.CallExpression) => {
    const options = call.arguments[1];
    const fallback = options && ts.isObjectLiteralExpression(options) ? prop(options, 'fallbackCode')?.initializer : undefined;
    if (!fallback || !ts.isStringLiteral(fallback)) throw new Error('B22_UNCLASSIFIED_FALLBACK');
    return "'" + fallback.text + "'";
  };
  type Origin = { kind: 'direct' | 'packing' | 'untrusted'; alias: boolean };
  function origin(node: ts.Expression, seen = new Set<ts.Symbol>()): Origin | undefined {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = symbol(node.expression)?.declarations?.[0];
      const module = declaration && ts.isNamespaceImport(declaration) ? declaration.parent.parent : undefined;
      const moduleName = module && ts.isImportDeclaration(module) && ts.isStringLiteral(module.moduleSpecifier) ? module.moduleSpecifier.text : '';
      if (node.name.text === 'safeRouteError' && moduleName === '../shared/routeError') return { kind: 'direct', alias: true };
      if (node.name.text === 'packingCommandError' && moduleName === './shipmentPackingCommand') return { kind: 'packing', alias: true };
    }
    if (!ts.isIdentifier(node)) return undefined;
    const local = symbol(node);
    if (!local || seen.has(local)) return ['safeRouteError', 'packingCommandError'].includes(node.text)
      ? { kind: 'untrusted', alias: false } : undefined;
    seen.add(local);
    const declarations = local.declarations ?? [];
    if (declarations.length !== 1) return ['safeRouteError', 'packingCommandError'].includes(node.text)
      ? { kind: 'untrusted', alias: false } : undefined;
    const declaration = declarations[0];
    if (ts.isImportSpecifier(declaration)) {
      const imported = declaration.propertyName?.text ?? declaration.name.text;
      const module = declaration.parent.parent.parent;
      const moduleName = ts.isImportDeclaration(module) && ts.isStringLiteral(module.moduleSpecifier) ? module.moduleSpecifier.text : '';
      if (imported === 'safeRouteError') return { kind: moduleName === '../shared/routeError' ? 'direct' : 'untrusted', alias: node.text !== 'safeRouteError' };
      if (imported === 'packingCommandError') return { kind: moduleName === './shipmentPackingCommand' ? 'packing' : 'untrusted', alias: node.text !== 'packingCommandError' };
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const prior = origin(declaration.initializer, seen);
      if (prior) return { ...prior, alias: true };
    }
    if (['safeRouteError', 'packingCommandError'].includes(node.text)) return { kind: 'untrusted', alias: false };
    return undefined;
  }
  function owner(node: ts.Node): string {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isCallExpression(current) && /^router\.(get|post|put|patch|delete)$/.test(current.expression.getText(source))
        && current.arguments[0] && ts.isStringLiteral(current.arguments[0])) {
        return current.expression.getText(source).slice(7) + ' ' + current.arguments[0].text;
      }
      if (ts.isVariableDeclaration(current) && current.initializer
        && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) return current.name.getText(source);
    }
    return 'UNCLASSIFIED';
  }
  const exported = provider.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && node.name?.text === 'packingCommandError' && !!node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword));
  if (exported.length !== 1 || exported[0].parameters.length !== 1 || exported[0].body?.statements.length !== 1) {
    throw new Error('B22_UNTRUSTED_PACKING_PROVIDER');
  }
  const providerReturn = exported[0].body.statements[0];
  if (!ts.isReturnStatement(providerReturn) || !providerReturn.expression || !ts.isCallExpression(providerReturn.expression)) {
    throw new Error('B22_UNTRUSTED_PACKING_PROVIDER');
  }
  const producer = providerReturn.expression, producerOrigin = origin(producer.expression);
  if (producerOrigin?.kind !== 'direct' || producerOrigin.alias || !producer.arguments[0]
    || !same(producer.arguments[0], exported[0].parameters[0].name) || directFallback(producer) !== "'SAVE_FAILED'") {
    throw new Error('B22_UNTRUSTED_PACKING_PROVIDER');
  }
  function bindingProperty(node: ts.Node | undefined, binding: ts.Identifier, field: string): boolean {
    return !!node && ts.isPropertyAccessExpression(node) && node.name.text === field && same(node.expression, binding);
  }
  function collect(root: ts.Node): ts.Node[] {
    const nodes: ts.Node[] = [];
    const walk = (node: ts.Node) => {
      // A nested closure cannot prove that this catch actually returns a carrier.
      if (node !== root && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) return;
      nodes.push(node); ts.forEachChild(node, walk);
    };
    walk(root); return nodes;
  }
  const handoffDeclarations: ts.VariableDeclaration[] = [];
  const findHandoff = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handoffError') handoffDeclarations.push(node);
    ts.forEachChild(node, findHandoff);
  };
  findHandoff(source);
  const handoff = handoffDeclarations[0];
  if (handoffDeclarations.length !== 1 || !handoff.initializer || !ts.isArrowFunction(handoff.initializer)
    || handoff.initializer.parameters.length !== 3 || !ts.isBlock(handoff.initializer.body)
    || !ts.isVariableDeclarationList(handoff.parent) || !(handoff.parent.flags & ts.NodeFlags.Const)) {
    throw new Error('B22_UNTRUSTED_HANDOFF_PROVIDER');
  }
  const handoffFunction = handoff.initializer;
  const handoffBody = handoffFunction.body as ts.Block;
  function assertCarrier(call: ts.CallExpression, site: string) {
    const declaration = call.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call || !ts.isIdentifier(declaration.name)
      || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) {
      throw new Error('B22_UNBOUND_SAFE_RESULT ' + site);
    }
    const binding = declaration.name;
    let caught: ts.CatchClause | undefined;
    for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
      if (ts.isCatchClause(current)) { caught = current; break; }
    }
    const handoffAdapter = call.parent.parent.parent.parent === handoffBody;
    const input = handoffAdapter ? handoffFunction.parameters[1].name : caught?.variableDeclaration?.name;
    if (!input || !call.arguments[0] || !same(call.arguments[0], input)) {
      throw new Error('B22_WRONG_CAUGHT_ERROR ' + site);
    }
    const options = call.arguments[1];
    const message = options && ts.isObjectLiteralExpression(options) ? options.properties.find(
      property => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && propertyName(property.name) === 'fallbackMessage') : undefined;
    const messageSymbol = message && ts.isShorthandPropertyAssignment(message) ? checker.getShorthandAssignmentValueSymbol(message)
      : message && ts.isPropertyAssignment(message) ? symbol(message.initializer) : undefined;
    if (handoffAdapter && (handoffBody.statements.length !== 2 || !messageSymbol
      || messageSymbol !== symbol(handoffFunction.parameters[2].name))) {
      throw new Error('B22_UNTRUSTED_HANDOFF_PROVIDER');
    }
    const nodes = collect(handoffAdapter ? handoffBody : caught!.block);
    if (nodes.some(node => ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)
      && same(node.left.expression, binding) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) throw new Error('B22_MUTATED_SAFE_RESULT ' + site);
    const carriers = nodes.filter((node): node is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(node)
      && ts.isPropertyAssignment(node.parent) && propertyName(node.parent.name) === 'error'
      && node.pos > call.pos);
    const valid = carriers.filter(object => {
      if (object.properties.length !== 3 || !bindingProperty(prop(object, 'code')?.initializer as ts.Node, binding, 'code')
        || !bindingProperty(prop(object, 'message')?.initializer as ts.Node, binding, 'message')) return false;
      const spread = object.properties.find(ts.isSpreadAssignment);
      let spreadExpression = spread?.expression;
      while (spreadExpression && ts.isParenthesizedExpression(spreadExpression)) spreadExpression = spreadExpression.expression;
      if (!spreadExpression || !ts.isConditionalExpression(spreadExpression)) return false;
      const conditional = spreadExpression, condition = conditional.condition;
      if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
        || !bindingProperty(condition.left, binding, 'details') || !ts.isIdentifier(condition.right) || condition.right.text !== 'undefined'
        || symbol(condition.right)?.declarations?.length || !ts.isObjectLiteralExpression(conditional.whenTrue) || conditional.whenTrue.properties.length
        || !ts.isObjectLiteralExpression(conditional.whenFalse) || conditional.whenFalse.properties.length !== 1
        || !bindingProperty(prop(conditional.whenFalse, 'details')?.initializer as ts.Node, binding, 'details')) return false;
      const envelope = object.parent.parent;
      if (!ts.isObjectLiteralExpression(envelope)) return false;
      const response = envelope.parent;
      if (ts.isCallExpression(response) && response.arguments[0] === envelope && ts.isPropertyAccessExpression(response.expression)
        && response.expression.name.text === 'json' && ts.isCallExpression(response.expression.expression)) {
        const status = response.expression.expression;
        return ts.isPropertyAccessExpression(status.expression) && status.expression.name.text === 'status'
          && ts.isIdentifier(status.expression.expression) && status.expression.expression.text === 'res'
          && symbol(status.expression.expression)?.declarations?.some(ts.isParameter)
          && (!handoffAdapter || same(status.expression.expression, handoffFunction.parameters[0].name))
          && status.arguments.length === 1 && bindingProperty(status.arguments[0], binding, 'status');
      }
      // The physical adapter is an HTTP-data adapter; the route writes its body.
      return ts.isPropertyAssignment(response) && propertyName(response.name) === 'body'
        && ts.isObjectLiteralExpression(response.parent) && ts.isReturnStatement(response.parent.parent)
        && bindingProperty(prop(response.parent, 'status')?.initializer as ts.Node, binding, 'status');
    });
    if (valid.length !== 1) throw new Error('B22_MISSING_SAME_BINDING_CARRIER ' + site);
  }
  const safeSites: string[] = [], adapterSites: string[] = [], directCarriers: string[] = [], adapterCarriers: string[] = [], resultCarriers: string[] = [];
  const handoffSites: string[] = [], handoffActions: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && same(node, handoff.name) && node !== handoff.name
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) throw new Error('B22_BORROWED_HANDOFF_PROVIDER');
    if (ts.isCallExpression(node)) {
      if (same(node.expression, handoff.name)) {
        const site = owner(node);
        if (!HANDOFF_ERROR_SITES.includes(site)) throw new Error('B22_UNREGISTERED_HANDOFF_EXIT ' + site);
        let caught: ts.CatchClause | undefined;
        for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
          if (ts.isCatchClause(current)) { caught = current; break; }
        }
        const handler = caught?.parent.parent.parent;
        const response = handler && ts.isArrowFunction(handler) ? handler.parameters[1]?.name : undefined;
        if (node.arguments.length !== 3 || !response || !same(node.arguments[0], response)
          || !caught?.variableDeclaration || !same(node.arguments[1], caught.variableDeclaration.name)
          || !ts.isStringLiteral(node.arguments[2])) throw new Error('B22_WRONG_HANDOFF_INPUT ' + site);
        handoffSites.push(site);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'handoffActionRoute') {
        handoffActions.push(node.arguments.map(argument => argument.getText(source)));
      }
      const provenance = origin(node.expression);
      if (provenance) {
        if (provenance.kind === 'untrusted') throw new Error('B22_UNTRUSTED_ERROR_PROVIDER ' + owner(node));
        if (provenance.alias) throw new Error('B22_BORROWED_ERROR_PROVIDER ' + owner(node));
        const site = owner(node) + ' ' + (provenance.kind === 'direct' ? directFallback(node) : "'SAVE_FAILED'");
        const inventory = provenance.kind === 'direct' ? SAFE_EXIT_SITES : PACKING_ADAPTER_SITES;
        if (!inventory.includes(site)) throw new Error('B22_UNREGISTERED_ERROR_EXIT ' + site);
        assertCarrier(node, site);
        (provenance.kind === 'direct' ? safeSites : adapterSites).push(site);
        (provenance.kind === 'direct' ? directCarriers : adapterCarriers).push(site);
      }
    }
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
      const provenance = origin(node);
      if (provenance && provenance.kind !== 'untrusted'
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        // A reference passed through .bind, an object or parentheses is not a
        // credited direct invocation; it cannot hide an additional HTTP exit.
        throw new Error('B22_BORROWED_ERROR_PROVIDER ' + owner(node));
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'error'
      && node.initializer.getText(source) === 'result.error') resultCarriers.push(owner(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (JSON.stringify(handoffSites) !== JSON.stringify(HANDOFF_ERROR_SITES)
    || JSON.stringify(handoffActions) !== JSON.stringify(HANDOFF_ACTION_SITES)) throw new Error('B22_HANDOFF_INVENTORY_DRIFT');
  return { safeSites, adapterSites, directCarriers, adapterCarriers, resultCarriers, handoffSites, handoffActions };
}

const RAW = 'PrismaClientKnownRequestError: Invalid `prisma.shipment.findMany()` invocation in /srv/app/server/src/shipping/route.ts:225 — The table `Shipment` does not exist in the current database.';

function appWith(prisma: any) {
  const app = express();
  app.use(express.json());
  // Trusted synthetic server context is built through the actual current role
  // loader; source authority below still rereads this storage before the fault.
  app.use(async (req, _res, next) => {
    const user = await loadUserWithRoles(prisma, 'shipping-reader');
    const actor = await buildLoadedAuthTokenPayload(prisma, user);
    if (prisma._ceiling !== undefined) actor.permissionCeiling = [...prisma._ceiling];
    (req as any).actor = actor;
    await prisma._afterTrustedActor?.();
    next();
  });
  app.use('/api/v1/shipping', createShippingRouter({
    prisma, requireAuth: false, apiKeys: new Set<string>(), onDataChange: vi.fn(),
    exceptionChecker: null,
  }));
  return app;
}

function rejecting(err: Error) {
  const user = { id: 'shipping-reader', displayName: 'Current logistics reader', status: 'active', deletedAt: null,
    primaryDeptId: null, roles: [{ roleId: 'role-logistics', departmentId: null,
      role: { id: 'role-logistics', name: 'Logistics', permissions: ['orders:read', 'shipments:read'].map(scope => ({ permission: { scope } })) } }] };
  const db: any = { _user: user, _ceiling: undefined,
    userAccount: storageReader(() => [user]), userPermissionOverrides: storageReader(() => []),
    order: storageReader(() => [{ id: 'O1', ownerId: 'shipping-reader', customerRelationId: null, deletedAt: null }]),
    orderShipmentBatch: { findMany: vi.fn(async () => { throw err; }) },
  };
  db.$transaction = vi.fn(async (work: any) => work(db));
  return db;
}

async function get(app: express.Express, p: string) {
  return request(app).get(p);
}

describe('B22 · shipping 出口：内部原文不上屏', () => {
  it('GET /order-batches 服务层炸 → 500 + LIST_FAILED + 中文文案 + 零内部细节', async () => {
    const res = await get(appWith(rejecting(new Error(RAW))), '/api/v1/shipping/order-batches?orderId=O1');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('LIST_FAILED');
    const body = JSON.stringify(res.body);
    for (const frag of ['PrismaClient', 'prisma.shipment', 'route.ts:225', 'does not exist', '/srv/app']) {
      expect(body, `响应体不应含内部细节「${frag}」`).not.toContain(frag);
    }
    expect(res.body.error.message).toMatch(/[一-龥]/);
    expect(res.body.error.message).toContain('批次');
  });

  it('★ §3.3 前置条件正面化：抛出的业务错误带明细 ⇒ 状态、码、文案、**明细**一起送达，不能吞', async () => {
    const gate = Object.assign(new Error('该运单所属订单尚未确认，不能排柜'), {
      code: 'GATE_BLOCKED', statusCode: 409,
      details: { blockedBy: ['ORDER_NOT_CONFIRMED'], shipmentId: 'SHP__1' },
    });
    const res = await get(appWith(rejecting(gate)), '/api/v1/shipping/order-batches?orderId=O1');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GATE_BLOCKED');
    expect(res.body.error.message).toBe('该运单所属订单尚未确认，不能排柜');
    expect(res.body.error.details).toEqual({ blockedBy: ['ORDER_NOT_CONFIRMED'], shipmentId: 'SHP__1' });
  });

  it('没有明细时不凭空造 `details` 字段（前端按字段存在与否分支，多出空字段就是契约变更）', async () => {
    const biz = Object.assign(new Error('运单不存在或已被删除'), { code: 'SHIPMENT_NOT_FOUND', statusCode: 404 });
    const res = await get(appWith(rejecting(biz)), '/api/v1/shipping/order-batches?orderId=O1');
    expect(res.status).toBe(404);
    expect(Object.prototype.hasOwnProperty.call(res.body.error, 'details')).toBe(false);
  });

  it('抛出的业务错误不再被硬编码答成 500（收敛前的行为，本批有意改掉）', async () => {
    const res = await get(appWith(rejecting(
      Object.assign(new Error('订单已终结，不能改派'), { code: 'ORDER_TERMINAL', statusCode: 400 }),
    )), '/api/v1/shipping/order-batches?orderId=O1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ORDER_TERMINAL');
  });
});

describe('B22 · shipping 源码棘轮', () => {
  it('21 处出口已改接真源；响应体里不再有取原始异常的写法', () => {
    const src = routeSrc();
    expect(src.match(/message:\s*(err|e)\??\.message/g) ?? []).toHaveLength(0);
    expect(channelCensus(src).safeSites).toEqual(SAFE_EXIT_SITES);
    const census = channelCensus(src);
    expect(census.directCarriers, '同一真源 binding 的直接明细载体逐站核验').toEqual(SAFE_EXIT_SITES);
    expect(census.adapterSites, '只登记实际 provider 的两个装箱出口').toEqual(PACKING_ADAPTER_SITES);
    expect(census.adapterCarriers, '装箱载体不能混入 direct 计数').toEqual(PACKING_ADAPTER_SITES);
    // 阳性对照：旧写法必须被第一条抓到
    expect((`res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });`)
      .match(/message:\s*(err|e)\??\.message/g) ?? []).toHaveLength(1);
  });
});

/**
 * 出运门禁明细的两条通道（R5 评审引 spec §3.3 那条硬前置的**可执行版本**）
 *
 * 数都取自 2026-09-20 12:19–12:22 实测（剥注释、排除 `.test.`），命令与本文件的断言即为其落盘处：
 *   返回值通道 `json({ error: result.error })` **12 处**（明细键名 `gateDetails`，前端唯一消费者
 *     `services/shipmentService.ts:77`）；抛出通道 `safeRouteError` **21 处**（明细键名 `details`，
 *     全 web 四目录（services/components/utils/lib，非测试）读 `error.details` 的站点 **0 处**）。
 *  ⇒ 两键不互通是本批敢收敛那 21 处的**全部**理由。哪天有人把 12 处也接进管道，
 *    键名静默变成 `details`、前端零消费者 ⇒ 面板从此列不出「哪个订单缺哪条」，
 *    而 B22 的棘轮**看不见这一改**（那 12 处整包外发，本就不在它的正则口径里）。
 */
describe('B22 · shipping 门禁明细：两条通道各用各的键，不许合并', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..', '..');   // 仓根（web 树在这里）
  const readWeb = (rel: string) =>
    stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  it('★ 返回值通道仍整包转发 result.error（12 处）⇒ 门禁明细活着到前端', () => {
    const fwd = channelCensus().resultCarriers;
    expect(fwd, '逐站完整转发；不能将结果错误改写为抛出通道键名').toEqual(RESULT_ERROR_SITES);
    // 两通道不重叠：抛出通道 21 处 + 返回值通道 12 处
    expect(channelCensus().safeSites, '逐站抛出通道').toEqual(SAFE_EXIT_SITES);
    expect(channelCensus().adapterSites, '装箱 adapter 另表登记').toEqual(PACKING_ADAPTER_SITES);
  });

  it('★ 消费侧只认 gateDetails：shipmentService 逐字读它，全 web 树无人读 error.details', () => {
    const svc = readWeb('services/shipmentService.ts');
    expect((svc.match(/err\.gateDetails = data\.error\.gateDetails/g) ?? []).length,
      '前端取明细那一行变了 ⇒ 本文件上一条必须同步重估（两键一旦合并，面板就空了）').toBe(1);
    expect((svc.match(/error\??\.details/g) ?? []).length,
      '前端一旦开始读 details，说明键名迁移已经发生 ⇒ 这条要连同服务端一起改').toBe(0);
  });

  it('双向对照：注释里整包转发不算，合成一处必须算（防正则退化成恒不匹配）', () => {
    const sample = [
      '// json({ error: result.error }) 旧写法',
      '/* json({ error: result.error }) */',
      "res.status(409).json({ error: result.error });",
    ].join('\n');
    expect(stripComments(sample).match(/\.json\(\{ error: result\.error \}\)/g) ?? []).toHaveLength(1);
    // 反向：把明细换成管道键名后，整包转发那条就数不到了（这正是上面第 1 条会红的形状）
    const converged = "const se = safeRouteError(err, { fallbackCode: 'GATE_BLOCKED', fallbackMessage: '…' });\nres.status(se.status).json({ error: { code: se.code, message: se.message } });";
    expect(converged.match(/\.json\(\{ error: result\.error \}\)/g) ?? []).toHaveLength(0);
    expect(converged.match(/safeRouteError\(/g) ?? []).toHaveLength(1);
  });
});


describe('Current shipment read authority and error-carrier mutations', () => {
  it('current grant removal and an empty signed ceiling reject before the target storage fault', async () => {
    const db = rejecting(new Error(RAW));
    db._afterTrustedActor = () => { db._user.roles[0].role.permissions = []; };
    const revoked = await get(appWith(db), '/api/v1/shipping/order-batches?orderId=O1');
    expect(revoked.status).toBe(403); expect(revoked.body.error.code).toBe('FORBIDDEN');
    expect(db.orderShipmentBatch.findMany).not.toHaveBeenCalled();
    const capped = rejecting(new Error(RAW)); capped._ceiling = [];
    const denied = await get(appWith(capped), '/api/v1/shipping/order-batches?orderId=O1');
    expect(denied.status).toBe(403); expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(capped.orderShipmentBatch.findMany).not.toHaveBeenCalled();
  });
  it('fixed AST inventories catch a lost carrier, a rekeyed carrier and an added unknown exit', () => {
    const original = routeSrc(); expect(channelCensus().resultCarriers).toEqual(RESULT_ERROR_SITES);
    const lost = original.replace('body: { error: result.error }', 'body: { error: { code: result.error.code } }');
    expect(channelCensus(lost).resultCarriers).not.toEqual(RESULT_ERROR_SITES);
    const lostBatch = original.replace('ok: false, error: result.error', 'ok: false, error: { details: result.error.gateDetails }');
    expect(channelCensus(lostBatch).resultCarriers).not.toEqual(RESULT_ERROR_SITES);
    const added = original + "\nconst stray = safeRouteError(err, { fallbackCode: 'LIST_FAILED' });";
    expect(() => channelCensus(added)).toThrow('B22_UNREGISTERED_ERROR_EXIT');
    expect(channelCensus(original + "\n// safeRouteError(err, { fallbackCode: 'LIST_FAILED' });").safeSites).toEqual(SAFE_EXIT_SITES);
  });
});


// Extract the actual small, pure production adapter, without duplicating its
// business body. These are adapter controls, not native database/run proofs.
function actualAdapter(name: string, file: string): (...args: any[]) => any {
  const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let declaration: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableDeclaration(node) && node.name.getText(source) === name)) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration) throw new Error(`Actual adapter not found: ${name}`);
  const code = ts.isVariableDeclaration(declaration) ? 'const ' + declaration.getText(source) + ';' : declaration.getText(source);
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('safeRouteError', js + '; return ' + name + ';')(safeRouteError);
}

describe('Actual batch error adapters preserve the two original channels', () => {
  it('batchRespond forwards the original result; typed errors retain detail content under the actual central normalization contract', () => {
    const error = { code: 'GATE_BLOCKED', message: '当前来源未具备放行资格', status: 409,
      gateDetails: { orders: [{ orderId: 'O1', blockingReasons: ['FINAL_QC_MISSING'] }] } };
    const respond = actualAdapter('batchRespond', 'route.ts');
    const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
    respond(res, { ok: false, error });
    expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith({ ok: false, error });
    expect(res.json.mock.calls[0][0].error).toBe(error);
    const requireSuccess = actualAdapter('requireSuccess', 'orderShipmentBatchNativeService.ts');
    let thrown: unknown;
    try { requireSuccess({ ok: false, error }); } catch (caught) { thrown = caught; }
    expect(thrown).toBeInstanceOf(Error);
    const result = financialFailure(thrown, 'SHIP_FAILED');
    // The batch producer's existing result type had no detail fields. The new
    // optional fields must survive its typed throw; the central error adapter
    // then deliberately normalizes either detail input to `details`.
    expect(thrown).toMatchObject({ gateDetails: error.gateDetails });
    expect(Object.prototype.hasOwnProperty.call(thrown, 'details')).toBe(false);
    expect(result.error).toEqual({ code: error.code, message: error.message, status: error.status, details: error.gateDetails });
    expect(Object.prototype.hasOwnProperty.call(result.error, 'gateDetails')).toBe(false);
    const withDetails = { code: 'GATE_BLOCKED', message: '另一批次拒绝', status: 409, details: { blockedBy: ['ORDER_NOT_CONFIRMED'] } };
    let detailsError: unknown;
    try { requireSuccess({ ok: false, error: withDetails }); } catch (caught) { detailsError = caught; }
    expect(detailsError).toMatchObject({ details: withDetails.details });
    expect(Object.prototype.hasOwnProperty.call(detailsError, 'gateDetails')).toBe(false);
    expect(financialFailure(detailsError, 'SHIP_FAILED').error).toEqual(withDetails);
    let plainError: unknown;
    try { requireSuccess({ ok: false, error: { code: 'NOT_FOUND', message: '当前批次不存在', status: 404 } }); } catch (caught) { plainError = caught; }
    expect(plainError).toBeInstanceOf(Error);
    expect(Object.prototype.hasOwnProperty.call(plainError, 'details')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(plainError, 'gateDetails')).toBe(false);
    expect(financialFailure(plainError, 'SHIP_FAILED').error).toEqual({ code: 'NOT_FOUND', message: '当前批次不存在', status: 404 });
    expect(financialFailure(Object.assign(new Error('抛出的业务拒绝'), { code: 'GATE_BLOCKED', statusCode: 409,
      details: { blockedBy: ['ORDER_NOT_CONFIRMED'] } }), 'SHIP_FAILED').error).toEqual({
      code: 'GATE_BLOCKED', message: '抛出的业务拒绝', status: 409, details: { blockedBy: ['ORDER_NOT_CONFIRMED'] },
    });
  });
});

// Source mutants exercise the actual classifier against fixed production bytes.
// They are wiring controls, not HTTP, browser, database or permission proofs.
function mutateErrorSite(method: string, route: string, change: (handler: string) => string): string {
  const original = routeSrc(), source = ts.createSourceFile('route.ts', original, ts.ScriptTarget.Latest, true);
  let target: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'router.' + method
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === route) target = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!target) throw new Error('Missing actual mutation site: ' + method + ' ' + route);
  const before = target.getText(source), after = change(before);
  if (after === before) throw new Error('Mutation did not change actual source: ' + method + ' ' + route);
  return original.slice(0, target.getStart(source)) + after + original.slice(target.end);
}

describe('B22 finite provenance controls (source wiring)', () => {
  it('rejects an additional unregistered direct safeRouteError exit', () => {
    expect(() => channelCensus()).not.toThrow();
    const mutant = routeSrc() + "\nrouter.get('/unregistered-error', async (req, res) => { try { throw new Error('probe'); } catch (error) { const safe = safeRouteError(error, { fallbackCode: 'LIST_FAILED' }); res.status(safe.status).json({ error: { code: safe.code, message: safe.message, ...(safe.details === undefined ? {} : { details: safe.details }) } }); } });";
    expect(() => channelCensus(mutant)).toThrow('B22_UNREGISTERED_ERROR_EXIT');
  });
  it('rejects a real imported safeRouteError borrowed under another local binding', () => {
    expect(() => channelCensus()).not.toThrow();
    const mutant = routeSrc() + "\nrouter.get('/borrowed-error', async (req, res) => { try { throw new Error('probe'); } catch (error) { const borrowed = safeRouteError; const safe2 = borrowed(error, { fallbackCode: 'LIST_FAILED' }); res.status(safe2.status).json({ error: { code: safe2.code, message: safe2.message, ...(safe2.details === undefined ? {} : { details: safe2.details }) } }); } });";
    expect(() => channelCensus(mutant)).toThrow('B22_BORROWED_ERROR_PROVIDER');
  });
  it.each(['parenthesized', 'bound'] as const)('rejects a borrowed safeRouteError value: %s', kind => {
    expect(() => channelCensus()).not.toThrow();
    const borrow = kind === 'parenthesized' ? '(safeRouteError)' : 'safeRouteError.bind(null)';
    const mutant = routeSrc() + "\nrouter.get('/borrowed-value', async (req, res) => { try { throw new Error('probe'); } catch (error) { const borrowed = " + borrow + "; const safe2 = borrowed(error, { fallbackCode: 'LIST_FAILED' }); res.status(safe2.status).json({ error: { code: safe2.code, message: safe2.message, ...(safe2.details === undefined ? {} : { details: safe2.details }) } }); } });";
    expect(() => channelCensus(mutant)).toThrow('B22_BORROWED_ERROR_PROVIDER');
  });
  it.each(['renamed import', 'namespace import'] as const)('rejects a real provider imported through another call binding: %s', kind => {
    expect(() => channelCensus()).not.toThrow();
    const imported = kind === 'renamed import' ? "import { safeRouteError as borrowedSafe } from '../shared/routeError';" : "import * as boundary from '../shared/routeError';";
    const called = kind === 'renamed import' ? 'borrowedSafe' : 'boundary.safeRouteError';
    const mutant = imported + '\n' + routeSrc() + "\nrouter.get('/borrowed-import', async (req, res) => { try { throw new Error('probe'); } catch (error) { const safe2 = " + called + "(error, { fallbackCode: 'LIST_FAILED' }); res.status(safe2.status).json({ error: { code: safe2.code, message: safe2.message, ...(safe2.details === undefined ? {} : { details: safe2.details }) } }); } });";
    expect(() => channelCensus(mutant)).toThrow('B22_BORROWED_ERROR_PROVIDER');
  });
  it('rejects details from a different binding even with the canonical key and condition', () => {
    expect(() => channelCensus()).not.toThrow();
    const mutant = mutateErrorSite('get', '/:id/ci-sources', handler => handler.replace('{ details: safe.details }', '{ details: error.details }'));
    expect(() => channelCensus(mutant)).toThrow('B22_MISSING_SAME_BINDING_CARRIER');
  });
  it.each(['wrong import', 'same-name local shadow', 'forged packing provider'] as const)('rejects an unrelated provider: %s', kind => {
    expect(() => channelCensus()).not.toThrow();
    if (kind === 'wrong import') {
      const mutant = routeSrc().replace("from '../shared/routeError'", "from '../shared/unrelatedRouteError'");
      expect(mutant).not.toBe(routeSrc());
      expect(() => channelCensus(mutant)).toThrow('B22_UNTRUSTED_ERROR_PROVIDER');
    } else if (kind === 'same-name local shadow') {
      const mutant = mutateErrorSite('get', '/:id/ci-sources', handler => handler.replace('const safe = safeRouteError(error,',
        "function safeRouteError(_error: unknown, _options: unknown) { return { status: 500, code: 'ASSEMBLE_FAILED', message: 'unrelated', details: undefined }; } const safe = safeRouteError(error,"));
      expect(() => channelCensus(mutant)).toThrow('B22_UNTRUSTED_ERROR_PROVIDER');
    } else {
      const provider = packingProviderSrc().replace("from '../shared/routeError'", "from '../shared/unrelatedRouteError'");
      expect(provider).not.toBe(packingProviderSrc());
      expect(() => channelCensus(routeSrc(), provider)).toThrow('B22_UNTRUSTED_PACKING_PROVIDER');
    }
  });
  it.each([
    ['get', '/:id/ci-sources', 'delete'], ['get', '/:id/packing', 'delete'], ['put', '/:id/packing', 'delete'],
    ['get', '/:id/ci-sources', 'rekey'], ['get', '/:id/packing', 'rekey'],
  ])('rejects a missing or rekeyed same-binding details carrier: %s %s %s', (method, route, change) => {
    expect(() => channelCensus()).not.toThrow();
    const mutant = mutateErrorSite(method, route, handler => change === 'delete'
      ? handler.replace(', ...(safe.details === undefined ? {} : { details: safe.details })', '')
      : handler.replace('{ details: safe.details }', '{ gateDetails: safe.details }'));
    expect(() => channelCensus(mutant)).toThrow('B22_MISSING_SAME_BINDING_CARRIER');
  });
});


describe('Finite handoff error adapter controls', () => {
  it('executes the actual helper: internal faults are masked and typed business details survive', () => {
    const respond = actualAdapter('handoffError', 'route.ts');
    const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
    respond(res, new Error(RAW), '出运交接暂不可读取，请刷新后重试。');
    expect(res.status).toHaveBeenLastCalledWith(500);
    expect(res.json).toHaveBeenLastCalledWith({ ok: false, error: { code: 'INTERNAL_ERROR', message: '出运交接暂不可读取，请刷新后重试。' } });
    const details = { blockingReasons: ['FINAL_QC_MISSING'] };
    respond(res, Object.assign(new Error('来源尚未完成'), { code: 'GATE_BLOCKED', statusCode: 409, details }), 'fallback');
    expect(res.status).toHaveBeenLastCalledWith(409);
    expect(res.json).toHaveBeenLastCalledWith({ ok: false, error: { code: 'GATE_BLOCKED', message: '来源尚未完成', details } });
  });
  const mutateHandoff = (change: (source: string) => string) => {
    const source = routeSrc(), start = source.indexOf('const handoffError ='), end = source.indexOf("router.post('/handoffs/eligibility'", start);
    const original = source.slice(start, end), modified = change(original);
    expect(modified).not.toBe(original);
    return source.slice(0, start) + modified + source.slice(end);
  };
  it('pins every adapter caller and all five action registrations', () => {
    expect(channelCensus().handoffSites).toEqual(HANDOFF_ERROR_SITES);
    expect(channelCensus().handoffActions).toEqual(HANDOFF_ACTION_SITES);
  });
  it.each([
    ['wrong error', (text: string) => text.replace('safeRouteError(error,', 'safeRouteError(new Error("replacement"),'), 'B22_WRONG_CAUGHT_ERROR'],
    ['lost details', (text: string) => text.replace('...(safe.details === undefined ? {} : { details: safe.details })', ''), 'B22_MISSING_SAME_BINDING_CARRIER'],
    ['raw message', (text: string) => text.replace('message: safe.message', 'message: error.message'), 'B22_MISSING_SAME_BINDING_CARRIER'],
    ['mutated result', (text: string) => text.replace('res.status(safe.status)', 'safe.message = "raw"; res.status(safe.status)'), 'B22_UNTRUSTED_HANDOFF_PROVIDER'],
    ['wrong fallback message', (text: string) => text.replace("'INTERNAL_ERROR', fallbackMessage", "'INTERNAL_ERROR', fallbackMessage: error.message"), 'B22_UNTRUSTED_HANDOFF_PROVIDER'],
  ] as const)('rejects helper mutation: %s', (_name, change, expected) => {
    expect(() => channelCensus(mutateHandoff(change))).toThrow(expected);
  });
  it('rejects caller substitution, borrowed references and an extra action', () => {
    const source = routeSrc();
    expect(() => channelCensus(source.replace("handoffError(res, error, '出运资格", "handoffError(res, new Error('replacement'), '出运资格"))).toThrow('B22_WRONG_HANDOFF_INPUT');
    expect(() => channelCensus(source.replace('const handoffActionRoute =', 'const borrowed = handoffError; const handoffActionRoute ='))).toThrow('B22_BORROWED_HANDOFF_PROVIDER');
    expect(() => channelCensus(source.replace("handoffActionRoute('start', 'start');", "handoffActionRoute('start', 'start'); handoffActionRoute('unknown', 'start');"))).toThrow('B22_HANDOFF_INVENTORY_DRIFT');
    expect(() => channelCensus(source.replace("'/handoffs/eligibility'", "'/handoffs/unregistered'"))).toThrow('B22_UNREGISTERED_HANDOFF_EXIT');
  });
});


describe('Export declaration completion result carrier', () => {
  it('pins its full service error rather than reconstructing selected fields', () => {
    expect(channelCensus().resultCarriers).toEqual(RESULT_ERROR_SITES);
    const mutant = mutateErrorSite('post', '/:id/export-declaration-completion', handler =>
      handler.replace('error: result.error', 'error: { code: result.error.code, message: result.error.message }'));
    expect(channelCensus(mutant).resultCarriers).not.toEqual(RESULT_ERROR_SITES);
  });
});
