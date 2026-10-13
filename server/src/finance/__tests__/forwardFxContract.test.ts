/**
 * forwardFxContract.test.ts — ★ D6 结构守卫：远期结汇合约层的落点与边界
 *
 * 判据：
 *   ① schema 有两张新表 + 迁移存在；迁移**只建新表**（不 DROP/ALTER 既有表 ⇒ 对生产零风险）
 *   ② 路由三端点齐全 + 写端点有 scope 门
 *   ③ ★ 不得把银行合约信息塞进 `FxRateLock`（两者语义不同：订单侧内部定价锚 vs 外部金融合约）
 *   ④ 派生量（剩余/状态/损益）走真源纯函数，不在路由里另写一套
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
/**
 * 反向断言**先剥注释**（同类第 5 次：注释里写「回滚 = DROP TABLE」会被自己的断言命中）。
 * SQL 注释是 `--`（不是 `//`），所以三种注释形态都剥。
 */
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/(^|\s)--[^\n]*/g, '$1');

const SCHEMA = read('server/prisma/schema.prisma');
const MIGRATION = read('server/prisma/migrations/20260918190000_add_forward_fx_contract/migration.sql');
const ROUTE = read('server/src/finance/route.ts');
const SERVICE = read('server/src/finance/forwardFxService.ts');

describe('★ D6 结构守卫：远期结汇合约', () => {
  it('① schema 定义两张表', () => {
    expect(SCHEMA).toContain('model ForwardFxContract {');
    expect(SCHEMA).toContain('model ForwardFxSettlementLink {');
    // 一笔水单只能用一张合约（唯一键）
    expect(SCHEMA).toContain('@@unique([contractId, settlementId])');
  });

  it('② 迁移存在，且**只建新表**（不碰既有表 ⇒ 对生产零风险）', () => {
    expect(MIGRATION).toContain('CREATE TABLE "ForwardFxContract"');
    expect(MIGRATION).toContain('CREATE TABLE "ForwardFxSettlementLink"');
    const body = stripComments(MIGRATION);
    expect(body).not.toMatch(/\bDROP\b/);
    expect(body).not.toMatch(/\bALTER\b/);
  });

  it('③ 路由三端点齐全，写端点有 scope 门', () => {
    expect(ROUTE).toContain("router.get('/forward-fx'");
    expect(ROUTE).toContain("router.post('/forward-fx'");
    expect(ROUTE).toContain("router.post('/forward-fx/:id/settlements'");
    expect(ROUTE).toMatch(/router\.post\('\/forward-fx', requireRemitWrite/);
    // 错误码映射覆盖关键拒绝路径
    expect(ROUTE).toContain('DUPLICATE_CONTRACT');
    expect(ROUTE).toContain('CURRENCY_MISMATCH');
    expect(ROUTE).toContain('OVER_CONTRACT');
    expect(ROUTE).toContain('SETTLEMENT_ALREADY_LINKED');
  });

  it('★ ④ 不得把银行合约信息塞进 FxRateLock（语义不同，混在一起必然漂移）', () => {
    const start = SCHEMA.indexOf('model FxRateLock {');
    const end = SCHEMA.indexOf('\nmodel ', start + 10);
    const block = SCHEMA.slice(start, end);
    expect(block).not.toMatch(/contractNumber|bankName|maturityDate/);
  });

  it('⑤ 派生量走真源纯函数（不在路由里另写一套）', () => {
    expect(SERVICE).toContain('export function forwardFxRemainingOf');
    expect(SERVICE).toContain('export function forwardFxStatusOf');
    expect(SERVICE).toContain('export function forwardFxPnlCnyOf');
    expect(SERVICE).toContain('export function daysToMaturityOf');
    // 路由不直接算损益/状态（交给服务）
    expect(stripComments(ROUTE)).not.toMatch(/actualRate\s*-\s*contractRate/);
  });
});
