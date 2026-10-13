# G 线第 6 批（B50-1a）：agent 面两个订单状态工具接回唯一门禁引擎 —— ★同一个动作有两条实现，审批过的那条一条控制都没有

> 目标来源：注册目标「按 §2 G1–G7 与 §8 M0–M7 的顺序把可自主推进的缺口逐批清掉」⇒ ①..⑤ 已全部交付后，接手 §9 里可自主推进的最重一条：**B50（门禁覆盖面）**。
> 权威基准：`docs/交付目标与验收标准-2026-09-20.md` 首行 **v2.27**（本批回写至 v2.28）。
> 本批性质：**修安全缺陷**（不是文案债）。**未新增判据**（D49），并把一条**既有判据的覆盖面缺口**量出来（§六.3）。

---

## 〇、一句话

`orders.update_status` / `orders.batch_status` 两个 agent 工具此前**自己手写**「读旧状态 → 建状态流转行 → `order.update({status})`」，
于是同一个动作的四样控制**一条都没有**：**确认门禁（信用 / MOQ / L/C）、状态转换矩阵、AuditLog、事务原子性**。
本批把它们接回唯一引擎 `transitionOrderStatus`（V1/V2 路由与 `orderLifecycleFlow` 早就走它），**不抄第二套判定**。

## 一、缺陷形状（全部现读，含 HEAD 对照）

| 控制 | HTTP 路由（对照） | 本批之前的 agent 工具 | 证据 |
|---|---|---|---|
| 信用门禁 | ✅ | ❌ 无 | 门禁在 `orders/orderLifecycleService.ts:352-394`（服务内、非路由内），工具走 `toolRuntime.ts:5474` 直写 |
| MOQ 门禁 | ✅ | ❌ 无 | 同上 `:395-445`（命中还会自动发起豁免审批单 DR-007） |
| L/C 门禁 | ✅（G-4） | ❌ 无 | 同上 `:446-468` |
| 状态转换矩阵 | ✅ | ❌ 无（只校验"是不是 6 个合法值之一"） | `toolRuntime.ts` 里 `validateStatusTransition` 只被 Invoice/Shipment 类工具调用（`:560/:587/:6154/:6237`），订单两个工具**没调** |
| AuditLog | ✅ | ❌ 无 | `writeRouteAuditLog` 在 `toolRuntime.ts` 的使用点是 `:6077/:6192/:6273`，均非订单状态工具 |
| 事务原子性 | ✅ | ❌ `batch` 逐条裸写、无事务 | 旧实现 `for (...) { create; update; }` |

★ **旁路是真的，不是推测**：把 HEAD（`b9a07ad4`）的 `toolRuntime.ts` 原样放回，本批新测试 **11 例里红 10 例**；还原我的版本后 `cmp` 通过、`git diff` = +51/−38。

## 二、为什么"已过审批"不能当作门禁（本批的口径决定，登记为 D81）

`orders.update_status` 在注册表里是 `risk:'high' + approvalPolicy:'always'`（`agent/toolRegistry.ts:216-229`），
`draft→approval→commit` 的哈希/语义校验（`PROCESS_DRAFT_MISSING` / `SEMANTIC_VALIDATION_FAILED`）是**追加的人类层**，
其代码里**没有任何一处读信用、MOQ 或 L/C**。⇒ 审批人批准的是"允许尝试这次确认"，不是"这个客户没被冻结、信用证已登记"。
按最严解释自处：**门禁必须在每一条改状态的路径上跑，审批不算替代**；同时把这条政策摆给 Kevin（§12.1 第 16 条），因为它会**改变 agent 的行为**（原来能做成的事现在会被挡）。

## 三、做了什么（两处接回，零新增判定实现）

1. `toolRuntime.ts` 顶部 import 唯一引擎（先例：`agent/orderLifecycleFlow.ts:12` 早已 import 同一函数）。
2. `updateOrderStatus`：删掉「预读旧状态 + 自建流转行 + `order.update`」，改为一次 `transitionOrderStatus({prisma, orderId, toStatus, note, operator:'agent', actorId:'agent'})`，成功/拒绝都从引擎结果映射。
   - 入参级守卫保留在引擎之前（`ORDER_ID_AND_STATUS_REQUIRED` / `INVALID_STATUS: x`）⇒ **工具对外的 `reason` 词表一字不变**。
   - 引擎码 → 工具词表是**纯映射**（`lifecycleReasonToToolReason`：`NO_CHANGE→ALREADY_IN_STATUS`、`ORDER_ALREADY_DELETED→ORDER_NOT_FOUND`），不在此重做任何判定。
   - 门禁类码（`MOQ_VIOLATION` / `CREDIT_*` / `OVERDUE_60_DAYS` / `LC_GATE_BLOCKED` / `LC_EXCEPTION_CHECK_FAILED`）**原样透出**，并带出 `approvalRequestId`（MOQ 命中时前端/agent 要知道去哪张审批单）。
3. `batchUpdateOrderStatus`：同样逐条交回引擎，并修掉两个连带缺陷 ——
   - ★ 旧实现 `ok` **恒为 true** 且对不处理的单**静默 `continue`** ⇒ 三条单全被挡时返回值仍长得像"批量成功"，agent 会照实汇报"已确认 3 单"。现在：`ok = failed.length === 0`，被挡的进 `failed[]`（带 reason/message/approvalRequestId）。
   - 旧实现每条先 `findUnique` 再 `update`（读写之间可被并发改动）⇒ 交回引擎后由引擎在同一事务内读判写。

### 行为变更（单列，D28 口径变更写进文档）

| 变更 | 收敛前 | 收敛后 | 影响面 |
|---|---|---|---|
| agent 确认订单 | 无条件成功（只要状态值合法） | 走信用/MOQ/L/C 三道门禁，可能拒绝 | ★ **这是本批的目的**。两条路径都需人工审批在先 ⇒ 变化只发生在"审批通过但业务条件不满足"的单上 |
| 非法状态跳转（如 Pending→Delivered） | 允许 | 引擎的转换矩阵可能拒（`INVALID_TRANSITION`） | 与 HTTP 面一致化。⚠️ 未逐条枚举哪些跳转由放行转拒绝（**未覆盖**，见 §五.4） |
| AuditLog | 不写 | 写（引擎内） | 运维面净增益 |
| batch 的 `ok` 语义 | 恒 true | 有失败即 false | ★ MCP 客户端/agent 若把 `ok` 当"调用送达"会看到差异；本批认为"全挡却报成"比这更危险 |
| batch 新增 `failed[]`/`skipped[]`、去掉静默跳过 | 无这两个字段 | 有（`NO_CHANGE→skipped`，真失败→`failed`） | 纯增量；`ok` 语义见上一行 |
| ★ 接回引擎=继承**引擎的全部副作用**（复核 MAJOR，第一版文档漏写） | 什么都不触发 | 成功流转后会 `publishBusinessEvent`（`orderLifecycleService.ts:534-554`）⇒ 自动化规则 `automationConfig.ts:36-45` 起 **L1 投产流水线**、`:64-72` 起 **L6 BOM 草稿**、并投通知（`eventBindings.ts:41-43`） | 与 HTTP 面**同一套**副作用（这正是"接回唯一实现"的目的），但**agent 批量一次可放大到 N 份** ⇒ 记此以免有人以为 agent 面是"静默改状态" |
| ★ 门禁跑在矩阵/守卫**之前** ⇒ 被拒的单也可能留下审批单 | agent 面不留 | agent 面现在会留：低于 MOQ 的 `Paused/Cancelled` 单，先由 `:395-445` 自动发起豁免审批单，**再**被 `:478-494` 的矩阵/守卫拒绝 ⇒ 人工待办里多一张无意义的豁免单 | **引擎既有缺陷**（HTTP 面同样如此），本批把批量入口接了上去使量级变大 ⇒ 立账 **B56**，与 slice 2 同批修（把守卫/矩阵前置，或让豁免只在通过校验后发起）。⚠️ 本批**没有**为此加一次"预检顺序"的私有实现，那会造第二套真源 |
| ★ 审计里"谁发起的"分不开（复核 NOTE） | — | `AuditLog.detail.source` 是常量 `'route:order:status-transition'` ⇒ agent 写与人工写在审计表里**长得一样**；目前只能靠 `OrderStatusTransition.operator='agent'` 区分 | **未解决**（改常量会动 HTTP 契约）⇒ 并入 **B57**；不许把"已接回"表述成"审计可追溯了" |

## 四、证据（D56）

1. **新测试** `server/src/agent/__tests__/orderStatusToolGateB50.test.ts`（**11 例**）：
   - ★ 核心可证伪断言：门禁挡下时 **`order.update` 与 `orderStatusTransition.create` 各零次**（不是"没返回成功"，是"没有写"）。
   - `MOQ_VIOLATION` 必须带出 `approvalRequestId`；`prisma` 句柄与 `operator:'agent'` 原样交给引擎（钉"判定没在工具里重做"）。
   - 对外词表 5 条例外逐一钉（含"引擎之前就该拒"的守卫不升反降的检查，用**调用次数不变**而不是"从未调用"——我第一版写 `not.toHaveBeenCalled()` 把自己写红了：**断言错、代码对**，已留痕在注释）。
   - batch 混合结果 / 全挡 两例（"不许把全挡报成全成"）。
   - 结构钉：两个函数**体内**不得再出现 `.order.update(` / `orderStatusTransition.create(` / `.order.findUnique(`，且必须出现 `transitionOrderStatus(`；配了**非空自检**（切片失效时必须红，不能恒真）。
   - **反例实测**：HEAD 版 `toolRuntime.ts` 放回 ⇒ **10/11 红**；随后逐字节还原。
2. **回归面**：改完先跑 `src/agent src/orders` ⇒ **99 文件 / 1306 例全绿**（没有任何既有用例依赖旧的宽松行为；反过来说，这两个工具的写路径此前**零测试覆盖**）。
3. **全量门禁**：见 §五.2（本批取到 4 轮，其中 2 轮全绿、2 轮各有 1–2 处**与改动无关域**的红 ⇒ 直接撞上 B15，取证见 §五.3）。

## 五、门禁与 B15 新样本

1. **D63 起跑前登记**：`HEAD=b9a07ad4`、`8081=68014`（未动，属主目录 checkout）、负载 `4.86 4.27 4.36`、`pgrep vitest | wc -l` = **0**（独占）、2 处未提交。
2. **同状态取到 4 轮全量**：

| 轮 | 方式 | 结果 |
|---|---|---|
| D 16:48 | 并行 · 独占 | **2 红**：`audit/entityRoute`（期望 400 得 404）、`inventory/inventoryOwnershipRouteScope`（期望 403 得 404） |
| E 16:5x | `--no-file-parallelism` | 仍红，且换成**第三个文件**（lookbook P2b）：2 files failed / 1 test failed |
| F 17:0x | 并行（一次误跑的整套件） | **528 文件 / 7031 例 全绿 · 0 红** |
| （对照）16:23 上一批终轮 | 并行 · 独占 | 527/7020 全绿 |
| **G 17:42 本批终轮（复核处置后）** | 并行 · 独占（`pgrep vitest`=0、负载 2.76、`8081=68014`） | server **528 文件 / 7034 例**，**1 红** = `suppliers/factoryRoute.test.ts`"expected 404 to be 201"（本批未触碰 suppliers；隔离复跑 **22/22 绿**）⇒ 计入 B15 第 **5** 个不同文件样本 |
| G 17:44 web / tsc | 同上 | web **185 文件 / 3621 通过 + 13 跳过 · 0 红**；根 `tsc` **0**、server `tsc` **0** |

★ **终轮定性（写给下一位）**：本批代码终态 = **server 除 1 处 B15 型红外全绿（该文件隔离 22/22 绿）、web 与两端 tsc 0 红**。
"这一轮只红 1 个" **不得**被读成"抖动已缓解"；它是 B15 的第 5 个不同文件样本（audit / inventory / lookbook / permission 类 / suppliers），进一步支持"与具体文件无关、与整套件规模有关"的现读结论。

3. ★ **B15 取证（本批净增的排除项，四条都是现读/实测，不是推定）**：
   - 响应形状：`text="Not Found"`，且 **`ct=-`（无 content-type）、无 `server`、无 `x-powered-by`** ⇒ **不是本仓 Express 答的**（Express 404 会带 HTML + `Cannot GET`）；与 15:5x 那轮的 `{"error":"not_found"}` 是**两种不同形状** ⇒ 至少两个来源或两种时刻。
   - **排除「打了常驻 8081 / 别的 checkout」**：失败的 `audit/entityRoute.test.ts` 自建 `express()` + `createAuditRouter(...)` + supertest 就地跑，全文无 `8081/baseUrl/localhost`（`grep` 空）。
   - **排除「HTTP 拦截器泄漏」**：依赖树里**没有** `nock`/`msw`/`undici`/`interceptor` 任何一支（读 `package.json` 全量 deps），测试里也无人 `setupServer/MockAgent`。
   - **排除「全局 agent/keepAlive 复用陈旧 socket」**：`src` + `scripts` 内 `globalAgent|keepAlive` **0 命中**，也没有测试自建长驻 `listen()`。
   - **排除「与并行度相关」**：`--no-file-parallelism` 照样红（且换文件）。
   - **排除「这两个文件的配对互相污染」**：`src/audit src/inventory` 同跑 **12 文件 / 169 例全绿**。
   ⇒ 结论：触发条件与**整套件规模**相关而非文件配对；机制**仍未定**。**没有把红写成"已定性为抖动"**，也没据此判"抖动已修"（B15 的规矩）。下一步该做的探针写在 §9.1 B15 行。

## 六、复核与本批撞见的新账

1. ★ **`toolRegistry.ts` 的 `inputSchema` 与执行器读的是两套参数名**：注册表写 `{poNumber, newStatus, reason}`（`:138-146`），执行器读 `{orderId, toStatus, note}`，MCP manifest（模型真正看到的）写 `{orderId, toStatus, note}`（`mcp/manifest.ts:320`）。
   ⇒ **manifest ↔ 执行器一致，注册表 schema 是第三份且是错的**；且运行时**不校验** `inputSchema`（现读无任何 validate/ajv 调用）⇒ 按注册表 schema 生成的调用会恒返 `ORDER_ID_AND_STATUS_REQUIRED`。立账为 **B54**（同一工具的三份契约描述、其中一份为假）。
2. **`order.confirm` 与 `invoice.issue` 两条旁路本批未接**（§七 是它们的施工图）：
   - `agent/commitTransaction.ts:285` 直写 `tx.order.update({status})` **且** `:305` 附近 `tx.invoice.create({type:'Receivable', status:'Issued'})` ⇒ **一次调用绕过确认门禁 + 开票门禁两道**（G-4 修的 PI 转正正是同一类）。
   - `agent/invoiceIssueFlow.ts:229` 只有 `tx.invoice.create(` 一处（现读确认全文件无 `createInvoice`/`decideLcGate`）。
3. ★ **既有 L/C 接线源钉只有 4 个文件、不含任何 `agent/` 文件**（现读 `customs/__tests__/lcGateWiring.test.ts:32/39/46/54/61`）⇒ 上面两条旁路**它一条都拦不住**。本批没有擅自扩它（那会在未接回时就把守卫做成"替缺陷背书"），但记下：**接回 slice 2 时必须把清单从 4 文件扩到 6 文件并配"永不触发"反例**。
4. 转换矩阵的收紧面**未逐条枚举**（哪些 from→to 由放行变拒绝）⇒ 属"未覆盖"，slice 2 里补一张矩阵对照。
5. ★★ **本批最意外的发现（B50-1c，已立账未修）**：旁路**不止 agent 面**。**变更单的两条"恢复"路径**用字面量 `'Confirmed'` 兜底并直写状态：
   `orderChanges/orderChangeRequestService.ts:798`（审批驳回时）与 `:862`（申请人撤回时）各算一次
   `restoreStatus = candidate && !DR010_GUARDED_STATUSES.has(candidate) && candidate !== 'Cancelled' ? candidate : 'Confirmed'`，
   随后 `:810` / `:881` 直接 `tx.order.update({ data: { status: restoreStatus } })`。
   ⇒ 可达路径是 **HTTP**：`index.ts:635` 审批路由的 `onDecided` 钩子 → `syncFromApprovalDecision` → 本服务。
   ★ 这条正是 §9 B50 原文明言的那个盲区：**`status: toStatus` 这类变量写法，字面量判据永远扫不到** —— 我按"哪个文件写着 `'Confirmed'`"去数，前两批都会漏掉它。
   ⚠️ 语义分歧（不自拍，已进 §12.1 第 16 条第 ④ 问）：它是"回到暂停/取消申请之前的状态"，不是首次确认；但暂停期间客户可能被冻结、信用证可能过期 ⇒ 按 D81 的一致性处理则恢复也该重跑门禁（代价：撤回一个取消申请会变慢且可能被拒）。
   同函数 `:486` 的 `lifecycleStatus` 取值域经现读只有 `{CancelRequested, PauseRequested, null}` ⇒ **不是**确认旁路，别混进这一条（我差点把它一起算进去）。
6. ★★★ **同一轮现读又撞出第四处（B50-1d，未修）**：`shipping/orderLinkService.ts:180` 直写 `tx.order.update({status: target})`，而 `target` 由 `:126-137` 决定 —— **先查"最近一次进 Shipping 的 fromStatus"，查不到或查询抛错就 `catch {}` 吞掉并兜底 `return 'Confirmed'`**。⇒ 除了不过门禁，它还犯了一条本仓已写成判据取向的错：**"查不出来"时猜一个状态并写库**（对照 G-4 的 `LC_EXCEPTION_CHECK_FAILED`、B14 的 `DEPENDENCY_CHECK_FAILED` —— 那两处都是"没结论就阻断"）。语义上"回到发货前"是否该重跑门禁同属 §12.1 第 16 条第 ④ 问，但**猜状态**这点不需要政策就能判为缺陷。
7. ⇒ 本批顺手把 §9 B50 欠了很久的那件事做掉了一半：**按"谁能把订单写成 `Confirmed`"逐处现读取到分母**（5 个写点，见 §9 B50 行末尾的清单），而不是再靠字面量扫 —— 这正是该条原文警告的"`status: 变量` 扫不到"，两处兜底 `'Confirmed'` 都是靠人读才发现的。

## 七、slice 2（B50-1b）施工图（本批刻意不做，避免在长会话尾部动最安全关键的块）

**为什么单独一批**：这两条旁路都在**已开启的 `$transaction` 内**，而 `transitionOrderStatus` / `createInvoice` 自己开事务 ⇒ 不能简单改调用；把门禁判定塞进 commit 里"再抄一份"正是本仓头号病。做法：
1. 从 `transitionOrderStatus` **抽出** `evaluateOrderConfirmGates({ prisma: tx, order, amount, actorId })`（信用 + MOQ + L/C，返回 `{code|null, message, approvalRequestId?}`），让服务与 `commitTransaction` **共用同一实现**；`decideLcGate` 已经是 tx-capable，无需重做。
2. `commitTransaction` 写状态之前调用它；开票腿直接调 `decideLcGate`（与 `invoiceMutationService` 同一函数、同一 action 语义），被挡时**整笔事务回滚、不建票、不烧单据号**（G-4 已验证的三条断言照抄成用例）。
3. `invoiceIssueFlow.ts:229` 同一处理。
4. 源钉清单 4→6 文件 + 每文件一条"若字段名/判定被抄错则永不触发"的反例（G-4 的教训原文）。
5. 口径问题给 Kevin：**审批已过的事务是否仍要跑业务门禁**（§12.1 第 16 条）。本批按"要"实现（最严解释），slice 2 沿用。

## 八、未做 / 未覆盖（S1–S3）

1. `order.confirm` / `invoice.issue` 两条旁路未接（§七）。⇒ **本批不得被读成"agent 面已收口"**（引用 G-4 的同条禁令）。
2. 数据迁移面（`migration/dataMigrationService.ts:310/337`）是否**有意**不过门禁，未证 ⇒ 待核（若有意，写进 DR 而不是留在缺陷账里）。
3. 转换矩阵收紧的具体跳转清单未枚举（§六.4）。
4. **未做浏览器/端到端实测**：agent 工具结果在屏面上如何呈现（尤其新的 `reason`/`failed[]`）未验；只验到返回值形状。
5. B54（三份契约描述）与 slice 2 之外的 `toolRegistry` outputSchema 与真实返回不一致，均未修。

## 九、边界（与目标一致，逐条核过）

未 push、未部署、未改生产库；★ **本行第一版写的是"本批完全没读库"，被复核证伪了必要性**：正因为我不查库，`actorId:'agent'` 这种"表里根本没有的哨兵"才一路绿灯到复核才被抓（见 §十）⇒ 现已做过**只读**查询两处：`UserAccount` 哨兵存在性计数（`system` 在、`agent/api/unknown/batch-api` 都不在，总 53 行）与 `pg_constraint` 查 `AuditLog_actorId_fkey`（存在、NOT DEFERRABLE）。**未执行任何写入、未 `ALTER`、未动 schema**；主目录 `apps/Bambook` 的 1c 未提交改动未碰；`8081=68014` 未停未动；§12.1 的口径未一条自拍（新增的第 16 条是**问题**，不是结论）。

---

## 十、R4-T4 只读独立复核逐条处置（复核判 **BLOCK**，不是修文案能过的 —— 我把功能改坏了）

### ★ BLOCKER：我自造的哨兵 `actorId:'agent'` 会让每一次调用回滚

`AuditLog.actorId` 是 **`UserAccount` 的外键**（`prisma/schema.prisma:3796`；实库 `pg_constraint` 里 `AuditLog_actorId_fkey` 存在且 NOT DEFERRABLE）。
我自己只读查库复核（`panda_hub_local`）：

| 哨兵 | `UserAccount` 里是否存在 |
|---|---|
| `agent` / `api` / `unknown` / `batch-api` | **全部不存在**（`agent` 0 行） |
| `system` | **存在**，displayName = 系统服务（`UserAccount` 共 53 行） |

⇒ 引擎在同一事务内写审计（`orderLifecycleService.ts:522`）与发起信用豁免（`:374`）时，只要 actorId 不是真实账号就 **P2003 回滚** ⇒ 我的"接回门禁"实际效果是 **agent 再也改不动任何订单状态**，而且 `ok:false, reason` 会被塌成 `TRANSITION_FAILED`（对外看像"系统故障"，真因藏在 FK 违约里）。
★★ **最难受的一点**：这个坑**本仓早已踩过并定了答案** —— `audit/routeAudit.ts:182-184` 原文写着
"'system' 哨兵与 seed 系统账号对齐（AuditLog.actorId 外键要求 UserAccount 行存在；历史哨兵 'api' 无对应账号 → API-Key 审计写 FK 违约，已统一收敛为 'system'）"。
⇒ 我是**没查既有真源就自造了一个**，正是本仓反复登记的头号病 + 我自己 memory 里那条"先查已有真源"。**修法**：`actorId:'system'`（既有种子账号），"谁发起的"交给无外键的 `operator:'agent'`；并新增一条用例把这件事钉住（`actorId` 必须是 `system`、`operator` 必须是 `agent`）。
⚠️ **未做**：没有真库写入演练（写库超出本批边界，`ALTER`授权也未给）⇒ "回滚"这条是**完整推理链（外键存在 + id 不存在 + 写在事务内）+ 只读计数**，不是观察到的失败现场。复核方同样未执行写入。真实演练留在 M3（G-3 数据集就绪后）。

### 其余四条的处置

| # | 级别 | 复核指出 | 处置 |
|---|---|---|---|
| 2 | MAJOR | "对外 `reason` 词表不变"是假的：引擎 `:568` 把 `e.code` 原样带回 ⇒ Prisma 的 `P2003/P2025` 会变成 MCP 可见的 `reason` | **已修**：加已知码白名单 `LIFECYCLE_TOOL_REASONS`，白名单外一律塌成 `TRANSITION_FAILED` 且**原文进 `logger.error`**（同 B22/B42 的"对外收窄、日志留全"）。新增 3 码用例（含 `INVALID_TRANSITION` 仍透出，证明不是一刀切） |
| 3 | MAJOR | 接回引擎=继承了一批**没说出来的副作用**：`publishBusinessEvent`（`:534-554`）→ 自动化 `automationConfig.ts:36-45`（L1 投产流水线）+ `:64-72`（L6 BOM 草稿）+ 通知；且**门禁跑在矩阵/守卫之前**（`:336-470` vs `:478-494`）⇒ 低于 MOQ 的 `Paused/Cancelled` 单会**先生成一张人看得见的审批单、再被拒**；`batch_status` 一次最多 N 张审批单 + N 条投产 | **不掩盖、不顺手改**：① 写进 §三"行为变更"（见下）；② 引擎的"门禁先于守卫"顺序缺陷立账为 **B56**（HTTP 面早就同样如此 ⇒ 不是本批引入，但本批把 agent 面的**批量**入口接了上去，量级变大）；③ 修法与 slice 2 同批（把守卫/矩阵前置，或让豁免只在通过校验后才发起） |
| 4 | MINOR | `ALREADY_IN_STATUS` 被算成 `failed` ⇒ 无事可做的批量调用报"失败"；另外 `agentLoop.ts:652/666` 仍把整轮记成 `ok:true`/`status:'complete'`，时间线与载荷互相矛盾 | **前半已修**：新增 `skipped[]` 一档（`NO_CHANGE → skipped`，`ok = failed.length===0`），配用例（两条都已在目标态 ⇒ `ok:true` 且 `skipped` 有两条、零直写）。**后半未修**：`agentLoop` 的运行级 ok 与工具载荷不一致，属**可观测性**缺陷 ⇒ 立账 **B57**（另批） |
| 5 | NOTE | `AuditLog.detail.source` 是常量 `'route:order:status-transition'` ⇒ agent 写与人工写在审计里**分不开**（G4 要求可分） | **承认未解决**：不改引擎常量（HTTP 契约依赖它），现仅靠 `OrderStatusTransition.operator='agent'` 可分（该列可分但不在审计表里）。⇒ 并入 **B57**（审计"谁发起"的可分辨性），本批文档明确写"未解决"，不让它藏在"已接回"这句话后面 |

### 复核确认成立的部分（省得下批重查）
- **路由/可达性**（我 §二 的核心前提）：**成立** —— `orders.update_status` 无 `processSpec`（`toolRegistry.ts:213-227`，测试 `:229` 钉），审批后重放经 `executeAgentTool → executeTool`（`:1822`）→ 注册表分发（`:2945/2947`）→ 我改的那两个函数。⇒ "旁路是真的、修的是活路径"两句都站得住。
- 转换矩阵收紧面已枚举：新增被拒的跳转 = `Pending→Production/Shipping/Delivered`、`Confirmed→Shipping/Delivered`、`Production→Delivered`、`Delivered→任何`、`Alert→Delivered`、以及 DR-010 扩展态；**`Pending→Confirmed` 仍放行**（主线不断）。唯一调用方是 LLM（`mcp/manifest.ts:337-348`），`pwa/`、`electron/`、`components/` 均无引用 ⇒ 是真收紧，不是打断界面。
- 既有测试面：`businessScenarioEval` + `permissionAgentToolMatrix` + `toolRegistry` **124 例全绿**；导入器/`lcGateWiring` 4 文件/B50-1c/1d 的站点全部复验。
- 复核自己也没查完的两点（如实记）：`resolveReviewerByDepartment('agent')` 对 `'agent'` 的确切抛错路径未看（改用 `system` 后此路不再传哨兵）；FK 违约**未做成真写入观察**。
