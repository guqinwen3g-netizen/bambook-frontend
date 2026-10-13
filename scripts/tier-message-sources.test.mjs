import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTierMessageSources, legacyTierMessageSources, classifyPrivateSymbolRefusals, classifyPrivateResultBoundaries } from './lib/tierMessageSources.mjs';

// Synthetic source only: no backend module, database or external action executes.
const central = { file: 'src/shared/errorCodes.ts', src: `
export function businessError(code:string,message:string){
  const spec=lookupErrorCode(code); if(!spec) throw new Error('码未登记');
  return Object.assign(new Error(message), {code,statusCode:spec.status});
}` };
const hr = { file: 'src/hr/hrService.ts', src: `
export class HrError extends Error {
  readonly code:string; readonly statusCode:number;
  constructor(code:string,message:string,statusCode=hrStatusForCode(code)){
    super(message);this.code=code;this.statusCode=statusCode;
  }
}` };
const stage = { file: 'src/production/stageService.ts', src: `
export class StageGateError extends Error {
  constructor(public code:string,message:string,public statusCode=409){super(message)}
}` };
const words = report => report.publicLiterals.filter(row => row.file === 'src/probe.ts').map(row => row.message).sort();
const scan = src => scanTierMessageSources([central, hr, stage, { file: 'src/probe.ts', src }]);

test('plain/message-first/code-first constructors have their actual message positions', () => {
  const report = scan(`import {HrError as H} from './hr/hrService';
    import {StageGateError} from './production/stageService';
    class Validation extends Error{constructor(message:string,public code='VALIDATION_FAILED',public statusCode=400){super(message)}}
    throw new Error('普通文案'); throw new H('INVALID_TRANSITION','请假状态不可决定');
    throw new StageGateError('ORDER_NOT_FOUND','生产订单不存在'); throw new Validation('金额无效');`);
  assert.deepEqual(words(report), ['普通文案', '生产订单不存在', '金额无效', '请假状态不可决定'].sort());
  assert.ok(!words(report).includes('ORDER_NOT_FOUND'));
  assert.equal(report.typedContracts.filter(row => row.file === 'src/probe.ts').length, 3);
});
test('actual central import aliases and re-exports resolve, not the spelling of the callee', () => {
  const report = scanTierMessageSources([central, { file: 'src/barrel.ts', src: "export {businessError as refused} from './shared/errorCodes';" },
    { file: 'src/probe.ts', src: "import {refused as x} from './barrel'; throw x('NOT_FOUND','准确目标不存在');" }]);
  assert.deepEqual(words(report), ['准确目标不存在']);
  assert.equal(report.typedContracts.find(row => row.file === 'src/probe.ts').code, 'NOT_FOUND');
});
test('same-name local function cannot impersonate the central businessError binding', () => {
  const report = scan("function businessError(code,message){return new Error(code)}; throw businessError('ACTUAL_MESSAGE','不能误采第二参');");
  assert.deepEqual(words(report), ['ACTUAL_MESSAGE']);
  assert.equal(report.typedContracts.filter(row => row.file === 'src/probe.ts').length, 0);
});
test('central factory message/code positions come from its actual return binding, not fixed offsets', () => {
  const reversed = { ...central, src: central.src.replace('code:string,message:string', 'message:string,code:string') };
  const report = scanTierMessageSources([reversed, { file: 'src/probe.ts', src:
    "import {businessError} from './shared/errorCodes'; throw businessError('按真实签名采集','NOT_FOUND');" }]);
  assert.deepEqual(words(report), ['按真实签名采集']);
  assert.equal(report.typedContracts.find(row => row.file === 'src/probe.ts').code, 'NOT_FOUND');
});
test('parameter shadowing cannot inherit a trusted imported factory', () => {
  const report = scan("import {businessError} from './shared/errorCodes'; function run(businessError){throw businessError('CONFLICT','不能假认')} ");
  assert.deepEqual(words(report), []);
  assert.ok(report.unresolved.some(row => row.file === 'src/probe.ts' && row.expression.includes('businessError')));
});
test('shadowed Error is unresolved rather than assumed to be the native Error constructor', () => {
  const report = scan("function Error(x){return x}; throw new Error('并非原生错误');");
  assert.deepEqual(words(report), []);
  assert.equal(report.unresolved.filter(row => row.file === 'src/probe.ts').length, 1);
});
test('known inherited message and canonical businessError-backed super(message) are resolved', () => {
  const report = scan(`import {businessError} from './shared/errorCodes';
    class Inherited extends Error{readonly code='STOCK_INSUFFICIENT';readonly statusCode=409;}
    class Canonical extends Error{readonly code='CONFLICT';readonly statusCode=409;
      constructor(code:string,message:string){const classified=businessError(code,message);super(classified.message)}}
    throw new Inherited('实际库存不足'); throw new Canonical('CONFLICT','来源已变化');`);
  assert.deepEqual(words(report), ['实际库存不足', '来源已变化'].sort());
});
test('implicit/explicit subclass super forwarding retains a bound code-first parent signature', () => {
  const report = scan(`import {HrError} from './hr/hrService';
    class Implicit extends HrError{}; class Explicit extends HrError{constructor(code:string,message:string){super(code,message)}};
    throw new Implicit('INVALID_TRANSITION','继承真实文案'); throw new Explicit('NOT_FOUND','显式转发文案');`);
  assert.deepEqual(words(report), ['继承真实文案', '显式转发文案'].sort());
});
test('object-message constructor resolves the actual supplied message property', () => {
  const report = scan(`class ResultError extends Error{readonly code='INVALID_STATE';readonly statusCode=409;
    constructor(readonly result:{code:string,message:string}){super(result.message)}}
    throw new ResultError({code:'INVALID_STATE',message:'原批准已失效'});`);
  assert.deepEqual(words(report), ['原批准已失效']);
});
test('single-expression error factories retain caller literals and default arguments', () => {
  const report = scan(`class DecideError extends Error{constructor(public code:string,message:string,public statusCode:number){super(message)}}
    function reject(code:string,message:string,status=409):never{throw new DecideError(code,message,status)}
    const missing=(message:string)=>new DecideError('NOT_FOUND',message,404);
    reject('CONFLICT','原决定已存在'); throw missing('来源不存在');`);
  assert.deepEqual(words(report), ['原决定已存在', '来源不存在'].sort());
});
test('dynamic/interpolated/missing messages, unknown constructors and rethrows stay unresolved', () => {
  const report = scan("throw new Error(value); throw new Error(`动态 ${id}`); throw new Error(); throw new UnknownError('未知签名'); throw caught;");
  const unresolved = report.unresolved.filter(row => row.file === 'src/probe.ts');
  assert.equal(unresolved.length, 5);
  assert.deepEqual(words(report), []);
  assert.ok(unresolved.some(row => row.expression.includes('UnknownError')));
  assert.equal(report.accounting.total, ['public-message', 'typed-contract', 'internal', 'unresolved']
    .reduce((sum, key) => sum + report.accounting[key], 0));
});
test('multiline/escaped/noninterpolated template literals remain real source literals', () => {
  const report = scan("throw new Error(\n '跨行文案'\n); throw new Error('引号\\\'文案'); throw new Error(`静态模板`);");
  assert.deepEqual(words(report), ['跨行文案', "引号'文案", '静态模板'].sort());
});
test('comments and example strings cannot become producer sites', () => {
  const report = scan("// throw new Error('注释例子');\nconst example=\"throw new Error('字符串例子')\";");
  assert.equal(report.inventory.filter(row => row.file === 'src/probe.ts').length, 0);
});
test('audited internal template identities are inventoried and never promoted into public messages', () => {
  const report = scanTierMessageSources([{ file: 'src/templates/render.ts', src:
    "export class TemplateNotFoundError extends Error{constructor(id:string){super(`Template not found: ${id}`)}}; throw new TemplateNotFoundError('private-template');" }]);
  assert.equal(report.internal.length, 1); assert.equal(report.publicLiterals.length, 0);
  assert.equal(report.internal[0].internalReason, 'internal-template-id');
});
test('unknown custom untyped classes require adjudication instead of an assumed public constructor signature', () => {
  const report = scan("class UndecidedError extends Error{constructor(id:string){super(id)}}; throw new UndecidedError('私有标识');");
  assert.deepEqual(words(report), []);
  assert.ok(report.unresolved.some(row => row.reason === 'unadjudicated-class-contract'));
});
test('historical regex remains an independent raw meter with its documented code-as-message defect', () => {
  const entries = [hr, { file: 'src/probe.ts', src: "import {HrError} from './hr/hrService'; throw new HrError('INVALID_TRANSITION','真正文案');" }];
  assert.deepEqual(legacyTierMessageSources(entries).map(row => row.message), ['INVALID_TRANSITION']);
  assert.deepEqual(scanTierMessageSources(entries).publicLiterals.map(row => row.message), ['真正文案']);
});

const privateSource = `
const PRIVATE = Symbol('private-refusal');
const COPY = {NOT_FOUND:'来源不存在',CONFLICT:'原请求已变化'} as const;
function refuse(code:keyof typeof COPY):never{throw Object.assign(new Error(COPY[code]),{[PRIVATE]:code});}
function run(){try{work()}catch(error){
  const refusal:keyof typeof COPY|undefined=error?.[PRIVATE];
  if(refusal && Object.prototype.hasOwnProperty.call(COPY,refusal)){
    const publicCopy=\`\${refusal}: \${COPY[refusal]}\`;
    return {ok:false,committed:false,error:publicCopy};
  }
}}
`;
test('private Symbol requires a finite copy producer plus a guarded failed-result consumer', () => {
  const [witness] = classifyPrivateSymbolRefusals(privateSource);
  assert.ok(witness); assert.deepEqual(witness.keys, ['NOT_FOUND', 'CONFLICT']);
  assert.ok(witness.setupSource.includes("Symbol('private-refusal')"));
  assert.ok(witness.consumerSource.includes('hasOwnProperty'));
});
for (const [name, mutation] of [
  ['public string discriminant', src => src.replace("Symbol('private-refusal')", "'private-refusal'")],
  ['exported marker', src => src.replace('const PRIVATE', 'export const PRIVATE')],
  ['missing finite membership check', src => src.replace('Object.prototype.hasOwnProperty.call(COPY,refusal)', 'true')],
  ['unknown copy spread', src => src.replace("CONFLICT:'原请求已变化'", "...unknown")],
  ['no explicit keyof finite parameter', src => src.replace('code:keyof typeof COPY', 'code:string')],
  ['mutable copy contents', src => src + "\nCOPY.CONFLICT='覆写';"],
  ['arbitrary potential mutation', src => src + '\nexternal(COPY);'],
  ['raw caught message output', src => src.replace('error:publicCopy', 'error:error.message')],
  ['success result', src => src.replace('ok:false', 'ok:true')],
  ['committed result', src => src.replace('committed:false', 'committed:true')],
  ['foreign marker read', src => src.replace('error?.[PRIVATE]', 'error?.[OTHER]')],
  ['shadowed Object membership', src => 'const Object=external;\n'+src],
]) test(`private refusal negative control: ${name} stays in unclassified B34 debt`, () => {
  assert.equal(classifyPrivateSymbolRefusals(mutation(privateSource)).length, 0);
});
test('private producer is retained once in the internal inventory, not lost from the denominator', () => {
  const report = scanTierMessageSources([{ file: 'src/probe.ts', src: privateSource }]);
  assert.equal(report.internal.filter(row => row.internalReason === 'private-finite-refusal').length, 1);
  assert.ok(report.inventory.some(row => row.origin === 'private-refusal'));
});

const safeModule = { file: 'src/shared/routeError.ts', src: 'export function safeRouteError(error,opts){return {status:500,message:opts.fallbackMessage}}' };
const wrappedSource = `import {safeRouteError} from './shared/routeError';
type Refusal='NOT_FOUND'|'INVALID_STATE';
class NativeResultError extends Error{constructor(readonly code:Refusal,message:string){super(message)}}
function reject(code:Refusal,message:string):never{throw new NativeResultError(code,message)}
function failure(error:unknown){
  if(error instanceof NativeResultError)return {ok:false,error:{code:error.code,message:error.message}};
  const safe=safeRouteError(undefined,{fallbackCode:'INTERNAL_ERROR',fallbackMessage:'未知结果不可确认'});
  return {ok:false,error:{code:'INTERNAL_ERROR',message:safe.message}};
}
function work(){try{store()}catch(error){return failure(error)}}
reject('NOT_FOUND','真实来源不存在');`;
const wrappedEntries = src => [safeModule, { file: 'src/probe.ts', src }];
test('private result wrapper is proved from finite producers, native instance consumer and actual catch/unknown boundary', () => {
  const [proof] = classifyPrivateResultBoundaries(wrappedEntries(wrappedSource));
  assert.ok(proof); assert.equal(proof.className, 'NativeResultError');
  assert.deepEqual(proof.codes, ['NOT_FOUND', 'INVALID_STATE']); assert.equal(proof.catchLines.length, 1);
  const report = scanTierMessageSources(wrappedEntries(wrappedSource));
  assert.ok(report.internal.some(row => row.internalReason === 'private-result-boundary'));
  assert.ok(report.publicLiterals.some(row => row.publicResultMessage && row.message === '真实来源不存在'));
});
for (const [name, mutation] of [
  ['exported class', src => src.replace('class NativeResultError', 'export class NativeResultError')],
  ['unbounded constructor code', src => src.replace('readonly code:Refusal', 'readonly code:string')],
  ['removed instanceof', src => src.replace('error instanceof NativeResultError', 'true')],
  ['unknown error raw message', src => src.replace("code:'INTERNAL_ERROR',message:safe.message", "code:'INTERNAL_ERROR',message:error.message")],
  ['missing actual catch caller', src => src.replace('return failure(error)', 'return null')],
  ['public status field', src => src.replace('extends Error{constructor', 'extends Error{readonly statusCode=409;constructor')],
  ['foreign safe function binding', src => src.replace('function failure(error:unknown)', 'function failure(error:unknown,safeRouteError:any)')],
]) test(`private result negative control: ${name} cannot be exempted by class spelling`, () => {
  assert.equal(classifyPrivateResultBoundaries(wrappedEntries(mutation(wrappedSource))).length, 0);
});
