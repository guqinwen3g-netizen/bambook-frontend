import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverage, extractLedgerStatements } from './build-global-design-coverage.mjs';

test('indexes confirmed, open, corrected, and unbulleted limits without granting approval', () => {
  const rows = extractLedgerStatements('## 四、开发\n### 4.1 版本\n**已确认**\n- 大版本。\n1. 点号版本。\n本段不表示全部已冻结。\n**仍待定**\n- 确认字段。\n## 十四、职责纠偏\n1. 业务员经办。\n');
  assert.deepEqual(rows.map(row => [row.section,row.decisionStatus,row.line]), [
    ['4.1','confirmed',4],['4.1','confirmed',5],['4.1','context',6],['4.1','open',8],['14','confirmed',10],
  ]);
});

test('indexes every handoff and correction table row, excluding headers and separators', () => {
  const rows = extractLedgerStatements('## 二、节点\n| 业务节点 | 角色 |\n|---|---|\n| 开发 | 业务员 |\n## 九、排除\n| 旧理解 / 曾提出的做法 | 当前有效规则 |\n|---|---|\n| 财务开CI | 业务开CI |\n');
  assert.deepEqual(rows.map(row => [row.kind,row.decisionStatus,row.text]), [
    ['handoff','confirmed','开发 | 业务员'],['exclusion','confirmed','财务开CI | 业务开CI'],
  ]);
});

test('source changes invalidate previous implementation and verification claims', () => {
  const old = buildCoverage('## 四、开发\n### 4.1 版本\n**已确认**\n- 独立确认。\n');
  old.requirements[0].implementation = { status:'verified',files:['old.ts'],gaps:[] };
  old.requirements[0].verification = { status:'passed',evidence:['old.json'] };
  old.requirements[0].staticAudit = { section:'4.1',requiredScenarios:['exact version readback'] };
  const unchanged = buildCoverage('## 四、开发\n### 4.1 版本\n**已确认**\n- 独立确认。\n',old);
  assert.equal(unchanged.requirements[0].verification.status,'passed');
  assert.deepEqual(unchanged.requirements[0].staticAudit, old.requirements[0].staticAudit);
  const changed = buildCoverage('## 四、开发\n### 4.1 版本\n**已确认**\n- 独立确认和QC。\n',old);
  assert.equal(changed.requirements[0].verification.status,'unverified');
  assert.equal(changed.requirements[0].previousEvidenceInvalidated,true);
  assert.equal(changed.requirements[0].staticAudit,undefined);
});
