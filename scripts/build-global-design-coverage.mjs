import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ledgerPath = 'docs/design/global/2026-10-06/08-2026-10-06-对话设计决策总账.md';
const outputDir = 'artifacts/acceptance-20261007/global-goal';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Retain source statements verbatim. This index never infers business approval
// from a plan, source file, test name, or a passing build.
export function extractLedgerStatements(source) {
  const statements = [];
  let chapter = '', section = '', approval = 'context';
  const counts = new Map();
  const append = (line, text, kind) => {
    const key = section || chapter;
    const ordinal = (counts.get(key) || 0) + 1;
    counts.set(key, ordinal);
    statements.push({ id: `D-${key}-${String(ordinal).padStart(3, '0')}`, section: key,
      line, text, kind, decisionStatus: approval, sourceTextSha256: digest(text) });
  };
  const chapters = ['一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七'];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    const heading = text.match(/^## ([一二三四五六七八九十]+)、/);
    if (heading) {
      chapter = String(chapters.indexOf(heading[1]) + 1); section = chapter;
      approval = ['14','15','16','17'].includes(chapter) ? 'confirmed' : chapter === '11' ? 'open' : 'context';
      return;
    }
    const subheading = text.match(/^### (\d+(?:\.\d+)*)\b/);
    if (subheading) { section = subheading[1]; approval = 'context'; return; }
    if (/^\*\*已确认/.test(text) || /^\*\*已更正/.test(text)) { approval = 'confirmed'; return; }
    if (/^\*\*(?:仍待定|待定|不属于本次已确认)/.test(text)) { approval = 'open'; return; }
    if (/^\*\*行业规则依据/.test(text)) { approval = 'context'; return; }
    if (!chapter || !text || /^#{1,6} |^\*\*|^>/.test(text)) return;
    if (text.startsWith('|')) {
      if (!['2','9'].includes(chapter) || /^\|\s*[-:]|^\| (?:业务节点|旧理解)/.test(text)) return;
      const cells = text.split('|').slice(1,-1).map(cell => cell.trim());
      const previous = approval; approval = 'confirmed';
      append(index + 1, cells.join(' | '), chapter === '9' ? 'exclusion' : 'handoff');
      approval = previous; return;
    }
    if (/^(?:- |\d+\. )/.test(text)) {
      append(index + 1, text.replace(/^(?:- |\d+\. )/, ''), approval === 'open' ? 'open-design' : 'statement');
    } else if (/[。；]$/.test(text)) {
      // Unbulleted qualifications are indexed too, including later corrections
      // and explicit limits on approval. They are not promoted to decisions.
      const previous = approval; approval = 'context';
      append(index + 1, text, 'source-note'); approval = previous;
    }
  });
  if (!statements.length || statements.some(row => row.section === '0')) throw Error('Ledger headings could not be indexed');
  return statements;
}

export function buildCoverage(source, previous = {}) {
  const prior = new Map((previous.requirements || []).map(row => [row.id, row]));
  const requirements = extractLedgerStatements(source).map(row => {
    const old = prior.get(row.id);
    const same = old?.sourceTextSha256 === row.sourceTextSha256;
    return { ...row, implementation: same ? old.implementation : { status: 'unassessed', files: [], gaps: [] },
      verification: same ? old.verification : { status: 'unverified', evidence: [] },
      ...(same && old.staticAudit ? { staticAudit: old.staticAudit } : {}),
      ...(old && !same ? { previousEvidenceInvalidated: true } : {}) };
  });
  return { version: 1, source: { path: ledgerPath, sha256: digest(source) },
    boundary: 'Source coverage is an index, not implementation or acceptance evidence.', requirements };
}

export function renderCoverage(matrix) {
  const groups = Object.groupBy(matrix.requirements, row => row.decisionStatus);
  const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return `# 全量决策逐项覆盖与证据索引\n\n唯一业务决策依据：[对话设计决策总账](../../../../${ledgerPath})。源文件 SHA-256：\`${matrix.source.sha256}\`。\n\n共 ${matrix.requirements.length} 条源语句；已确认 ${groups.confirmed?.length || 0} 条，待定 ${groups.open?.length || 0} 条，上下文/限制 ${groups.context?.length || 0} 条。覆盖索引不代表实现完成。未决设计由本轮实施规格明确标注，不伪称用户已确认。\n\n| ID / 总账行 | 决策状态 | 源语句 | 实现 / 缺口 | 验证证据 |\n|---|---|---|---|---|\n` + matrix.requirements.map(row => {
    const implementation = [row.implementation.status, ...row.implementation.files,
      ...row.implementation.gaps].join('；');
    const verification = [row.verification.status, ...row.verification.evidence].join('；');
    return `| ${row.id} / L${row.line} | ${row.decisionStatus} | ${escape(row.text)} | ${escape(implementation)} | ${escape(verification)} |`;
  }).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = fs.readFileSync(path.join(root, ledgerPath), 'utf8');
  const destination = path.join(root, outputDir, 'decision-coverage.json');
  const previous = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : {};
  const matrix = buildCoverage(source, previous);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(matrix, null, 2) + '\n');
  fs.writeFileSync(path.join(root, outputDir, 'decision-coverage.md'), renderCoverage(matrix));
  console.log(JSON.stringify({ sourceSha256: matrix.source.sha256, requirements: matrix.requirements.length,
    confirmed: matrix.requirements.filter(row => row.decisionStatus === 'confirmed').length,
    open: matrix.requirements.filter(row => row.decisionStatus === 'open').length }));
}
