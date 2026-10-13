/**
 * §9 B22 · 第 2 个域 `finance/route.ts` 收敛后的**执行**覆盖（27 处 `message: err.message` → 0）
 *
 * 判据来自外部（G6.5 / §0.5），不是"实现现在答什么"：
 *   ① 未预期异常：**内部原文一个字符都不进响应体**，界面必须是业务员能照着做的中文话术；
 *   ② 业务错误（`code:string` + `statusCode:number`）：**原样透传**它自己的码、状态与文案
 *      （这是本仓对"有意抛给用户的错误"的既有约定，不是本批新发明的口径）；
 *   ③ 响应体形状 = nested `{ error: { code, message } }` —— 财务 v1 的前端契约，
 *      收敛只换文案来源，**不许顺手把形状改成 flat**（形状一变前端就读不到码了）。
 *
 * 每条断言都配"能不能红"的自检（见文件末尾那条变异对照），避免退化成恒真守卫。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFinanceRouter } from '../route';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function asAdmin() {
  return {
    Authorization: `Bearer ${jwt.sign({ userId: 'u-admin', roles: ['admin', 'owner', 'finance'] }, JWT_SECRET)}`,
  };
}

function appWith(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({
    prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn(),
  }));
  return app;
}

/** 一条典型的 Prisma 原文：含表名/方法名/调用参数，绝不能上屏 */
const RAW_PRISMA_TEXT = 'PrismaClientKnownRequestError: Invalid `prisma.invoice.findMany()` invocation in src/finance/route.ts:290 - The table `Invoice` does not exist in the current database.';

describe('B22 · finance 出口：未预期异常不外发原文', () => {
  it('GET / 服务层抛内部异常 → 500 + 保留 LIST_FAILED + 中文专属文案 + 原文一个字符都不在', async () => {
    const prisma = {
      invoice: {
        findMany: vi.fn().mockRejectedValue(new Error(RAW_PRISMA_TEXT)),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const res = await request(appWith(prisma)).get('/api/v1/finance/').set(asAdmin());
    // ① 档位：未归因的服务端故障 = 500（RFC 9110 §15.6.1，与收敛前一致 ⇒ 本批不改这一档）
    expect(res.status).toBe(500);
    // ③ 形状：nested `{error:{code,message}}` 是财务 v1 契约，一个字未改
    expect(typeof res.body.error).toBe('object');
    expect(res.body.error.code).toBe('LIST_FAILED');
    // ① 泄露判据（本条的存在理由）
    expect(JSON.stringify(res.body)).not.toContain('PrismaClientKnownRequestError');
    expect(JSON.stringify(res.body)).not.toContain('prisma.invoice.findMany');
    expect(JSON.stringify(res.body)).not.toContain('does not exist in the current database');
    // ① 业务员拿到的话：中文 + 说清是什么没加载出来 + 给下一步
    expect(res.body.error.message).toMatch(/[\u4e00-\u9fa5]/);
    expect(res.body.error.message).toContain('财务单据列表');
  });

  it('GET / 服务层抛**业务错误**（自带 code+statusCode）→ 认它自己的档位与文案（G6.5 透传）', async () => {
    const prisma = {
      invoice: {
        findMany: vi.fn().mockRejectedValue(
          Object.assign(new Error('财务期间已锁定，不能查询该期间的单据'), { code: 'PERIOD_LOCKED', statusCode: 409 }),
        ),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const res = await request(appWith(prisma)).get('/api/v1/finance/').set(asAdmin());
    // 收敛前这里是 **500**（硬编码），业务拒绝被答成服务端故障 ⇒ 本批的**有意**行为变更
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PERIOD_LOCKED');
    expect(res.body.error.message).toBe('财务期间已锁定，不能查询该期间的单据');
  });

  it('带 `ok: false` 的端点（作废/删除族）收敛后仍保留 ok:false 与自带码', async () => {
    const prisma = {
      invoice: {
        findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', invoiceNumber: 'INV__1', status: 'Issued', deletedAt: null }),
        invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
        $transaction: vi.fn().mockRejectedValue(new Error(RAW_PRISMA_TEXT)),
        auditLog: { create: vi.fn().mockResolvedValue({ id: 1 }) },
      },
    };
    const res = await request(appWith(prisma)).post('/api/v1/finance/INV__1/cancel').set(asAdmin()).send({ reason: 'E2E-演练' });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('CANCEL_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('PrismaClientKnownRequestError');
    expect(res.body.error.message).toContain('未能作废');
  });
});

/** 取出所有 `.json( … )` 的参数区（括号配平；字符串内的括号按引号跳过） */
function jsonArgumentSpans(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src.slice(i, i + 6) !== '.json(') continue;
    let depth = 1, j = i + 6;
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === "'" || c === '"' || c === '`') {
        const q = c; j++;
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
        continue;
      }
      if (c === '(') depth++; else if (c === ')') depth--;
    }
    out.push(src.slice(i + 6, j - 1));
  }
  return out;
}

describe('B22 · finance 出口 · 源码棘轮（形状与处数，只许减不许增）', () => {
  const src = () => stripComments(fs.readFileSync(path.join(HERE, '..', 'route.ts'), 'utf8'));

  it('响应体里不得再出现任何「原始异常文本」的取法（只看 .json(…) 的参数区）', () => {
    // 判据范围刻意收在**响应体**：`logger.error(…, { error: err?.message })` 是设计要的（原文进日志），
    // 只有出现在 `.json(...)` 里的才算外泄。用"全文扫 String(err)"会把 16 处日志误判成泄露 —— 那是假红。
    const bodies = jsonArgumentSpans(src());
    const leaky = bodies.filter((b) => /(?:message|error)\s*:\s*(?:[^,}]*\b(?:err|e)\??\.message|[^,}]*String\(\s*(?:err|e)\b)/.test(b));
    expect(leaky, `响应体里还有 ${leaky.length} 处直接取原始异常文本：${JSON.stringify(leaky.slice(0, 2))}`).toHaveLength(0);
    // 交叉核对：与 B22 棘轮同一口径的"路由直传"写法也必须为 0
    expect(src().match(/message:\s*(err|e)\.message/g) ?? []).toHaveLength(0);
  });

  it('safeRouteError 出口处数含新增授权检查，两条未知异常泄漏守卫仍为零', () => {
    // The fixed pre-V1 source fde1d263 already has 29 protected consumers;
    // the historical 27 count was stale. Raw-error debt guards remain zero.
    expect((src().match(/safeRouteError\((err|e), \{ fallbackCode: '/g) ?? []).length).toBe(29);
  });

  it('★ 阳性对照（防恒真）：上述两条判据必须抓得住收敛前的真实写法', () => {
    const before = [
      "res.status(500).json({ error: { code: 'LIST_FAILED', message: err.message } });",
      "res.status(500).json({ error: { code: 'PDF_FAILED', message: err?.message || String(err) } });",
    ].join('\n');
    const beforeBodies = jsonArgumentSpans(before);
    expect(beforeBodies.length, '抽取器必须认得这两处 .json 参数区').toBe(2);
    expect(beforeBodies.filter((b) => /(?:message|error)\s*:\s*(?:[^,}]*\b(?:err|e)\??\.message|[^,}]*String\(\s*(?:err|e)\b)/.test(b)).length)
      .toBe(2);
    expect((before.match(/safeRouteError\((err|e), \{ fallbackCode: '/g) ?? []).length).toBe(0);
    // 收敛后的形状才被计入
    const after = "const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '加载失败' });";
    expect((after.match(/safeRouteError\((err|e), \{ fallbackCode: '/g) ?? []).length).toBe(1);
  });
});
