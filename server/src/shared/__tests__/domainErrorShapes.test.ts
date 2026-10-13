import { ReleaseBatchBindingError } from '../../production/releaseBatchBinding';
import { ProductionBatchFactsError } from '../../production/productionBatchFacts';
/**
 * 域内 error class 形状核定（S0-A Task 4）
 *
 * 为什么要钉：`safeRouteError` / `resolveError` 靠「code:string + statusCode:number」认业务错误。
 * 全仓自定义 error class 无共同基类，凡不带这二者者，其**有意的业务文案会被吞、
 * 状态码兜成 500**。本测试把「哪个类带不带契约」变成可核对的表，而不是靠人翻。
 *
 * 判据分两类：
 *   · 有意给用户看的（校验类、门禁类）→ 必须携带 code+statusCode，否则红。
 *   · 纯内部技术错（CAS 冲突、SSRF 拦截、模板渲染失败）→ 允许不带（走通用文案），
 *     但必须显式列进 INTERNAL_CLASSES，防「以后新增一个类忘了想」被静默放过。
 *
 * ★ 断言写法约束（权威文档 G6.4：期望值与现值同源 = 断言无效）：
 *   本文件的每个期望值都是**测试自带的字面量**，不写 `toBe(err.code)`、也不写
 *   `toBe(那条常量本身)` 这种「拿产出它的表达式当期望值」的比较 —— 那样契约被删掉照样绿。
 *   （唯一例外：`GENERIC_ROUTE_ERROR_MESSAGE` 用来断言「内部文案没被换成通用文案」的
 *    `not` 比较，以及下面「全表标点一致」那条性质断言 —— 钉的是**规则**，不是值相等。）
 *
 * ★ 复审折入（评审 I1/I2/M-1/M-2）：
 *   · I1「委托那条主腿没人看着」→ 新增三条：表内 5xx 码走通「查表出状态与文案」、
 *     `fallbackMessage` 仍压过表文案、以及一个**表内 4xx 探针**（只有它能分辨「查表」与「写死 500」）。
 *   · I2「注释声称与 hr/route.ts 同值，但本文件从不打开那个文件」→ 新增「跨文件真源核对」组，
 *     fs 读 `hr/route.ts` 解析出映射逐码比对，并带**合成样本正向对照**证明抽取器不静默返回空表。
 *   · M-1 兜底码普查的阈值从 `>20` 改成精确 80 处 / 35 码 + 双向自检；M-2 补 `details` 的适配层两条。
 *   · Task 5 复审 F3：兜底码普查从「只扫 `safeRouteError(… fallbackCode: 'X')`」扩成三支
 *     （加 `resolveError(<ident>, 'CODE')` 直调 + 一条**已核对过**的「中继 helper」清单）。
 *     不扩的后果：risk 收敛到 `resolveError` 之后，它那 20 个兜底码**从这条红线的分母里消失** ——
 *     把 `errorCodes.ts` 里任一 risk 码改成 4xx，旧普查照样全绿。`80 / 35` 两个数按支分账，口径未放宽。
 *   这四条各自「改坏会红」的变异证据见 Task 4 的任务报告 §10；
 *   Task 5 复审 F3（普查扩支）的变异证据见 Task 5 报告的复审修复段。
 *
 * ★ Step 0 实测的构造器签名（构造调用照实签写，不照核定表猜）：
 *   · `HrError(code, message, statusCode?)`        —— **code 在前**（brief 示例把 message 写在第一位，
 *     照抄会把 80 个抛出点的「码 / 文案」对调）；statusCode 默认**按 code 推**（400/404/409）
 *   · `StageGateError(code, message, statusCode?)` —— 同上，code 是逐抛出点给的语义码
 *     （ORDER_NOT_FOUND / PP_RELEASE_BLOCKED …），不是常量，无法收敛成一个 code 默认值
 *   · `CrmValidationError(message, code?, statusCode?)` / `SealValidationError(同)` /
 *     `FabricCalcValidationError(message)`（后者 code 早就是 `VALIDATION_FAILED`，见其行内注释）
 *   · `GateBlockedError(eligibility, check?)`      —— **不是 message 构造器**，入参是 GateEligibility 对象，
 *     消息由类自己组装（含 DR-013 例外入口提示）
 *   · `TemplateNotFoundError(id)` / `TemplateRenderError(id, cause)` / `SsrfBlockedError(message)`
 *   · `StockMovementCasConflictError(itemId)` / `CreditBlockedError(message)` /
 *     `RoleWriteRejectedError(message, statusCode, code)` —— 这三个**未 export**，本文件引不到，
 *     只能在下面的普查里按源码文本核定
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { ERROR_CODES, GENERIC_ROUTE_ERROR_MESSAGE, lookupErrorCode, resolveError, isBusinessError } from '../errorCodes';
import { safeRouteError } from '../routeError';
import { HrError, hrStatusForCode } from '../../hr/hrService';
import { CrmValidationError } from '../../crm/crmService';
import { StageGateError } from '../../production/stageService';
import { SealValidationError } from '../../seal/sealService';
import { GateBlockedError } from '../../exceptions/exceptionGate';
import { FabricCalcValidationError } from '../../tools/fabricCalculatorService';
import { TemplateNotFoundError, TemplateRenderError } from '../../templates/render';
import { SsrfBlockedError } from '../../lib/ssrfGuard';
import { CreditExceptionConsumptionError } from '../../credit/creditExceptionGate';
import { InventoryStockInsufficientError } from '../../inventory/inventoryService';
import { ProformaAccessError } from '../../finance/proformaInvoiceAccess';
import { DevelopmentDomainError } from '../../development/developmentOperationalGuard';
import { releaseQuantity } from '../../production/releaseBatchBinding';
import { PurchaseOrderDomainError } from '../../procurement/purchaseOrderErrors';
import { ReceiptDomainError } from '../../procurement/receiptWarehouseAccess';
import { QcAssignmentError } from '../../qc/qcAssignmentAccess';
import { QcReportError, qcReportFailure } from '../../qc/qcReportAuthority';
import { ClaimVisibilityError } from '../../claims/claimVisibility';
import { CashRefundError } from '../../claims/claimCashRefundFact';
import { ClaimTransactionError } from '../../claims/claimApprovalFact';
import { ApprovalDecisionError } from '../../approvals/approvalDecisionService';
import { ReceiptMatchProposalError } from '../../finance/receiptMatchProposalService';
import { DemandError } from '../../procurement/procurementDemandService';
import { PurchaseServiceDeliveryError } from '../../procurement/purchaseServiceDeliveryService';
import { OrderLineWriteError, orderLineWriteFailure, currentOrderLineWriteActor } from '../../orders/orderLineWriteAccess';
import { WorkflowError, currentWorkflowActor, workflowReject } from '../../workflow/workflowAccess';
import { PricingDomainError } from '../../pricing/pricingError';
import { stripComments } from './utils/sourceScan';
import { classifyPrivateResultBoundaries } from '../../../../scripts/lib/tierMessageSources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SRC = path.resolve(HERE, '..', '..'); // server/src

/** 遍历 src 下的生产 .ts（守卫自己的样本字符串与测试文件必须排除，同 routeError.test.ts 的教训） */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(abs, out);
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) out.push(abs);
  }
  return out;
}

/**
 * 计数前必须剥注释（同 `routeError.test.ts:47` 的教训，那里已实测过一次假红）：
 * `routeError.ts` 文件头的**用法示例**里就写着 `fallbackCode: 'ENTITY_SEARCH_FAILED'` ——
 * 不剥注释时它会被算成第 81 处调用点，精确计数（M-1）当场对不上。
 */

/**
 * 一个**确定不在注册表里**的兜底码：业务判定只能由类自己携带的 code/statusCode 成立，
 * 不能靠「兜底码恰好在表里是 4xx」蒙过断言（表里加一个码是本批后续任务的事，不该联动本测试）。
 */
const FALLBACK_NOT_IN_TABLE = 'DOMAIN_SHAPES_PROBE_CODE_NOT_IN_REGISTRY';

type ShapeSpec = {
  /** 期望 code —— 测试自带字面量，不是「回头读实例上那个字段」 */
  code: string;
  /** 期望 status —— 核定表要求的值 */
  status: number;
  /** 消息由调用方给入 ⇒ 期望值就是那句字面量 */
  message?: string;
  /** 消息由类自己组装（GateBlockedError）⇒ 只能钉「关键内容有没有活下来」 */
  messageIncludes?: string[];
};

/** 面向业务：必须自带 code + statusCode，且业务文案能透传 */
const USER_FACING: Array<[string, Error, ShapeSpec]> = [
  ['DevelopmentDomainError', new DevelopmentDomainError('DEVELOPMENT_CLOSED', '开发已结案，请按变更流程继续'),
    { code: 'DEVELOPMENT_CLOSED', status: 409, message: '开发已结案，请按变更流程继续' }],
  ['ProformaAccessError', new ProformaAccessError('FORBIDDEN', '当前账号不能处理原发票'),
    { code: 'FORBIDDEN', status: 403, message: '当前账号不能处理原发票' }],
  ['PurchaseOrderDomainError', new PurchaseOrderDomainError('采购单已变化，请刷新', 'CONFLICT'),
    { code: 'CONFLICT', status: 409, message: '采购单已变化，请刷新' }],
  ['ReceiptDomainError', new ReceiptDomainError('收料来源不存在', 'NOT_FOUND'),
    { code: 'NOT_FOUND', status: 404, message: '收料来源不存在' }],
  ['QcAssignmentError', new QcAssignmentError('UNAUTHORIZED', '请登录后处理验货任务'),
    { code: 'UNAUTHORIZED', status: 401, message: '请登录后处理验货任务' }],
  ['CreditExceptionConsumptionError', new CreditExceptionConsumptionError('EXCEPTION_NOT_FOUND', '受控例外不存在，请重新核对'),
    { code: 'EXCEPTION_NOT_FOUND', status: 404, message: '受控例外不存在，请重新核对' }],
  ['InventoryStockInsufficientError', new InventoryStockInsufficientError('实际可用库存不足'),
    { code: 'STOCK_INSUFFICIENT', status: 409, message: '实际可用库存不足' }],
  ['ClaimVisibilityError', new ClaimVisibilityError('NOT_FOUND', '案件不存在或不可见'),
    { code: 'NOT_FOUND', status: 404, message: '案件不存在或不可见' }],
  ['CashRefundError', new CashRefundError('INVALID_STATE', '退款没有准确付款批准事实'),
    { code: 'INVALID_STATE', status: 409, message: '退款没有准确付款批准事实' }],
  ['ClaimTransactionError', new ClaimTransactionError({ code: 'VALIDATION_FAILED', message: '索赔金额必须为有效正数' }),
    { code: 'VALIDATION_FAILED', status: 400, message: '索赔金额必须为有效正数' }],
  ['ApprovalDecisionError', new ApprovalDecisionError('SELF_APPROVAL_FORBIDDEN', 403, '申请人不能审批自己的申请'),
    { code: 'SELF_APPROVAL_FORBIDDEN', status: 403, message: '申请人不能审批自己的申请' }],
  ['ReceiptMatchProposalError', new ReceiptMatchProposalError('FORBIDDEN', '当前账号不能确认核销', 403),
    { code: 'FORBIDDEN', status: 403, message: '当前账号不能确认核销' }],
  ['DemandError', new DemandError('NOT_FOUND', '采购需求不存在或不可见', 404),
    { code: 'NOT_FOUND', status: 404, message: '采购需求不存在或不可见' }],
  ['PurchaseServiceDeliveryError', new PurchaseServiceDeliveryError('INVALID_INPUT', '实际验收数量无效', 400),
    { code: 'INVALID_INPUT', status: 400, message: '实际验收数量无效' }],
  ['HrError', new HrError('VALIDATION_FAILED', 'KPI 权重总和 120 超过 100'),
    { code: 'VALIDATION_FAILED', status: 400, message: 'KPI 权重总和 120 超过 100' }],
  ['CrmValidationError', new CrmValidationError('body.totalLimit 必填且须为正数（信用额度）'),
    { code: 'CRM_VALIDATION_FAILED', status: 400, message: 'body.totalLimit 必填且须为正数（信用额度）' }],
  ['StageGateError', new StageGateError('STAGE_BLOCKED', '阶段 pp 已被标记阻塞，请先在看板解除阻塞（留痕）后再推进'),
    { code: 'STAGE_BLOCKED', status: 409, message: '阶段 pp 已被标记阻塞，请先在看板解除阻塞（留痕）后再推进' }],
  ['SealValidationError', new SealValidationError('印章图必填'),
    { code: 'SEAL_VALIDATION_FAILED', status: 400, message: '印章图必填' }],
  ['FabricCalcValidationError', new FabricCalcValidationError('字段 gsm 须为正数'),
    { code: 'VALIDATION_FAILED', status: 400, message: '字段 gsm 须为正数' }],
  // 门禁类的消息同时含「为什么被挡（SS_NOT_CONFIRMED）」与「下一步做什么（DR-013 受控例外入口）」——
  // 这正是 G7.5「异常可行动」要求的那段话，被吞成通用 500 就等于把用户推到「只能猜」。
  ['GateBlockedError', new GateBlockedError({
    eligible: false, gate: 'shipment_release', blockingReasons: ['SS_NOT_CONFIRMED'],
  }), { code: 'GATE_BLOCKED', status: 409, messageIncludes: ['SS_NOT_CONFIRMED', 'shipment_release', 'DR-013'] }],
];

/** 纯内部：允许不外显细节，但必须显式登记 —— [类名, 实例, 不得出现在响应里的内部标识片段] */
const INTERNAL_CLASSES: Array<[string, Error, string[]]> = [
  ['TemplateNotFoundError', new TemplateNotFoundError('packing_list'), ['packing_list']],
  ['TemplateRenderError',
    new TemplateRenderError('packing_list', new Error('driver said: connection terminated unexpectedly')),
    ['connection terminated', 'packing_list']],
  ['SsrfBlockedError', new SsrfBlockedError('不允许访问内网/回环地址'), ['内网', '回环']],
];

// Independently adjudicated HTTP literals. These are not obtained from the
// constructors or registry under test; the 503 rows also prevent a blanket
// "all user-facing errors are 4xx" assumption. SQL is tested separately below.

/** These two exact source-bound wrappers carry failed Results out of their
 * owning transaction. They are not public error classes or finite raw-message
 * exemptions. A name, constructor shape or serialized object alone is not proof. */
export function privateTransactionResultProof(file: string, source: string) {
  const spec = file === 'finance/billingItemService.ts' ? {
    name: 'ManualInvoiceAbort', command: 'invoiceBillingItem', producer: 'abortManualInvoice',
    klass: `export class ManualInvoiceAbort extends Error {
      constructor(readonly failure: { code: string; message: string; status: number }) { super(failure.message); }
    }`,
    helper: `export function abortManualInvoice(code: string, message: string, status: number): never {
      throw new ManualInvoiceAbort({ code, message, status });
    }`,
    consumer: `export function manualInvoiceFailure(error: unknown, fallbackCode: string, fallbackMessage: string) {
      if (error instanceof ManualInvoiceAbort) return fail(error.failure.code, error.failure.message, error.failure.status);
      const result = safeRouteError(error, { fallbackCode, fallbackMessage });
      return fail(result.code, result.message, result.status);
    }`, count: 3,
  } : file === 'pricing/commissionPayableService.ts' ? {
    name: 'CommissionAbort', command: 'createCommissionPayable', producer: undefined,
    klass: `class CommissionAbort extends Error {
      constructor(readonly refusal: CommissionResult<never>) { super('Commission Payable refused'); }
    }`, helper: undefined, consumer: undefined, count: 5,
  } : undefined;
  if (!spec) return undefined;
  const ast = ts.createSourceFile('/source/' + file, source, ts.ScriptTarget.Latest, true);
  const collect = (node: ts.Node, predicate: (n: ts.Node) => boolean) => {
    const found: ts.Node[] = [];
    const visit = (n: ts.Node) => { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); };
    visit(node); return found;
  };
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host: ts.CompilerHost = {
    getSourceFile: name => name === ast.fileName ? ast : undefined,
    getDefaultLibFileName: () => '/missing.d.ts', writeFile() {}, getCurrentDirectory: () => '/',
    getDirectories: () => [], fileExists: name => name === ast.fileName,
    readFile: name => name === ast.fileName ? source : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const checker = ts.createProgram([ast.fileName], options, host).getTypeChecker();
  const same = (a: ts.Node, b: ts.Node) => !!checker.getSymbolAtLocation(a)
    && checker.getSymbolAtLocation(a) === checker.getSymbolAtLocation(b);
  const printed = (text: string) => {
    const output = ts.createPrinter({ removeComments: true }).printFile(
      ts.createSourceFile('contract.ts', text, ts.ScriptTarget.Latest, true));
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, output);
    const tokens: Array<[ts.SyntaxKind, string]> = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
      tokens.push([token, scanner.getTokenText()]);
    return JSON.stringify(tokens); // Ignore layout, never literal contents or bindings.
  };
  const text = (n: ts.Node | undefined) => n?.getText(ast) ?? '';
  const oneFunction = (id: string) => {
    const found = collect(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === id);
    return found.length === 1 ? found[0] as ts.FunctionDeclaration : undefined;
  };
  const classes = collect(ast, n => ts.isClassDeclaration(n) && n.name?.text === spec.name);
  const klass = classes.length === 1 ? classes[0] as ts.ClassDeclaration : undefined;
  if (!klass?.name || printed(text(klass)) !== printed(spec.klass)) return undefined;
  // A shadowed/imported Error or native class name invalidates this source binding.
  const bindings = collect(ast, n => (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isClassDeclaration(n)
    || ts.isFunctionDeclaration(n) || ts.isImportSpecifier(n))
    && ('name' in n) && [spec.name, 'Error'].includes(text((n as ts.NamedDeclaration).name)));
  if (bindings.length !== 1) return undefined;
  const command = oneFunction(spec.command);
  if (!command?.body) return undefined;
  const nativeTransactions = collect(command, n => ts.isCallExpression(n)
    && text(n.expression) === 'prisma.$transaction' && n.arguments.length === 1
    && ts.isArrowFunction(n.arguments[0])) as ts.CallExpression[];
  if (nativeTransactions.length !== 1) return undefined;
  const transaction = nativeTransactions[0].arguments[0];
  const inside = (node: ts.Node, parent: ts.Node) => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) if (n === parent) return true;
    return false;
  };
  const constructors = collect(ast, n => ts.isNewExpression(n) && same(n.expression, klass.name!)) as ts.NewExpression[];
  if (constructors.length !== spec.count || constructors.some(n => !ts.isThrowStatement(n.parent))) return undefined;
  if (spec.producer) {
    const producer = oneFunction(spec.producer), consumer = oneFunction('manualInvoiceFailure');
    if (!producer || !consumer || printed(text(producer)) !== printed(spec.helper!)
      || printed(text(consumer)) !== printed(spec.consumer!)) return undefined;
    if (constructors.some(n => !inside(n, transaction) && !inside(n, producer))) return undefined;
    const failedCanonical = collect(transaction, n => ts.isIfStatement(n) && text(n.expression) === '!r.ok'
      && ts.isExpressionStatement(n.thenStatement) && ts.isCallExpression(n.thenStatement.expression)
      && same(n.thenStatement.expression.expression, producer.name!) && n.thenStatement.expression.arguments.length === 3);
    if (failedCanonical.length !== 1) return undefined;
    const imported = collect(ast, n => ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)
      && n.moduleSpecifier.text === '../shared/routeError' && !!n.importClause?.namedBindings
      && ts.isNamedImports(n.importClause.namedBindings)
      && n.importClause.namedBindings.elements.some(e => e.name.text === 'safeRouteError' && !e.propertyName));
    const safeCalls = collect(consumer, n => ts.isCallExpression(n) && text(n.expression) === 'safeRouteError');
    const safeBindings = collect(ast, n => (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n)
      || ts.isImportSpecifier(n)) && 'name' in n && text((n as ts.NamedDeclaration).name) === 'safeRouteError');
    if (imported.length !== 1 || safeCalls.length !== 1 || safeBindings.length !== 1) return undefined;
    const catches = collect(command, ts.isCatchClause) as ts.CatchClause[];
    const outer = catches.find(n => !inside(n, transaction));
    if (!outer || !collect(outer.block, n => ts.isReturnStatement(n) && !!n.expression
      && ts.isCallExpression(n.expression) && text(n.expression.expression) === 'manualInvoiceFailure'
      && text(n.expression.arguments[0]) === text(outer.variableDeclaration?.name)).length) return undefined;
    return { className: spec.name, file, constructorSource: text(klass), producerSource: text(producer),
      consumerSource: text(consumer), transactionSource: text(command), constructors: constructors.length };
  }
  if (constructors.some(n => !inside(n, transaction))) return undefined;
  const catches = collect(command, ts.isCatchClause) as ts.CatchClause[];
  const outer = catches.find(n => !inside(n, transaction));
  if (!outer || text(outer.variableDeclaration?.name) !== 'error') return undefined;
  const first = outer.block.statements[0];
  if (!ts.isIfStatement(first) || !ts.isBinaryExpression(first.expression)
    || first.expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword
    || !same(first.expression.right, klass.name)
    || printed(text(first)) !== printed('if (error instanceof CommissionAbort) return error.refusal;')) return undefined;
  const last = outer.block.statements[outer.block.statements.length - 1];
  if (printed(text(last)) !== printed("return unknownCommissionFailure(error, 'create');")) return undefined;
  const failedCanonical = collect(transaction, n => ts.isIfStatement(n)
    && printed(text(n)) === printed('if (!invoiceResult.ok) throw new CommissionAbort(invoiceFailure(invoiceResult.error));'));
  if (failedCanonical.length !== 1) return undefined;
  return { className: spec.name, file, constructorSource: text(klass), producerSource: '',
    consumerSource: text(outer.block), transactionSource: text(command), constructors: constructors.length };
}

describe('V1 新增三个公共错误类：逐码 HTTP/文案及未知存储边界', () => {
  const message = '独立验收文案，请核对原请求。';
  const orderLineCases = [
    ['UNAUTHORIZED', 401], ['ACCOUNT_DISABLED', 401], ['FORBIDDEN', 403],
    ['AUTHORIZATION_UNAVAILABLE', 503], ['CONFLICT', 409], ['ORDER_NOT_FOUND', 404], ['ORDER_LINE_NOT_FOUND', 404],
  ] as const;
  const workflowCases = [
    ['INVALID_INPUT', 400], ['UNAUTHORIZED', 401], ['DEPENDENCY_CHECK_FAILED', 503],
    ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['CONFLICT', 409], ['INVALID_STATE', 409],
  ] as const;
  const pricingCases = [['VALIDATION_FAILED', 400], ['NOT_FOUND', 404], ['INVALID_MULTIPLIER', 400]] as const;

  it.each(orderLineCases)('OrderLineWriteError %s 真实两件套保留 %i 与公开文案', (code, status) => {
    expect(safeRouteError(new OrderLineWriteError(code, message), { fallbackCode: FALLBACK_NOT_IN_TABLE }))
      .toMatchObject({ code, status, message, passthrough: status < 500 });
  });
  it.each(workflowCases)('WorkflowError %s 真实显式状态 %i 不被通用兜底压掉', (code, status) => {
    expect(safeRouteError(new WorkflowError(code, message, status), { fallbackCode: FALLBACK_NOT_IN_TABLE }))
      .toMatchObject({ code, status, message, passthrough: status < 500 });
  });
  it.each(pricingCases)('PricingDomainError %s 保留独立核定状态 %i', (code, status) => {
    expect(safeRouteError(new PricingDomainError(code, message), { fallbackCode: FALLBACK_NOT_IN_TABLE }))
      .toMatchObject({ code, status, message, passthrough: true });
  });
  it('workflowReject 的当前默认是来源/状态冲突409，不能改成 blanket400', () => {
    let caught: unknown;
    try { workflowReject('CONFLICT', message); } catch (error) { caught = error; }
    expect(safeRouteError(caught, { fallbackCode: FALLBACK_NOT_IN_TABLE }))
      .toMatchObject({ code: 'CONFLICT', status: 409, message, passthrough: true });
  });
  it.each(['订单不存在', 'INVALID_STATE', '金额必须为正数'])('含 %s 的真实未知 SQL 形状不能伪装三个新增公共类', fragment => {
    const error = Object.assign(new Error(`SQL private_table.private_column ${fragment} /private/path`), { code: 'P2022' });
    expect(error).not.toBeInstanceOf(OrderLineWriteError);
    expect(error).not.toBeInstanceOf(WorkflowError);
    expect(error).not.toBeInstanceOf(PricingDomainError);
    expect(orderLineWriteFailure(error)).toBeNull();
    const result = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
    expect(result).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, passthrough: false, message: GENERIC_ROUTE_ERROR_MESSAGE });
    expect(JSON.stringify(result)).not.toMatch(/SQL|private_table|private_column|private\/path|P2022/);
  });
  it.each(['orderLine', 'workflow'] as const)('%s 当前身份存储读取故障实际变为503，不恢复旧授权/泄SQL', async domain => {
    const failed = async () => { throw Object.assign(new Error('SQL 不存在 private_authority'), { code: 'P2022' }); };
    const db = { userAccount: { findFirst: failed, findUnique: failed } };
    const prior = { userId: 'synthetic-current-user', roles: ['owner'] as const, permissions: ['*'], departmentIds: [] };
    let caught: unknown;
    try {
      if (domain === 'orderLine') await currentOrderLineWriteActor(db, { ...prior, roles: ['owner'] }, 'update');
      else await currentWorkflowActor(db, { ...prior, roles: ['owner'] });
    } catch (error) { caught = error; }
    const result = safeRouteError(caught, { fallbackCode: 'INTERNAL_ERROR' });
    expect(result.status).toBe(503);
    expect(result.code).toBe(domain === 'orderLine' ? 'AUTHORIZATION_UNAVAILABLE' : 'DEPENDENCY_CHECK_FAILED');
    expect(result.message).toBe(domain === 'orderLine' ? '暂时无法核验写入权限，请稍后重试。' : '无法核对当前工作流权限，请稍后重试');
    expect(JSON.stringify(result)).not.toMatch(/SQL|private_authority|P2022/);
  });
});

describe('★ 前提：兜底探针码必须不在注册表里（否则下面的判定会被表蒙过）', () => {
  it('FALLBACK_NOT_IN_TABLE 未登记', () => {
    expect(lookupErrorCode(FALLBACK_NOT_IN_TABLE)).toBeUndefined();
  });
});

describe('★ 面向业务的 error class 必须携带透传契约', () => {
  it.each(USER_FACING)('%s 实例经 resolveError 后必须原样透传自己的文案', (name, err, spec) => {
    const r = resolveError(err, FALLBACK_NOT_IN_TABLE);
    if (spec.message !== undefined) {
      expect(r.message, `${name} 的业务文案被吞了 —— 该类需补 code + statusCode`).toBe(spec.message);
    } else {
      for (const token of spec.messageIncludes ?? []) {
        expect(r.message, `${name} 的消息丢了「${token}」= 可行动信息被吞`).toContain(token);
      }
    }
    expect(r.code, `${name} 外发的码不对`).toBe(spec.code);
    expect(r.status, `${name} 的状态码没跟着类走`).toBe(spec.status);
    expect(r.status).toBeLessThan(500);
  });

  /**
   * `HrError` 的 status 由 `code` 推（与 `hr/route.ts` 的 `hrErrorStatus` 同一条规则）。
   * 为什么要单独钉：81 个抛出点分 400/404/409 三档，给类写死任何一个数，
   * 收敛那天就会把「记录不存在」答成 400（那一档 16 个点）。下面的字面量是
   * `hr/route.ts:838` 映射的实测值，不是从类里读回来的。
   *
   * ⚠️ 但**本条只钉得住类自己的默认值**：它从不打开 `hr/route.ts`，所以路由那份副本哪天改成
   * 401/500，这里照样绿（评审 I2）。真正「两份副本不许漂移」的机器保证在下面
   * `跨文件真源核对` 那一组 —— 它 fs 读路由源码、解析出映射再逐码比对。
   */
  it('HrError 的 statusCode 按 code 分档（400 / 404 / 409），与 hr/route.ts 的映射同值', () => {
    expect(new HrError('VALIDATION_FAILED', 'userId 必填').statusCode).toBe(400);
    expect(new HrError('RUN_NOT_FOUND', '工资单 RUN_x 不存在').statusCode).toBe(404);
    expect(new HrError('INVALID_TRANSITION', '请假单当前状态 Approved，不可审批').statusCode).toBe(409);
    // 显式第三参仍可覆写（个别抛出点需要偏离码语义默认档）—— 当前无调用点这么做
    expect(new HrError('VALIDATION_FAILED', 'x', 422).statusCode).toBe(422);
  });
});

describe('内部技术错类不得伪装成业务错误', () => {
  it.each(INTERNAL_CLASSES)('%s 不带 statusCode 时必须落到通用文案、且不带任何内部标识', (name, err, tokens) => {
    const r = resolveError(err, FALLBACK_NOT_IN_TABLE);
    expect(r.status).toBe(500);
    // 未被认成业务错误 ⇒ 外发的码就是兜底探针本身；哪天有人顺手给这类补上 code，这里就红
    expect(r.code).toBe(FALLBACK_NOT_IN_TABLE);
    expect(r.message).not.toBe(err.message);
    expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE); // 只钉「换成了通用文案」这件事，不比内容
    for (const t of tokens) {
      expect(r.message, `内部标识「${t}」泄进响应了`).not.toContain(t);
    }
    expect(JSON.stringify(r)).not.toContain('prisma');
  });
});

describe('★ 用户可见 5xx 文案的标点一致性（Task 4 折入的实测偏差）', () => {
  it('注册表每条文案都以全角句号结尾（通用 500 那条曾少一个句号 ⇒ 用户可见文案不一致）', () => {
    expect(GENERIC_ROUTE_ERROR_MESSAGE.endsWith('。')).toBe(true);
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(spec.message, `${code} 的文案结尾标点与其余条目不一致`).toMatch(/。$/);
    }
  });
});

describe('★ 委托后 safeRouteError 与注册表同源', () => {
  it('业务错误：透传自己的码/文案/状态', () => {
    const r = safeRouteError(new SealValidationError('印章名称必填'), { fallbackCode: FALLBACK_NOT_IN_TABLE });
    expect({ status: r.status, code: r.code, message: r.message, passthrough: r.passthrough }).toEqual({
      status: 400, code: 'SEAL_VALIDATION_FAILED', message: '印章名称必填', passthrough: true,
    });
  });

  it('未预期异常：兜底码不在表里 ⇒ 500 + 通用文案，原始信息一个字都不外发', () => {
    const r = safeRouteError(new Error('Invalid `prisma.order.findMany()` invocation'), {
      fallbackCode: FALLBACK_NOT_IN_TABLE,
    });
    expect({ status: r.status, code: r.code, passthrough: r.passthrough }).toEqual({
      status: 500, code: FALLBACK_NOT_IN_TABLE, passthrough: false,
    });
    expect(r.message).not.toContain('prisma');
  });

  /**
   * 收敛点行为钉子：调用点显式给的 `status` 只兜**未预期异常**那一支，不得压过业务错误
   * 自带的状态码 —— 若被压过，paymentRequestRoute:317 / orders/routeV2:190 那两处
   * （`status: notFound ? 404 : 500`，404 靠文案含「不存在」判）会把一个 400 的业务拒绝
   * 悄悄改写成 404 —— 那是收敛前的行为，委托不许顺手改掉。
   */
  it('opts.status 只兜未预期异常，不覆盖业务错误自带的状态码', () => {
    const business = safeRouteError(new HrError('INVALID_TRANSITION', '员工已离职，不可再变更'), {
      fallbackCode: FALLBACK_NOT_IN_TABLE, status: 404,
    });
    expect(business.status).toBe(409);
    expect(business.message).toBe('员工已离职，不可再变更');

    const unexpected = safeRouteError(new Error('db down'), {
      fallbackCode: FALLBACK_NOT_IN_TABLE, status: 404, fallbackMessage: '生成付款申请单失败',
    });
    expect(unexpected.status).toBe(404);
    expect(unexpected.message).toBe('生成付款申请单失败');
  });

  /**
   * 业务错误自带的码**恰好与调用点的兜底码同名**时，文案仍必须是业务的那句。
   * 为什么单独钉：全仓 116 处 `Object.assign(new Error(msg), { code, statusCode })`，码由产出方
   * 自取 ⇒ 「业务码 == fallbackCode」是可发生的巧合（`VALIDATION_FAILED` / `*_FAILED` 两边都在用）。
   * 若 `fallbackMessage` 的生效条件按**码名**判（`r.code === opts.fallbackCode`），
   * 这种巧合下有意的业务文案会被兜底文案顶掉 —— 正是本批要消灭的「吞文案」。
   */
  it('业务码与兜底码同名时仍透传业务文案（按形状判，不按码名判）', () => {
    const r = safeRouteError(new SealValidationError('印章图必填'), {
      fallbackCode: 'SEAL_VALIDATION_FAILED', fallbackMessage: '兜底文案',
    });
    expect({ status: r.status, code: r.code, message: r.message }).toEqual({
      status: 400, code: 'SEAL_VALIDATION_FAILED', message: '印章图必填',
    });
  });

  /**
   * ★ I1：委托的**主打那条腿** —— 「兜底码查表出状态与文案」端到端穿过适配层。
   * 为什么必须单独钉：本文件其余 `safeRouteError` 用例**故意**用表外探针码（为的是钉「不许被表蒙过去」），
   * 于是那条腿的状态恒 500、文案恒通用 —— 把 `routeError.ts:88` 退回成写死的 `opts.status ?? 500`、
   * 或把 `:93` 退回成 `opts.fallbackMessage ?? GENERIC_ROUTE_ERROR_MESSAGE`，
   * `domainErrorShapes` / `routeError` / `errorCodes` 三个文件**一条都不红**（修复前实测见报告 §10.1），
   * 委托就成了没人看着的空转（R6「改坏咬红」不成立）。
   * 期望值的依据是两条独立事实，不是「实现现在返回什么」：
   *   · 500 Internal Server Error = 「服务端未预期故障、客户端没做错任何事」的唯一正确语义；
   *   · 「风险概览加载失败，请稍后重试。」是**注册表**为 `OVERVIEW_FAILED` 登记的产品文案
   *     （真源是那张表），Task 5 收敛 risk 域时靠的就是它。
   */
  it('★ 表内 5xx 兜底码：状态与文案都由注册表决定（委托的主路径）', () => {
    const r = safeRouteError(new Error('内部细节'), { fallbackCode: 'OVERVIEW_FAILED' });
    expect(r).toMatchObject({ status: 500, code: 'OVERVIEW_FAILED', message: '风险概览加载失败，请稍后重试。' });
    expect(r.message).not.toContain('内部细节');
  });

  /**
   * ★ I1 的另一半：**显式** `fallbackMessage` 仍压过注册表文案。
   * 依据是本任务的硬约束「签名与返回形状不变、既有调用点行为不变」—— 51 个调用点自带文案，
   * 让表文案顶掉它们等于本批顺手改用户可见响应（那不属于一个委托任务）。
   * 与上一条合起来才把优先级钉全：**调用点显式文案 > 注册表文案 > 通用文案**。
   */
  it('★ 显式 fallbackMessage 仍压过注册表文案（表文案只在该调用点没写文案时顶上）', () => {
    const r = safeRouteError(new Error('内部细节'), {
      fallbackCode: 'OVERVIEW_FAILED', fallbackMessage: '调用点自己写的文案',
    });
    expect({ status: r.status, code: r.code, message: r.message }).toEqual({
      status: 500, code: 'OVERVIEW_FAILED', message: '调用点自己写的文案',
    });
  });

  /**
   * ★ I1 的**状态**那条腿单独一个探针。
   * 为什么 5xx 探针不够：表里全部 risk 域码的状态都是 500，与「写死 500」在观测上**完全相同** ⇒
   * 那行退回成 `opts.status ?? 500` 时，上一条照样绿（这正是评审挑出的「无法咬红」）。
   * 只有拿一个**表内 4xx** 码当探针，两种实现才会分开：查表 ⇒ 404，写死 ⇒ 500。
   * 期望依据：`NOT_FOUND` 在注册表里登记为 404，而 404 Not Found 的 HTTP 语义就是「目标资源不存在」；
   * 「委托」的**定义**即「状态由表给」，本条钉的是这个定义。
   * ⚠️ 这不是给生产调用点开绿灯：兜底码的语义是「这次失败我没预料到」⇒ 只许表外码或表内 5xx 码，
   *   那由下面的 F 组普查逐处守着（2026-09-20 量：205 处调用点里 0 处用表内 4xx 码）；这里是**直接调适配器**做
   *   单元核对，没有任何路由这样写。
   */
  it('★ 兜底码在表里时状态确实来自表（表内 4xx 探针：写死 500 的实现会被这条咬红）', () => {
    const r = safeRouteError(new Error('db down'), { fallbackCode: 'NOT_FOUND' });
    expect({ status: r.status, code: r.code, message: r.message, passthrough: r.passthrough }).toEqual({
      status: 404, code: 'NOT_FOUND', message: '目标记录不存在或已被删除。', passthrough: true,
    });
  });

  /**
   * ★ M-2：`safeRouteError` 本次新增的 `details` 字段（归一化本身在 `errorCodes.test.ts:21-29` 已钉，
   * 缺的是**适配层这一腿**）。为什么值得单独钉：出运门禁 409 的明细是前端
   * ShipmentGateBlockedPanel 的输入（spec §3.3）—— 适配层若把它丢了，状态码与文案全对、
   * 面板却是空的，且没有任何别的测试会红。期望依据是那条前端契约，不是实现。
   */
  it('★ 业务错误带 gateDetails → 适配层逐字随附 details（键名归一到 details 一个键）', () => {
    const gateDetails = {
      blockingReasons: ['SS_NOT_CONFIRMED'],
      orders: [{ orderId: 'SO-2026-0917', blockingReasons: ['SS_NOT_CONFIRMED'] }],
      exceptionReason: 'NONE',
    };
    const e = Object.assign(new Error('出运门禁未通过'), { code: 'GATE_BLOCKED', statusCode: 409, gateDetails });
    const r = safeRouteError(e, { fallbackCode: 'SHIPMENT_RELEASE_FAILED' });
    // 409 Conflict 的依据是 HTTP 语义本身：请求与资源当前状态冲突（门禁未放行），不是服务端故障
    expect(r.status).toBe(409);
    expect(r.details).toEqual(gateDetails);
    expect(r.details, '明细被复制/改写 ⇒ 前端面板拿到的不再是逐字那份').toBe(gateDetails);
    expect('gateDetails' in r, '适配层不得再产出旧键名（明细统一落 details，见 asyncHandler 头注释）').toBe(false);
  });

  it('★ 未预期异常 → details 键**不存在**（不是值为 undefined）', () => {
    const r = safeRouteError(new Error('db down'), { fallbackCode: 'OVERVIEW_FAILED' });
    expect('details' in r).toBe(false);
    expect(JSON.parse(JSON.stringify(r)), '序列化后凭空多出一个 details 空洞').not.toHaveProperty('details');
  });
});

/**
 * ★ I2：`hr/route.ts` 与 `hrService.ts` 的 `hrStatusForCode` 曾是**同一条规则的多份副本**
 * （Task 4 有意留下的，收口排在 Task 4b）。上面 A2 那条只钉得住类自己的默认值 —— 它从不打开路由文件，
 * 所以哪天路由把 `_NOT_FOUND` 改成 500，本文件里那句「与 hr/route.ts 的映射同值」就成了假话（评审 I2）。
 * 这组守卫先把那句话变成事实（fs 读路由源码 → 解析映射 → 逐码比对）；Task 4b 落地后路由副本已删，
 * 本组随即改钉**终态**：路由必须改引真源（import）、`hrErrorStatus` 只许剩「instanceof 甄别 + 委托」，
 * 任何字面量规则复活（整段复活 / 半收敛 / 别名式丢甄别）都要红。G6.3：每种坏形态各配一份阳性对照。
 */

type RouteRule =
  | { kind: 'equals'; code: string; status: number }
  | { kind: 'suffix'; suffix: string; status: number };

/** `{ converged: true }` = 路由副本已被删掉、改 import 真源（Task 4b 的终态，视为通过） */
type ParsedRouteMap = { rules: RouteRule[]; fallback: number } | { converged: true };

/** 路由那份映射的**终态**长这样：不再有本地规则，改引 hrService 的真源 */
const CONVERGED_IMPORT_RE = /import\s*\{[^}]*\bhrStatusForCode\b[^}]*\}\s*from\s*'\.\/hrService'/;
/** 终态函数体只剩委托：状态数一律出自 hrStatusForCode */
const DELEGATES_TRUTH_RE = /return\s+hrStatusForCode\s*\(/;
/** 委托之外再出现任何「码字面量 → 状态」形态 = 半收敛（第二份真源在长回来）
 *  ★ 复审 F5 补最后一支：委托**返回值上重新挂数字兜底**（`hrStatusForCode(err.code) || 500`）。
 *    真源是全函数，那条兜底要么永不生效（死腿），要么说明有人想把「认不出时答什么」
 *    搬回调用方 —— 那正是 Task 4b 复审 F2 的成因，必须判成残留规则而不是 converged。
 *    注意本仓实际的 500 兜底只写在 `hrService.hrStatusForBareCode` 一处（裸码包装），
 *    所以 `return hrStatusForCode(err.code);` 这种干净委托不在此列。 */
const LEFTOVER_RULE_RE = /err\.code\s*===|\.endsWith\(\s*'[A-Z_0-9]+'\s*\)|[A-Z][A-Z0-9_]{3,}:\s*[45]\d\d|hrStatusFor\w*\s*\([^)]*\)\s*(?:\|\||\?\?)\s*\d/;
/** 陷阱 2 的机器形态：非 HrError → 500 的甄别必须仍在（别名式收敛会把它弄丢） */
const INSTANCEOF_GUARD_RE = /instanceof\s+HrError/;

/**
 * ★ B22 终态（比 Task 4b 更彻底的一步）：`hrErrorStatus` 整层删除，路由的错误出口**全部**改走
 * `safeRouteError` ⇒ 状态出自 `HrError.statusCode`，而那个默认值就是 `hrStatusForCode(code)`
 * （钉在 `hrService.ts` 的构造器上，见本组「正向对照 3」与 `hr/__tests__/hrStatusForCode.test.ts`）。
 * 判据 = 「import 了 routeError 的委托 + 全文再不提 hrStatusForCode」。
 * ⚠️ 这一支**不是逃生门**：还要过 LEFTOVER_RULE_RE（码规则复活）、HrError 仍在抛出、
 *    以及「委托数 ≥ 1」这三关；任一不过即 throw。
 */
const RELAY_ONLY_IMPORT_RE = /import\s*\{[^}]*\bsafeRouteError\b[^}]*\}\s*from\s*'\.\.\/shared\/routeError'/;
const RELAY_CALL_RE = /safeRouteError\(/g;
function isRelayOnly(src: string): boolean {
  // 只看**剥注释后**的可执行文本：路由的导读注释里会提到 `hrStatusForCode`（说明状态真源在哪），
  // 那不是"路由自己推状态"。（本仓踩过一次：判据没剥注释 ⇒ 一条注释把守卫判成非终态。）
  const code = stripComments(src);
  return RELAY_ONLY_IMPORT_RE.test(code) && !/\bhrStatusForCode\b/.test(code);
}

/* ── 下面这些合成样本只服务「正向/负向对照」，不参与对真身的比对 ──────────────
 * 刻意不拿 `hr/route.ts` 的当前文本去改（`routeSrc().replace(...)`）：
 * 那会让对照组依赖路由今天的写法，Task 4b 换形态之后就误报。 */

/** 与真身同形，但函数被改名（抽取器必须 throw，不能返回空表） */
const HR_MAP_SAMPLE_RENAMED = [
  '  function hrStatusRenamedByMistake(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  "    if (err.code === 'VALIDATION_FAILED') return 400;",
  "    if (err.code.endsWith('_NOT_FOUND')) return 404;",
  '    return 409;',
  '  }',
].join('\n');

/** 函数还在、规则没了（被换成读别的字段 / 抄成字面量表）*/
const HR_MAP_SAMPLE_NO_RULES = [
  '  function hrErrorStatus(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  '    return err.statusFromSomewhereElse;',
  '  }',
].join('\n');

/** 两条兜底 return ⇒ 不许猜哪条算兜底 */
const HR_MAP_SAMPLE_TWO_DEFAULTS = [
  '  function hrErrorStatus(err: any): number {',
  "    if (err.code === 'VALIDATION_FAILED') return 400;",
  '    return 409;',
  '    return 418;',
  '  }',
].join('\n');

/** 真身的规则，但两档状态被改坏（400 → 403、404 → 500）⇒ 漂移必须被判出 */
const HR_MAP_SAMPLE_DRIFTED = [
  '  function hrErrorStatus(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  "    if (err.code === 'VALIDATION_FAILED') return 403;",
  "    if (err.code.endsWith('_NOT_FOUND')) return 500;",
  '    return 409;',
  '  }',
].join('\n');

/** Task 4b 收敛后的真身形态：本地规则删净、函数只剩 instanceof 甄别 + 委托真源 ⇒ 判为 converged */
const HR_MAP_SAMPLE_CONVERGED = [
  "import { createHrService, HrError, hrStatusForCode } from './hrService';",
  '  function hrErrorStatus(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  '    return hrStatusForCode(err.code);',
  '  }',
].join('\n');

/** ★ 陷阱 2 负样本：`const hrErrorStatus = hrStatusForCode` 别名式「收敛」丢甄别 ⇒ 必须 throw */
const HR_MAP_SAMPLE_ALIAS = [
  "import { createHrService, HrError, hrStatusForCode } from './hrService';",
  '  const hrErrorStatus = hrStatusForCode;',
].join('\n');

/** 半收敛负样本：一边委托真源、一边还留着自己的码规则（两份真源并存）⇒ 必须 throw */
const HR_MAP_SAMPLE_HALF_CONVERGED = [
  "import { hrStatusForCode } from './hrService';",
  '  function hrErrorStatus(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  "    if (err.code === 'VALIDATION_FAILED') return 400;",
  '    return hrStatusForCode(err.code);',
  '  }',
].join('\n');

/** ★ 复审 F5 负样本：委托干净、但数字兜底被重新挂在委托上 ⇒ 判为半收敛（不是 converged） */
const HR_MAP_SAMPLE_REATTACHED_FALLBACK = [
  "import { createHrService, HrError, hrStatusForCode } from './hrService';",
  '  function hrErrorStatus(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  '    return hrStatusForCode(err.code) || 500;',
  '  }',
].join('\n');

/** 委托了真源却没 import（本地捏了个同名假函数）⇒ 必须 throw，不能让「同名即真源」蒙混 */
const HR_MAP_SAMPLE_NO_IMPORT = [
  '  function hrErrorStatus(err: any): number {',
  "    if (!(err instanceof HrError)) return 500;",
  '    return hrStatusForCode(err.code);',
  '  }',
].join('\n');

/** ★ B22 relay 终态正样本：整层删除、出口全走 safeRouteError、抛出物仍是 HrError ⇒ converged */
const HR_MAP_SAMPLE_RELAY = [
  "import { createHrService, HrError, hrStatusForBareCode } from './hrService';",
  "import { safeRouteError } from '../shared/routeError';",
  "      throw new HrError('VALIDATION_FAILED', '必填');",
  '      const r = safeRouteError(err, { fallbackCode: HR_PROBE_FAILED });',
  '      res.status(r.status).json({ ok: false, error: r.code, message: r.message });',
].join('\n');

/** relay 形态下把状态规则写回路由（字面量表复活）⇒ 不许判成 converged */
const HR_MAP_SAMPLE_RELAY_WITH_TABLE = [
  "import { safeRouteError } from '../shared/routeError';",
  "  const HTTP: Record<string, number> = { VALIDATION_FAILED: 400, RUN_NOT_FOUND: 404 };",
  "      throw new HrError('VALIDATION_FAILED', '必填');",
  '      const r = safeRouteError(err, { fallbackCode: HR_PROBE_FAILED });',
].join('\n');

/** relay 形态但抛出物不再是 HrError（改抛裸 Error ⇒ 业务码全退化成 500）⇒ 必须 throw */
const HR_MAP_SAMPLE_RELAY_NO_HRERROR = [
  "import { safeRouteError } from '../shared/routeError';",
  '      const r = safeRouteError(err, { fallbackCode: HR_PROBE_FAILED });',
].join('\n');

/** 只 import 不调用（假终态：看着像收敛，实际出口还在原处）⇒ 必须 throw */
const HR_MAP_SAMPLE_RELAY_NO_CALL = [
  "import { safeRouteError } from '../shared/routeError';",
  "      throw new HrError('VALIDATION_FAILED', '必填');",
].join('\n');

/**
 * 解析失败一律 **throw** —— 「静默返回 `{}` / `[]`」会让下面的比对恒绿，
 * 而那正是本条守卫要防的失效形态（抽取器自己不咬 = 守卫等于没有）。
 */
function parseRouteHrErrorStatus(src: string, label = 'hr/route.ts'): ParsedRouteMap {
  const body = /\bfunction\s+hrErrorStatus\b[^{]*\{([\s\S]*?)\n\s*\}/.exec(src)?.[1];
  if (body === undefined) {
    if (CONVERGED_IMPORT_RE.test(src)) {
      // 函数整个被删、调用点直接引真源：仍须保住「非 HrError → 500」甄别（陷阱 2）
      if (!INSTANCEOF_GUARD_RE.test(src)) {
        throw new Error(
          `${label}: 已 import 真源但全文找不到 instanceof HrError ⇒ `
          + `「非 HrError → 500」的甄别被丢（别名式收敛），未知异常会在 catch 里炸 TypeError`,
        );
      }
      return { converged: true };
    }
    // ★ B22 终态：整层删除、状态由 HrError.statusCode 携带、出口全部走 safeRouteError
    if (isRelayOnly(src)) {
      if (LEFTOVER_RULE_RE.test(stripComments(src))) {
        throw new Error(
          `${label}: 已改成 safeRouteError 直传，但全文仍留有「码字面量 → 状态」形态 ⇒ 第二份真源长回来了`,
        );
      }
      if (!/new HrError\(/.test(src)) {
        throw new Error(
          `${label}: relay 终态下路由不再推状态，抛出物必须仍是 HrError（statusCode 由类默认值出自真源）；`
          + `没有 new HrError( 说明有人改抛裸 Error ⇒ 业务码会全部退化成 500`,
        );
      }
      if ((src.match(RELAY_CALL_RE) ?? []).length === 0) {
        throw new Error(`${label}: import 了 safeRouteError 却一处没调用 ⇒ 假终态`);
      }
      return { converged: true };
    }
    throw new Error(
      `${label}: 既找不到 function hrErrorStatus，也没有「改引 hrStatusForCode」的 import、`
      + `也没有 safeRouteError 直传的 relay 终态 ⇒ `
      + `映射被改名/搬走/删成字面量了。本条守卫必须人工复核，不许静默放行。`,
    );
  }
  // Task 4b 终态：函数保留、规则委托真源 —— 但必须「委托得干净」且「import 是真的」
  if (DELEGATES_TRUTH_RE.test(body)) {
    if (LEFTOVER_RULE_RE.test(body)) {
      throw new Error(
        `${label}: hrErrorStatus 既委托 hrStatusForCode 又留有自己的码规则 / 在委托上重挂数字兜底 ⇒ 半收敛 = 两份真源并存`,
      );
    }
    if (!INSTANCEOF_GUARD_RE.test(body)) {
      throw new Error(
        `${label}: hrErrorStatus 委托了真源却没有 instanceof HrError 甄别 ⇒ 非 HrError 的 undefined.code 会在 catch 里炸（陷阱 2）`,
      );
    }
    if (!CONVERGED_IMPORT_RE.test(src)) {
      throw new Error(
        `${label}: hrErrorStatus 调用了 hrStatusForCode，却没从 './hrService' import ⇒ 可能是本地同名假函数`,
      );
    }
    return { converged: true };
  }
  // 过渡期形态（副本未删）：逐行抽出码规则 + 兜底，交给下面的逐码比对
  const rules: RouteRule[] = [];
  const bareReturns: number[] = [];
  for (const line of body.split('\n')) {
    const eq = /^\s*if\s*\(\s*err\.code === '([A-Z_0-9]+)'\s*\)\s*return\s+(\d+)\s*;/.exec(line);
    if (eq) { rules.push({ kind: 'equals', code: eq[1], status: Number(eq[2]) }); continue; }
    const suf = /^\s*if\s*\(\s*err\.code\.endsWith\(\s*'([A-Z_0-9]+)'\s*\)\s*\)\s*return\s+(\d+)\s*;/.exec(line);
    if (suf) { rules.push({ kind: 'suffix', suffix: suf[1], status: Number(suf[2]) }); continue; }
    // 只认「整行就是 return N;」的那一条当兜底：`if (!(err instanceof HrError)) return 500;`
    // 是以 `if` 开头的守卫行（非 HrError 根本不参与本比对），不当规则、也不当兜底
    const bare = /^\s*return\s+(\d+)\s*;\s*$/.exec(line);
    if (bare) bareReturns.push(Number(bare[1]));
  }
  if (rules.length === 0) {
    throw new Error(`${label}: hrErrorStatus 函数体里解析到 0 条形如 err.code === 'X' return N 的规则 ⇒ 抽取器已失效`);
  }
  if (bareReturns.length !== 1) {
    throw new Error(`${label}: hrErrorStatus 必须有且只有一条兜底 return，实得 ${JSON.stringify(bareReturns)}`);
  }
  return { rules, fallback: bareReturns[0] };
}

/** 按解析出的规则算状态（行的先后即优先级，与 JS 的 if 顺序一致） */
function statusFromRouteMap(parsed: ParsedRouteMap, code: string): number {
  if ('converged' in parsed) return hrStatusForCode(code);
  for (const r of parsed.rules) {
    if (r.kind === 'equals' && r.code === code) return r.status;
    if (r.kind === 'suffix' && code.endsWith(r.suffix)) return r.status;
  }
  return parsed.fallback;
}

/** 路由副本 vs 真源的差异清单（空 = 两份同值） */
function routeMapDiffers(parsed: ParsedRouteMap, codes: string[]): string[] {
  if ('converged' in parsed) return [];
  return codes
    .map((c) => ({ c, route: statusFromRouteMap(parsed, c), truth: hrStatusForCode(c) }))
    .filter((x) => x.route !== x.truth)
    .map((x) => `${x.c}: 路由给 ${x.route} / 真源给 ${x.truth}`);
}

describe('★ 跨文件真源核对：hr/route.ts 的映射逐码必须等于 hrStatusForCode', () => {
  const routeSrc = () => fs.readFileSync(path.join(SRC, 'hr', 'route.ts'), 'utf8');

  /** HR 域**实际外发**的码集：从抛出点扫出来，不手抄（手抄的那份会变成第二个真源） */
  function hrCodesActuallyThrown(): string[] {
    const out = new Set<string>();
    for (const abs of walkTs(path.join(SRC, 'hr'))) {
      for (const m of fs.readFileSync(abs, 'utf8').matchAll(/new HrError\(\s*'([A-Z_0-9]+)'/g)) out.add(m[1]);
    }
    return [...out].sort();
  }

  it('抽取器不是摆设：路由真身必须解析出 ≥2 条码规则 + 恰好 1 条兜底（或已是收敛终态）', () => {
    const src = routeSrc();
    const parsed = parseRouteHrErrorStatus(src);
    if ('converged' in parsed) {
      // 两种终态都算 converged，各自的成立条件在这里复核（不是逃生门：
      // 不成立时上面的 parse 已经 throw，这里只是把「终态到底长成什么样」写清楚）
      if (isRelayOnly(src)) {
        // B22 relay：路由不再推状态，出口整层委托 safeRouteError
        expect(RELAY_ONLY_IMPORT_RE.test(src)).toBe(true);
        expect((stripComments(src).match(RELAY_CALL_RE) ?? []).length,
          'relay 终态下 safeRouteError 调用数不得为 0').toBeGreaterThan(0);
      } else {
        // Task 4b 已完成的形态：路由不再自己写映射、改引真源 ⇒ 核对「import 确实在 + 甄别确实还在」。
        expect(CONVERGED_IMPORT_RE.test(src)).toBe(true);
        expect(src, '终态里「非 HrError → 500」的甄别必须仍在（陷阱 2）').toMatch(INSTANCEOF_GUARD_RE);
      }
      return;
    }
    expect(parsed.rules.length, '规则数 < 2 ⇒ 只解析到一支，比对会被漏掉的那支蒙过去').toBeGreaterThanOrEqual(2);
    expect(parsed.rules.filter((r) => r.kind === 'equals').length).toBe(1);
    expect(parsed.rules.filter((r) => r.kind === 'suffix').length).toBe(1);
  });

  it('★ 正向对照 1：映射被改名/删掉且未改引真源 ⇒ 抽取器必须 throw（不许静默返回空表）', () => {
    // 全部用合成样本，不依赖路由今天的写法（否则 Task 4b 改完形态，这几条会误报）
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_RENAMED, 'sample(改名)'))
      .toThrow(/既找不到 function hrErrorStatus/);
    expect(() => parseRouteHrErrorStatus('export const x = 1;', 'sample(删除)')).toThrow(/人工复核/);
    // 函数还在、但规则被换成别的写法（读别的字段 / 只剩兜底）⇒ 也必须 throw，而不是抽出空表让比对恒绿
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_NO_RULES, 'sample(无规则)')).toThrow(/0 条/);
    // 两条兜底 return ⇒ 不猜哪条算兜底，直接 throw
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_TWO_DEFAULTS, 'sample(双兜底)')).toThrow(/只有一条兜底/);
    // ★ Task 4b 陷阱 2 的钉子：别名式「收敛」丢掉非 HrError 甄别 ⇒ 必须 throw，不许当 converged 放行
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_ALIAS, 'sample(别名)')).toThrow(/instanceof HrError/);
    // ★ 半收敛（委托 + 自己的码规则并存 = 两份真源）⇒ 必须 throw
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_HALF_CONVERGED, 'sample(半收敛)')).toThrow(/半收敛/);
    // ★ 复审 F5：委托上重挂数字兜底（`hrStatusForCode(err.code) || 500`）⇒ 也必须 throw，
    //    否则「把 500 兜底偷偷搬回调用方」这种形状会被判成 converged（F2 就是这么长出来的）
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_REATTACHED_FALLBACK, 'sample(兜底复发)'))
      .toThrow(/半收敛/);
    // LEFTOVER_RULE_RE 自己不是一条恒假正则：拿四种坏形状逐一证明它会咬（真身必须一条都不咬，见上两条）
    for (const bad of [HR_MAP_SAMPLE_HALF_CONVERGED, HR_MAP_SAMPLE_REATTACHED_FALLBACK]) {
      expect(/\bfunction\s+hrErrorStatus\b[^{]*\{([\s\S]*?)\n\s*\}/.exec(bad)![1]).toMatch(LEFTOVER_RULE_RE);
    }
    expect(HR_MAP_SAMPLE_CONVERGED.match(/\bfunction\s+hrErrorStatus\b[^{]*\{([\s\S]*?)\n\s*\}/)![1])
      .not.toMatch(LEFTOVER_RULE_RE);
    // ★ 调用了 hrStatusForCode 却没 import ⇒ 同名假函数也必须 throw
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_NO_IMPORT, 'sample(无import)')).toThrow(/假函数/);
    // 终态正向：规则删净 + instanceof 甄别保留 + 改引真源 ⇒ 不 throw，判为 converged
    expect(parseRouteHrErrorStatus(HR_MAP_SAMPLE_CONVERGED, 'sample(已收敛)')).toEqual({ converged: true });
  });

  it('★ 正向对照 2：路由副本若漂移，比对必须判出（证明逐码等值那条不是恒真）', () => {
    const parsed = parseRouteHrErrorStatus(HR_MAP_SAMPLE_DRIFTED, 'sample(漂移)');
    const diff = routeMapDiffers(parsed, ['VALIDATION_FAILED', 'RUN_NOT_FOUND', 'INVALID_TRANSITION']);
    expect(diff, '漂移都没被判出 ⇒ 这组守卫是恒真的').toEqual([
      'VALIDATION_FAILED: 路由给 403 / 真源给 400',
      'RUN_NOT_FOUND: 路由给 500 / 真源给 404',
    ]);
    // 反向：收敛终态（副本删掉、改引真源）不该误报
    expect(routeMapDiffers({ converged: true }, ['RUN_NOT_FOUND'])).toEqual([]);
  });

  /** ★ 复审 F3：这条以前把两件事写在一条里（sanity + 政策），且标题只提了前者 */
  const hrThrownTiers = () => [...new Set(hrCodesActuallyThrown().map(hrStatusForCode))].sort((a, b) => a - b);

  it('HR 实际抛出的码集覆盖三档（抽样非空 sanity：否则下面的档位比对会被空样本蒙过）', () => {
    const codes = hrCodesActuallyThrown();
    expect(codes.length).toBeGreaterThanOrEqual(3);
    // 只钉「档位数量 ≥3」这一件事：码集若被压成一档 / 普查抽风成空集，这里先红，
    // 政策那条就不会拿着空样本「等于三个档位」地恒过。
    expect(hrThrownTiers().length, '档位 < 3 ⇒ 三档比对失去意义（先修普查再谈政策）').toBeGreaterThanOrEqual(3);
  });

  it('★ 政策钉子（F3）：HR 真源对**实际抛出的码**只允许返回 {400, 404, 409} 三档', () => {
    // ★ 这是一条**政策**断言，不是恒真事实：Task 4b 之前 `hrStatusForCode` 结构上只能返回这三档
    // （那时写 [400,404,409] 是同义反复）；收口后真源还登记了 401/403/500 三支码
    // （`UNAUTHORIZED`/`FORBIDDEN`/`INTERNAL_ERROR`，服务 `dissolveTeam` 的裸码），
    // 所以「HR 抛出点用不到它们」现在是一个**结论**而不是**构造**。
    // 若这条变红，含义只有两种，都必须重新裁定、不许顺手改期望值：
    //   ① 有人给真源加/改了一条规则，把某支实际抛出的码答成了**新的一档**（401/403/500 之一）——
    //      例：`CAPACITY_FULL` 被改成 403（名额满不是权限问题，改错即红）；
    //   ② HR 域新抛出了一支认证/授权/内部错码（401/403/500 档进了抛出码集）—— 那说明 HR 开始
    //      用业务异常表达「没登录」或「服务炸了」，属于 G6.5 之上的口径变化，要走裁定，不是本文件能自批的。
    expect(hrThrownTiers()).toEqual([400, 404, 409]);
  });

  it('★ 正向对照 3（B22 relay 终态）：真终态判 converged，四种"看着像终态"必须 throw', () => {
    // 真终态：整层删除 + 出口走 safeRouteError + 抛出物仍是 HrError
    expect(parseRouteHrErrorStatus(HR_MAP_SAMPLE_RELAY, 'sample(relay)')).toEqual({ converged: true });
    // 终态里长出第二张码表 ⇒ 不许被 relay 支放行
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_RELAY_WITH_TABLE, 'sample(relay+码表)'))
      .toThrow(/第二份真源长回来了/);
    // 抛出物不再是 HrError（裸 Error 直抛 ⇒ 状态规则整体失效）
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_RELAY_NO_HRERROR, 'sample(relay 无 HrError)'))
      .toThrow(/new HrError/);
    // import 了却不调用 = 假终态
    expect(() => parseRouteHrErrorStatus(HR_MAP_SAMPLE_RELAY_NO_CALL, 'sample(relay 无调用)'))
      .toThrow(/假终态/);
    // 反面对照：relay 判据不能顺手把 4b 的委托形态也认成 relay（那支有 hrStatusForCode 引用）
    expect(isRelayOnly(HR_MAP_SAMPLE_CONVERGED)).toBe(false);
    expect(isRelayOnly(HR_MAP_SAMPLE_RENAMED)).toBe(false);
  });

  it('★ 逐码同值：hr/route.ts 的映射 == hrStatusForCode == HrError 默认 statusCode', () => {    const codes = hrCodesActuallyThrown();
    const parsed = parseRouteHrErrorStatus(routeSrc());
    expect(routeMapDiffers(parsed, codes), '两份副本漂移 ⇒ Task 4b 要并的那张表已经不一致了').toEqual([]);
    // 这一支钉的是「类的默认值真的接到了真源上」（构造器里那个 `= hrStatusForCode(code)` 被换成
    // 写死的数、或改成另一张表时，这里红）；它**不是**上面那条的替代品 —— 路由那份副本只能由上条管。
    for (const code of codes) {
      expect(new HrError(code, '探针文案').statusCode, `${code} 的类默认状态与真源不一致`).toBe(hrStatusForCode(code));
    }
  });
});

describe('ReleaseGateError：私有原生生产者与结果边界独立核定', () => {
  const source = () => fs.readFileSync(path.join(SRC, 'production/releaseService.ts'), 'utf8');
  const inspect = async (probe: { kind: string; code?: string; status?: number }) => {
    const src = source();
    const ast = ts.createSourceFile('releaseService.ts', src, ts.ScriptTarget.Latest, true);
    const names = ['ReleaseGateError', 'knownReleaseFailure', 'storageReleaseConflict', 'createReleaseScope'];
    const declarations = names.map(name => {
      const matches = ast.statements.filter(node => (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node))
        && node.name?.text === name);
      expect(matches, `${name} 的实际本地绑定须唯一`).toHaveLength(1);
      return matches[0].getText(ast).replace(/^export\s+/, '');
    });
    const failure = ast.statements.find(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'fail'));
    expect(failure).toBeDefined();
    const script = `${failure!.getText(ast)}\n${declarations.join('\n')}\n
      async function run(input:any){
        const error = input.kind === 'native' ? new ReleaseGateError(input.code, '独立放行业务拒绝。', input.status)
          : input.kind === 'development' ? new DevelopmentDomainError('CONFLICT', '开发来源已变化。')
          : input.kind === 'conflict' ? {code:'P2034',message:'SQL private_scope'}
          : input.kind === 'fake' ? Object.assign(new Error('SQL private_scope P2003'), {name:'ReleaseGateError', code:'SCOPE_NOT_ACTIVE', statusCode:409})
          : new Error('SQL private_scope P2003');
        const result = await createReleaseScope({prisma:{orderLine:{findUnique:async()=>({id:'L1',orderId:'O1'})},
          $transaction:async()=>{throw error}},orderId:'O1',orderLineId:'L1',input:{quantity:1},actorId:'U1'});
        return {result,known:knownReleaseFailure(error)};
      }
      run(probe);`;
    const compiled = ts.transpileModule(script, { compilerOptions: {
      module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    // Only selected actual declarations run; storage is a rejection seam, not PG.
    return vm.runInNewContext(compiled, { probe, DevelopmentDomainError, ReleaseBatchBindingError, ProductionBatchFactsError, OrderLineWriteError, releaseQuantity, isBusinessError, safeRouteError,
      Prisma: { PrismaClientKnownRequestError: class extends Error {} },
      logger: { error() {} } }, { timeout: 1000 });
  };

  it.each([['ORDER_LINE_NOT_FOUND', 404], ['SCOPE_NOT_ACTIVE', 409]] as const)(
    '%s 原生实例按其独立业务状态消费，并保留公开文案', async (code, status) => {
      const { result, known } = await inspect({ kind: 'native', code, status });
      expect(result).toEqual({ ok: false, error: { code, status, message: '独立放行业务拒绝。' } });
      expect(known).toEqual(result);
    });
  it('实际来源冲突与序列化冲突保留409', async () => {
    expect((await inspect({ kind: 'development' })).result).toEqual({
      ok: false, error: { code: 'CONFLICT', status: 409, message: '开发来源已变化。' },
    });
    expect((await inspect({ kind: 'conflict' })).result).toEqual({ ok: false, error: {
      code: 'CONFLICT', status: 409, message: '放行范围或来源正在变化，请保留原请求并刷新重试',
    } });
  });
  it.each(['sql', 'fake'])('%s 不能满足原生消费边界，只返回安全500', async kind => {
    const rejected = await inspect({ kind });
    expect(rejected.known).toBeNull();
    expect(rejected.result).toEqual({ ok: false, error: { code: 'SCOPE_CREATE_FAILED', status: 500,
      message: '创建放行范围未能完成，请稍后重试；持续失败请联系管理员核对该订单行的放行范围与拆批记录。',
    } });
    expect(JSON.stringify(rejected)).not.toMatch(/SQL|private_scope|P2003/);
  });
  it('当前构造器是开放code/status私有契约，不可登记成有限raw-message豁免', () => {
    const src = source();
    expect(src).toMatch(/class ReleaseGateError extends Error \{\s*constructor\(readonly code: string, message: string, readonly statusCode: number\)/);
    expect(src).toMatch(/if \(error instanceof ReleaseGateError \|\| error instanceof DevelopmentDomainError\) return fail\(error.code, error.message, error.statusCode\)/);
    expect(classifyPrivateResultBoundaries([{ file: 'src/production/releaseService.ts', src }])
      .some((proof: { className: string }) => proof.className === 'ReleaseGateError')).toBe(false);
  });
});

describe('★ 全仓 error class 普查：所有类逐个核定，新增类必须先登记', () => {
  /** 原核定不删；V1 五个原生公共类有上方独立字面量证人及隔离业务回归。 */
  const ADJUDICATED = [
    'CreditBlockedError', 'CrmValidationError', 'FabricCalcValidationError', 'GateBlockedError',
    'HrError', 'RoleWriteRejectedError', 'SealValidationError', 'StageGateError',
    'StockMovementCasConflictError', 'SsrfBlockedError', 'TemplateNotFoundError', 'TemplateRenderError',
    'CreditExceptionConsumptionError', 'InventoryStockInsufficientError', 'ClaimVisibilityError', 'CashRefundError',
    'ClaimTransactionError', 'CreditNoteTransactionError', 'ApprovalDecisionError', 'ReceiptMatchProposalError',
    'DemandError', 'PurchaseServiceDeliveryError',
    'OrderLineWriteError', 'WorkflowError', 'PricingDomainError',
    'ProformaCommandError',
    'DevelopmentDomainError', 'ProformaAccessError', 'PurchaseOrderDomainError', 'ReceiptDomainError', 'QcAssignmentError',
    'ManualInvoiceAbort', 'CommissionAbort', // Source-bound TX-result contracts below; no public/raw exemption.
    'ReleaseGateError', // Private open contract: independent native consumer controls above; no finite exemption.
    'ProductionBatchFactsError', 'ReleaseBatchBindingError',
  ];

  it('类清单必须等于核定表（多一个 = 有人新增没想清楚，少一个 = 表要更新）', () => {
    const names: string[] = [];
    for (const abs of walkTs(SRC)) {
      for (const m of fs.readFileSync(abs, 'utf8').matchAll(/class ([A-Za-z_$][\w$]*) extends Error/g)) {
        names.push(m[1]);
      }
    }
    expect([...new Set(names)].sort()).toEqual([...ADJUDICATED].sort());
  });

  /**
   * 未导出的 3 个类只能按源码文本核定。这里只钉真正危险的那一条：
   * `StockMovementCasConflictError` 的消息里嵌了 **itemId**（`库存余额并发冲突（itemId=…）`），
   * 属于内部标识 —— 它必须**保持不带 code/statusCode**，一旦有人「顺手补个契约」，
   * 内部标识就会伪装成业务文案直达屏幕。
   *
   * 另两个类**本来就带**契约，核定结论是「保留、不动」（不在此加断言钉死，避免把
   * 「内部三类一律不带契约」这个并不成立的假设写成钉子）：
   *   · `CreditBlockedError` 自带 code=CREDIT_BLOCKED + statusCode=409，由
   *     `quotationRoute.ts:561` 读 statusCode 答 409 —— 信用门禁阻断是真实业务冲突，不是服务端故障；
   *   · `RoleWriteRejectedError` 的 statusCode/code 由构造器强制（非法角色 400 / 越权授 SuperAdmin 403），
   *     由 `admin/route.ts:534` 的 instanceof 分支读 statusCode 作答；逃出该分支才落到
   *     `admin/route.ts:49` 的 withRouteErrorGuard —— 那里恒答 500、**不读** statusCode。
   */
  it('CreditNoteTransactionError 仅用于事务回滚，必须由结果边界消费且不能伪装为公共业务错误', () => {
    const src = stripComments(fs.readFileSync(path.join(SRC, 'claims/creditNoteService.ts'), 'utf8'));
    const body = /class CreditNoteTransactionError extends Error \{[\s\S]*?\n\}/.exec(src)?.[0];
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/statusCode/);
    expect(body).not.toMatch(/readonly code/);
    expect(src).toMatch(/if \(error instanceof CreditNoteTransactionError\) return fail\(error\.creditNoteError\.code, error\.creditNoteError\.message\)/);
    expect(safeRouteError(new Error('private SQL detail'), { fallbackCode: 'INTERNAL_ERROR' }))
      .toMatchObject({ status: 500, code: 'INTERNAL_ERROR', passthrough: false, message: GENERIC_ROUTE_ERROR_MESSAGE });
  });

  it('ClaimTransactionError 的四种业务结果与实际 HTTP 契约一致', () => {
    const expected = [['NOT_FOUND', 404], ['VALIDATION_FAILED', 400], ['INVALID_STATE', 409], ['UNSUPPORTED_KIND', 422]] as const;
    for (const [code, status] of expected) {
      const result = safeRouteError(new ClaimTransactionError({ code, message: '独立探针业务文案' }), { fallbackCode: 'INTERNAL_ERROR' });
      expect(result).toMatchObject({ code, status, message: '独立探针业务文案', passthrough: true });
    }
  });

  it('StockMovementCasConflictError 不得携带 code/statusCode（其消息含 itemId，属内部标识）', () => {
    const src = fs.readFileSync(path.join(SRC, 'inventory/inventoryService.ts'), 'utf8');
    const body = /class StockMovementCasConflictError extends Error \{[\s\S]*?\n\}/.exec(src)?.[0];
    expect(body, '类体找不到 = 该类被改名或搬走，核定表要更新').toBeTruthy();
    expect(body).not.toMatch(/statusCode/);
    expect(body).not.toMatch(/\bcode\b/);
  });
});

describe('ProformaCommandError：内部事务拒绝须由实际结果边界消费', () => {
  const source = () => fs.readFileSync(path.join(SRC, 'finance/proformaInvoiceService.ts'), 'utf8');
  const entries = (src = source()) => [{ file: 'src/finance/proformaInvoiceService.ts', src },
    { file: 'src/shared/routeError.ts', src: fs.readFileSync(path.join(SRC, 'shared/routeError.ts'), 'utf8') }];
  const witness = () => {
    const proof = classifyPrivateResultBoundaries(entries()).find((p: { className: string }) => p.className === 'ProformaCommandError');
    expect(proof).toBeTruthy(); return proof!;
  };
  it('有限构造器、instanceof结果消费、两处真实catch及unknown安全结果全部在场', () => {
    const proof = witness();
    expect(proof.codes).toEqual(['NOT_FOUND', 'QUOTATION_NOT_FOUND', 'QUOTATION_NOT_ACCEPTED', 'NOT_PROFORMA',
      'ALREADY_CONVERTED', 'INVALID_STATUS', 'SEQUENCE_FAILED', 'LC_GATE_BLOCKED', 'LC_EXCEPTION_CHECK_FAILED', 'INTERNAL_ERROR']);
    expect(proof.producerLines).toHaveLength(1); expect(proof.catchLines).toHaveLength(2);
    expect(proof.producer).toBe('reject'); expect(proof.consumer).toBe('failure');
    expect(proof.constructorSource).not.toContain('statusCode');
  });
  // Only the extracted native class/reject/failure run. The actual shared safe
  // adapter is injected; logging is disabled. Neither the service nor PG runs.
  const inspect = (probeInput: Record<string, unknown>) => {
    const proof = witness();
    const source = `${proof.constructorSource}\n${proof.producerSource}\n${proof.consumerSource}\n
      function inspect(input:any){let caught:any;
        if(input.kind==='native'){try{${proof.producer}(input.code,input.message)}catch(error){caught=error}}
        else caught=input.error;
        return {result:${proof.consumer}(caught,input.mode),direct:safeRouteError(caught,{fallbackCode:'INTERNAL_ERROR'})};
      }
      inspect(probeInput);`;
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;
    return vm.runInNewContext(compiled, { probeInput, safeRouteError, ProformaAccessError, logger: { error() {} } }, { timeout: 1000 });
  };
  it.each(['NOT_FOUND', 'SEQUENCE_FAILED'])('本地 %s 保留结果码/文案，但不可直接冒充公共HTTP类', code => {
    const result = inspect({ kind: 'native', code, message: '独立事务拒绝文案。', mode: 'generate' });
    expect({ ok: result.result.ok, code: result.result.error.code, message: result.result.error.message })
      .toEqual({ ok: false, code, message: '独立事务拒绝文案。' });
    expect(result.direct).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, passthrough: false, message: GENERIC_ROUTE_ERROR_MESSAGE });
  });
  it.each(['generate', 'convert'])('%s 未知SQL/同名假类不能继承内部拒绝文案', mode => {
    const error = { name: 'ProformaCommandError', code: 'NOT_FOUND', message: 'SQL private_table 不存在' };
    const result = inspect({ kind: 'unknown', error, mode });
    expect({ ok: result.result.ok, code: result.result.error.code, message: result.result.error.message }).toEqual({
      ok: false, code: 'INTERNAL_ERROR', message: mode === 'generate'
        ? '形式发票生成结果暂不可确认，请刷新核对原发票记录后重试。'
        : '形式发票转正结果暂不可确认，请刷新核对原形式发票及正式发票后重试。',
    });
    expect(result.direct.status).toBe(500);
    expect(JSON.stringify(result)).not.toMatch(/SQL|private_table/);
  });
  it('移除实际instanceof消费或catch调用，内部登记证明必须失效', () => {
    const noTypeGuard = source().replace('error instanceof ProformaCommandError) return', 'true) return');
    const noCatch = source().replaceAll("return failure(error, 'generate')", 'return null')
      .replaceAll("return failure(error, 'convert')", 'return null');
    expect(classifyPrivateResultBoundaries(entries(noTypeGuard))).toHaveLength(0);
    expect(classifyPrivateResultBoundaries(entries(noCatch))).toHaveLength(0);
  });
});

describe('★ 委托的安全前提：调用点的 fallbackCode 不得是表里的 4xx', () => {
  /**
   * Task 4 把 `safeRouteError` 的「未预期异常」那一支也交给注册表 ⇒ 若某个调用点把
   * 表里状态为 **4xx** 的码当兜底码，一次数据库故障就会被悄悄答成 4xx（收敛前恒为 500）。
   * 兜底码的语义是「这次失败是我没预料到的」⇒ 它只能是表外的码、或表内的 5xx 码。
   *
   * 真要引入 4xx 兜底码，就得把码名加进下面的显式清单并说明「该调用点的 catch 分支里
   * 确实只可能是客户端错误」—— 加了码却答不出这句话，该改的是调用点而不是这里。
   */
  const FOUR_XX_FALLBACKS_ALLOWED: string[] = [];

  it.each(['SIGN_FAILED', 'QC_REPORT_DOCUMENT_FAILED'])(
    '新增QC出口%s：实际原生拒绝保留，未知SQL和同名假类安全500', fallbackCode => {
      const native = safeRouteError(qcReportFailure(new QcReportError('FORBIDDEN', '当前账号不能处理此报告。')),
        { fallbackCode, fallbackMessage: '报告操作结果暂不可确认，请刷新后核对。' });
      expect(native).toMatchObject({ status: 403, code: 'FORBIDDEN', passthrough: true,
        message: '当前账号不能处理此报告。' });
      const unknown = safeRouteError(qcReportFailure({ name: 'QcReportError', code: 'FORBIDDEN',
        statusCode: 403, message: 'SQL private_report P2003' }),
      { fallbackCode, fallbackMessage: '报告操作结果暂不可确认，请刷新后核对。' });
      expect(unknown).toMatchObject({ status: 500, code: fallbackCode, passthrough: false,
        message: '报告操作结果暂不可确认，请刷新后核对。' });
      expect(JSON.stringify(unknown)).not.toMatch(/SQL|private_report|P2003/);
    });

  /** 扫描正则只写一次（自检与普查共用，避免两份正则各坏各的） */
  function fallbackHits(code: string): string[] {
    return [...code.matchAll(/safeRouteError\([\s\S]{0,220}?fallbackCode:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  }

  /**
   * ★ 第二支（Task 5 复审 F3）：直接把兜底码交给 `resolveError(<标识符>, 'CODE')` 的调用点。
   *   它和 safeRouteError 一样危险 —— 表里那个码是 4xx，一次数据库故障就被答成 4xx。
   *   只扫第一支时，全仓这一处（`lib/asyncHandler.ts:70` 的 `'INTERNAL_ERROR'`）根本不在分母里。
   */
  function resolveErrorFallbackHits(code: string): string[] {
    return [...code.matchAll(/\bresolveError\(\s*[A-Za-z_$][\w$]*\s*,\s*'([A-Z0-9_]+)'\s*,?\s*\)/g)].map((m) => m[1]);
  }

  /**
   * ★ 第三支：「中继 helper」清单 —— 码写在**调用点**，交给注册表那一行在**别处**。
   *   risk 收敛后正是这个形状：20 个 `handleError(res, e, 'X_FAILED')` 调用点，helper 内部
   *   `resolveError(e, code)`（`risk/riskRoute.ts:103`）把形参原样转交注册表 ⇒ 前两支**一处都扫不到**，
   *   risk 的 20 个兜底码于是从这条红线的分母里静默消失
   *   （把 `shared/errorCodes.ts:41` 的 `ALERT_LIST_FAILED` 改成 400，旧普查照样全绿）。
   *   每条 = 一个已核对「该形参确实被原样交给 resolveError」的文件；下面那条自检就是为这条声称存在的
   *   （新增中继、却没在目标文件里留下 `resolveError(<ident>, <该形参>)` 这一行 ⇒ 自检红），
   *   所以它不是一张随手抄近的白名单。
   */
  const RELAY_HELPERS: Array<{ file: string; param: string; re: RegExp }> = [
    {
      file: 'risk/riskRoute.ts',
      param: 'code',
      re: /handleError\(\s*res\s*,\s*[A-Za-z_$][\w$]*\s*,\s*'([A-Z0-9_]+)'\s*,?\s*\)/g,
    },
    // 阳性对照（2026-09-20 实跑，非推演）：往本清单加一条 param 不相符的条目 ⇒ 第二腿红「中继清单过期」；
    // 加一条正则匹配不到任何站点的条目 ⇒ 第一腿红「空转的中继清单」。两条都会被下面那个循环抓到。
  ];

  function relayHits(relay: { re: RegExp }, code: string): string[] {
    return [...code.matchAll(relay.re)].map((m) => m[1]);
  }

  type FallbackHit = { file: string; code: string; via: 'safeRouteError' | 'resolveError' | 'relay' };

  /** 全仓生产调用点的兜底码普查（剥注释后扫，三支合计） */
  function scanFallbackCallSites(): FallbackHit[] {
    const hits: FallbackHit[] = [];
    for (const abs of walkTs(SRC)) {
      const src = stripComments(fs.readFileSync(abs, 'utf8'));
      const file = path.relative(SRC, abs).split(path.sep).join('/');
      for (const code of fallbackHits(src)) hits.push({ file, code, via: 'safeRouteError' });
      for (const code of resolveErrorFallbackHits(src)) hits.push({ file, code, via: 'resolveError' });
      for (const relay of RELAY_HELPERS) {
        if (file !== relay.file) continue;
        for (const code of relayHits(relay, src)) hits.push({ file, code, via: 'relay' });
      }
    }
    return hits;
  }

  it('普查到的 fallbackCode 全部为「表外码」或「表内 5xx 码」', () => {
    const hits = scanFallbackCallSites();
    const viaSafe = hits.filter((h) => h.via === 'safeRouteError');
    const viaDirect = hits.filter((h) => h.via === 'resolveError');
    const viaRelay = hits.filter((h) => h.via === 'relay');
    // ★ M-1：原来是 `toBeGreaterThan(20)` —— 80 处里 60 处失配照样绿，等于没钉。
    //   现在钉**精确数**（Task 4 与评审各自独立数到的同一份：80 处调用点 / 20 个文件 / 35 个不同兜底码）。
    //   精确计数还顺带补上扫描自身的弱点：漏写 `fallbackCode:` 字面量（例如改传变量）的调用点
    //   会被正则**静默丢掉**（或被下一处吃掉），只有精确数才能把「扫不到了」变成红的。
    //   新增调用点请把这个数改对 —— 棘轮口径同 `routeError.test.ts` 的 FROZEN_RAW_ERROR_LEAKS：
    //   「改数」本身就是一次显式确认，而不是留一个松阈值让覆盖率往下掉没人知道。
    // ★ 2026-09-20（§9 B22 第 1、2 个域收敛）：80 → 116 → **143** 处 / 35 → 70 → **78** 码。
    //   第 2 域 `finance/route.ts` 再 +27 处 / +8 码（12 枚码名里 4 枚与既有域重名，故 distinct 只 +8）；
    //   第 3 域 `seasons/seasonRouteV2.ts` +22 处 / **码数不变**（22 处共用同一枚 `INTERNAL_ERROR`）⇒ 165 处 / 78 码，
    //   第 4 域 `suppliers/factoryRouteV2.ts` +19 处（共用 INTERNAL_ERROR，码数不变）；
    //   第 5 域 `shipping/route.ts` +21 处，本域用到 12 枚码名（LIST/CREATE/UPDATE/SHIP/RECALC/STATS/…），
    //     其中 5 枚与既有域重名 ⇒ 全局 distinct 只 +7（78 → 85）⇒ 205 / 85，三支合计 226 / 105。
    //   每个数都由独立脚本量过（不是把上一批的数加加减减推出来的）。
    //   差额**只**来自 `hr/route.ts` 的 36 处 `message: err.message` 改接 safeRouteError
    //   （35 个新兜底码，一支不复用），其余文件一处未动 —— 独立脚本量过，不是 80+36 推出来的。
    // Fixed b7586f05 immutable census: 352 safe consumers, 196 distinct; all original 4xx fallback refusals retained.
    // Prior eaca22f9 339/195 remains in source-readings; new consumers are source changes, not a loosened safety rule.
    // Added adapters retain the unchanged registered-4xx negative guard below.
    // 2037ad14 fixed census: six actual consumers added (development 1,
    // finance 3, procurement 2). Their snippets are preserved in source-readings;
    // REVIEW_FAILED is unregistered safe-500; INTERNAL_ERROR is registered 500.
    // The unchanged registered-4xx rejection below validates every consumer.
    // f886194c adds Agent QC sign + native customs QC adapter. Exact old/new
    // source readings retain both snippets; unknown storage remains safe 500.
    // Fixed 408a300e immutable AST census: 12 actual consumers added, no retired
    // sites; safe 374/201, all 395/221. Eight registered INTERNAL_ERROR500;
    // four unknown codes keep safe500 with domain-specific Chinese fallback copy.
    // Exact source diff/evidence records each addition; unchanged registered-4xx
    // rejection and every scanner counterexample below remain mandatory.
    // 7832f54b exact complete source replay: safe384/202;all405/222;direct1/relay20.
    // Old066 actual381 -> current405 is +26/-2 semantic tuples;74 line moves.
    // No fallback policy or original registered-4xx rejection is changed.
    // Exact da9448 source replay retains all 405 original7832 semantic tuples:
    // seven documented consumers added, no retirement; safe391/all412.
    expect(viaSafe.length, 'safeRouteError 调用点处数与基线不符（新增未登记 / 扫描正则失效）').toBe(393);
    // 299 → 306：v3.03 B42·A1 净收七站（customsRouteV2 5 + quotationRoute 2；两审批站刻意不收，见 quotationCopyB42 文件头）
    // 288 → 299：S0-A2 第 10 批复核补的 11 处（首版按形状只数了 14 处，见 docs/S0-A2第10批…§五）
    expect(new Set(viaSafe.map((h) => h.code)).size, '不同兜底码的个数与基线不符').toBe(202);
    // 160 → 171：第 10 批复核补的 11 处各用一枚**全新**码名（EMAIL_LIST/PATCH/DETAIL_FAILED、IMAP_* 6 枚、ATTACHMENT_DOWNLOAD_FAILED）⇒ 净 +11
    // ★ F3：分母从「只扫 safeRouteError」扩成三支 ⇒ 下面三个数与 `toBe(116)/toBe(70)` 是**同一口径的分支账**，
    //   不是把 116/70 改小或改松：safeRouteError 那 116 处 / 70 码一个字没动，
    //   新增的是 `resolveError` 直调 1 处（asyncHandler 的 INTERNAL_ERROR，本就混在里面）
    //   与 risk 的中继 20 处 / 20 码（Task 5 摘豁免后才出现的支路，旧正则扫不到）。
    //   合计 226 处 / 105 码 = 红线现在真正看着的面。少一处的唯一后果就是「有一批兜底码不在照妖镜里」。
    expect(viaDirect.length, 'resolveError 直调兜底码处数与基线不符（扫描正则失效 / 新增未登记）').toBe(1);
    expect(viaRelay.length, '中继（handleError → resolveError）处数与基线不符 = risk 的码掉出普查分母').toBe(20);
    expect(new Set(viaRelay.map((h) => h.code)).size, 'risk 的中继兜底码必须仍是 20 个不同码').toBe(20);
    expect(hits.length, '全仓兜底码调用点总数（三支合计）').toBe(414);
    /**
     * ★ 复核 B-1（也是我自己的现量）：这里原先钉 **196**，旁边写着"实测，非推算"，而尺自报 **195**
     *   （隔离单跑**确定性**复现同一红 ⇒ 不是偶发）。196 是按注释里那句"八站"推出来的，**那一版这条用例没跑过**。
     *   对账：并集 = safe 支 **175** 枚（上面那条）+ risk 中继 **20** 枚，直调那 1 处是既有 `INTERNAL_ERROR` ⇒ **195**。
     *   ⇒ **站点数 ≠ 码名数**：本批收 7 站，但只有 **4 枚全新码名**（报关四站各一枚；`/documents` 列表与报价两站复用 `INTERNAL_ERROR`）。
     */
    expect(new Set(hits.map((h) => h.code)).size, '全仓不同兜底码总数（三支合计）').toBe(222);
    const bad = hits.filter(({ code }) => {
      const spec = lookupErrorCode(code);
      return spec !== undefined && spec.status < 500 && !FOUR_XX_FALLBACKS_ALLOWED.includes(code);
    });
    expect(bad, `这些兜底码会把服务端故障答成 4xx：${JSON.stringify(bad)}`).toEqual([]);
  });

  /**
   * ★ F3 的阳性对照（照本文件 M-1/M-2 的双向口径）：新增两支持续正则**认得真写法**、
   * **不吃注释**、**不把变量当码**，并且「risk 的 20 个码在分母里」这件事本身是可核对的。
   * 少了这一条，「普查已覆盖 risk」就只是一句没法证伪的话。
   */
  it('★ 守卫自检（Task 5 复审 F3，勿与上面 Task 4 那条同名 F3 混）：resolveError 支与中继支认得真站点、不吃注释、不把中继声称写成假覆盖', () => {
    const sample = [
      "const a = resolveError(e, 'DIRECT_ONE');",
      'const b = resolveError(',
      '  err,',
      "  'DIRECT_MULTILINE',",
      ');',
      "// const c = resolveError(e, 'DIRECT_LINE_COMMENTED');",
      "/* const d = resolveError(e, 'DIRECT_BLOCK_COMMENTED'); */",
      "const g = resolveError(e, code);", // 变量：这一支扫不到（由中继支按文件白名单负责）
      'const h = resolveError(e, opts.fallbackCode);', // 属性访问：同上
      "handleError(res, e, 'RELAY_ONE');",
      "// handleError(res, e, 'RELAY_ONE_LINE_COMMENTED');",
      "/* handleError(res, e, 'RELAY_BLOCK_COMMENTED'); */",
    ].join('\n');
    // resolveError 支：不剥注释会把两处示例算进去（与第一支同一口径的已知假红源）
    expect(resolveErrorFallbackHits(sample)).toEqual(['DIRECT_ONE', 'DIRECT_MULTILINE', 'DIRECT_LINE_COMMENTED', 'DIRECT_BLOCK_COMMENTED']);
    expect(resolveErrorFallbackHits(stripComments(sample))).toEqual(['DIRECT_ONE', 'DIRECT_MULTILINE']);
    // 中继支：正例 + 注释不参与 + 变量写法不吃。
    // 注：合成样例与 risk 的调用写法绑定；若往 RELAY_HELPERS 里加**另一种写法**的中继，须为它补一对合成样例。
    // 下面那个逐条循环只保证「每条清单的声称都为真、且不是空转条目」，不能替代这一对正反对照。
    const relay = RELAY_HELPERS[0];
    expect(relayHits(relay, sample)).toEqual(['RELAY_ONE', 'RELAY_ONE_LINE_COMMENTED', 'RELAY_BLOCK_COMMENTED']);
    expect(relayHits(relay, stripComments(sample))).toEqual(['RELAY_ONE']);
    // ★ 真站点（不是合成串）：全仓那 1 处 resolveError 直调字面量兜底码
    expect(
      resolveErrorFallbackHits(stripComments(fs.readFileSync(path.join(SRC, 'lib/asyncHandler.ts'), 'utf8'))),
    ).toEqual(['INTERNAL_ERROR']);
    // ★ risk 的 20 个码确实在普查分母里（少一个 = 该文件的写法变了，中继支该更新）
    expect(
      new Set(relayHits(relay, stripComments(fs.readFileSync(path.join(SRC, relay.file), 'utf8')))).size,
    ).toBe(20);
    // ★ 中继声称必须为真，且**逐条**核：只查 `[0]` 的话，日后往清单里加第二条中继，
    //   它就带着「形参原样交给 resolveError」的声称进了红线分母，而这条声称从未被核过 ——
    //   那正是本条自检要防的假覆盖。空转条目（真文件里一处都匹配不到）也在这里红掉。
    for (const entry of RELAY_HELPERS) {
      const src = stripComments(fs.readFileSync(path.join(SRC, entry.file), 'utf8'));
      expect(relayHits(entry, src).length, `${entry.file} 是一条空转的中继清单（正则匹配不到任何站点）`)
        .toBeGreaterThan(0);
      expect(
        src,
        `中继清单过期：${entry.file} 里已不存在把形参 ${entry.param} 交给 resolveError 的那一行，` +
          '兜底码普查不能再算它（要么改调用点形状，要么把这条从清单里删掉）',
      ).toMatch(new RegExp(`resolveError\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*${entry.param}\\s*,?\\s*\\)`));
    }
  });

  /**
   * ★ 守卫自检（双向，照 `routeError.test.ts:188-207` 的口径）：
   * 光有精确计数还不够 —— 正则哪天被改坏（例如丢了 `[\s\S]{0,220}?`），计数掉到 0 时
   * 只说「与基线不符」，分不清是「扫不到」还是「真少了」。这里用合成样本正反各钉一次。
   */
  it('★ 守卫自检：扫描正则认得真调用点（含多行写法），且不把注释里的示例算进去', () => {
    const sample = [
      "const a = safeRouteError(e, { fallbackCode: 'REAL_ONE' });",
      "// const b = safeRouteError(e, { fallbackCode: 'LINE_COMMENTED' });",
      "/* const c = safeRouteError(e, { fallbackCode: 'BLOCK_COMMENTED' }); */",
      'const d = safeRouteError(e, {',
      "  fallbackCode: 'REAL_TWO',",
      "  fallbackMessage: '多行写法也要扫到',",
      '});',
      "const f = safeRouteError(e, { fallbackMessage: '这一处漏写了兜底码' });",
    ].join('\n');
    // 不剥注释会把两处示例算成调用点（4 处）—— 这就是 routeError.test.ts 已经踩过的假红
    expect(fallbackHits(sample)).toEqual(['REAL_ONE', 'LINE_COMMENTED', 'BLOCK_COMMENTED', 'REAL_TWO']);
    // 剥完只剩两处真调用点；正则退化成恒不匹配 ⇒ 这一行当场红
    expect(fallbackHits(stripComments(sample))).toEqual(['REAL_ONE', 'REAL_TWO']);
    // 反向：漏写兜底码的写法不该被计入（它逃过本条，但会被上面的 toBe(205) 抓住）
    expect(fallbackHits("const g = safeRouteError(e, { fallbackMessage: '无兜底码' });")).toEqual([]);
  });
});
