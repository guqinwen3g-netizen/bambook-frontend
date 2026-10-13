#!/usr/bin/env node
/**
 * B274 · 取号并发演练（可重跑版）—— 2026-09-28
 *
 * 存在的理由：台账 §9 B274 里那两组"5 路同时提交 ⇒ 15/15 成功、0 撞号"的读数，
 * 演练件此前只写在 /tmp ⇒ **不可重跑**（那句读数只剩保质期，没有证人）。
 * 本件把同一刀搬进仓库：走 **真 HTTP + 真后端 + 真 PostgreSQL**，量的是产品路径上的并发取号，
 * 不是单测里的假库。跑不动的时候它**拒绝出数**（后端身份不成立 / 口令没给 / 可用订单不够），
 * 绝不把"没跑"印成"通过"。
 *
 * 每轮三格判据（两站各跑 ROUNDS 轮，每轮 FANOUT 路同时提交）：
 *  ① N 路全部 201 ⇒ 0 次撞号（旧写法 count+1 在同一天并发必然出现 P2002 或重号）；
 *  ② N 个号**互不相同**且面格式逐字仍是 EXC-YYYYMMDD-NNN / OCR-YYYYMMDD-NNN（日付钉死本机日）；
 *  ③ SequenceRegister 的增量 === 累计成功张数（多消费＝回滚没退号；少消费＝有别人在取号 ⇒ 读数作废），
 *     外加每张主单都带得到一个真实存在的审批单行（事务外先建、建完没写主单两种坏法都会红）。
 *
 * ★ 挑单口径（为什么每轮重新挑、每轮末尾清）：审批单按 requesterId+actionType+targetId 幂等复用
 *   （已立账 B276）。同一轮里并发路**必须各用一张不同订单**，否则审批单会被复用 ⇒ ③那格
 *   "审批单齐"被 B276 那一族顶下来，抓到的就不是取号问题。轮与轮之间末尾自清，
 *   所以订单存量只需 FANOUT 张（本机 Confirmed 订单现量只有 6 张，不够 15 张 —— 这是本件的成因）。
 *
 * 覆盖边界（不许越过去解读）：只证**并发取号**与**审批单同生共死**这两条；
 *  不证失败注入那一格（在 server 侧真库件 numberingRollbackRealDbB274 / numberingRollbackRealDbOcrB274），
 *  不证屏面渲染（在 ① 的走查件），也不证生产形态（本仓从未部署、从未 push）。
 *
 * 用法（口令只从环境读，本件不打印凭证）：
 *   cd server && B274_DRILL_PASSWORD=… node scripts/b274-numbering-concurrency-drill.mjs [--self-check] [--rounds 3] [--fanout 5]
 * 前置：后端已重启到当前 HEAD；且这段时间没有别的东西在取号（否则③那格红＝读数作废，不是产品的错）。
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const API = (process.env.B274_DRILL_API ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');
const EMAIL = process.env.B274_DRILL_EMAIL ?? 'jason.shen@bambook.local';
const PASSWORD = process.env.B274_DRILL_PASSWORD ?? '';
const SELF_CHECK = process.argv.includes('--self-check');
const num = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(process.argv[i + 1])) ? Number(process.argv[i + 1]) : dflt;
};
const ROUNDS = num('--rounds', 3);
const FANOUT = num('--fanout', 5);
const SWEEP = process.argv.includes('--sweep');

// 自造自清的抓手：两站都用**精确等值**标记（不用前缀 ⇒ 不去顶宽任何一把尺）
const EXC_SUB = 'b274_http_drill';
const OCR_REASON = 'B274 取号并发演练：客户要求把交货期顺延两周，需走改单申请留痕（本件跑完按自造自清删掉）。';
const OCR_IMPACT = '影响交期与后续出运排期，需与客户确认新港船期；本合同项下暂无不可逆承诺，未收款未出运。';

const localDayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DAY = localDayKey().replace(/-/g, '');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` ⇒ ${detail}` : ''}`); }
  return cond;
};

/**
 * 按本件自己写的两个**精确等值**标记清扫（也用于"上一批崩了没清掉"的现场恢复：`--sweep`）。
 * 判据绝不宽于自己的写入：只碰 subCategory / changeReason 这两个本件写入的字面量，以及这些行记着的审批单。
 */
async function sweep(prisma) {
  const exc = await prisma.dr013ExceptionRequest.findMany({ where: { subCategory: EXC_SUB }, select: { id: true, approvalRequestId: true } });
  const ocr = await prisma.orderChangeRequest.findMany({ where: { changeReason: OCR_REASON }, select: { id: true, approvalRequestId: true } });
  const rowIds = [...exc.map(x => x.id), ...ocr.map(x => x.id)];
  const apprIds = [...new Set([...exc, ...ocr].map(x => x.approvalRequestId).filter(Boolean))];
  if (rowIds.length + apprIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { targetId: { in: [...rowIds, ...apprIds] } } });
    await prisma.dr013ExceptionRequest.deleteMany({ where: { subCategory: EXC_SUB } });
    await prisma.orderChangeRequest.deleteMany({ where: { changeReason: OCR_REASON } });
    await prisma.approvalRequest.deleteMany({ where: { id: { in: apprIds } } });
  }
  const [leftExc, leftOcr, leftAppr] = await Promise.all([
    prisma.dr013ExceptionRequest.count({ where: { subCategory: EXC_SUB } }),
    prisma.orderChangeRequest.count({ where: { changeReason: OCR_REASON } }),
    prisma.approvalRequest.count({ where: { id: { in: apprIds } } }),
  ]);
  return { exc: exc.length, ocr: ocr.length, appr: apprIds.length, leftExc, leftOcr, leftAppr };
}

/** 判决核（纯函数，好喂反例）：张数/撞号/格式漂移/号被多消费/审批单缺失，五类都在这里判 */
export function judgeRound({ numbers, expectN, seqDelta, approvalOkCount, formatRe }) {
  const issues = [];
  if (numbers.length !== expectN) issues.push(`成功张数 ${numbers.length} ≠ 并发路数 ${expectN}`);
  if (new Set(numbers).size !== numbers.length) issues.push(`撞号：${numbers.length} 张里只有 ${new Set(numbers).size} 个唯一号`);
  for (const n of numbers) if (!formatRe.test(n)) issues.push(`号的面格式漂移：${n}`);
  if (seqDelta !== expectN) issues.push(`发号表增量 ${seqDelta} ≠ 本轮成功张数 ${expectN}（多＝回滚没退号，少＝有别人在取号 ⇒ 本次读数作废）`);
  if (approvalOkCount !== expectN) issues.push(`带真实存在审批单行的主单 ${approvalOkCount} ≠ ${expectN}`);
  return issues;
}

function selfCheck() {
  console.log('— 判据自证（反例必须各被抓住，否则实跑那些 ✓ 不算数）');
  // ★ 这里的 formatRe 与实跑同一形状：**日期钉死成今天**（不写 \d{8} 那种"任意日期"）。
  //   因为 B274 那处改动的语义变化正是"日切从 UTC 换成本机时区"——日付前缀写错必须能被抓住。
  const base = {
    numbers: [`EXC-${DAY}-001`, `EXC-${DAY}-002`], expectN: 2, seqDelta: 2, approvalOkCount: 2,
    formatRe: new RegExp(`^EXC-${DAY}-\\d{3}$`),
  };
  ok('反例·撞号', judgeRound({ ...base, numbers: [`EXC-${DAY}-001`, `EXC-${DAY}-001`] }).some(s => s.includes('撞号')));
  ok('反例·号的面格式漂移（含日付前缀不对＝UTC/本机日切写歪）', judgeRound({ ...base, numbers: [`EXC-${DAY}-001`, 'EXC-20260101-002'] }).some(s => s.includes('格式漂移')));
  ok('反例·号被多消费（回滚没退号的形状）', judgeRound({ ...base, seqDelta: 5 }).some(s => s.includes('发号表增量')));
  ok('反例·有别人在取号（号被少消费）', judgeRound({ ...base, seqDelta: 1 }).some(s => s.includes('发号表增量')));
  ok('反例·主单没带上审批单', judgeRound({ ...base, approvalOkCount: 1 }).some(s => s.includes('审批单行')));
  ok('正例·等价写法不假红（五格齐 ⇒ 无 issue）', judgeRound(base).length === 0, JSON.stringify(judgeRound(base)));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    if (!PASSWORD) throw new Error('没给 B274_DRILL_PASSWORD ⇒ 本件拒绝取数（"没跑"不许印成"通过"）');

    // 前置 1：后端身份＝当天代码（跑在旧后端上的绿不算读数）
    const health = await fetch(`${API}/api/health`).then(r => (r.ok ? r.json() : Promise.reject(new Error(`health HTTP ${r.status}`))));
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    if (!head) throw new Error('git rev-parse HEAD 取空 ⇒ 身份判据无法成立，拒绝出数');
    if (spawnSync('git', ['merge-base', '--is-ancestor', health.build, head], { encoding: 'utf8' }).status !== 0) {
      throw new Error(`后端 build=${health.build} 不是 HEAD=${head} 的祖先 ⇒ 拒绝出数`);
    }
    const changed = new Set((spawnSync('git', ['log', '--format=', '--name-only', `${health.build}..${head}`, '--', 'server/'], { encoding: 'utf8' }).stdout ?? '')
      .split('\n').map(s => s.trim()).filter(Boolean));
    if (changed.size > 0) throw new Error(`该端口自报 build=${health.build}，其后至 HEAD 有 ${changed.size} 个 server/ 文件变过 ⇒ 跑的是旧代码，先重启到 ${head}`);
    console.log(`✓ 后端身份：build=${health.build} 到 HEAD 之间 server/ 零变动（读数署得到 ${head.slice(0, 8)}）`);

    // 前置 2：登录
    const loginRes = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status} ⇒ 账号/口令变了？（本件不打印凭证）`);
    const lj = await loginRes.json();
    const token = lj.token ?? lj.accessToken ?? lj.data?.token;
    if (!token) throw new Error('登录响应里没有 token ⇒ 判据无法取数');

    const post = async (path, body) => {
      const res = await fetch(`${API}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, j: await res.json().catch(() => ({})) };
    };
    const regSeq = async (seqType) => (await prisma.sequenceRegister.findUnique({ where: { id: `SEQREG_${seqType}_${localDayKey()}` }, select: { currentSeq: true } }))?.currentSeq ?? 0;
    /** 每轮重新挑：并发路各用一张不同订单，且这轮开始前名下既无待批变更也无 order:change 审批单 */
    async function pickUsable(n) {
      const cand = await prisma.order.findMany({ where: { deletedAt: null, status: 'Confirmed' }, select: { id: true }, orderBy: { updatedAt: 'desc' } });
      const out = [];
      for (const o of cand) {
        if (out.length >= n) break;
        const [pending, anyAppr] = await Promise.all([
          prisma.orderChangeRequest.findFirst({ where: { orderId: o.id, status: 'Pending', deletedAt: null }, select: { id: true } }),
          prisma.approvalRequest.findFirst({ where: { actionType: 'order:change', targetId: o.id }, select: { id: true } }),
        ]);
        if (!pending && !anyAppr) out.push(o.id);
      }
      return out;
    }
    /** 主单带的那个审批单是不是真的在库里（孤儿/漏建都数不进来） */
    const approvalsExist = async (ids) => {
      const clean = ids.filter(Boolean);
      if (clean.length === 0) return 0;
      return new Set((await prisma.approvalRequest.findMany({ where: { id: { in: clean } }, select: { id: true } })).map(f => f.id)).size;
    };
    /** 末尾自清：只删本件记下的 id（删不可归因的行＝造假清零） */
    async function cleanup(list) {
      for (const c of list) {
        await prisma.auditLog.deleteMany({ where: { targetId: { in: [c.id, c.approvalId].filter(Boolean) } } });
        if (c.station === 'EXC') await prisma.dr013ExceptionRequest.delete({ where: { id: c.id } });
        else await prisma.orderChangeRequest.delete({ where: { id: c.id } });
        if (c.approvalId) await prisma.approvalRequest.delete({ where: { id: c.approvalId } });
      }
      return list.length;
    }

    /** 两站的请求体（探针与实跑共用同一份 ⇒ 不会出现"探针验的是另一形状"；tag 只给探针用，避开实跑那一发的 targetId） */
    const excBody = (r, i, tag = '') => ({
      exceptionCategory: 'price_deviation', subCategory: EXC_SUB, bypassedApprovalIds: [],
      exceptionReason: `B274 取号并发演练 R${r + 1}：客户临时改价导致毛利低于成本线，需要走例外放行以避免交付延误与违约索赔。`,
      customerCommitment: '客户书面确认维持原价',
      riskMitigationPlan: '限定本单一次性放行，本件跑完按自造自清口径删除自己建的行',
      targetType: 'Order', targetId: `b274-drill-exc-${DAY}${tag}-r${r}i${i}`, action: 'shipment:release',
      validUntil: new Date(Date.now() + 86400000).toISOString(), maxUses: 1,
      responsibleOwnerId: 'usr_demo_boss',
    });
    const ocrBody = (orderId, i) => ({
      orderId, changeType: 'delivery',
      beforeSnapshot: { deliveryDate: '2026-10-15' }, afterDelta: { deliveryDate: `2026-11-${String(10 + i).padStart(2, '0')}` },
      changeReason: OCR_REASON, impactSummary: OCR_IMPACT,
    });

    // 前置 3：★ 响应形状的硬前置。第一批我凭"服务层返回结构"猜了路由层的字段路径 ⇒
    //   30 路全被读成"0 成功"，可库里那 30 张该写还是写了（判据说没成、库却成了）。
    //   所以现在先各打一发，验"判据读的字段真的在那儿"，不对就当场拒绝开跑（发出来的探针行随即 sweep 掉）。
    const probeExc = await post('/api/v1/exceptions', excBody(0, 0, '-probe'));
    const oneOrder = await pickUsable(1);
    const probeOcr = oneOrder.length ? await post('/api/v1/order-changes', ocrBody(oneOrder[0], 0)) : { status: 0, j: {} };
    const shapeExc = probeExc.status === 201 && !!probeExc.j?.exception?.exceptionNumber && !!probeExc.j?.approvalRequestId;
    const shapeOcr = probeOcr.status === 201 && !!probeOcr.j?.changeRequest?.requestNumber && !!probeOcr.j?.approvalRequestId;
    const swept = await sweep(prisma);
    ok('前提：EXC 建单响应里判据读的那三个字段真在（顶层键现读，不靠记忆）', shapeExc,
      `status=${probeExc.status} 顶层键=${JSON.stringify(Object.keys(probeExc.j ?? {}))}`);
    ok('前提：OCR 建单响应同上', shapeOcr,
      `status=${probeOcr.status} 顶层键=${JSON.stringify(Object.keys(probeOcr.j ?? {}))}`);
    ok('前提：探针行已被 sweep 清干净（数的是**清完之后**的存量）', swept.leftExc === 0 && swept.leftOcr === 0 && swept.leftAppr === 0,
      `删掉 EXC=${swept.exc} OCR=${swept.ocr} 审批单=${swept.appr} ⇒ 剩 ${swept.leftExc}/${swept.leftOcr}/${swept.leftAppr}`);
    if (!shapeExc || !shapeOcr) throw new Error('响应形状与判据读的字段不一致 ⇒ 拒绝开跑（先看路由层返回什么，别改判据）');

    const totalCreated = [];
    // ═════════ 站 1：EXC（异常处置单）—— targetId 每路唯一，不占订单名额
    console.log(`\n— 站 1 EXC：${ROUNDS} 轮 × ${FANOUT} 路同时提交`);
    {
      let done = 0;
      for (let r = 0; r < ROUNDS; r += 1) {
        const seqBefore = await regSeq('exceptionRequest');
        const settled = await Promise.all(Array.from({ length: FANOUT }, (_, i) => post('/api/v1/exceptions', excBody(r, i))));
        const good = settled.filter(x => x.status === 201 && x.j?.exception?.exceptionNumber);
        const bad = settled.filter(x => !String(x.status).startsWith('2')).map(x => `${x.status}:${x.j?.error ?? '?'}`);
        ok(`EXC 轮 ${r + 1}：${good.length}/${FANOUT} 成功`, good.length === FANOUT, bad.join(' | '));
        const numbers = good.map(x => x.j.exception.exceptionNumber);
        const mine = good.map(x => ({ station: 'EXC', id: x.j.exception.id, approvalId: x.j.approvalRequestId }));
        const issues = judgeRound({
          numbers, expectN: FANOUT, seqDelta: (await regSeq('exceptionRequest')) - seqBefore,
          approvalOkCount: await approvalsExist(mine.map(m => m.approvalId)),
          formatRe: new RegExp(`^EXC-${DAY}-\\d{3}$`),
        });
        ok(`EXC 轮 ${r + 1} 判决`, issues.length === 0,
          issues.length ? issues.join(' ; ') : `${[...numbers].sort()[0]} … ${[...numbers].sort().slice(-1)} 唯一、号增量=${FANOUT}、审批单齐`);
        await cleanup(mine);
        done += mine.length; totalCreated.push(...mine);
      }
      ok('站 1 总数：建单张数 === 轮数×并发路数', done === ROUNDS * FANOUT, `${done}/${ROUNDS * FANOUT}`);
    }

    // ═════════ 站 2：OCR（改单申请）—— 每路一张不同订单，轮末自清后下一轮复用名额
    console.log(`\n— 站 2 OCR：${ROUNDS} 轮 × ${FANOUT} 路同时提交`);
    {
      let done = 0;
      for (let r = 0; r < ROUNDS; r += 1) {
        const usable = await pickUsable(FANOUT);
        if (usable.length < FANOUT) {
          ok(`OCR 轮 ${r + 1} 前提：够 ${FANOUT} 张可用订单`, false, `实有 ${usable.length} 张（本机 Confirmed 订单本来就少）⇒ 该轮不出数`);
          break;
        }
        const seqBefore = await regSeq('orderChangeRequest');
        const settled = await Promise.all(usable.map((orderId, i) => post('/api/v1/order-changes', ocrBody(orderId, i))));
        const good = settled.filter(x => x.status === 201 && x.j?.changeRequest?.requestNumber);
        const bad = settled.filter(x => !String(x.status).startsWith('2')).map(x => `${x.status}:${x.j?.error ?? '?'}`);
        ok(`OCR 轮 ${r + 1}：${good.length}/${FANOUT} 成功`, good.length === FANOUT, bad.join(' | '));
        const numbers = good.map(x => x.j.changeRequest.requestNumber);
        const mine = good.map(x => ({ station: 'OCR', id: x.j.changeRequest.id, approvalId: x.j.approvalRequestId }));
        const issues = judgeRound({
          numbers, expectN: FANOUT, seqDelta: (await regSeq('orderChangeRequest')) - seqBefore,
          approvalOkCount: await approvalsExist(mine.map(m => m.approvalId)),
          formatRe: new RegExp(`^OCR-${DAY}-\\d{3}$`),
        });
        ok(`OCR 轮 ${r + 1} 判决`, issues.length === 0,
          issues.length ? issues.join(' ; ') : `${[...numbers].sort()[0]} … ${[...numbers].sort().slice(-1)} 唯一、号增量=${FANOUT}、审批单齐`);
        await cleanup(mine);
        done += mine.length; totalCreated.push(...mine);
      }
      ok('站 2 总数：建单张数 === 轮数×并发路数', done === ROUNDS * FANOUT, `${done}/${ROUNDS * FANOUT}`);
    }

    // ═════════ 残留断言（两站各自的精确等值标记 + 记下的审批单 id）
    console.log('\n— 残留断言（每轮末尾已自清，这里再数一遍）');
    const [leftExc, leftOcr, leftAppr] = await Promise.all([
      prisma.dr013ExceptionRequest.count({ where: { subCategory: EXC_SUB } }),
      prisma.orderChangeRequest.count({ where: { changeReason: OCR_REASON } }),
      prisma.approvalRequest.count({ where: { id: { in: totalCreated.map(c => c.approvalId).filter(Boolean) } } }),
    ]);
    ok('残留清点：两站标记行与记下的审批单全部归 0', leftExc === 0 && leftOcr === 0 && leftAppr === 0,
      `EXC=${leftExc} OCR=${leftOcr} 审批单=${leftAppr}（不归零＝本件在库里留了脏，别把下一次读数当基线）`);
    console.log('  · 发号表**刻意不回退**：演练消费掉的号留在 SequenceRegister（号有洞不是脏数据，手动回退才是造假）');
    console.log(`\n读数：pass=${pass} fail=${fail} · 建单 ${totalCreated.length} 张（两站各 ${ROUNDS} 轮 × ${FANOUT} 路）`);
    return fail === 0 ? 0 : 1;
  } catch (e) {
    console.log(`✗ 本件拒绝出数：${e?.message ?? e}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

// --sweep：只按本件自己那两个精确标记清场（上一批崩了没清干净时的恢复出口）
if (SWEEP) {
  const prisma = new PrismaClient();
  const r = await sweep(prisma);
  console.log(`sweep 读数：删掉 EXC=${r.exc} OCR=${r.ocr} 审批单=${r.appr} ⇒ 清完后存量 EXC=${r.leftExc} OCR=${r.leftOcr} 审批单=${r.leftAppr}`);
  await prisma.$disconnect();
  process.exitCode = r.leftExc === 0 && r.leftOcr === 0 && r.leftAppr === 0 ? 0 : 1;
} else if (SELF_CHECK) {
  selfCheck();
  console.log(`\n自证读数 pass=${pass} fail=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  main().then(rc => { process.exitCode = rc; });
}
