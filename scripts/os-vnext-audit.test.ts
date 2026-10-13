import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditFiles,
  createBaseline,
  formatAuditReport,
  OS_VNEXT_FORBIDDEN_VALUE_PATTERNS,
} from './audit-os-vnext.mjs';

describe('OS vNext design audit', () => {
  it('detects page-local visual values outside the contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'os-vnext-audit-'));
    mkdirSync(join(root, 'components'), { recursive: true });
    mkdirSync(join(root, 'styles'), { recursive: true });
    writeFileSync(join(root, 'components/BadPanel.tsx'), [
      'export const BadPanel = () => (',
      '  <div className="rounded-[23px] bg-[#123456] shadow-[0_0_20px_rgba(0,0,0,0.2)] text-[13px]" />',
      ');',
    ].join('\n'));
    writeFileSync(join(root, 'styles/os-vnext.css'), '.ok { color: #123456; }\n');

    const result = auditFiles({ rootDir: root, paths: ['components', 'styles'] });

    expect(OS_VNEXT_FORBIDDEN_VALUE_PATTERNS.map(pattern => pattern.id)).toEqual([
      'hex-color',
      'rgba-color',
      'arbitrary-tailwind',
      'inline-pixel-style',
    ]);
    expect(result.violations).toHaveLength(4);
    expect(result.violations.map(violation => violation.file)).toEqual([
      'components/BadPanel.tsx',
      'components/BadPanel.tsx',
      'components/BadPanel.tsx',
      'components/BadPanel.tsx',
    ]);
    expect(formatAuditReport(result)).toContain('components/BadPanel.tsx:2');
  });

  it('supports a baseline so existing design debt does not block the first gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'os-vnext-audit-baseline-'));
    mkdirSync(join(root, 'components'), { recursive: true });
    writeFileSync(join(root, 'components/Legacy.tsx'), [
      'export const Legacy = () => (',
      '  <div className="rounded-[23px] bg-[#123456]" />',
      ');',
    ].join('\n'));

    const baseline = createBaseline(auditFiles({ rootDir: root, paths: ['components'] }));
    const cleanResult = auditFiles({ rootDir: root, paths: ['components'], baseline } as any);
    writeFileSync(join(root, 'components/Legacy.tsx'), [
      'export const Legacy = () => (',
      '  <div className="rounded-[23px] bg-[#123456] text-[13px]" />',
      ');',
    ].join('\n'));
    const regressedResult = auditFiles({ rootDir: root, paths: ['components'], baseline } as any);

    expect(cleanResult.violations).toHaveLength(0);
    expect(regressedResult.violations).toHaveLength(1);
    expect(regressedResult.violations[0].match).toBe('text-[13px]');
  });

  it('is wired into package scripts', () => {
    const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

    expect(packageJson).toContain('"audit:os-vnext": "node scripts/audit-os-vnext.mjs"');
  });
});
