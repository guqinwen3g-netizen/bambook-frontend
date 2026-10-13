/**
 * 章图注入回归测试（2026-09-15）
 *
 * 背景：validateImage 只校验 `data:image/` 前缀 + 长度，不校验内容字符；
 * renderDocStamp 又把 imageDataUrl 原样内联进 `src="..."`（注释称"base64 不含引号，
 * 无需转义"）。真实业务方给的章图/文件名千奇百怪，只要内容里带一个双引号就能
 * 闭合 src 属性 → 注入 onerror/onload 等事件属性 = 存储型 XSS（章图是管理员上传、
 * 所有看单据的人都会触发）。
 *
 * 本测试锁定：
 *   ① createSeal 拒绝含引号 / 非 base64 SVG 等危险 imageDataUrl；
 *   ② renderDocStamp 输出的属性值被安全转义（即使上游漏过也炸不了）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSealService } from '../sealService';
import { renderDocStamp } from '../../templates/docPrintBase';

function mockPrisma() {
  const created: any[] = [];
  return {
    _created: created,
    seal: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { created.push(data); return { id: 'SEAL__1', ...data }; }),
      update: vi.fn(async ({ data }: any) => ({ id: 'SEAL__1', ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'AUD__1' })) },
    $transaction: vi.fn(async (fn: any) => fn({
      seal: {
        create: vi.fn(async ({ data }: any) => { created.push(data); return { id: 'SEAL__1', ...data }; }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      auditLog: { create: vi.fn(async () => ({ id: 'AUD__1' })) },
    })),
  } as any;
}

const GOOD_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('章图 imageDataUrl 注入防护', () => {
  const dangerous = [
    { name: '双引号闭合 → onerror', url: 'data:image/png;base64,AAAA" onerror="alert(1)' },
    { name: '单引号闭合', url: "data:image/png;base64,AAAA' onerror='alert(1)" },
    { name: '非 base64 的 SVG（可含脚本/尖括号）', url: 'data:image/svg+xml,<svg onload="alert(1)">', alsoRender: true },
    { name: 'base64 编码的 SVG', url: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=' },
    { name: '含尖括号', url: 'data:image/png;base64,AAAA<script>alert(1)</script>' },
    { name: '含换行符（可截断属性/破坏版式）', url: 'data:image/png;base64,AAAA\n onerror="alert(1)"' },
  ];

  for (const c of dangerous) {
    it(`createSeal 拒绝：${c.name}`, async () => {
      const prisma = mockPrisma();
      const svc = createSealService(prisma);
      await expect(
        svc.createSeal({ name: '恶意章', imageDataUrl: c.url }, 'u_admin'),
      ).rejects.toThrow();
    });

    it(`renderDocStamp 不产出可执行属性：${c.name}`, () => {
      const html = renderDocStamp({ id: 'SEAL__1', name: 'x', imageDataUrl: c.url });
      // 按属性边界判定（而非全文 grep）：src 值必须吞掉整段 payload，
      // 即 src="…" 之后到标签结束之间，不得再出现任何 on* 事件属性。
      const srcAttr = /src="([^"]*)"/.exec(html);
      expect(srcAttr).toBeTruthy();
      const restOfTag = html.slice((srcAttr!.index ?? 0) + srcAttr![0].length).split('>')[0] ?? '';
      expect(restOfTag).not.toMatch(/\son\w+\s*=/i);
      // 值里若含 < 说明可能被当标签解析
      expect(srcAttr![1]).not.toMatch(/</);
    });
  }

  it('正常 base64 PNG 仍可通过（不误伤）', async () => {
    const prisma = mockPrisma();
    const svc = createSealService(prisma);
    const row = await svc.createSeal({ name: '公司公章', imageDataUrl: GOOD_PNG }, 'u_admin');
    expect(row.name).toBe('公司公章');
  });

  it('正常 base64 PNG 渲染出 <img> 且 data URL 完整', () => {
    const html = renderDocStamp({ id: 'SEAL__1', name: 'x', imageDataUrl: GOOD_PNG });
    expect(html).toContain('<img');
    expect(html).toContain(GOOD_PNG);
  });
});
