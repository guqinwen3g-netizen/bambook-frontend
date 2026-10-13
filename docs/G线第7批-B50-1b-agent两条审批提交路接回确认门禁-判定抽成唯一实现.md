# G 线第 7 批（B50-1b）· agent 两条审批提交路接回确认门禁：判定抽成唯一实现，顺带挖出审计哨兵撞外键

日期 2026-09-21（本地 18:0x–18:2x 实测）· 工作树 `apps/bambook-s0a` · 分支 `s0/error-truth-foundation`
起点 HEAD `15332f63`（B50-1a）· 施工图：`docs/G线第6批-B50-1a-*.md` §七 · 判据源：`docs/交付目标与验收标准-2026-09-20.md` v2.28 §2 G4 / §8 / §9 B50

---

## 一、这批补的是哪几个漏

`order.confirm` 与 `invoice.issue` 是 agent 的两段式工具：**先出 ProcessDraft → 人工审批 → 审批通过后重放提交**。
提交段在自己的一份 `prisma.$transaction` 里**直接写主数据**，所以 §9 记在引擎上的那些控制对它们一条都不成立：

| # | 漏口（改前，HEAD=15332f63 的行号） | 写的是什么 | 缺哪道控制 |
|---|---|---|---|
| 1 | `agent/commitTransaction.ts:285`（`tx.order.update` 把状态改成 Confirmed）+ `:272`（状态流转记录） | 订单状态 | 确认三门（信用 / MOQ / L-C）全缺 —— 而 `orders/orderLifecycleService.ts:336-470` 那 130 行判定就在同仓里 |
| 2 | `agent/commitTransaction.ts:305`（`tx.invoice.create` 直接建 `status=Issued` 的应收票） | 发票 | 开票 L/C 门禁（`finance/invoiceMutationService.ts:390` 有，这条路上没有） |
| 3 | `agent/invoiceIssueFlow.ts:229`（`tx.invoice.create`） | 发票 | 同上 —— 这是**第二条**不走 `createInvoice` 的开票出口 |
| 4 | `agent/commitTransaction.ts:232` `approval?.requesterId \|\| 'unknown'` 与 `agent/invoiceIssueFlow.ts:280` `actorId: 'agent'` | `AuditLog.actorId` | 该列有外键 → `UserAccount(id)`，而 `'unknown'` / `'agent'` 库里**没有账号行** ⇒ 审计写入必撞 P2003 ⇒ 整笔提交回滚 |

第 4 条不是"顺手洁癖"：门禁接到一条**跑不通**的路上只是自欺（B50-1a 的复核 BLOCK 就是同一类：我自造了一个库里不存在的哨兵）。

---

## 二、真库读数（全部只读 `SELECT` / `pg_constraint`，未做任何写操作）

库：`panda_hub_local`（本机业务库，就是本仓测试/演练用的那一份）。

| 问题 | 结果 | 结论 |
|---|---|---|
| `AuditLog.actorId` 有没有外键 | `AuditLog_actorId_fkey · FOREIGN KEY ("actorId") REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE RESTRICT` | 有，且强制 |
| `ApprovalRequest.requesterId` | 同样有 FK → `UserAccount(id)` | 用假身份自动发起豁免单也会撞 FK |
| `UserAccount` 里有没有 `'system'` / `'agent'` / `'unknown'` | `'system'` 有（displayName `系统服务`，全表 53 行）；`'agent'` `'unknown'` **均无行** | 只有 `'system'` 是合法哨兵（与本仓 `audit/routeAudit.ts:182-184` 的既有收敛一致） |
| `AuditLog` 里用过这些哨兵的条数 | `system` 8 条；`agent` 0 条；`unknown` 0 条；`api` 0 条 | 与"外键会拦"一致 |
| `AgentCommitReceipt` 行数 | **0** | agent 提交路径**从未跑通过** |
| `AuditLog` 里 `action='order_confirm_committed'` / `'invoice_issue_committed'` | **0 条 / 0 条** | 同上（两处审计都在事务内，回滚就什么都没留下） |
| `ApprovalRequest` 按 `actionType×status` | `contract:sign` 170 approved、`aftersales:claim-disposition` 7 pending、`order:moq-exemption` 3 approved + 2 pending、`quotation:price-deviation` 3 pending、`finance:payment_request` 2 pending —— **没有 `order:confirm` 类审批单** | 见下面"把 B50-1a 的话收窄" |

★ **纠正上一批的说法（登记留痕，不改写历史）**：B50-1a 的文档里我写这两条旁路在"活路径（审批重放）"上。本批实测把它**收窄为**：
"入口可达（`agent/toolRuntime.ts:2528 / :2707 / :3100 / :3136` 四处调用提交函数），但**真库上从未跑通过**（0 回执、0 条相关审计、库里没有 order.confirm 类审批单）"。
这不降低严重度 —— 漏口是"M3 演练一旦真跑审批重放就会暴露"，而不是"已经在生产上漏着"。**可达 ≠ 已发生**，上一批那句话写得像后者。

---

## 三、怎么改的：判定只留一份，位置按副作用定

### 3.1 抽出 `evaluateOrderConfirmGates`（唯一一份确认判定）

`orders/orderLifecycleService.ts`：把原来长在 `transitionOrderStatus` 里的那 130 行（信用 → MOQ → L/C）
整体搬进导出函数，`transitionOrderStatus` 变成"调它 + 拿 `creditExceptionPass` 去核销"。

为什么**不**让 `commitTransaction` 直接改调 `transitionOrderStatus`：它自己开 `$transaction`，
而 Prisma 不许嵌套交互事务 —— 所以两条路能共用的**最小交集是"判定"，不是"事务"**。
这正是 B50 本体（"同一动作两份实现"）的成因，所以这次共用点选在哪一层，是要写下来的判断而不是实现细节。

★ 函数**自己查订单行**，不接受调用方传 row：门禁要的字段一旦被某个调用方少选一个
（历史上最贵的那次：`paymentInstrument` 被写成矩阵里的 `paymentMethod`，字段根本不存在 ⇒ 门禁恒不触发且全绿），
漏的就是那一个调用方。少一个入口 = 少一处能漏的东西。原先那段 `select` 与"已是 Confirmed 就不重复跑门禁"这条规则一起下沉，
`transitionOrderStatus` 里那份读数删除（台账 §9 B36/B48 的"同一 select 两处"因此少了一处）。

### 3.2 位置：确认腿在事务**之前**，开票腿在事务**之内**

判据不是"哪个更严格"，而是**有没有写库的副作用**：

- `credit/creditExceptionGate.ts:79` `exceptionService.createExceptionRequest(...)` —— 信用门禁阻断且无生效例外时**真的建一张豁免申请单**；
  `resolveCreditException` 返回的 hint 原文是"已自动发起信用例外申请（例外单 X，审批单 Y），审批通过后重试"。
  MOQ 腿同理（`moqValidationSvc.validateCreate({autoCreateApproval:true})`）。
  ⇒ 放进 `$transaction` 里，阻断 → 回滚 → 那张单**也跟着消失**，而屏幕上是那句"已自动发起"——一句假话，
  且用户照做会在审批中心找不到单子。**这是"必须在事务之前"的唯一理由**，也是本批最容易做反的地方。
- `customs/lcGate.ts` 的 L/C 判定是**纯读**（`decideLcGate` 只 `findMany` 信用证 + 查 DR-013 例外，不写）。
  ⇒ 放在事务内、任何写入之前：判完即写不留竞态，抛出即整笔回滚，票不落地。

### 3.3 结果形状：业务拒绝不许伪装成数据库错误

`agent/feedbackContract.ts` 新增契约码 `CONFIRM_GATE_BLOCKED`，并把 `OrderConfirmError` 扩了两个字段：
`gateCode`（精确的门禁码：`MOQ_VIOLATION` / `CREDIT_FROZEN_60_DAYS` / `LC_GATE_BLOCKED` …）与
`approvalRequestId`（DE-6：阻断时自动发起的豁免单号必须透传）。
`parseErrorCode` 里三枚新分支**排在 `COMMIT_FAILED` 兜底之前** —— 否则 `CONFIRM_GATE_BLOCKED: …`
会被吞成 `COMMIT_TRANSACTION_FAILED`，userAction 就成了"数据库错误，请稍后重试"，
于是业务员对着一道永远挡住他的门反复重试。开票腿两枚码（`LC_GATE_BLOCKED` / `LC_EXCEPTION_CHECK_FAILED`）
直接进 union 并与 `invoiceMutationService`、`invoiceIssueFlow` **同名**：同一道门在同一动作上必须同名。
（信用族的 `blockCode` 是开放集合 ⇒ 不枚举进 union，走 `gateCode` 字符串，避免又一份要人手工跟齐的穷尽表。）

### 3.4 审计身份

`commitTransaction.ts`：`approval?.requesterId || 'system'`（原 `'unknown'`），既用于审计也用于传给门禁
（豁免单 `requesterId` 同样受外键约束 ⇒ 假身份会让"自动发起"注定失败）。
`invoiceIssueFlow.ts`：原来把字面量 `'agent'` 直接写进 `AuditLog.actorId` ⇒ 同一张表同一个外键，
改成"查 approval 的真实请求人，查不到才落 `'system'`"（与 `commitTransaction` 同一口径）。
`OrderStatusTransition.operator` 仍是 `'agent'`：该列无外键（实测 `OrderStatusTransition` 只有 `orderId` 一条 FK），
它是"谁干的"留痕文本，不是身份引用 —— 与 B50-1a 同一区分。

### 3.5 顺手补上的一处真缺陷（不补就是假门禁）

`transitionOrderStatus` 走信用例外放行时，提交后要 `consumeCreditException` 核销那张一次性例外。
`commitTransaction` 原来根本不跑门禁，自然也没有核销这一步 ⇒ 接上门禁后**必须**补上，
否则"只许用一次"的例外在这条路上变成可无限复用（放行的边界只剩审批人当初写的那句话）。

---

## 四、证据

### 4.1 行为证据（主证据 = 域测试，不是源码正则）

`server/src/agent/__tests__/orderConfirmGateCommitB50b.test.ts`（新增 15 例）——**不 mock 门禁**，
delegate 口径照 `orders/__tests__/orderConfirmGates.test.ts` 那一套（真判定跑在假库上）：

| 组 | 判什么 | 用例数 |
|---|---|---|
| ① 确认腿 | MOQ 不足 / 信用 Frozen / L-C 无证 ⇒ 契约码 `CONFIRM_GATE_BLOCKED`、`gateCode` 精确、豁免单号透传、**零写入 + 零幂等回执**（回执是事务体第一笔写 ⇒ 它没出现就等价于"门禁跑在事务之前"）；另钉"已自动发起"那句消息里的单号来自真调用 | 6 |
| ② 开票腿 | 事务外读 T/T（放行）、事务内读 L/C 无证 ⇒ 码是 `LC_GATE_BLOCKED` 而不是数据库错误，且状态/流转/票**三处都零写入**；例外查不出来 ⇒ 单独一码 `LC_EXCEPTION_CHECK_FAILED` | 2 |
| ③ 审计身份 | 有请求人 ⇒ 全部审计行 `usr_tester`；approval 查不到 ⇒ 落 `system` 且**断言不出现 `unknown`** | 2 |
| ④ invoice.issue | L-C 无证 ⇒ failed + 码对 + 票没建 + 审计没落；T/T 正向对照；无 orderId 锚点 ⇒ 连信用证表都不查（边界，见 §六）；Payable 不受客户信用证门禁 | 5 |

### 4.2 反例（把接线拆掉，必须红）

| 反例 | 怎么拆 | 结果（跑的是三份文件合起来 77 例：门禁行为 15 + 分发层 3 + 既有 commit 语义 57 + invoiceIssueFlow 20）|
|---|---|---|
| CE-1 | `commitTransaction.ts` 确认腿 `if (gateAnchor && !gateAnchor.deletedAt)` → `if (false)` | **6 红** |
| CE-2 | `commitTransaction.ts` 开票腿 `if (invoiceOp && invoiceType === 'Receivable')` → `if (false)` | **2 红** |
| CE-3 | `invoiceIssueFlow.ts` 开票腿 `if (anchorOrderId && invoiceType === 'Receivable')` → `if (false)` | **2 红** |
| CE-4 | `toolRuntime.ts` 分发层把码写死成 `UNKNOWN_ERROR`（= 复核抓到改动前的行为） | **3 红**（正好是分发层那 3 例） |
| 还原 | 从 `/tmp/b50b_backup` 恢复三份文件后重跑 | **77 绿**，`grep -c "CE-"` = 0 |

★ 每一处 patch 都带 `assert s.count(old)==1`：本批第一轮就因为转义写错**静默没打上**，那次的"15 绿"是空跑（教训见 §九）。

过程记一条自己的错：第一轮 CE-2 / CE-3 我用了 `python3 -c "…\"…\"…"` 的转义写法，patch **根本没打上**，
那两行"15 passed"是空跑。上面这组数是改成 heredoc 重打 patch 后重跑的。

### 4.3 靶向回归（同域全套）

`npx vitest run src/customs/__tests__/lcGateWiring.test.ts src/agent/__tests__ src/orders/__tests__ src/finance/__tests__` ⇒ **147 文件 / 1988 例全绿**（接线中途的一次量，最终数字看下表）。

### 4.3b ★ 终轮全量（独占环境，D56/D63）

| 项 | 登记 |
|---|---|
| 起跑前 | `pgrep vitest` = 0（无并发测试）· 负载 3.49 / 5.35 / 5.56 · `:8081` = `PID 68014`（**未动**，本批也没打它） |
| server | **530 文件 / 7057 例 / 0 红**（上一批 528 / 7034 ⇒ +2 文件 +23 例；上一批那 1 处 `suppliers/factoryRoute` 的 B15 域红**本轮未复现**） |
| web | **185 文件 / 3621 例 + 13 跳过 / 0 红** |
| `tsc` | 两端均 **0** |
| 落盘 | `/tmp/gate_b50b_server_final.txt`、`/tmp/gate_b50b_web_final.txt`（整份，不是摘要） |

★ **首轮全量不是绿的**，而且红的全是本批自己造的形：`rawErrorLeakRatchet`(B22) `commitTransaction 0→1`、`orderLifecycleService 2→3`、`toolRuntime 10→11`，`serviceMessageWrapRatchet`(B30) `feedbackContract 0→1`，`businessThrowShapeRatchet`(B34) 全仓 `149→151`。
⇒ 处置：跨层**不新增 `.message` 转发**（返回体沿用既有 `{code,message}` 外壳，字符串仍在一处组装）、分发层改取 `_r.error`、两处抛点补 `statusCode: lookupErrorCode(code)?.status ?? 500`。**三条判据一条没改、基线一个没动**。

`commitTransaction.test.ts`（既有 57 例）改动**只加不改**：
补 `prisma.order.findFirst`（确认腿锚点）+ `tx.order.findUnique`（开票腿自取付款方式）两处 delegate，
并把确认门禁 `vi.mock` 桩成放行（该文件测 draft/hash/receipt 语义）；**期望值一条没改**。
注意：它的桩里**没有**桩 `decideLcGate` ⇒ 那 57 例是真跑开票腿门禁的（这正是要求补 `findUnique` 的原因）。

### 4.4 三层互补（删掉接线谁会红）

1. 行为层：新测试文件（真门禁 + 真 `decideLcGate`）—— 删任一条腿即红（CE-1/2/3 已量）；
2. 桩层：`commitTransaction.test.ts` 的 `evaluateOrderConfirmGates` spy —— 用于钉"调用参数（orderId 来自 poNumber 解析、actorId 用真实请求人）"；
3. 清单层：`lcGateWiring.test.ts` 接入点 4 → **6 文件**，每文件带"接错就永不触发"的反向钉
   （`order: null` 会把门禁变成放行、不许自带 `letterOfCredit.findMany` / `hasActiveException` 另造一份判定、
   门禁要用的字段 select 全仓只许出现一次）。

---

## 五、影响面与不变量

- **非信用证订单行为不变**：真库存量 69/69 为 T/T（G-4 实测，本批未重测）。T/T 路径上
  `evaluateOrderConfirmGates` 仍要跑信用 + MOQ ⇒ 这是**新增的阻断**，不是无变化：
  原先"审批一过就 Confirmed"，现在 Frozen 客户 / 低于 MOQ 的 agent 确认会被挡（这正是本批要的效果）。
  正向对照（合规 T/T 订单照常提交、发票照建）在 ① 组与 `commitTransaction.test.ts` 57 例里钉住。
- 无迁移、无 schema 变更、无前端契约变更（`errorFeedback` 只**增**字段不改旧字段；新增码在 union 里是追加）。
- ★ **抽取的等价性证据**（这条最重要的"顺手搬家"必须可查）：把 HEAD 那段 130 行与新函数做**去注释、忽略缩进**的逐段 diff ⇒ **72 处差异，全部属于四类外壳**：函数签名/返回形状（`{ok:false,error:{code,message}}` → `{allowed:false,code,message}`）、`actorId ?? operator ?? 'api'` 提成局部量 `actor`、日志 payload 多带一个 `logScope` 字段、`if (status !== 'Confirmed')` 反成"已 Confirmed 就早退还放行"。
  **三道门的判定条件、执行顺序、消息文案、fail-closed 分支：零改动**（diff 里没有出现任何条件或常量的增删）。行为等价另有 orders 域 22 条真门禁用例 + §4.3 的 1988 例回归兜底。
- ⚠️ 一处**微差异**（不是等价抽取的一部分，是有意的）：MOQ 分支 HEAD 无条件写 `approvalRequestId: moqCheck.approvalRequestId`（值可能是 `undefined` ⇒ JSON 序列化后该键消失），新实现改为"有值才带键"。对外 HTTP 载荷不变（`undefined` 本来就不出现在 JSON 里），差别只在**进程内**读 `error.approvalRequestId === undefined` 与 `'approvalRequestId' in error` 的代码 —— 全仓 grep 无这种写法，1988 例回归亦无红。
- 历史单据不追改：本批纯控制流接线，不碰任何已确认订单/已开发票的数据。
- ★ 顺手把 B50 分母的"字面量粗扫"这条老坑核了一遍：`grep status:'Confirmed'`（去测试）全仓 9 处命中，**逐处读后没有一处是 Order 状态写入** —— `bom/bomService.ts:594`、`procurement/procurementService.ts:699`、`hr/hrService.ts:991/:1135` 写的是 BOM / 采购单 / 请假（不同实体的同名词），`briefing/briefingService.ts:116` 与 `scheduler/tasks/stuckProcessDetector.ts:60` 是**查询条件**（后者只读 + 发通知），`agent/mcp/manifest.ts:1048` 是给模型看的示例串。
  ⇒ 这正是 §9 B50 那条"字面量判据对 `status: <变量>` 无效、粗扫一片假阳性"的原文教训的第二次实测确认：**分母只能按调用链逐处现读**，本批的分母仍是上一批那份人工清单（不是判据）。
- D28 三约束里"口径变更写进文档"：agent 面 `order.confirm` 的语义从"审批通过即提交"变为
  "审批通过 **且** 业务门禁通过才提交" ⇒ 就是本节这句话，台账 §12.1 第 16 条已把"审批 vs 门禁"的政策问题挂给 Kevin，
  本批按最严解释（要挡）实现；若 Kevin 反过来拍"审批过了就不该再挡"，回退点就是 `commitTransaction.ts` 那一个 `if`。

---

## 六、未做 / 未覆盖（S1–S3，写明"没证明"而不是省略）

0. ★ **可达性一句话更正（复核判出）**：`toolRuntime.ts` 里那四处调用**代码上都在**，但 `executeTool` 是**注册表优先 return** ⇒ `:2528` / `:2707` 两处内联分支实为死代码，`order.confirm` / `invoice.issue` 真跑的是 `_rct` 注册的 `:3100` / `:3136`。
   复核同时判出该**唯一可达**的 `order.confirm` 分发映射有缺陷（读不存在的 `feedback` ⇒ 一律 `UNKNOWN_ERROR`）⇒ 本批已改映射并补 3 例（CE-4）；其**成功路径**同样读 `_r.feedback`（`committed` 字段传不出去）⇒ 未修，立 **B61**。
1. **真库端到端未跑**：断言全部来自 mock prisma。P2003 回滚、Serializable 行为、"被挡时不留半张票"的**回滚原子性**
   本身是 DB 语义，mock 里证明不了 —— 本批只证明了"阻断时那几笔写在 mock 里没发生"。真库演练属 M3（B35 数据集是前置）。
2. **门禁读数与写入之间的窗口**：确认腿在事务前读、事务内写 ⇒ 理论上"读时合格、写时已不合格"。
   这个窗口与 `transitionOrderStatus` 现有实现**完全同源**（它的门禁也在 `$transaction` 之前），本批没有把它变小也没有把它变大；
   已登记 §9 **B59**，不许因为"两边一样"就当不存在。
3. **`invoice.issue` 无锚点票不过 L/C 门禁**：`agent/toolRuntime.ts:624` `orderId: ti.orderId ? … : undefined` ⇒
   `orderId` 是**可选**入参，无锚点的应收票跳过本门禁（与 HTTP 开票主路径同一条件，不是本批新造的洞）。
   已登记 §9 **B60**。
4. **`actorId:'agent'` 的其余站点没清**：`grep` 全仓 agent 面 34 处 / 19 文件（不含测试与 manifest 示例）。
   本批只逐处确认并修了会落 `AuditLog` 的 2 处（`invoiceIssueFlow.ts:280`、`commitTransaction.ts:232`）；
   其余 32 处**未逐处确认**下游是否写审计（有的服务只把它当 operator 留痕）。整族登记 §9 **B58**，不在本批顺手改。
5. **一次性例外的"用掉"未在真库验证**：`consumeCreditException` 在提交后被调（代码路径 + 单测口径），
   但没在真库上验过"第二次确认就被挡"。
6. B50 余下两切片未做：`B50-1c`（变更申请恢复 Confirmed）、`B50-1d`（发运取消回退**猜** `'Confirmed'`）—— 见 §9 B50 行。

---

## 七、下一批建议

1. **B58（优先）**：`grep` 出来的 34 处 `actorId:'agent'` 逐处定性（身份 or 留痕）→ 身份族统一收敛 `'system'`，
   并加一条"审计 actorId 必须是 `UserAccount` 里真存在的行"的判据（形式待定：先在 `prisma/schema.prisma` 层加种子断言，
   别一上手就加棘轮 —— 守 D49）。M3 演练会让这条族**全部现形**（任何一次审批提交都回滚）。
2. `B50-1c/1d`：同一份 `evaluateOrderConfirmGates` 接回这两处（已经是可达函数，改动量小）。
3. `B53`（4 处 rethrow 吞业务文案）、S0-A2 第 9 批（email 14 处，前置已量完）。

---

## 十、R4-T4 独立复核处置（总判 **PASS-with-findings**，逐条）

| 复核条 | 判 | 我的处置 |
|---|---|---|
| A1 抽取等价 | 成立（含那处微差异） | 已写进 §五；不改 |
| A2 假门禁风险 | 大体成立，**留一处残余 fail-open**：`invoice.issue` 的 `orderId` 脏值 ⇒ 门禁自取 null ⇒ "不适用"放行、票照落（`Invoice.orderId` 无外键） | 未修（不在本批范围），**B60 已按此加细**，并把"`lcGateWiring` 的 `order: null` 反向钉只咬字面量、咬不到 `invoiceMutationService.ts:393` 的表达式版"一并写进去 |
| A3 结果形状 | **部分不成立（BLOCK）**：可达的分发映射把新码洗成 `UNKNOWN_ERROR` | **已修**（`toolRuntime.ts` 的 `_rct('order.confirm')` 改读 `CommitResult` 自身字段），补 `orderConfirmCommitDispatchB50b.test.ts` 3 例 + CE-4 反例 |
| B1 测试有效性 | 两条弱例 | **已改**：Payable 例改断"提交成功 + 真没查信用证表"；无锚点例把订单行改成 L/C，使 throw-mock 真能触发，并加 `not.toHaveBeenCalled()` |
| B2 三层互补 | 第三层不存在：`gateSpy` 声明了却没有任何断言用它 ⇒ 我那句注释是假话 | **已补**：新增 2 例真用 spy（门禁调用次数 + `orderId` 取 poNumber 解析值（草稿里故意放另一个 id 作对照）+ `actorId=审批请求人` + `logScope`；以及阻断时 `$transaction` 未开） |
| B3 反向钉覆盖面 | 判据成立但自我高估 | 采纳：不改判据，把限制写进测试注释 + B60（见上） |
| C1/C2 外键与留痕 | 成立（`operator` 无外键、`'agent'` 族确有更多站点） | 已按 B58 的口径登记，不夸大 |
| D1 副作用位置 | 成立（`exceptionService.ts:463` / `approvalCreateService.ts:109` 真写库，用的都是调用方传入的 client） | §三 的理由由"读注释"升级为"读实现"，保留 |
| D2 可达性 | 说过头 | 见 §六-0 更正 |
| D3① 注释不实 | "位置在任何一笔写之前"与自家测试互相打脸（幂等回执在前） | **已改注释**为"主数据那几笔写之前"，并说明回执为何不算主数据 |
| D3② 静默假证据 | 未使用的 `gateSpy` 局部量（server 无 `noUnusedLocals` ⇒ tsc 不红） | 已由 B2 的处置消除（现在真被断言使用） |

★ 复核之外、我自己在全量首轮撞到的：三条棘轮抓到本批新增的 4 处形状（见 §4.3b）——**先跑全量再自夸"绿"，比任何自评都管用**。
