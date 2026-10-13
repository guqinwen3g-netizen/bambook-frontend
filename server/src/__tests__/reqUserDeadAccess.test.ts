/**
 * 「actor 取值」守卫（2026-09-17）
 *
 * ── 病灶 ─────────────────────────────────────────────────
 * `hr/route.ts` 创建派工单时写 `assignerId: (req as any).user?.id || null`，
 * 而 **`req.user` 在本仓从未被赋值** ——
 *   · 全库唯一的赋值在**测试 mock** 里（`production/__tests__/rbac.test.ts:15` 的 `req.user = { roles }`）；
 *   · 生产代码里被赋值的是 **`req.actor`**（`auth/middleware.ts:40` 的 `(req as any).actor = payload`）。
 * ⇒ `(req as any).user?.id` **恒为 undefined** ⇒ `assignerId` **恒为 null**：派活人永久丢失。
 *
 * 实测（真库演练 `scripts/acceptance-hr-assigner-id.mjs`）：
 *   修前 S2/S3 报 `assignerId=null`（期望 `usr_demo_boss`）→ 修后 6 通过 / 0 失败。
 *
 * ── 本文件钉三件事 ───────────────────────────────────────
 *   1. **真源语义**：`actorIdFromRequest` 的三种取值（`actor.userId` / `actor.id` / `'system'` 兜底）
 *   2. **结构守卫**：`server/src`（非测试）里**不得出现 `req.user` / `(req as any).user` 读取**
 *      —— 这是**逻辑空集**（从未赋值 ⇒ 读到的永远是 undefined），任何一处都是死代码
 *   3. **守卫自检**：正则能咬住旧写法；**不误伤** `req.actor` 与 Prisma 的 `where.user`（关系过滤）
 *
 * ⚠️ 计数前剥注释、排除 `__tests__`（同 `localDateKey.test.ts` / `routeError.test.ts` 的纪律）。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actorIdFromRequest } from '../audit/routeAudit';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/__tests__
const SRC = path.resolve(HERE, '..'); // server/src

/**
 * 违规写法：读取从未被赋值的 `req.user`。
 * 两种形式：`(req as any).user`（旧写法）与 `req.user`。
 * 注意 `\b` 锚定，避免误伤 `request.user` 之外的正常标识符。
 */
const DEAD_REQ_USER_RE = /\(req as any\)\s*\.\s*user\b|\breq\.user\b/g;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // `//` 前一个字符不是 ':'，避免误伤 https://
}

function scanDeadReqUser(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        const code = stripComments(fs.readFileSync(abs, 'utf8'));
        const n = (code.match(DEAD_REQ_USER_RE) ?? []).length;
        if (n > 0) out[path.relative(SRC, abs).split(path.sep).join('/')] = n;
      }
    }
  };
  walk(SRC);
  return out;
}

const SCAN_TIMEOUT_MS = 30_000;
let _scanned: Record<string, number> | null = null;
function scanned(): Record<string, number> {
  if (!_scanned) _scanned = scanDeadReqUser();
  return _scanned;
}

describe('★ actor 取值真源', () => {
  it('★ `req.actor` 有 userId 时取 userId（中间件写入的真源）', () => {
    expect(actorIdFromRequest({ actor: { userId: 'usr_1' } })).toBe('usr_1');
  });

  it('只有 `actor.id` 时回退到 id', () => {
    expect(actorIdFromRequest({ actor: { id: 'usr_2' } })).toBe('usr_2');
  });

  it('无 actor / req 为空 → `system` 哨兵（与 seed 系统账号对齐，满足 FK）', () => {
    expect(actorIdFromRequest({})).toBe('system');
    expect(actorIdFromRequest(null)).toBe('system');
    expect(actorIdFromRequest(undefined)).toBe('system');
    // 即便误传了 req.user（从未赋值的那种），也必须落到 system —— 而不是取到它
    expect(actorIdFromRequest({ user: { id: 'ghost' } })).toBe('system');
  });
});

describe('★ 结构守卫：不得读取从未赋值的 `req.user`', () => {
  it('全库（非测试）`req.user` 读取必须为 0 处', () => {
    expect(scanned()).toEqual({});
  }, SCAN_TIMEOUT_MS);

  it('★ 修复点已归零：hr/route.ts 用 actorIdFromRequest，不再读 req.user', () => {
    expect(scanned()['hr/route.ts']).toBeUndefined();
    const src = fs.readFileSync(path.join(SRC, 'hr', 'route.ts'), 'utf8');
    expect(src).toMatch(/assignerId: actorIdFromRequest\(req\)/);
    expect(stripComments(src)).not.toMatch(DEAD_REQ_USER_RE);
  });

  it('★ 守卫自检：正则能咬住两种旧写法（防止退化成恒不匹配）', () => {
    for (const s of [
      "assignerId: (req as any).user?.id || null,",
      "assignerId: req.user?.id || null,",
      "if (req.user) { doThing(); }",
    ]) {
      expect((stripComments(s).match(DEAD_REQ_USER_RE) ?? []).length, `漏掉：${s}`).toBe(1);
    }
  });

  it('★ 守卫自检：不误伤 req.actor 与 Prisma 的 where.user 关系过滤', () => {
    for (const s of [
      "const actor = extractActorFromRequest(req);",
      "assignerId: actorIdFromRequest(req),",
      "(req as any).actor = payload;",
      "if (query.deptId) where.user = { primaryDeptId: query.deptId };",
      "const u = request.user;",
    ]) {
      expect((stripComments(s).match(DEAD_REQ_USER_RE) ?? []).length, `误伤：${s}`).toBe(0);
    }
  }, SCAN_TIMEOUT_MS);

  it('★ 守卫自检：剥注释后不把「解释该写法的注释」算成违规', () => {
    const sample = [
      '// 旧写法 assignerId: (req as any).user?.id 是错的（req.user 从未赋值）',
      '/* 也别写 req.user */',
      'assignerId: actorIdFromRequest(req),',
    ].join('\n');
    expect((stripComments(sample).match(DEAD_REQ_USER_RE) ?? []).length).toBe(0);
  });
});
