/**
 * B131 的活路径钉子（v3.11）：HTTP 档位的**默认兜底档是 400** 这件事，本批收掉了哪三族、刻意没收哪些。
 *
 * ★ 为什么这个文件里**没有**"改前答 400"的断言（重要，别再加回来）：
 *   改前的读数是一次性快照量的（240 条抛错文案 + 4 条运行时消息，逐条前后对账）：
 *     · 掉到兜底档（400）的抛错文案 **176 条**、404 26 条、409 37 条、500 只有 1 条；
 *     · 本批改完**只有 3 条移动**（TypeError 崩溃、"Can't reach database…" 带码/不带码两种），
 *       静态抛错文案 **0 条**改档 ⇒ "缺输入族"只是从"默认档侥幸答对"变成"由规则答对"。
 *   这类"改前是多少"的句子只能进台账 §9 B131，**不能进测试**：测试要钉的是"改后必须长期成立的语义"。
 *   本文件第一版就是把改前的值写成了断言，修法一落地就自杀红了 3 格 —— 是自家守卫拦下来的。
 *
 * ★ 全 mock：只 import 纯函数，不连库、不开端口 ⇒ 与 B15 那族无关，也不会因环境抖动。
 */
import { describe, expect, it } from 'vitest';
import { statusFromError } from '../bizStatus';
import { lookupErrorCode } from '../errorCodes';

describe('B131 · 本批收掉的三族（每族都配"不许被顺带动到"的反面对照）', () => {
  it('① 编程错误族 ⇒ 500（改前实测 400）；RangeError **刻意不收**，仍走兜底', () => {
    const crash = new TypeError("Cannot read properties of undefined (reading 'x')");
    expect((crash as any).code, '前提：这类错误没有 code ⇒ 注册表那一档拿不到它（所以才需要 2c 这一档）').toBeUndefined();
    expect(statusFromError(crash)).toBe(500);
    expect(statusFromError(new SyntaxError('Unexpected token }'))).toBe(500);
    expect(statusFromError(new ReferenceError('boom is not defined'))).toBe(500);
    // 反面对照：RangeError 可能由合法的大输入/递归深度造成 ⇒ 收进来就是把合法输入判成服务端故障
    expect(statusFromError(new RangeError('Invalid array length'))).toBe(400);
    expect(statusFromError(new RangeError('Invalid array length'), 503),
      '它确实是在兜底档上（喂什么答什么）⇒ 证明它没被 2c 扫进去').toBe(503);
  });

  it('② P1xxx **不**走 2b —— 前一批写死的既定决定，本批第一版扩了、被自家守卫拦回，现原样保住', () => {
    // 出处：`bizStatusB68.test.ts:65` 断言「P1xxx（引擎初始化错误）不在这一档 ⇒ 不许顺手扩」。
    expect(statusFromError({ code: 'P1001', message: '完全不像故障的业务文案' }),
      'P1xxx 单独出现不许被扫进 500（既有决定；要改得先立账说理由，别在别的批里顺手改）').toBe(400);
    // 而真实世界的 P1001 一定带那句话 ⇒ 由第 3 档接住，根本不需要动码族：
    expect(statusFromError(Object.assign(new Error("Can't reach database server at localhost:5432"), { code: 'P1001' })),
      '真实"连不上库"的 P1001：靠 message 走系统档 ⇒ 500').toBe(500);
  });

  it('③ "连不上数据库"的英文原话 ⇒ 500（改前 400）；**未入典的措辞仍走兜底** ⇒ 边界写诚实', () => {
    expect(statusFromError(new Error("Can't reach database server at localhost:5432"))).toBe(500);
    expect(statusFromError(new Error('Can not reach database server'))).toBe(500);
    expect(statusFromError(new Error('db box is down right now')),
      '未入典措辞仍掉兜底 ⇒ 这就是"176 条要逐族给码/给档"的原因，不许引用本格说连接类故障已收口').toBe(400);
  });

  it('④ "缺输入"族：读数与改前**相同**（400），但从"默认档兜住"变成"由规则给出" —— 拿兜底档当探针区分', () => {
    for (const m of ['业务线代码必填', 'body.name 不能为空', '缺少参数 tenantId', '请提供 actorId', '未提供 requestId']) {
      expect(statusFromError(new Error(m), 500),
        '「' + m + '」若靠默认档兜着，喂 500 就会变 500；现在必须仍读 400 ⇒ 证明是规则给的').toBe(400);
    }
  });

  it('⑤ 对外契约没被动到（B68 写明的既有档位，改前改后必须一样）', () => {
    expect(statusFromError(new Error('贸易单据 DOC-1 不存在'))).toBe(404);
    expect(statusFromError(new Error('状态非法，不能删除'))).toBe(409);
    expect(statusFromError(new Error('最多不能超过 10 行')),
      '「超过 ⇒ 409」是既有对外契约，本批刻意**不**把它让给新的 400 族').toBe(409);
    expect(statusFromError(new Error('金额超过授信额度'))).toBe(409);
    expect(statusFromError(Object.assign(new Error('dup'), { code: 'P2002' }))).toBe(500);
    expect(statusFromError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(500);
  });

  it('⑥ 默认档本身**仍是 400**（本批刻意没翻）：空消息、未登记码、没入典的散文都吃它', () => {
    expect(statusFromError(new Error(''))).toBe(400);
    // ⚠️ 这一格**刻意不钉**"某条业务拒绝文案现在答 400"（我第一版钉了）—— 下一批的正确修法就是给它登记一枚码，
    //    那时那条断言会红着挡路 ⇒ 钉"未登记"这个**前提**，不钉"因此答几档"这个**会被自己修掉的结果**。
    expect(lookupErrorCode('ROLE_GRANT_DENIED'), '未登记的码 ⇒ 第 2 档拿不到它（这才是"要给它补码"这句话的证据）').toBeUndefined();
    expect(statusFromError(new Error('')), '空消息没有任何文本可判 ⇒ 只能吃兜底；这一条不会被"补码"修掉，可以钉').toBe(400);
  });
});
