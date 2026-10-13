/**
 * B185 / B188（v3.74）：门禁汇总器自己的**行为**守卫。
 *
 * 为什么必须有一件：`gate-summary.mjs` 是"数别人读数"的那把尺，而它第一版恰好漏掉了
 * 它要防的那一类的**新形态** —— 今天真实发生：
 *   `server/src/finance/__tests__/forwardFxDrill.test.ts` 7 条用例**全部 passed**、
 *   文件 `status='failed'`（钩子/未捕获错误）、顶层 `success=false`、vitest 退出码 **1**，
 *   而当时的汇总器打的是 `失败=0 文件级错误=0`（它的规则要求"该文件没有通过的用例"才算错）。
 *   ⇒ 只差一步，"server 域全绿"就要被写进台账；拦下来的是链里保留的 **runner 退出码**那一道。
 *
 * ★ 不连库、不起服务：只喂合成 json + 跑一个 node 子进程。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = mkdtempSync(join(tmpdir(), 'gate-summary-'));

const run = (obj: any) => {
  const f = join(DIR, `t-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(obj));
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [join(REPO, 'scripts/gate-summary.mjs'), f], { encoding: 'utf8' });
  } catch (e: any) {
    out = String(e.stdout || '') + String(e.stderr || '');
    code = typeof e.status === 'number' ? e.status : 99;
  }
  return { out, code };
};

const caseOf = (n: number, status: string) => ({ assertionResults: Array.from({ length: n }, (_, i) => ({ status, fullName: `c${i}` })) });

describe('gate-summary · B185/B188：读数必须把"文件跑不起来"和"runner 不认账"算进去', () => {
  it('全绿：文件级错误=0、runner未成功=0、退 0', () => {
    const r = run({ success: true, numTotalTests: 3, testResults: [{ name: 'a.test.ts', status: 'passed', ...caseOf(3, 'passed') }] });
    expect(r.out).toMatch(/失败=0 文件级错误=0 跳过=0 其他状态=0 空文件=0 注册=3 runner未成功=0/);
    expect(r.out).toMatch(/^文件=1 /, '绿的时候汇总行不许带 !! 前缀');
    expect(r.code).toBe(0);
  });
  it('★ 今天那起真实事故的形状（用例全 passed、文件 status=failed、success=false）⇒ 必须报文件级错误并退 1', () => {
    const r = run({ success: false, numTotalTests: 7, testResults: [{ name: '/x/forwardFxDrill.test.ts', status: 'failed', ...caseOf(7, 'passed') }] });
    expect(r.out, '第一版就是在这一格上漏的：它要求"没有通过的用例"才算文件级错误').toMatch(/文件级错误=1/);
    expect(r.out).toMatch(/runner未成功=1/);
    expect(r.out).toMatch(/forwardFxDrill\.test\.ts/);
    expect(r.code).not.toBe(0);
  });
  // ★ 事故那一格是"文件级错误=1 且 runner未成功=1"同时成立 ⇒ 它隔离不出后半个分支。
  //   下面两格各只让一个维度坏，缺任何一格，"runner 这一只眼"就是没证人的守卫。
  it('★ 只有 runner 不认账（文件全 passed、success=false）⇒ 单靠 runner未成功=1 也必须退非 0', () => {
    const r = run({ success: false, numTotalTests: 1, testResults: [{ name: '/x/quiet.test.ts', status: 'passed', ...caseOf(1, 'passed') }] });
    expect(r.out).toMatch(/文件级错误=0/);
    expect(r.out).toMatch(/runner未成功=1/);
    expect(r.code).not.toBe(0);
  });
  it('success 字段整个缺失 ⇒ runner未成功=-1 且拦下（"没这个字段"不许读成 0）', () => {
    const r = run({ numTotalTests: 1, testResults: [{ name: '/x/no-field.test.ts', status: 'passed', ...caseOf(1, 'passed') }] });
    expect(r.out).toMatch(/runner未成功=-1/);
    expect(r.code).not.toBe(0);
  });
  it('transform 失败（文件里一条用例都没有）⇒ 同样报，且原文要打出来', () => {
    const r = run({ success: false, numTotalTests: 0, testResults: [{ name: '/x/broken.test.ts', status: 'failed', message: 'Transform failed: Unexpected "."', assertionResults: [] }] });
    expect(r.out).toMatch(/文件级错误=1/);
    expect(r.out).toMatch(/Transform failed/);
    expect(r.code).not.toBe(0);
  });
  it('★ skip 不许从分母里消失（I-2）：两条 skip + 一条 pass ⇒ 跳过=2 必须看得见', () => {
    const r = run({ success: true, numTotalTests: 3, testResults: [{ name: '/x/s.test.ts', status: 'passed',
      assertionResults: [{ status: 'skipped', fullName: 'a' }, { status: 'skipped', fullName: 'b' }, { status: 'passed', fullName: 'c' }] }] });
    expect(r.out).toMatch(/跳过=2/);
    expect(r.out).toMatch(/用例=1 /);   // 用例只数真跑过的；跳过另占一格 ⇒ 两数相加才等于注册数
  });
  it('空文件集（一个文件都没跑到）⇒ 不算通过', () => {
    const r = run({ success: true, numTotalTests: 0, testResults: [] });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/一个测试文件都没有/);
  });
  // ═══ v3.76 · B193（复核 #18 第 4、5 项）：默认值与"第三种隐身"═══
  it('★ 复核 #18 第 5 项：不带 --check 时 失败=9 也必须非零退出（旧版这里退 0，而全部证人都走这条分支）', () => {
    // 复核原话的形状：9 条失败 + 7 条通过（注册数 16 = 9+7，对账是平的 ⇒ 这一格只测"默认放行"这一维）
    const r = run({ success: true, numTotalTests: 16, testResults: [{ name: '/x/f.test.ts', status: 'failed',
      assertionResults: [...Array(7).keys()].map((i) => ({ status: 'passed', fullName: `p${i}` }))
        .concat([...Array(9).keys()].map((i) => ({ status: 'failed', fullName: `f${i}` }))) }] });
    expect(r.out).toMatch(/用例=16 失败=9/);
    // ★ 这里断言的是**这一维自己那句原因**，不是"退出码非 0"：突变实测（把 `failedTests>0` 那格摘掉）
    //   退出码仍然非 0 —— 因为真实 vitest 里有失败用例的文件本身 status=failed ⇒ 文件级错误那格先响了。
    //   也就是说这一格在真跑里是**第二层网**，不是唯一证人；只断言"非 0"会把这层网写成"有证人"（假覆盖）。
    expect(r.out, '这一维必须自己出声，不许搭文件级错误那格的便车').toMatch(/失败=9 条用例（v3\.76 起无条件拦/);
    expect(r.code, '旧实现是 `if (check && failedTests > 0)` ⇒ 默认调用下退 0').not.toBe(0);
    expect(r.out).toMatch(/^!! /, '不绿时汇总行必须以 !! 开头（人眼扫过也不会误判）');
  });
  it('★ 复核 #18 第 4 项之一：未知状态（todo）必须进 其他状态= 并拦下，不许静默掉出分母', () => {
    const r = run({ success: true, numTotalTests: 3, testResults: [{ name: '/x/t.test.ts', status: 'passed',
      assertionResults: [{ status: 'passed', fullName: 'a' }, { status: 'todo', fullName: 'b' }, { status: 'todo', fullName: 'c' }] }] });
    expect(r.out).toMatch(/其他状态=2/);
    expect(r.out).toMatch(/不属于 passed\/failed\/skipped\/pending 任何一档/, 'todo 既不是跑过也不是跳过 ⇒ 必须自己出声，不许静默掉出分母');
    expect(r.code).not.toBe(0);
  });
  it('★ 注册数与文件里报出来的用例对不上账 ⇒ 必须点名两个数并拦下（"有落点不在任何一档上"）', () => {
    const r = run({ success: true, numTotalTests: 10, testResults: [{ name: '/x/lost.test.ts', status: 'passed', ...caseOf(3, 'passed') }] });
    expect(r.out).toMatch(/对账不平：注册=10 ≠ 用例 3/);
    expect(r.code).not.toBe(0);
  });
  it('★ 复核 #18 第 4 项之二：文件 status=passed 却 0 条用例 ⇒ 空文件=1 且拦下（第三种隐身方式）', () => {
    const r = run({ success: true, numTotalTests: 0, testResults: [{ name: '/x/hollow.test.ts', status: 'passed', assertionResults: [] }] });
    expect(r.out).toMatch(/空文件=1/);
    expect(r.code, '旧版六格全零 + 退 0 ⇒ "整文件一条没注册"读成全绿').not.toBe(0);
    expect(r.out).toMatch(/hollow\.test\.ts/);
  });
  it('空文件那一格不许抢"文件级错误"的活（v3.74 那起事故两格必须各报各的）', () => {
    const r = run({ success: true, numTotalTests: 7, testResults: [{ name: '/x/ok.test.ts', status: 'passed', ...caseOf(7, 'passed') }] });
    expect(r.out).toMatch(/空文件=0/);
    expect(r.code, '有 7 条通过用例的文件不许被当成空壳').toBe(0);
  });
  it('★ 跳过只出声、不判红：刻意不做（降范围表第 46/47 条）不许被这把刀推翻', () => {
    const r = run({ success: true, numTotalTests: 4, testResults: [{ name: '/x/s2.test.ts', status: 'passed',
      assertionResults: [{ status: 'skipped', fullName: 'a' }, { status: 'skipped', fullName: 'b' }, { status: 'passed', fullName: 'c' }, { status: 'passed', fullName: 'd' }] }] });
    expect(r.out).toMatch(/跳过=2/);
    expect(r.out).toMatch(/降范围决策登记/);
    expect(r.code, '跳过是已拍板的范围，不是缺陷 ⇒ 拦它就等于替业务方改范围').toBe(0);
  });
  it('分母塌了 + runner 不认账 同时发生时，两条原因都要打出来（旧版先 exit 吞掉后一条）', () => {
    const r = run({ success: false, numTotalTests: 0, testResults: [] });
    expect(r.out).toMatch(/一个测试文件都没有/);
    expect(r.out).toMatch(/runner 顶层 success 不是 true/);
    expect(r.out).toMatch(/本次不绿：2 条前提不成立/);
    expect(r.code).not.toBe(0);
  });
});
