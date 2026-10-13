#!/usr/bin/env node
// Read-only source inventory for acceptance design. Never imports application
// handlers, opens a database, executes tests, or treats source presence as pass.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.argv[2] || 'artifacts/acceptance-20261001/source');
if (!output.startsWith(root + path.sep)) throw new Error('Output must stay inside this checkout');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inputs = new Map();
function source(file) {
  const value = read(file);
  inputs.set(file, digest(value));
  return ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const git = args => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tracked = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const codeFiles = tracked.filter(file => /\.(tsx?|[cm]?js)$/.test(file)
  && !/(^|\/)(node_modules|out|dist|archive)\//.test(file));
const unknown = node => ({ unresolvedExpression: node.getText().slice(0, 160) });

function enumValues(sf, name) {
  const statement = sf.statements.find(node => ts.isEnumDeclaration(node) && node.name.text === name);
  if (!statement) throw new Error('Missing enum ' + name);
  return Object.fromEntries(statement.members.map(member => {
    if (!member.initializer || !ts.isStringLiteral(member.initializer)) throw new Error('Nonliteral enum');
    return [member.name.getText(sf), member.initializer.text];
  }));
}
const view = enumValues(source('types.ts'), 'View');

// Only evaluates literal data expressions. Call expressions remain unresolved.
function constants(sf, globals = {}) {
  const nodes = new Map(), memo = new Map(), active = new Set();
  for (const statement of sf.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) nodes.set(declaration.name.text, declaration.initializer);
    }
  }
  function get(name) {
    if (name in globals) return globals[name];
    if (memo.has(name)) return memo.get(name);
    if (!nodes.has(name)) return { unresolvedIdentifier: name };
    if (active.has(name)) throw new Error('Cyclic literal ' + name);
    active.add(name); const value = evaluate(nodes.get(name)); active.delete(name); memo.set(name, value); return value;
  }
  function property(node) {
    if (ts.isComputedPropertyName(node)) return evaluate(node.expression);
    return node.text ?? node.getText(sf);
  }
  function evaluate(node) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)
      || ts.isSatisfiesExpression(node)) return evaluate(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) return get(node.text);
    if (ts.isPropertyAccessExpression(node)) return evaluate(node.expression)?.[node.name.text] ?? unknown(node);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(item => ts.isSpreadElement(item) ? evaluate(item.expression) : [evaluate(item)]);
    if (ts.isObjectLiteralExpression(node)) {
      const result = {};
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) {
          const spread = evaluate(item.expression);
          if (!spread || spread.unresolvedExpression || spread.unresolvedIdentifier) throw new Error('Unresolved spread');
          Object.assign(result, spread);
        } else if (ts.isPropertyAssignment(item)) {
          const key = property(item.name);
          if (typeof key !== 'string') throw new Error('Unresolved object key');
          result[key] = evaluate(item.initializer);
        } else if (ts.isShorthandPropertyAssignment(item)) result[item.name.text] = get(item.name.text);
      }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left), right = evaluate(node.right);
      if (typeof left === 'string' && typeof right === 'string') return left + right;
    }
    return unknown(node);
  }
  return { get, nodes };
}

const front = constants(source('lib/rolePermissionMatrix.ts'), { View: view });
const sharedView = enumValues(source('server/src/_shared/_typesView.ts'), 'View');
const back = constants(source('server/src/_shared/rolePermissionMatrix.ts'), { View: sharedView });
const policies = constants(source('lib/modulePermissions.ts'), { View: view }).get('VIEW_POLICY_OVERRIDES');
const scopeMap = front.get('VIEW_TO_MAIN_SCOPES');
const roleIds = front.get('SYSTEM_ROLE_IDS'), roles = front.get('SYSTEM_ROLE_META');
const defaults = front.get('DEFAULT_ROLE_PERMISSION_MATRIX');
const dataScopes = front.get('DEFAULT_DATA_SCOPE_BY_ROLE');
const allScopes = [...new Set(Object.values(defaults).flatMap(value => Object.keys(value)))].sort();
const roleScopeRows = [];
for (const [roleId, role] of Object.entries(roles)) for (const scope of allScopes) {
  roleScopeRows.push({ role_id: roleId, role_name: role.name, scope,
    declared_default: roleId === roleIds.SUPER_ADMIN || defaults[roleId]?.[scope] === true ? 'allow' : 'deny',
    basis: roleId === roleIds.SUPER_ADMIN ? 'source super-admin bypass' : 'source default only',
    business_expectation: '待与岗位规则核对', runtime_result: '未测' });
}
const registry = constants(source('components/moduleRegistry.ts'), { View: view });
const modules = registry.get('BAMBOOK_MODULES').map(module => ({
  id: module.id, label: module.productLabel, view: module.view, entry: module.entry.current,
  nav: module.nav, subViews: module.subViews || [],
  declaredPolicy: policies[module.view] || { policy: 'permission', required: scopeMap[module.view]?.read },
  declaredScopes: scopeMap[module.view] || {}, sourceStatus: 'registered', runtimeStatus: '未完成验收',
}));
if (modules.some(module => !fs.existsSync(path.join(root, module.entry)))) throw new Error('Missing registered entry');
const moduleRoleRows = [];
for (const module of modules) for (const [roleId, role] of Object.entries(roles)) {
  const gate = module.declaredPolicy;
  const declared = gate.policy === 'public-authenticated' || roleId === roleIds.SUPER_ADMIN
    || defaults[roleId]?.[gate.required] === true;
  moduleRoleRows.push({ module_id: module.id, label: module.label, role_id: roleId, role_name: role.name,
    read_policy: gate.policy, read_scope: gate.required || '', source_default_entry: declared ? 'allow' : 'deny',
    extra_nav_role_gate: module.nav.adminOnly ? 'owner/admin navigation condition also applies' : '',
    business_expectation: '待核对', runtime_result: '未测' });
}

// DMMF is generated structural metadata; loading it creates no PrismaClient.
const { Prisma } = require(path.join(root, 'server/node_modules/@prisma/client'));
const schema = read('server/prisma/schema.prisma');
inputs.set('server/prisma/schema.prisma', digest(schema));
const schemaModels = [...schema.matchAll(/^model (\w+) \{/gm)].map(match => match[1]);
const models = Prisma.dmmf.datamodel.models;
if ([...schemaModels].sort().join('|') !== models.map(model => model.name).sort().join('|')) throw new Error('Schema/client model names differ');
const schemaBlocks = new Map([...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(match => [match[1], match]));
const designFiles = tracked.filter(file => file.startsWith('docs/design/02-数据模型/') && file.endsWith('.md'));
const designText = designFiles.map(file => [file, read(file)]);
for (const [file, text] of designText) inputs.set(file, digest(text));
const modelRows = [], fieldRows = [], relations = [];
for (const model of models) {
  const block = schemaBlocks.get(model.name);
  const schemaFields = block[2].split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//') && !line.startsWith('@'))
    .map(line => line.match(/^(\w+)\s+([\w\[\]?]+)/)).filter(Boolean);
  if (schemaFields.map(field => field[1]).sort().join('|') !== model.fields.map(field => field.name).sort().join('|')) throw new Error('Schema/client fields differ: ' + model.name);
  for (const field of model.fields) {
    const declared = schemaFields.find(item => item[1] === field.name)[2];
    if (declared.replace(/[\[\]?]/g, '') !== field.type || declared.endsWith('[]') !== field.isList
      || !declared.endsWith('?') !== field.isRequired) throw new Error('Schema/client type or nullability differs: ' + model.name + '.' + field.name);
  }
  const stateFields = model.fields.filter(field => field.kind === 'scalar' && /(status|state|stage|phase|decision|result)/i.test(field.name)).map(field => field.name);
  modelRows.push({ model: model.name, schema_line: schema.slice(0, block.index).split('\n').length,
    fields: model.fields.length, state_field_candidates: stateFields.join(';'),
    declared_indexes_constraints: block[2].split('\n').map(line => line.trim()).filter(line => /^@@(index|unique|id|map)/.test(line)).join(';'),
    design_mentions: designText.filter(([, text]) => new RegExp('\\b' + model.name + '\\b').test(text)).map(([file]) => file).join(';'),
    business_scope: '待逐模型关联需求', validation_status: '未测' });
  for (const field of model.fields) {
    fieldRows.push({ model: model.name, field: field.name, type: field.type, kind: field.kind,
      required: field.isRequired, list: field.isList, id: field.isId, unique: field.isUnique,
      has_default: field.hasDefaultValue, updated_at: field.isUpdatedAt,
      relation_from: (field.relationFromFields || []).join(';'), relation_to: (field.relationToFields || []).join(';'),
      business_constraint_status: '待定义正反断言', test_result: '未测' });
    if (field.kind === 'object') relations.push({ from_model: model.name, field: field.name, to_model: field.type,
      from_fields: (field.relationFromFields || []).join(';'), to_fields: (field.relationToFields || []).join(';'),
      cardinality: field.isList ? 'many' : field.isRequired ? 'required-one' : 'optional-one',
      note: 'schema declared relation only; logical ID links need separate business mapping', runtime_result: '未测' });
  }
}

const mounts = [], routes = [], tests = [], controls = [], visualElements = [], sourceImports = {};
const http = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const resolvedImport = (file, specifier) => {
  if (!specifier.startsWith('.')) return '';
  const base = path.normalize(path.join(path.dirname(file), specifier));
  return [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx'].map(suffix => base + suffix)]
    .find(candidate => fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()) || '';
};
function literal(node) { return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : ''; }
function callableName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return callableName(node.expression) + '.' + node.name.text;
  if (ts.isCallExpression(node)) return callableName(node.expression);
  return '';
}
for (const file of codeFiles) {
  const sf = source(file), imports = [], names = {};
  const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
  const testDeclarations = [];
  const sourceReadPaths = new Set();
  function readPath(node) {
    if (!node) return '';
    if (ts.isNewExpression(node) && node.expression.getText(sf) === 'URL') return resolvedImport(file, literal(node.arguments?.[0]));
    if (ts.isCallExpression(node) && /^(path\.)?(resolve|join)$/.test(callableName(node.expression))
      && node.arguments[0]?.getText(sf) === '__dirname') {
      const parts = node.arguments.slice(1).map(literal);
      if (parts.length && parts.every(Boolean)) {
        const candidate = path.normalize(path.join(path.dirname(file), ...parts));
        return fs.existsSync(path.join(root, candidate)) ? candidate : '';
      }
    }
    return '';
  }
  for (const statement of sf.statements) if (ts.isImportDeclaration(statement)) {
    const specifier = literal(statement.moduleSpecifier), resolved = resolvedImport(file, specifier);
    imports.push({ specifier, resolved });
    const binding = statement.importClause;
    if (binding?.name) names[binding.name.text] = resolved;
    if (binding?.namedBindings && ts.isNamedImports(binding.namedBindings)) {
      for (const element of binding.namedBindings.elements) names[element.name.text] = resolved;
    }
  }
  sourceImports[file] = imports;
  function visit(node, owner = '') {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text || owner;
    if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) owner = node.name.getText(sf);
    if (ts.isCallExpression(node)) {
      const name = callableName(node.expression), first = literal(node.arguments[0]);
      if (isTest && /(^|\.)(readFileSync|readFile)$/.test(name)) {
        const target = readPath(node.arguments[0]);
        if (target) sourceReadPaths.add(target);
      }
      if (isTest && /^(it|test)(\.|$)/.test(name) && first) testDeclarations.push({ line: lineOf(sf, node), name: first, form: name });
      if (file.startsWith('server/') && !isTest && ts.isPropertyAccessExpression(node.expression) && first.startsWith('/')) {
        const receiver = node.expression.expression.getText(sf), method = node.expression.name.text.toLowerCase();
        if (http.has(method)) routes.push({ file, line: lineOf(sf, node), owner_function: owner,
          receiver, method: method.toUpperCase(), relative_path: first, full_path_status: 'mount resolution required', runtime_result: '未测' });
        if (method === 'use') {
          const handler = node.arguments.find((arg, index) => index > 0 && (ts.isCallExpression(arg) || ts.isIdentifier(arg)));
          const factory = handler ? callableName(handler) : '';
          mounts.push({ file, line: lineOf(sf, node), owner_function: owner, receiver, prefix: first,
            factory, factory_file: names[factory] || '', runtime_result: '未测' });
        }
      }
    }
    if (!isTest && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const tag = node.tagName.getText(sf);
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const classAttr = attrs.find(attr => attr.name.getText(sf) === 'className');
      const styleAttr = attrs.find(attr => attr.name.getText(sf) === 'style');
      const element = ts.isJsxElement(node.parent) ? node.parent : node;
      const directText = ts.isJsxElement(element) ? element.children.filter(ts.isJsxText)
        .map(child => child.text.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' / ') : '';
      visualElements.push({ id: file + ':' + lineOf(sf, node) + ':' + node.getStart(sf), file, line: lineOf(sf, node),
        tag, owner_function: owner, direct_literal_text: directText.slice(0, 240),
        class_expression: classAttr?.initializer?.getText(sf).slice(0, 500) || '',
        style_expression: styleAttr?.initializer?.getText(sf).slice(0, 400) || '',
        visual_status: '源码声明；BDS及实际渲染待核验' });
      const events = attrs.filter(attr => /^on(Click|Submit|Change|Select|Confirm|Save|Delete|Close)$/.test(attr.name.getText(sf)));
      if (events.length || /^(button|input|select|textarea)$/.test(tag) || /Button$/.test(tag)) {
        const parent = ts.isJsxElement(node.parent) ? node.parent : node;
        const text = [];
        function label(child) {
          if (ts.isJsxText(child) && child.text.trim()) text.push(child.text.trim().replace(/\s+/g, ' '));
          if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) text.push(child.text);
          ts.forEachChild(child, label);
        }
        if (ts.isJsxElement(parent)) parent.children.forEach(label);
        const conditions = [];
        for (let ancestor = parent.parent; ancestor; ancestor = ancestor.parent) {
          if (ts.isConditionalExpression(ancestor)) conditions.push(ancestor.condition.getText(sf).slice(0, 160));
          if (ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
            conditions.push(ancestor.left.getText(sf).slice(0, 160));
        }
        controls.push({ id: file + ':' + lineOf(sf, node) + ':' + node.getStart(sf), file, line: lineOf(sf, node),
          tag, owner_function: owner, literal_label_candidates: [...new Set(text)].join(' / ').slice(0, 300),
          event_handlers: events.map(attr => attr.getText(sf).slice(0, 240)).join(';'),
          conditional_candidates: conditions.join(';'), requirement_status: '待现场映射动作', runtime_result: '未测' });
      }
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(sf);
  if (isTest) tests.push({ file, layer_candidate: file.startsWith('server/') ? 'server source test' : 'frontend or auxiliary source test',
    suite_candidate: file.startsWith('server/')
      ? /^server\/acceptance-tests\/.*\.test\.ts$/.test(file) ? 'server acceptance opt-in include'
        : /^server\/(src|ops-panel\/src)\/.*\.test\.ts$/.test(file) ? 'server explicit include' : 'outside server explicit include'
      : file.startsWith('design-lab/') ? 'root explicit exclude' : 'root default filename candidate; collection not executed',
    static_test_declarations: testDeclarations.length,
    production_imports: imports.filter(item => item.resolved && !/\.(test|spec)\./.test(item.resolved)).map(item => item.resolved).join(';'),
    source_read_paths: [...sourceReadPaths].sort().join(';'),
    parameterized_note: 'static declarations are not expanded runtime case counts; suite membership must check config',
    run_result: '源码盘点不判定执行状态；实际证据见execution附件', declarations: testDeclarations });
}
for (const route of routes) {
  const candidates = mounts.filter(mount => mount.factory_file === route.file && mount.factory === route.owner_function);
  route.mount_candidates = candidates.map(mount => mount.prefix + (route.relative_path === '/' ? '' : route.relative_path));
  route.full_path_status = candidates.length ? 'static candidate only; nested routers and runtime registration need verification' : 'unresolved; do not treat as absent';
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equalDefaults = JSON.stringify(stable(defaults)) === JSON.stringify(stable(back.get('DEFAULT_ROLE_PERMISSION_MATRIX')));
function dependencies(entry) {
  const seen = new Set();
  function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const item of sourceImports[file] || []) if (item.resolved) walk(item.resolved);
  }
  walk(entry); return [...seen].sort();
}
const moduleDependencies = Object.fromEntries(modules.map(module => [module.id, dependencies(module.entry)]));
const globalDependencies = dependencies('App.tsx');
for (const item of [...controls, ...visualElements]) {
  item.module_candidates = modules.filter(module => moduleDependencies[module.id].includes(item.file)).map(module => module.id).join(';');
  item.global_app_candidate = globalDependencies.includes(item.file);
  item.association_basis = item.module_candidates ? 'static relative-import reachability; runtime visibility unverified' : 'no registered-entry relative-import path; investigate global/dynamic/unreachable entry';
}
for (const file of ['vite.config.ts', 'server/vitest.config.ts', 'server/acceptance.vitest.config.ts']) {
  if (fs.existsSync(path.join(root, file))) inputs.set(file, digest(read(file)));
}
const metadata = {
  generatedAt: new Date().toISOString(), sourceCommit: git(['rev-parse', 'HEAD']), generatorSha256: digest(fs.readFileSync(__filename)),
  snapshotBasis: 'working-tree inventory; sourceCommit is checkout HEAD, inputSha256 identifies the actual inspected bytes',
  purpose: 'acceptance design source inventory; no test execution and no coverage/pass claims',
  counts: { modules: modules.length, declaredSubViews: modules.reduce((total, module) => total + module.subViews.length, 0),
    roles: Object.keys(roles).length, defaultScopeUnion: allScopes.length, moduleRoleCandidates: moduleRoleRows.length,
    roleScopeCandidates: roleScopeRows.length, models: models.length, fields: fieldRows.length,
    declaredRelationFields: relations.length, routeDeclarations: routes.length, mountDeclarations: mounts.length, testSourceFiles: tests.length,
    interactiveControlDeclarations: controls.length, controlsWithModuleCandidate: controls.filter(control => control.module_candidates).length,
    jsxVisualDeclarations: visualElements.length },
  checks: { schemaClientModelAndFieldNamesMatch: true, schemaClientFieldTypesAndNullabilityMatch: true,
    frontendBackendDefaultRoleMatrixEqual: equalDefaults },
  limitations: ['source presence is not runtime availability', 'default role data is not effective database authorization',
    'static routes may omit dynamic registration', 'logical ID associations are not all Prisma relation fields',
    'static test declarations and imports do not prove coverage or executed case counts',
    'interactive controls omit external/dynamic wrappers; relative-import reachability is not actual rendered visibility'],
  inputSha256: Object.fromEntries([...inputs].sort(([a], [b]) => a.localeCompare(b))),
};
fs.mkdirSync(output, { recursive: true });
const compressed = new Set(['controls.json', 'test-declarations.json', 'interactive-controls.csv', 'visual-elements.csv']);
const save = (name, value) => {
  const file = path.join(output, name);
  if (compressed.has(name)) {
    fs.writeFileSync(file + '.gz', zlib.gzipSync(value, { level: 9 }));
    if (fs.existsSync(file)) fs.unlinkSync(file); // Replace only this generator's own output.
  } else fs.writeFileSync(file, value);
};
const json = (name, value) => save(name + '.json', JSON.stringify(value, null, 2) + '\n');
const csv = (name, rows) => {
  if (!rows.length) throw new Error('Empty required inventory ' + name);
  const headers = Object.keys(rows[0]);
  const cell = value => '"' + String(Array.isArray(value) ? JSON.stringify(value) : value ?? '').replaceAll('"', '""') + '"';
  save(name + '.csv', [headers, ...rows.map(row => headers.map(header => row[header]))].map(row => row.map(cell).join(',')).join('\n') + '\n');
};
json('metadata', metadata); json('modules', modules); json('roles', { roles, defaults, dataScopes, allScopes });
json('test-declarations', tests);
json('models', modelRows); json('api-routes', routes); json('controls', controls); json('module-dependencies', moduleDependencies);
csv('models', modelRows); csv('model-fields', fieldRows); csv('model-relations', relations);
csv('interactive-controls', controls);
csv('visual-elements', visualElements);
csv('module-role-defaults', moduleRoleRows); csv('role-scope-defaults', roleScopeRows);
csv('api-mounts', mounts); csv('api-routes', routes);
csv('test-inventory', tests.map(({ declarations, ...test }) => test));
console.log(JSON.stringify({ output: path.relative(root, output), counts: metadata.counts, checks: metadata.checks }, null, 2));
