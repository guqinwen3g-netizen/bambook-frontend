/**
 * B68（G1/G3 真值面）：HTTP 状态档**不能由异常文本里的中文关键词猜**。
 *
 * ★ 病灶（三处并行实现）：`customs/customsRoute.ts`、`customs/customsRouteV2.ts`、`mes/mesRoute.ts`
 *   各一份 `errStatus(msg, fallback = 400)`。真正要修的是**默认档**：**77 个调用点里 76 个不传 fallback**
 *   ⇒ 于是一条 `ECONNREFUSED` / Prisma `P2003` / 事务超时**全都被说成"你的请求有问题"**。
 *
 * ★★ v2.45 复核更正（本文件第一版沿用了台账 v2.35 的过度陈述）："三份已经漂、MES 少两条『不可编辑/不可审核』"
 *   —— 词表逐条比确实不同，但 MES 那份本来就有 `includes('不可')`，而"不可编辑/不可审核"都含"不可"
 *   ⇒ **当时三域的实际行为是一致的**（复现：`git show 19d8bc5f~1:server/src/mes/mesRoute.ts` 第 103 行）。
 *   ⇒ 本批"取并集"**不产生任何可见行为变更**；唯一的可见变更是第 3 档带来的"系统故障 4xx → 500"。
 *
 * 本模块是**唯一**一份实现，判定顺序（从最可信到最不可信）：
 *   1) 错误自己带 `statusCode` / `status`（业务错误两件套写上的）
 *   2) 错误自己带**已登记**的 `code` ⇒ 取注册表里的档位（`errorCodes` 是本仓既有真源，不另立）
 *   2b) 错误带 Prisma 的已知请求错误码 `P2xxx` ⇒ 500（★ P1xxx **刻意不收**，理由与出处见该常量上的注释）
 *   2c) 错误是 `TypeError`/`SyntaxError`/`ReferenceError` ⇒ 500（v3.11 B131：只可能是我们在崩，不许甩给用户） —— **Prisma 把码放在 `.code`、不放进 message**，
 *       所以只扫文本会整类漏掉（v2.45 复核 IMPORTANT-3 指出的就是这个洞）
 *   3) 文本读起来是**系统故障** ⇒ 5xx（这一档必须排在关键词表前面，见下面的"为什么"）
 *   4) 最后才认历史那张业务文案关键词表（保持既有对外行为，不顺手改契约）
 *      ★ **表内顺序也是契约**：`404 → 409 → 缺输入 400`。新加的族必须排在最后，否则会把
 *        「输入非法，请检查必填字段」这类同时命中两族的文案从 409 静默改成 400（v3.11 复核抓到的就是这个）。
 *   5) 都不认 ⇒ 调用点给的 fallback（默认 400，与改造前一致）
 *      ⚠️ **B131 未完的部分**：默认档仍是 400，而一路掉到这里抛错文案有**百条量级**。
 *      具体数与口径**不许钉在这里**（写死一定腐烂）—— 用 `node scripts/tier-message-snapshot.mjs` 随时重跑，
 *      读数登记在 `docs/交付目标与验收标准-2026-09-20.md` §9 B131。
 *      本批刻意**不翻**默认档：掉到这里的东西里既有"我们的 bug / 配置缺失"，也有"业务拒绝但文案没入典"
 *      （例："仅 SuperAdmin 可授予"），直接翻成 500 会把后者伪装成服务端故障（对外契约方向）
 *      ⇒ 要先按快照分族，再逐族给码/给档。
 *
 * ★ 为什么 (3) 要在 (4) 前面：关键词表认的是「不可 / 非法 / 不存在」这类中文，而系统故障文案里
 *   同样可能出现「不可用」「数据库不存在」—— 挂在 (4) 后面就会把服务故障报成 409/404（客户端错）。
 *   先实测再动手：报关 + MES 两个服务层可静态取到的 **121 条**（v2.45 复核重新量的数；第一版写 120）
 *   抛错文案里，含系统故障字样的 **0 条** ⇒ 这一档不会把任何既有业务文案改判，只会把原本被误判成 4xx 的技术故障抬回 5xx。
 *
 * ⚠️ **今天真正吃到流量的是第 3 档，不是第 1、2 档**（v2.45 复核 BLOCK-2）：报关与 MES 的服务层
 *   **没有任何 `statusCode` 生产者**（`grep -rn statusCode server/src/{customs,mes}` 排除测试 = 0 命中），
 *   `processChainService` 抛的那几枚 `code` 也没登记进 `errorCodes` ⇒ 前两档在这两个域拿不到输入。
 *   ⇒ **收形状 ≠ 收语义**：要让 1、2 档真起作用，得先给这些域的抛错补"自带码 + 自带档"（台账 B68-1/B68-2 的下一步），
 *     这也是"余下 82 处不许机械替换"的理由。
 *
 * ★ 改造前的调用点分布（2026-09-21 实测）：三份实现共被叫 **77** 处，其中 **76 处不传 fallback ⇒ 一律默认 400**，
 *   只有 1 处显式给了 500 —— 这就是"方向错"的量化来源。
 */
import { lookupErrorCode, type BusinessErrorShape } from './errorCodes';

/** 第 3 档的标记：出现任一即按"系统故障"处理（保守取宽，宁可抬到 5xx 也不压成 400） */
const SYSTEM_FAILURE = /prisma|P20\d\d|can'?t reach database|unable to reach|database server|ECONN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|timeout|timed out|connect(?:ion)? (?:refused|reset|lost|timeout)|deadlock|transaction|roll(?:n)? back|internal server|unavailable|out of memory|\bOOM\b|数据库|数据层|连接(?:池|失败)|超时|内部错误|服务(?:暂时)?不可用|事务|回滚|foreign key|constraint|violated|does not exist|doesn't exist|no such (?:table|column)|record not found|relation "/i;

/**
 * 第 2b 档：Prisma 的"已知请求错误"码族（P2002 唯一键、P2003 外键、P2025 记录不存在、P2022 列/表缺失…）。
 * ★ 为什么要单列一档：Prisma 把这些码放在 **`error.code`**，message 里**不含** `P2xxx` 也不含类名
 *   ⇒ 只扫文本会整类漏掉（v2.45 复核 IMPORTANT-3）。这类错误全是**数据层**故障，对外只能是 5xx：
 *   "记录不存在"若是数据层抛出来的而不是服务层判出来的，说明服务层没走自己的查没到分支，
 *   把它报成 404 等于替它编一个业务语义（B68 的原话：这是"又一种现编"）。
 */
/** ★ v3.11（B131）试过把 P1xxx 也收进来，**已回退**：`bizStatusB68.test.ts` 第 65 行是前一批**写死的既定决定**（「P1xxx 不在这一档 ⇒ 不许顺手扩」，并配了断言）。而真实世界不需要这一扩：Prisma 连不上库时一定带「Can't reach database server」这句话 ⇒ 由第 3 档接（见 SYSTEM_FAILURE 里 v3.11 补的那三个词）。⇒ 教训：**动档位语义前先读这一族的守卫**，别把「当初为什么不做」当成「忘了做」。 */
const DATA_LAYER_ERROR_CODE = /^P2\d{3}$/;
/** 第 4 档：改造前那张关键词表（三个域取并集，避免"同一个原因在三域不同档"的既有漂移被固化） */
const BIZ_KEYWORDS: Array<[RegExp, number]> = [
  [/不存在/, 404],
  [/已存在|非法|不可删除|不可编辑|不可审核|不可|超过/, 409],
  // ★ v3.11（B131）"缺输入"族：把这一族从"靠默认档侥幸答对"改成"**由规则**答对"。两条必须一起看：
  //   ① **必须排在本表最后**。它会与上面两行同时命中 —— 仓里真有 `输入非法，请检查必填字段与枚举值`
  //     （`agent/qcFlow.ts:82`、`agent/samplesFlow.ts:68`），放前面就把它们从 409 **静默**改成 400
  //     （v3.11 复核实测到的就是这个）⇒ 排最后才是**结构性中性**，而不是"巧合没碰上"。
  //   ② 刻意**不收** `最多/不能超过`：那会与既有 `超过 ⇒ 409` 抢，而 409 那一档是对外契约（B68 写明不许顺手改）。
  //   ⚠️ 也不要把这一行读成"缺输入已收口"：`customs/documentTemplateService.ts:174-175` 写的是
  //     `模板名称不可为空` ⇒ 被上面的 `不可` 拿去 409，而该域自己的尺把"不可为空"当客户端错 ⇒ 改它要动 409 契约，已登记 §9 B131、不在本批。
  [/必填|不能为空|不得为空|缺少参数|未提供|请提供/, 400],
];

function explicitStatus(e: unknown): number | undefined {
  const err = e as BusinessErrorShape & { status?: unknown } | null | undefined;
  if (!err || typeof err !== 'object') return undefined;
  for (const v of [err.statusCode, (err as { status?: unknown }).status]) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

/** 把"一个错误"映射成 HTTP 档位。★ 刻意**不提供**"只给一段文本"的兼容签名 ——
 *   那等于把 B68 的病灶（用文本猜档）做成公开 API；调用点一律传错误对象，让 1、2 档有机会生效。 */
export function statusFromError(e: unknown, fallback = 400): number {
  const explicit = explicitStatus(e);
  if (explicit !== undefined) return explicit;

  const code = (e as { code?: unknown } | null)?.code;
  const registered = lookupErrorCode(code);
  if (registered) return registered.status;
  if (typeof code === 'string' && DATA_LAYER_ERROR_CODE.test(code)) return 500;   // 2b：Prisma P2xxx
  // ★ 2c（v3.11 B131）：**只可能是我们在崩**的那一族先抬回 500。默认档仍是 400（本批刻意不翻，理由见文件头），
  //   而 B68 当年就写明“真正要修的是默认档” —— 在翻默认档之前，先把**方向上绝不会冤枉用户**的几类收掉：
  //   `TypeError/SyntaxError/ReferenceError` 没有一条是终端用户能造成的（实测改造前 `Cannot read properties of undefined` 答 400，
  //   用户照着“请求有误”提示改半天也好不了）。刻意**不收** `RangeError`（可能是合法的大输入/深度）与“任意无码错误”
  //   （那要的是补码，不是在这儿替它现编一个档）。
  if (e instanceof TypeError || e instanceof SyntaxError || e instanceof ReferenceError) return 500;

  const msg = typeof (e as { message?: unknown })?.message === 'string'
    ? String((e as { message: string }).message)
    : typeof e === 'string' ? e : '';
  if (!msg) return fallback;
  if (SYSTEM_FAILURE.test(msg)) return 500;
  for (const [re, status] of BIZ_KEYWORDS) if (re.test(msg)) return status;
  return fallback;
}
