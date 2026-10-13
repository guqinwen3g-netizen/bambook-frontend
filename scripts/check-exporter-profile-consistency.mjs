/**
 * 出口方档案（公司抬头/银行信息）跨层一致性核对
 *
 * 背景：生产库单租户给 Jiangsu Panda 使用，抬头以该公司为准。
 * 代码里多处存在同款副本，注释明确要求「任一侧修改必须同步另一侧」。
 * 单据抬头同时被前端预览与服务端 PDF 使用 —— 只要有一处差一个空格，
 * 前端预览和正式导出的抬头就会不一致。
 *
 * 用法：
 *   CLI：  node scripts/check-exporter-profile-consistency.mjs
 *          npm run check:exporter-profile
 *   门禁： 由 exporterProfileConsistency.test.ts 导入 collectExporterProfileProblems()
 *          （导出函数、不自动执行，才能被测试复用而不产生副作用）
 *
 * 只读，不改任何文件。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';

/** 脚本位于 scripts/ 下，退两级才是项目根 */
const DEFAULT_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const FIELDS = ['nameEn', 'addressEn', 'beneficiary', 'bankName', 'swiftCode', 'bankAddress', 'usdAccountNumber'];

const TARGETS = [
  { label: 'frontend exporterProfile.ts（注释声明的真源）', file: 'components/tools/exportDocs/exporterProfile.ts' },
  { label: 'server systemConfigRoute.ts', file: 'server/src/config/systemConfigRoute.ts' },
  { label: 'server templates/invoice/fabric-sample.ts', file: 'server/src/templates/invoice/fabric-sample.ts' },
  {
    label: 'server templates/invoice/pdas-sample.ts · DEFAULT_PDAS_BANK',
    file: 'server/src/templates/invoice/pdas-sample.ts',
    within: 'DEFAULT_PDAS_BANK', // 文件内 name: 出现多次，必须限定块
    map: { bankName: 'name', swiftCode: 'swift', usdAccountNumber: 'account' },
  },
  {
    label: 'server templates/invoice/pdas-sample.ts · DEFAULT_PDAS_COMPANY',
    file: 'server/src/templates/invoice/pdas-sample.ts',
    within: 'DEFAULT_PDAS_COMPANY',
    map: { nameEn: 'name' },
  },
  // 不参与逐字段比对，但需证明「无硬编码 / 引用单一来源」
  {
    label: 'server seed-systemconfig.ts（应引用 DEFAULT_EXPORTER_PROFILE）',
    file: 'server/scripts/seed-systemconfig.ts',
    expect: { import: 'DEFAULT_EXPORTER_PROFILE' },
  },
  {
    label: 'frontend sampleInvoiceTemplate.ts（应派生自 getExporterProfile）',
    file: 'components/tools/sampleInvoiceTemplate.ts',
    expect: { contains: 'getExporterProfile()' },
  },
  {
    label: 'frontend admin/CompanyProfileSection.tsx（表单空态，值来自服务端）',
    file: 'components/admin/CompanyProfileSection.tsx',
    expect: { contains: 'setForm(' },
  },
];

/** 抽 `field: '...'`（含 \\n 转义） */
function extract(src, field) {
  const re = new RegExp(`${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'm');
  const m = src.match(re);
  if (!m) return null;
  // 把源码里的 \n 还原成真实换行，便于逐字符比对
  return m[2].replace(/\\n/g, '\n');
}

/**
 * 采集各文件的字段值与「派生校验」结果。
 * @returns {{ rows: Array, baseline: object|null }}
 */
export function collectExporterProfileReport(root = DEFAULT_ROOT) {
  const rows = [];
  for (const t of TARGETS) {
    let src;
    try {
      src = readFileSync(resolve(root, t.file), 'utf8');
    } catch {
      rows.push({ ...t, values: {}, missing: 'FILE_NOT_FOUND' });
      continue;
    }
    if (t.expect) {
      const want = t.expect.import || t.expect.contains;
      rows.push({ ...t, values: {}, derived: { ok: src.includes(want), want } });
      continue;
    }
    const scoped = t.within ? src.slice(src.indexOf(t.within)) : src;
    const values = {};
    for (const f of FIELDS) values[f] = extract(scoped, t.map?.[f] || f);
    rows.push({ ...t, values });
  }
  const baseline = rows.find((r) => r.values?.nameEn) || null;
  return { rows, baseline };
}

/**
 * 返回所有不一致项。空数组 = 全部一致。
 * @returns {Array<{field:string,file:string,label:string,baseline:string,actual:string}>}
 */
export function collectExporterProfileProblems(root = DEFAULT_ROOT) {
  const { rows, baseline } = collectExporterProfileReport(root);
  const problems = [];

  if (!baseline) {
    problems.push({ field: '(真源)', file: '(未找到)', label: '未找到声明 nameEn 的真源文件', baseline: '', actual: '' });
    return problems;
  }

  for (const r of rows) {
    if (r.missing) {
      problems.push({ field: '(文件)', file: r.file, label: r.label, baseline: '文件存在', actual: r.missing });
      continue;
    }
    if (r.derived) {
      if (!r.derived.ok) {
        problems.push({ field: '(派生校验)', file: r.file, label: r.label, baseline: `含 ${r.derived.want}`, actual: '(缺失)' });
      }
      continue;
    }
    if (r === baseline) continue;
    for (const f of FIELDS) {
      const v = r.values[f];
      if (v === null) continue; // 该文件不声明该字段
      if (v !== baseline.values[f]) {
        problems.push({ field: f, file: r.file, label: r.label, baseline: baseline.values[f], actual: v });
      }
    }
  }
  return problems;
}

// ── CLI（仅在直接执行时运行）────────────────────────────────────────────
if (isCliEntry(import.meta.url)) {
  const { rows, baseline } = collectExporterProfileReport();
  console.log('基准 =', baseline ? baseline.label : '(未找到)', '\n');

  for (const r of rows) {
    if (!r.derived) continue;
    console.log(r.derived.ok ? `   = ${r.label}（含 ${r.derived.want}）` : `   ✗ ${r.label}：未找到 ${r.derived.want}`);
  }

  if (baseline) {
    for (const f of FIELDS) {
      const base = baseline.values[f];
      console.log(`── ${f}`);
      console.log(`   基准: ${JSON.stringify(base)}`);
      for (const r of rows) {
        if (r === baseline || r.derived || r.missing) continue;
        const v = r.values[f];
        if (v === null) continue;
        console.log(v === base ? `   = ${r.label}` : `   ✗ ${r.label}: ${JSON.stringify(v)}`);
      }
      console.log('');
    }
  }

  const problems = collectExporterProfileProblems();
  console.log('===== 结论 =====');
  if (problems.length === 0) {
    console.log('所有声明了对应字段的文件与基准逐字符一致。');
  } else {
    console.log(`发现 ${problems.length} 处不一致：`);
    for (const p of problems) {
      console.log(`  [${p.field}] ${p.file}`);
      console.log(`      基准: ${JSON.stringify(p.baseline)}`);
      console.log(`      实际: ${JSON.stringify(p.actual)}`);
    }
    process.exitCode = 1;
  }
}
