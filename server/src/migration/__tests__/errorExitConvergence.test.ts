/**
 * §9 **B39** · `migration/dataMigrationService.ts` 的**执行覆盖**（R3 / §6 S1）
 *
 * 本批把那处 ``fail('PARSE_FAILED', `文件解析失败：${e?.message ?? e}（支持 .xlsx / .csv）`)``
 * 换成字面中文，**并补上该文件原本没有的 `logger.error`**（实测 `logger.error` 计数为 0）—— D51：
 * 对 B39 只换文案 = 把唯一的线索删掉。
 *
 * ⚠️ 本处与其它 B39 站点**不同类**：它是**纯解析**（无 DB、无事务）⇒ 文案里**不许有任何写入状态承诺**，
 * 只保留"解析失败 + 格式指引 + 下一步"。这条差别由下面的断言钉住。
 *
 * 出口链已核：`dataMigrationRoute.ts` 的 validate 端点用
 * `res.status(result.error.status).json({ error: { code, message: result.error.message } })` 原样转发。
 *
 * 为什么单开一个文件：`dataMigrationService.ts` 用的是 `import * as XLSX from 'xlsx'`（命名空间导入），
 * 要让它抛错必须**模块级 mock** —— 放进既有 `dataMigrationService.test.ts` 会波及那里所有用例。
 */
import { describe, expect, it, vi } from 'vitest';

const B39_RAW = 'Unsupported file format: /srv/app/server/src/migration/dataMigrationService.ts:116 (zip signature not found)';
const B39_FRAGMENTS = ['Unsupported file format', 'dataMigrationService.ts:116', 'zip signature', '/srv/app'];

vi.mock('xlsx', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, read: vi.fn(() => { throw new Error(B39_RAW); }) };
});

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createDataMigrationService } from '../dataMigrationService';
import { logger } from '../../lib/logger';

/** parseRows 不碰 db（解析失败时 validateFile 直接早返）⇒ 空桩足够 */
const prismaStub: any = {};

describe('§9 B39 · 文件解析失败时用户收到的是中文，不是库内部原文', () => {
  it('★ 500/400 + 码名不变 + 中文文案 + 零原文；且**不承诺任何写入状态**', async () => {
    const svc = createDataMigrationService(prismaStub);
    const r = await svc.validateFile('orders', Buffer.from('not-a-real-xlsx'));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code, '码名不得随文案一起改（前端按码分支）').toBe('PARSE_FAILED');
    expect(r.error.status, '本处原为 fail 默认档 400，未改档位').toBe(400);

    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expect(r.error.message, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
    expect(r.error.message, '必须说清对象').toContain('解析');
    expect(r.error.message, '必须给下一步').toMatch(/(稍后重试|联系管理员)/);

    // ★ 本处是纯解析、无写入 ⇒ 不许承诺写入状态（谁"统一模板"谁红）
    expect(r.error.message, '纯解析出口不得承诺写入状态')
      .not.toMatch(/(没有写入任何数据|本次未确认任何改动|本次改动未生效)/);

    // 格式名是**业务信息**，必须留下（这是"零拉丁词"这条启发式的例外，显式 allowlist）
    expect(r.error.message, '格式指引必须保留').toMatch(/\.xlsx/);
    expect(r.error.message, '格式指引必须保留').toMatch(/\.csv/);
    const latin = (r.error.message.match(/[A-Za-z]{3,}/g) ?? []).filter((t: string) => !['xlsx', 'csv'].includes(t.toLowerCase()));
    expect(latin, `混入其它拉丁词（疑似原文上屏）：${JSON.stringify(latin)}`).toEqual([]);

    // 原文必须仍进日志
    expect(logger.error, 'catch 必须把原文写进日志').toHaveBeenCalledWith(
      expect.stringContaining('[DataMigration]'), expect.objectContaining({ error: B39_RAW }));
  });
});
