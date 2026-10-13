# S0-A2 第 8 批（B42·A1 首清）：products 12 + notifications 10 路由级直发收口 —— ★改文案前先量"日志有没有"，结果通知域 10 处**一条日志都没有**

> 目标来源：注册目标第 ⑤ 项「S0-A2 文案线并行继续：清 B42 的 A1 路由级直发（`products/route.ts` 12 · `notifications/route.ts` 10，D51 先按站点实测日志再换文案）」。
> 判据基准：`docs/交付目标与验收标准-2026-09-20.md`（本批开始时首行 **v2.26**）。B42 立账见 `docs/S0A2-第7j批-*.md`，逐处两分清单见 `docs/B42-路由级与内部对象两分清单-2026-09-21.md`。
> 本批性质：**修缺陷 + 收敛真源**，不动任何判据的定义（只移动三处已登记基线的数）。

---

## 〇、一句话

22 处「原始异常文本直接进响应体」的出口收口了，用户在产品档案与通知两屏看到的不再是 `PrismaClientKnownRequestError: P2002 ...`；
顺带量出**通知域此前对该域所有失败零日志** —— 也就是说这批修的不是"文案不好看"，而是"**出了问题既看不见也没得查**"。

## 一、这批清的是什么形状（以及为什么"门禁全绿"在这里不算证据）

形状：`res.status(500).json({ error: 'X_FAILED', message: String(e?.message ?? e) })` —— 原文包在**对象字面量**里。

| 既有判据 | 认不认这个形状 | 为什么 |
|---|---|---|
| B22 `rawErrorLeakRatchet` | **半认**（漏 1 处） | 它的正则是 `/res\.status\([^)]*\)\.json\([^\n]*e\?\.message/`（`routeError.test.ts:45`）—— **写死了标识符 `e`**。products 的事务出口写的是 `String(txErr?.message ?? txErr)`（收敛前 `:783`）⇒ 同一形状、换个变量名就少记一处。实测：B22 表里 products 记 **11**，B42 普查记 **12**。 |
| B33/B36①/B36②/B37/B39 | **不认** | 五支分别认"裸 `e.message` 位置参数""`fail(码, e.message, N)`"等写法，隔着 `String(` 与对象字面量后全部看不见（7j 批按偏移量过重叠 = 0）。 |

⇒ **本批的"改完了"不能拿"全量门禁没变红"当证据**，必须真打端点看响应体（见 §五）。这也是 D49 的立场：这类形状**不配再补一支正则判据**（正则判"是否直达响应体"= 造第二套真源），A 类清完再谈。

## 二、D51：先量日志，再换文案（改文案之前必须做，否则会把问题从"看得见"改成"看不见"）

| 域 | HEAD 版 `logger.` 次数 | 站点数 | 结论 | 本批动作 |
|---|---|---|---|---|
| `server/src/notifications/route.ts` | **0** | 10 | ★ **整域零日志** —— 原文当时是唯一的线索，直接换文案就会把"失败"变成"无声失败" | 每处**先加** `logger.error('[notifications] <端点> failed', { error: e?.message ?? String(e) })`，再换出口 ⇒ 工作树版 **10 条日志 / 10 站点**（1:1） |
| `server/src/products/route.ts` | **12** | 12 | 12 处**全部已有日志**（含 `txErr` 那一处）⇒ 原文没丢，只是同时上了屏 | 不新增日志，只把出口收敛到 `safeRouteError` |

⚠️ 这个"1:1"是**实测**（`grep -c`）不是推定：**日志与站点必须逐域核**，因为"先加日志"加多了就是重复噪声。

## 三、做了什么

1. **18 枚兜底码登记进唯一注册表** `server/src/shared/errorCodes.ts`：products 域 8 枚（`PRODUCT_LIST/EXCLUSIVITY_CHECK/QUERY/DETAIL/CREATE/UPDATE/DELETE/IMAGE_UPLOAD_FAILED`）+ notifications 域 10 枚（`NOTIFICATION_LIST/STATS/MARK_READ/MARK_ALL_READ/DELETE/DISMISS/PREFERENCES/PREFERENCE_UPSERT/CATALOG/CONVERT_FAILED`），全部 `status: 500` + 中文文案。
   **为什么带域名前缀**：注册表是**跨域共享**的，而 `LIST_FAILED`/`DELETE_FAILED` 这类名字全仓十几个域各写各的（`handleError(res, e, 'LB_LIST_FAILED')`、`'QC_LOCATION_DELETE_FAILED'`、`'DT_LIST_FAILED'`… 已经是既有习惯）。若我登记一枚裸 `LIST_FAILED`，就等于**替别的域的同名码定了状态与文案** —— 那是新增一处越权真源。HR 域此前已按 `HR_*` 同法处理。
2. **22 处出口统一为**：`const r = safeRouteError(e, { fallbackCode: '…' }); return res.status(r.status).json({ error: r.code, message: r.message });`
   ⇒ 码与状态的真源在注册表，路由里**不再出现 `res.status(500)` 字面量**（B32 的"三元/本地表"债一条未增）。
3. **响应体形状保持 flat**（`{ error, message }`）：两域前端都读这个形状，没动。
4. **三处已登记基线随实数移动**（不是放宽）：
   - `routeError.test.ts`：`FROZEN_RAW_ERROR_LEAKS` 的 `'products/route.ts': 11` **整行删除**（该文件已接真源，表上不再记它）。
   - `routeErrorSourceGuard.test.ts`：`FROZEN_NO_TRUTH_ROUTES` 删 `notifications/route.ts`、`products/route.ts` 两行 ⇒ 这两域从此受"已收敛文件必须 import 真源"那条正向钉约束。
   - `domainErrorShapes.test.ts`（B29 普查）：`safeRouteError` 站点 **252 → 274**、不同码 **132 → 150**；三支合计站点 **273 → 295**、码 **152 → 170**。
     ★ **自洽交叉验证**（这是我没预料到的、纯靠基线跑出来的对账）：站点 **+22 = 12+10**、码 **+18** —— 12 个 products 站点只用 8 枚码（列表/详情/删除各有复用），10 个通知站点用 10 枚 ⇒ 8+10=18。**两个数各自独立对上，说明"改了几处"与"登记了几枚"没有互相冒充。**

## 四、行为变更（必须单列）

| 变更 | 收敛前 | 收敛后 | 影响面 |
|---|---|---|---|
| 产品档案 11 个端点、通知 10 个端点在**未预期异常**下的响应体 | `message` = 原始异常文本（含 Prisma 错误码、SQL 片段、集合名） | `message` = 注册表中文一句，`error` = 域名前缀码 | 只影响失败路径；**状态码未变**（原本就是 `res.status(500)`，注册表也是 500） |
| **`error` 字段值改名**（`LIST_FAILED` → `PRODUCT_LIST_FAILED` 等 18 枚） | 通用名 | 域名前缀名 | ★ 现读证据两条：① 全仓**没有任何前端消费者**按这些码分支（`components/ProductsManager.tsx` 里 `.error` 分支 **0 处**）；② 裸 `LIST_FAILED`/`DELETE_FAILED` 被 **7+ 个其他域各自发着**（`suppliers/factoryRoute.ts:102`、`seasons/seasonRoute.ts:100`、`reporting/route.ts:165/:329`、`email/templateRoute.ts:203`、`devPanel/route.ts:124`、`business-profiles/route.ts:44`、`shipping/route.ts:226`…）⇒ **登记裸名 = 替那些域定状态与文案**，前缀不是审美选择，是不越权 |
| 通知域失败的**可观测性** | 无日志 + 原文上屏（用户替我们存了错误） | 有 `logger.error` + 用户只见中文 | ★ 运维侧从"要问用户屏幕写了啥"变成"看日志" |
| 业务错误（带 `code`+`statusCode`）透传 | 原样透传 | **仍原样透传**（`safeRouteError` 对业务形状永不套用兜底文案） | 无 —— 这条是这批最容易做坏的地方，已双向钉住（§五.2） |

### ★ "状态码未变"这句是量出来的，不是推的

1. HEAD 版两文件 catch 里的档位分布：products = **10 处字面 `res.status(500)`** + **2 处 `res.status(e?.statusCode ?? 500)`**（create/update，P1-3 早已认业务档）；notifications = **10 处字面 500**。工作树版两文件的字面 `res.status(500)` 均为 **0**（全改认表），其余档位（400/401/404/409）**逐数不变**（7/3、6/4、201 等计数一字未动）。
2. `safeRouteError` 会让"带 `code`+`statusCode` 的业务错"走透传档 ⇒ 会不会把某个原本 500 的响应变成 4xx？
   实测：`isBusinessError` 要求 `code:string` **且** `statusCode:number`（`errorCodes.ts:178-181`）；而**整个 products 域（route.ts 之外）与整个 notifications 域没有任何带 `statusCode` 的抛出点**（`grep -rn statusCode src/products/*.ts src/notifications/*.ts` 去掉 route.ts 后 **0 命中**）。
   两域内唯一那枚业务抛出 `products/route.ts:147`（`EXCLUSIVE_OWNER_REQUIRED/400`）恰好落在 create/update —— 也就是**收敛前就已经透传**的那 2 处 ⇒ **22 处站点无任何现存调用方会看到不同状态码**。
3. 残余差异（诚实记）：带 `code` 但**不带** `statusCode` 的异常（典型是 Prisma 的 `P2002`）在 create/update 两处，收敛前会把 **`P2002` 当 `error` 字段发给前端**，收敛后发注册码 ⇒ 这是**修好**而不是改坏，但它是前端可见的差异，写在账上。

## 五、证据（D56：域测试 + 可证伪探针为主证据）

1. **products 端点级实证**（新增 `server/src/products/__tests__/productErrorCopyB42.test.ts`，**15 例**）：12 处逐个真打 —— 用"任何一次 prisma 调用都抛内部原文"的 Proxy 替身，断言 `500` + 该端点的码 + **`message` 逐字等于注册表那一份** + 响应体不含 `P2010`/`Prisma`/`ProductAsset`。
   - 上传端点的**两个站点分别打**：外层 catch（`productId` 校验前就炸）与事务 catch（审计写失败 ⇒ 回滚），不是"两个用例复用同一异常"。
   - ★ **站点数自洽钉**：用例表长度必须等于源码里 `safeRouteError(` 出现次数（现 12）。⇒ 以后有人加第 13 个出口而没加用例，这张表会当场拒绝自称覆盖全量。
   - 顺带产出的**运行日志**就是 §二 的实证：15 例里每个失败例各打出一条 `[products/...] failed`（跑测试的 stdout 可见）。
   - 写这批时我自己踩到的一个坑，恰好证明这类测试必须真打：`GET /assets` 是 `Promise.all([findMany, count])`，我第一版正向对照只替身了 `findMany` ⇒ `count` 缺失先抛 `TypeError`，端点回了 **500 而不是业务 400** —— "看着像透传没生效"，实为夹具不忠实。**这不是代码缺陷，是证据缺陷**，已按 `rejectBoth()` 修正。
2. **正向 + 反向对照**（同文件）：业务错 `CURRENCY_REQUIRED/400 币种必填` 必须原样透传；**注册表外**的 `SKU_LOCKED_BY_OTHER/409` 也必须认它自己的状态与文案，且用例先断言"这枚码确实没登记"（否则前提消失时用例不会红）。
3. **notifications 端点级实证**（`server/src/notifications/__tests__/notificationErrorCopyB42.test.ts`，**13 例 / 覆盖 10 端点**）：10 个端点逐个真打（同一个"任何数据访问都异步 reject"的 Proxy 替身），每例断言 `500` + 该端点码 + `message` 逐字等于注册表 + 响应体无 `P2010`/`Prisma`/`pool#37`；再加"用例条数 = 源码 `safeRouteError(` 站点数(10)"自洽钉 + 18 枚码在注册表且为 5xx 的循环钉（带"未登记码必须真查不到"的非空转自检）。
   - ⚠️ **★ 复核抓到第一版是假覆盖**（本批最实在的一处收益）：第一版只 3 例、**10 端点里只打了 `GET /`**，标题却写"10 处"。复核给的反例是：把 `:151`（dismiss）改回原文直发，**旧版一处都不会红**（注册表里码还在 / 文件仍 import 真源 / `routeError.test.ts:45` 的正则匹配不了跨行 `.json({\n` / B42 按 D49 无棘轮）。⇒ 已改成逐个端点打，并**用那条反例实测**：改回直发后 **3 例同时红**（站点数钉 + 该端点例 + 结构例），随后 `cmp` 证明逐字节还原。
   - ★ **顺带量出本域一个结构事实**：从数据层抛一枚业务形状（`code`+`statusCode`）的错，**10 端点全部回兜底码而非透传** —— `notificationService.ts` 有 6 处内部 `catch`（`:147/:286/:380/:426/:586/:612`）先吸收了它。⇒ ① **本批未造成本域任何文案损失**（收敛前同一条路径也到不了路由，用户当时看到的是吸收后的**原文**）；② "业务错原样透传"这条性质**在通知域这条缝口不可证** ⇒ **本域不声称它**，由 products 域（路由自己抛的业务形状；400/409 两例）与 `shared/routeError.test.ts` 钉；③ 用例 13 钉的是"现状"，若将来服务层不再吸收它会红 —— 那时换成正向对照，而不是把断言反过来。
   - ⚠️ 自己写错并已改的一处：替身第一版是**同步 throw**，真 Prisma 恒返 promise ⇒ 改成 `async` throw（同步 throw 会改变"错误在哪一帧被吞"，正是上面那条结构事实被掩盖的原因）。
4. **跨层契约钉的改写**：`components/productImageAuditRuntimeQa.test.ts` 原有三条钉字面量（`error: 'DELETE_FAILED'`、`/UPLOAD_FAILED[\s\S]*500/`）在本批之后**必然红** —— 因为出口不再有字面量码、分支里不再有字面量 500。改写为**两层合一**的 `expectRouteStatus500()`：认表 + 认 `res.status(r.status).json({error: r.code, message: r.message})` + 认注册表给这枚码的状态确实是 500。
   **可证伪性实测**（临时脚本，跑完即删）：四条反例 —— 真形状=PASS、回退成硬编码 500=RED、漏了认表=RED、码拼错=RED。旧形状若被换回来一定红。
   ⚠️ 同时承认一处**效力下降的具体点**：原钉"`UPLOAD_FAILED[\s\S]*500`"是"分支体里同时出现码和 500"，新钉把 500 移到了注册表 ⇒ **判据跨了两个文件**，任何一侧单独漂移会红，但"码改名且注册表同步改名"这种一致漂移不再被这条钉住（这类漂移由 `fallbackCodeRegisteredRatchet` 与 B29 普查负责，不由本条负责）。
   另外把一条**名不符实**的既有钉（用例名 `UPDATE_FAILED → 500`，实际只 `toContain('[products/set-primary]')` —— 一个日志标签）换成了真判据。
5. **门禁（D63 起跑前登记 · 终轮 16:2x 本地，复核结束后独占复跑）**：起跑前 `HEAD=62c46481` · `8081=68014`（常驻，属主目录 `apps/Bambook` 那个 checkout，未动）· 负载 `4.79 4.87 4.75` · `pgrep vitest | wc -l` = **0** · 16 处未提交。
   - server：**527 文件 / 7020 例 全绿 · 0 红**（整份 `/tmp/b42f-server.log`）
   - web：**185 文件 / 3621 通过 + 13 跳过 · 0 红**（整份 `/tmp/b42f-web.log`）
   - `tsc --noEmit`：根 **0** 错（`/tmp/b42f-root-tsc.log`）、server **0** 错（`/tmp/b42f-server-tsc.log`）
   - ⚠️ **本批共取过三轮全量，前两轮各有缺陷，都留痕**：① 15:41 独占轮 server **526/6995 全绿** —— 但它取在**新增两个测试文件之前**，只能算"改动前基线"；② 15:5x 轮 server **527 文件 / 5 红**、web **2 红** —— 那轮我**与只读复核并发跑**（违反"全量测量独占环境"这条自定规矩），5 处红全在本批**未触碰的域**（permissionDenyPath/credit/invoiceMutationRoute/confirmedSourceRoute/orderLifecycleRoute），隔离复跑 **89/89 全绿**；web 那 2 红则是**真红**（我自己改的判据被本批改动打破，见 §六）。⇒ 按 B15 的规矩：**不因"这轮干净"就判抖动已修**，也不把并发轮的 5 红当"已定性为抖动"—— 只记为"并发环境下的未定性样本"。
   - **B42 计量（唯一度量入口 `measure-error-debt.mjs` 复跑）**：**144 处 / 48 文件 → 122 处 / 46 文件** ⇒ **−22 处、−2 文件**，与本批"12+10、两个文件"逐一对上；且这两个文件已**从候选清单里消失**。
     推算的余量（口径不变）：A1 55 → **33**，A 类 129 → **107**，总量 144 → **122**（实测的 122 ✓ 与推算一致）。
6. **前端未验证**（S1–S3 如实记）：没有起 dev server 看这两屏的真实报错样式，只验到"响应体形状与文案"。⇒ 不说"界面已验证"。

## 六、web 第一次跑的 2 红：不是抖动，是我改的判据被自己的改动打破

`components/productImageAuditRuntimeQa.test.ts` 的 `UPLOAD_FAILED → 500`、`DELETE_FAILED → 500` 两条**红了**。
隔离读源码定性：前者红**不是因为码改了名**（`PRODUCT_IMAGE_UPLOAD_FAILED` 含 `UPLOAD_FAILED` 子串，正则照样能过），而是因为 `500` 这个**字面量离开了分支体**；后者红在字面量 `error: 'DELETE_FAILED'` 已不存在。
⇒ 属"判据与被改的对象不是一回事"，处置见 §五.4。**没有把它们改成 skip，也没有放宽到只查子串。**

## 七、本批之外、但被这批撞见的（先记账不顺手修）

1. `routeError.test.ts:45` 的泄漏正则**把标识符写死成 `e`** ⇒ `txErr?.message` 这类写法对 B22 不可见（本批实测 11 vs 12）。这不是新论据，是 **D49 立场的又一次现场印证**。⚠️ **未加宽**：加宽会让一批"已收敛/未收敛"的分类同时变动，属独立一批（且要先量清楚加宽后各文件的数怎么落表）。→ 建议并入 §9.1 **B22** 行的口径备注。
   ★ **B22 的三张表本批一字未动**（现读：`git status` 里 `rawErrorLeakRatchet.test.ts` 无改动，它最近一次变更是 G-4 的 `786a2178`）⇒ 复核报告里"B22② 从 106/40→105/39 是 G-5 那半批带来的"这句**不成立**，本批两半都没移动 B22 的数（我一度照抄它，被自己的现读挡住 —— 同一批里的第二次"复核的数也要复量"教训）。
2. ★ **我一度判为"本批引入的吞文案回归"，实测证伪了自己的判断**（这个trace要留着，否则下一个人会同样误判并"修回"泄漏）：
   `products/route.ts:470/:628/:665` 三处 `if (!svcResult.ok) throw new Error(svcResult.error!.message)` —— 看起来"收敛前服务层的业务文案能上屏、收敛后被兜底文案换掉"。
   **逐条现读 `productAssetMutationService.ts` 后不成立**：该服务能返回的 `message` 里，
   `:56 INVALID_INPUT('sku, name, mainCategory required')`、`:59/:105 INVALID_AMOUNT('cost must be valid decimal')`、`:102/:142 NOT_FOUND` **都被路由层更早的同内容前置校验挡住了**（`:446` 必填 → 400、`:452` 金额 → 400、`:509/:657` 不存在 → 404）；
   真正可达的只有 `:90/:130/:160` 那三枚 **`String(e?.message ?? e)` 原文** ⇒ 收敛后把它们换成中文 + 进日志，**正是本批要的效果**，不是回归。
3. 但上面那三行确实暴露一族**既有缺陷（本批未修，立账为 B53）**：**服务层返回的 `{ok:false, error:{code, message}}` 在路由里被重抛成裸 `new Error(message)` ⇒ `code` 被销毁**，于是"服务说了 NOT_FOUND/INVALID_AMOUNT"到出口一律塌成 500。
   实测范围：生产代码 **4 处**（`products/route.ts:470/:628/:665` + `index.ts:645`，后者非路由出口、需再追一跳），另有 5 处在 `finance/__tests__/forwardFxDrill.test.ts`（演练脚本，不算交付面）。
   与 G-4 撞见的"V2 白名单/字段销毁"同族（**码在跨层边界上被丢**）。⚠️ **未顺手修**：修它要同时决定"每枚服务码落哪个 HTTP 档"，那是新增语义（D49），且会把本批的"只换出口、不动档位"这条硬约束破掉。
4. **A1 余下 33 处**：`email/route.ts` 7、`email/templateRoute.ts` 7（清单里 A1 的其余两批）+ 其余零散 ⇒ 下一批继续。
   ★ **第 9 批的 D51 前置已在 17:2x 逐站点量完**（按"站点前 6 行内有无 `logger.`"判配对，脚本现读）：
   - `email/route.ts` 7 处**全部已有日志**：`:270 BACKFILL_FAILED`、`:290 AUTO_LINK_FAILED`、`:319 CLASSIFY_FAILED`、`:348 CLASSIFY_BACKFILL_FAILED`、`:374 CREATE_FOLLOWUP_FAILED`、`:436 UNKNOWN_ERROR`、`:865 INTENTS_FAILED`；
   - `email/templateRoute.ts` 7 处**全部已有日志**：`:203 LIST_FAILED`、`:238 CREATE_FAILED`、`:268 UPDATE_FAILED`、`:286 USE_FAILED`、`:356 AI_GENERATE_FAILED`、`:369 DELETE_FAILED`、`:380 SEED_FAILED`。
   ⇒ 两域都**不缺日志**（通知域那种"整域零日志"不会重演）⇒ 第 9 批是**纯出口收敛**，不用先补 14 条。（本批早先按文件计的是 `11 条 logger.` / `8 条`，那是**文件级**数、含非站点日志 ⇒ 逐站点核之后才是"7/7 配对"。）
   ⚠️ 两条必须先于替换查清的差异：① `templateRoute.ts` 用 **nested 形状** `{ ok:false, error:{ code, message } }`，而 products/notifications 是 flat `{ error, message }` ⇒ `safeRouteError` 只返回 `{status,code,message}`，**组装形状由调用方保持**（`shared/routeError.ts` 顶部明写"两种形状都是前端契约，不能统一改"）；② 这批的码大量与其他域**同名**（`LIST_FAILED`/`CREATE_FAILED`/`UPDATE_FAILED`/`DELETE_FAILED`/`USE_FAILED`），且 `:436` 那枚是 **`UNKNOWN_ERROR`**（通用兜底名）⇒ 按 D77 一律登记成 `EMAIL_*` 前缀，改这一处的对外码名要单独记账（前端是否按码分支须现读，别沿用本批"无消费者"的结论——那是 products/notifications 两域的实测，不外推）。
   ⚠️ 另：`route.ts:436` 是 `POST /outbox/:id/send`（**发信动作**）⇒ 它的原始异常最可能含 SMTP 原文/收件人地址（PII），第 9 批这一处要单独判"是否还需要脱敏"，不能只做文案替换。
5. **A2 66 处 / A3 8 处**未动（A3 须先与前端确认 SSE 帧是否真被渲染）。
6. 这批**没有**给 B42 配任何新判据（D49/D58 一致）。`productErrorCopyB42.test.ts` 里的"站点数=用例数"钉子是**本文件自洽**用的，不是全仓棘轮，别把它当 B42 的守卫。

## 八、边界（与目标一致，逐条核过）

未 push、未部署、未改生产库；对 `panda_hub_local` **只读**（本批的 B42 判据一条都不依赖库；本会话唯一的读库是给 G-5 复限 §五.4 的量：13 案 / 15 成衣档案，见该批文档 §六）；主目录 `apps/Bambook` 的 1c 遗留未提交改动未碰；`8081=68014` 未停未动；公量结算 / MOQ 真源 / 尾款账期 / 停 68014 对照实验四项继续挂 §12.1 待 Kevin。

---

## 九、R4-T4 只读独立复核逐条处置（复核结论 SHIP-WITH-FIXES，5 条全部成立并已全部落地）

| # | 级别 | 复核指出 | 处置（现读/实测后） |
|---|---|---|---|
| 1 | MAJOR | **§9.1 是本仓唯一数字出处，却还写着本批之前的数**（144/48、下一块仍列这两个文件）⇒ 同一族出现两个数 = R2/§9.1 要防的"多套并行真源"，R7"改本表的数字"未满足 | **已改**：§9.1 `★ 候选 · B42` 行 → **122 处 / 46 文件**（复量 16:0x），A1 55→**33**、A 类 129→**107**，"下一块"改为已清/未清两段；版本行 → **v2.27** + 前注。⏱ 时序说明：复核读到的是我回写**之前**的快照（它 08:08 完成，我 08:07–08:08 才落笔），但**同一批内 R7 未闭环是我的事实**（回写晚于代码完成），不是它的误判 |
| 2 | MAJOR | **notifications 测试只打了 1/10 端点，标题却写"10 处"**；反例：把 `:151` 改回直发，注册表/真源 import/B22 正则/B42 全都不红 ⇒ 旧版是假覆盖 | **全盘接受**：改成 10 端点逐个打（13 例）+ 站点数自洽钉；并按它的反例实测"改回直发 ⇒ 3 例红"，再 `cmp` 逐字节还原。见 §五.3（含我第一版为何会假绿的四条机制） |
| 3 | MINOR | 前端 `expectRouteStatus500` 对**上传分支**做整段子串搜索，而该分支有**两个** catch ⇒ 只收敛一处也照样绿（最弱形式的逐站点钉） | **已收紧**：加 `minSites` 参数，上传那条传 `2`（认表出口处数 `< 2` 即红）。⚠️ 复核同时确认：服务端的 12 例测试**本来就分得开**两个站点（`[products/upload-image] tx failed` vs `[products/upload-image] failed` 两条日志标签为证）⇒ 这是"前端这条钉偏弱"，不是"整批没测到" |
| 4 | MINOR | `PRODUCT_DELETE_FAILED` 一枚码服务两个端点（删档案 / 删图），但文案写"该记录仍然存在" ⇒ 删图失败时用户不知道"什么还在"；同批 `PRODUCT_UPDATE_FAILED` 已加了"（产品档案或图片设置）"而 delete 没加 | **已改文案**：`'这次删除没有完成，要删的内容（产品档案或图片）仍然保留，…'`。**没有拆成两枚码**：一码多端点不是缺陷（`safeRouteError` 的语义是"这枚兜底码=这一类失败"），拆码会让 12 站点变 18 枚码、且前端并不按码分支（§四 已实测） |
| 5 | NOTE | "用例条数 = 站点数"的钉子是**减速带不是锁**（没人拦得住把 12 改成 13） | **接受这个定性**，不改设计：它拦的是"改了源码忘了同步这张表"，不拦"故意放宽"。已在 §七.6 写明它**不是** B42 的守卫，别把它当棘轮引用 |

### 复核顺带确认成立的正面结论（写清楚，免得下批重查）
数值全部复量对上（122/46、−22=12+10、两文件已从候选清单消失）；**没吞任何业务文案**；22 站点无状态码回归；products 15 例"真打到了 catch"（含两个上传站点可区分）；三处基线移动自洽（+22/+18 四个数交叉对上）；D51 复量一致（通知 0→10、产品 12→12）；18 枚码无重名、B32 同码两档仍 6；`services/apiService.ts:357` 原样展示 `message` ⇒ 用户净增中文、无损失。

### 复核没查完、我也没假装查完的
它自己点名的最大风险：**部署侧客户端与后端的版本配对**（常驻 `:8081`=PID 68014 属主目录 checkout；`pwa/`、`electron/` 打包物是否含按 `res.body.error` 分支的旧代码）—— 我这边同样只做到了"仓库内 grep 无消费者"这一层，**运行时配对未证**。本批未 push、未部署 ⇒ 该项在"上线前"清单里，不算本批债；但**上线前必须有人核**（记在此，不写进"已验证"）。
