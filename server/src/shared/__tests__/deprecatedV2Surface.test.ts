/**
 * 已废弃但**仍挂载**的 V2 路由族 —— 统一守卫（§12.05 D36）
 *
 * 背景：`seasons/seasonRouteV2.ts`（22 端点）与 `suppliers/factoryRouteV2.ts`（19 端点）
 * 头上都写着 DEPRECATED + 前端零消费（2026-09-15 B4 冗余收敛），但**路由还在挂载**，
 * 任何持 JWT / API Key 的调用方都打得开 ⇒ "有没有人用"不能让信息泄露打折。
 *
 * 本文件把两件事钉成**可证伪**（不是注释里的一句话）：
 *   ① 「前端零消费」—— 在前端各层全量搜接口路径，命中即红。
 *      红了不是坏事：说明这条路径重新变成产品面，必须回去补**逐端点的业务文案**并重新裁定
 *      （并回 V1 还是继续维护 V2），不许继续沿用本批的共享兜底句。
 *   ② 「错误出口已收敛」—— 两族的每个 catch 都必须走真源，且不得再出现 `message: e.message`。
 *
 * 为什么两族的文案是同文件一条常量而不是逐端点定制（D36 的取舍）：
 * 给一个等业务确认后整族删除的表面手写 41 句产品文案，是把力气花在账面进度上；
 * 真正的收益是"原文不再上屏"+"零消费这条声称可被证伪"。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './utils/sourceScan';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // server/src/shared/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');         // server/
const APP_ROOT = path.resolve(SERVER, '..');                  // 应用根（前端在此）

/** 被监护的废弃 V2 族：文件 + 它对外暴露的路径片段 + 收敛后的出口处数（只许减不许增） */
const DEPRECATED_V2_SURFACES = [
  { file: 'seasons/seasonRouteV2.ts', pathTokens: ['/api/v2/seasons', 'v2/seasons'], exits: 22 },
  { file: 'suppliers/factoryRouteV2.ts', pathTokens: ['/api/v2/suppliers', 'v2/suppliers'], exits: 19 },
];

const FRONTEND_DIRS = ['components', 'services', 'lib', 'customer-portal/src', 'server/ops-panel/src'];

describe('已废弃但仍挂载的 V2 族：泄露已堵 + "零消费"可证伪', () => {
  for (const sfc of DEPRECATED_V2_SURFACES) {
    const read = () => stripComments(fs.readFileSync(path.join(SERVER, 'src', sfc.file), 'utf8'));

    it(`${sfc.file}：不得再有把原始异常写进响应体的写法，出口全部走真源`, () => {
      const src = read();
      expect(src.match(/message:\s*(err|e)\??\.message/g) ?? [],
        '这一型会把 Prisma/SQL 原文直接回给调用方').toHaveLength(0);
      const exits = (src.match(/safeRouteError\((err|e), \{ fallbackCode: 'INTERNAL_ERROR'/g) ?? []).length;
      expect(exits, '收敛处数与基线不符（少了 = 又收敛了，同步这里；多了 = 有站点偷偷退回旧写法）').toBe(sfc.exits);
      // 阳性对照：本族收敛前的真实形状必须被第一条抓到（否则那条是恒真守卫）
      expect(("} catch (e: any) { res.status(500).json({ error: 'INTERNAL_ERROR', message: e?.message }); }")
        .match(/message:\s*(err|e)\??\.message/g) ?? []).toHaveLength(1);
    });

    it(`${sfc.file}：共享文案必须是中文且说清"有没有留下记录"`, () => {
      const src = read();
      // 名字里带数字（SEASON_V2_FAIL / SUPPLIERS_V2_FAIL）⇒ 字符集必须含数字；
      // 这与 D37 是同一课：判据要绑在语义上，别让语法形状（这里是个数字字符）把它掐掉。
      const m = /const [A-Z][A-Z0-9_]*_FAIL\s*=\s*'([^']+)'/.exec(src);
      expect(m, '共享文案常量必须存在').not.toBeNull();
      expect(m![1]).toMatch(/[一-龥]/);
      expect(m![1]).toContain('未确认任何改动');
      expect(m![1].length).toBeGreaterThanOrEqual(20);
    });

    it(`${sfc.file}：「${sfc.pathTokens[0]} 前端零消费」这条声称仍然成立（命中即需重新裁定）`, () => {
      const hits: string[] = [];
      for (const dir of FRONTEND_DIRS) {
        const root = path.join(APP_ROOT, dir);
        if (!fs.existsSync(root)) continue;
        const walk = (d: string) => {
          for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '__tests__') continue;
            const abs = path.join(d, ent.name);
            if (ent.isDirectory()) { walk(abs); continue; }
            if (!/\.(ts|tsx|js|jsx)$/.test(ent.name) || /\.test\.|\.spec\./.test(ent.name)) continue;
            const t = fs.readFileSync(abs, 'utf8');
            if (sfc.pathTokens.some((tok) => t.includes(tok))) hits.push(path.relative(APP_ROOT, abs));
          }
        };
        walk(root);
      }
      expect(hits.sort(), `已废弃族被重新消费 ⇒ 逐端点补业务文案、并重新裁定是否并回 V1（D36）`).toEqual([]);
    });
  }

  it('★ 阳性对照：跨树搜索器不是摆设（拿一个确实被前端消费的 V2 路径必须搜得出来）', () => {
    // `/api/v2/marketing` 是真有前端消费的（marketingCampaignsLeadsContract.test.ts 逐条钉着），
    // 用它证明"搜不到"是因为真没人用，而不是搜索器根本不咬。
    const hits: string[] = [];
    for (const dir of FRONTEND_DIRS) {
      const root = path.join(APP_ROOT, dir);
      if (!fs.existsSync(root)) continue;
      const walk = (d: string) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          if (ent.name === 'node_modules' || ent.name === 'dist') continue;
          const abs = path.join(d, ent.name);
          if (ent.isDirectory()) { walk(abs); continue; }
          if (!/\.(ts|tsx|js|jsx)$/.test(ent.name)) continue;
          if (fs.readFileSync(abs, 'utf8').includes('/api/v2/marketing')) hits.push(path.relative(APP_ROOT, abs));
        }
      };
      walk(root);
    }
    expect(hits.length, '对照组搜不到任何前端文件 ⇒ 搜索器本身失效，上面那三条"零消费"全都不可信').toBeGreaterThan(0);
  });
});
