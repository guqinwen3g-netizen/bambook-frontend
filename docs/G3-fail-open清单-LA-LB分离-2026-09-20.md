# G3 fail-open 存量清单 —— L-A / L-B 分离（派生件）

> **文档效力**：本文件是 `docs/交付目标与验收标准-2026-09-20.md` §2 **G3** 的**证据附件 / 派生清单**（R3 覆盖派生），
> **不定义判据**。判据仍以权威文档 §2 G3 表为准。按 §0.5「新增文档纪律」，本文件应由文档负责人登记为
> **证据附件**后再被引用；未登记前只能当线索。
>
> **本清单解决了什么**：G3 表 L-A 栏原写「**尚未分离出清单**」，L-B 栏原写「418 行 / 221 行（**含 L-A，尚未分离**）」
> —— 那两组数是两级混计，不能当判据。本文件把它们拆成 **L-A / L-B / 待核实** 三档，拆分由脚本派生（非手写）。
>
> **一句话结论**（现状栏是活数据，§0.3；**2026-09-20 04:19 CST 由 Task 7 复审 F1 重跑刷新**，命令见 §1.2）：
> L-A **不是 0，实测 190 处**（判据要求 = 0 ⇒ G3 L-A **不达标**）。其中 `catch(()=>0)` 形状被判 L-A 的只剩 **3 处**
> —— 首次取样时是 **9 处**，B14 那 6 处（`orderLifecycleService` 五路 + `orderLineMutationService:248`）已随提交
> **`35076222`** 改为 fail-closed ⇒ **196 → 190，差 6 恰好等于修掉的 6 处**（逐处对账见 §1.2）；
> 其余 187 处是「缺失值回落 0 后参与计算/判定/写」的存量（3 + 187 = 190），需按表 A/B/C 分层消化。
> **本文件不声称其中任何一处已在运行时出错**（见 §8）。

---

## 1. 取样记录（§0.3 格式：数值 + 证据 + 取样时间 + 命令）

> ★ **现状以 §1.2（2026-09-20 04:19 刷新）为准**；本节下面的 03:36 记录是**首次取样**，保留作对账历史（§0.3 现状栏是活数据）。

| 项 | 内容 |
|---|---|
| 取样时间 | **2026-09-20 03:36 – 03:38（GMT+8 / CST）** |
| 仓库状态 | `main` 主检出（未提交本清单；改动仅新增本文件 + 扫描脚本） |
| 扫描器 | `scripts/check-fail-open-inventory.mjs`（Node 22，零依赖，不新增依赖） |
| 命令 ①（自测） | `node scripts/check-fail-open-inventory.mjs --selfcheck` → **11/11 通过，exit 0** |
| 命令 ②（全量） | `node scripts/check-fail-open-inventory.mjs` → 下列总计，**exit 1**（L-A > 0） |
| 命令 ③（基线） | `node scripts/check-fail-open-inventory.mjs --baseline` → `✅ L-B 171 ≤ 基线 171`（退出码仍 1，来自 L-A） |
| 命令 ④（咬红验证） | `node scripts/check-fail-open-inventory.mjs --baseline --lb=170` → `❌ L-B 高于基线（170 → 171）`（G6.3：改坏会咬红，已实测） |

**扫描器实际打印的总计（命令 ②，首次取样 03:36 —— 历史值，现值见 §1.2）**：

```
覆盖：server/src 472 文件 · 前端主应用 296 · customer-portal/src 20（合计 788；测试/node_modules/构建产物/注释/字符串已排除）
═══ 总计 ═══
  L-A        196   server 146 · 前端 50 · portal 0
  L-B        171   server 91 · 前端 78 · portal 2
  待核实     367   server 214 · 前端 151 · portal 2
  命中总数   734
❌ G3 L-A 零容忍判据不达标：现存 196 处写/守卫路径兜底（判据 = 0）
```

形状分布（同一批数据）：`?? 0` **434** 命中 · `|| 0` **283** 命中 · `catch → 0` **17** 命中。
路径去重后：**server/src 416 行、前端主应用 255 行、portal 4 行**（合计 675 个不同行）。

### 1.1 与权威文档记录的 418 / 221 对账（不掩盖差异）

| 口径 | 权威文档（2026-09-20 01:20 扫描） | 本清单（同日 03:36，注释已抹除） | 差异原因 |
|---|---|---|---|
| `server/src` 非测试 | 418 行 | **416 行** | 差 2 行；**待核实** —— 原文档未附命令，无法确认其排除集是否含注释 |
| 前端非测试 | 221 行 | **255 行**（不含 portal） | 差 34 行；本清单口径含 `App.tsx index.tsx types.ts appTheme.ts components/ services/ utils/ lib/`，**是否就是原文档的目录集未知** |

⇒ **不得把本清单的行数与 418/221 当成同一口径互相引用**。两组数各自带命令/日期才可用（§0.3）。
差异方向（本清单前端多、服务端少 2 行）**未定位根因 ⇒ 待核实**，不做解释性结论。

### 1.2 刷新记录（2026-09-20 04:19 CST · Task 7 复审 F1 · **现状以此为准**）

| 项 | 内容 |
|---|---|
| 取样时间 | **2026-09-20 04:19（GMT+8 / CST）** |
| 仓库状态 | worktree `apps/bambook-s0a`，分支 `s0/error-truth-foundation`，HEAD `c224c1c6`（含 B14 修复 `35076222`） |
| 命令 ①（自测） | `node scripts/check-fail-open-inventory.mjs --selfcheck` → **11/11 通过，exit 0**（分类器仍非空转） |
| 命令 ②（全量） | `node scripts/check-fail-open-inventory.mjs` → 下列总计，**exit 1**（L-A > 0） |
| 命令 ③（基线） | `node scripts/check-fail-open-inventory.mjs --baseline` → `✅ L-B 171 ≤ 基线 171`（退出码仍 1，来自 L-A） |

**扫描器 04:19 实际打印的总计（命令 ②）**：

```
覆盖：server/src 473 文件 · 前端主应用 296 · customer-portal/src 20（合计 789；测试/node_modules/构建产物/注释/字符串已排除）
═══ 总计 ═══
  L-A        190   server 140 · 前端 50 · portal 0
  L-B        171   server 91 · 前端 78 · portal 2
  待核实     367   server 214 · 前端 151 · portal 2
  命中总数   728
❌ G3 L-A 零容忍判据不达标：现存 190 处写/守卫路径兜底（判据 = 0）
```

形状分布（同批 `--json`）：`?? 0` **434** · `|| 0` **283** · `catch → 0` **11**（合计 728）。
路径去重后：**server/src 410 行、前端主应用 255 行、portal 4 行**（合计 669 个不同行）。
L-A 涉及 **95 个文件**（首次记 96 ⇒ 只少 1 个：`orderLineMutationService.ts` 整文件出账，
`orderLifecycleService.ts` 仍因 `:342` 的 E1-gate 留在表 B）。

**与 03:36 首次取样逐档对账（差异必须能指名，不留"莫名少了几处"）**：

| 档 | 03:36 | 04:19 | Δ | 归因 |
|---|---|---|---|---|
| L-A | 196 | **190** | **−6** | = B14 修掉的 6 处（`orderLifecycleService.ts:176-180` 五路 + `orderLineMutationService.ts:248`），提交 `35076222` ⇒ **无来路不明的增减** |
| L-A 中 `catch→0` 形状 | 9 | **3** | −6 | 同上；余 3 见表 A（含 §4.0.1 的三处 deferred 判定记录） |
| `catch→0` 总命中 | 17 | **11** | −6 | 同上（待核实那 8 处一条未动：`--json` 复核仍为 8） |
| L-B | 171 | **171** | 0 | 基线未变 ⇒ `--baseline` 仍绿 |
| 待核实 | **360** | **360**（★ v3.236 就地复量：原写 367，今日同一把尺当场读 360 —— 历批顺手消化、没人回写这一格 ⇒ 腐烂的状态陈述） | 0 | 本批未做「域内失败语义」批次 ⇒ 一条未消化（符合预期） |
| 命中总数 | 734 | **728** | −6 | 全部由上面那 6 处解释 |
| 覆盖文件数 server/src | 472 | **473** | +1 | 期间并行的 Task 4b（HR 真源合并 `c224c1c6`）新增文件 ⇒ 覆盖面**变大不是变小**，L-A 下降不是"少扫了文件"造成的 |

---

## 2. 覆盖面（实扫了什么；G6.2 覆盖面 ≥ 写法面）

| 组 | 覆盖路径 | 文件数（首次 03:36 → 现值 04:19） |
|---|---|---|
| server | `server/src/**/*.ts` | **472 → 473**（+1：并行 Task 4b 新增文件 ⇒ 覆盖面变大，不是变小） |
| frontend（主应用） | `components/**`、`services/**`、`utils/**`、`lib/**` + `App.tsx` `index.tsx` `types.ts` `appTheme.ts` | **296** |
| portal | `customer-portal/src/**`（G5/B7 范围内的独立前端，**本清单额外补上**，原 418/221 口径未提它） | **20** |

**排除**：`__tests__/`、`*.test.ts(x)`、`*.spec.*`、`*.d.ts`、`node_modules/`、`dist*/`、`build/`、`out/`、`coverage/`、
`logs/`、`tmp*/`、`uploads/`、`storage/`、`private-files/`、`backups/`、`.git/`。
**未覆盖（明确写出，不含糊）**：根目录 `scripts/`（验收/运维脚本，含大量 `.catch(() => 0)` 类兜底）、`server/scripts/`、
`server/ops-panel/`、`electron/`、`pwa/`、`group-chat/`、`design-lab/`、`index.html`、`customer-portal/dist/`。
⇒ **L-A 的 190（04:19 现值）是"业务代码内"的下界**，不含运维脚本面（脚本面兜底属可接受类，但要判也得单列一次）。

**写法面（三种形状）**：
① `catch` 返回 0 —— 含 `.catch(() => 0)`、`.catch(e => 0)`、`.catch(() => [0, 0, 0])`（元组零值，比原文档口径多这一种）、
以及 `catch (e) { … return 0 }` 块形式；
② `?? 0`；③ `|| 0`。
② ③ 均**排除** `?? 0.7` / `|| 0.9` 这类"兜底成非零"（不是把缺失当 0，语义不同）。

---

## 3. 分类规则（摘要；**完整可争议版本以脚本头部注释为唯一真源**）

判据核心问句（G3 原文）：兜底出来的 0 **是否流进「计算 / 比较 / 返回值门禁 / 写」**。

* **E0 语义零豁免 → L-B**：`// fallback:display` 就地豁免（E0-a）· 分页/偏移默认（E0-b）·
  聚合/计数种子 `(m.get(k) ?? 0) + v`（E0-c）· 计数器/版本号 `(usageCount || 0) + 1`（E0-c2）·
  JSX 插值 / `toFixed|toLocaleString|formatX()` 纯渲染（E0-d）。
* **E1 判定证据 → L-A**：兜底表达式落在比较/三元/`if(…)` 条件内；绑定名在同块内进入判定/`throw`/`return` 门禁；
  或外层是 `check*|validate*|assert*|verify*|can*(` 这类**门禁调用**（E1-gate）。
* **E2 计算证据 → L-A**：兜底表达式是 `+ - * /`、`+=` 的操作数（含 `reduce` 求和项）；
  或 catch 兜底**函数**的返回值在调用点进算式（E2-fn）。
* **E3 写路径证据 → L-A**：命中（或任意外层）调用是 `create*|update*|upsert|delete*|save|submit|patch|put|post(`、
  `new Prisma.Decimal(`、`data: { … }`，或前端 `set*()/update*()` 表单行写入。
* **E5 业务量闸门（最可争议的一条）**：E1/E2/E3 只证明"值流进去了"，不证明它改的是**账目口径**。
  ⇒ 再要求兜底作用对象命中业务量词（amount·qty·total·count·price·cost·balance·rate·percent·invoice·shipment·
  voucher·limit·credit·tax·applied·received·version·seq…），不命中 ⇒ **降待核实**（不判 L-A，也不硬说它是展示兜底）。
  依据 = §6 偏差分级：**口径级（不报错但算错）最危险，体验级不是**。`catch→0` 形状不受本闸门约束（来源本身就是取数失败）。
* **E4 其余 → 待核实**，其中四类**明确不判红**（G3 现状① 教训）：吞掉写失败的 `.catch(()=>0)`；
  catch 内已有 `logger.error|setError` 的非静默兜底；绑定名只被**取属性**（`if (!credit.ok)` 判的是信封不是这个数）；
  名字只出现在**展示文案模板**（`body: \`…${n > 0 ? …}\``）里；只落在 `sort()` 比较器（改顺序不改数额）。

**匹配前先抹除注释与字符串内容**（本仓两次因注释文本被计成违例 ⇒ 假红；本次自测 S4 专门盯这条）。

---

## 4. L-A 清单（判据：**必须为 0** · 实测 **190**（04:19 刷新 · 首次 196）⇒ 不达标）

路径前缀缩写：`S:` = `server/src/`，`C:` = `components/`，`svc:` = `services/`，`lib:` = `lib/`，`u:` = `utils/`，`P:` = `customer-portal/src/`。

### 4.0 表外提要：三处最危险（先修这三处，再谈存量）· **现状：① ③ 已修，② 仍开，④ 已判定 deferred**

| 排序 | 站点 | 为什么是"写/守卫"而不是"显示" | 现状（04:19 复扫） |
|---|---|---|---|
| ① | `S:orders/orderLifecycleService.ts:176-180`（= 已登记的 **B14**，本清单照录 5 个站点） | 5 路依赖计数各自 `.catch(() => 0)` ⇒ 任一 `count()` 抛错即得 0 ⇒ `if (invoiceCount > 0 || …)` 不成立 ⇒ **HAS_DEPENDENTS 守卫被绕过，订单被软删**。失败方向 = 放行，且落在数据侧不是显示侧 | **✅ 已修** —— 提交 **`35076222`**（Task 7 B14 改 fail-closed）。原 5 个行号**已不存在**：五路计数现在是 `:220-227` 的 `Promise.all`，抛错走 `:228-234` 的 `catch` ⇒ 事务内 `throw dependencyCheckFailedError()`（`DEPENDENCY_CHECK_FAILED` / 503）整笔回滚。`--json`（04:19）里 `orderLifecycleService.ts` 只剩 `:342` 一条 E1-gate（表 B），五路已出账。测试：`S:orders/__tests__/deleteOrderDependencyGuardFailClosed.test.ts` |
| ② | `S:shared/invoiceAppliedSum.ts:50`（规则 E2-fn） | `num()` 把 **Decimal 转换失败**吞成 `return 0`，调用点 78/89/113 行直接 `Σ + num(appliedAmount)` ⇒ **发票"已核销额"被静默低估**，进而应收/账龄/结清判定全链路拿到错数且不报错 | **已修（v3.236 · B273）**：`num()` 四种读不出数的输入（null / 非有限数 / `toNumber()` 抛错 / 字符串读不出数）由"一律返回 0"改为**当场抛错**；★ 调用点行号已随本次改动漂移 —— v3.236 现读同尺在该文件命中的是三处 **L-B 聚合种子**（`:81 / :92 / :116`，原文写的 78/89/113 已过期），原 L-A 那一格（`:50` E2-fn）已从清单消失 |
| ③ | `S:orders/orderLineMutationService.ts:248`（规则 E1） | `entityLink.count().catch(() => 0)` ⇒ `if (linkCount > 0) deactivateEntityLinks(...)` 不执行 ⇒ **删订单行后残留 active EntityLink**（幽灵关联），随后仍继续 `tx.orderLine.delete` 写事务 | **✅ 已修** —— 提交 **`35076222`**。原 248 行**已不存在**：计数现在 `:265`（`where: { fromType: 'orderLine', fromId: lineId, deletedAt: null }`）且失败即在事务内抛 503。**顺带发现该站点比"吞错"更糟**：旧 where 用的 `sourceType`/`sourceId` 在 `EntityLink` 里根本不存在（`schema.prisma:1781-1800` 只有 `fromType`/`fromId`）⇒ `tx: any` 让编译器看不见 ⇒ 该查询**每次调用恒抛** `PrismaClientValidationError` ⇒ 恒 0 ⇒ **守卫从上线起就是假守卫**（订单行是硬删，`orderLineMutationService.ts:276` 起）。孤儿存量清点见 `task-7-report.md` 的 F2 节（本地 dev 库实测 **0**） |
| ④（并列） | `S:exceptions/exceptionService.ts:233` · `S:orderChanges/orderChangeRequestService.ts:303` | `count` 来自 `.catch(() => 0)` 后做 `String(count + 1)` ⇒ 查询失败时**业务单号从 `EXC-…-001` / `OCR-…-001` 重新起号**，与既有单据撞号（唯一约束冲突或覆盖式串号） | **未修 · 已判定并 defer**（controller ruling，理由见 §4.0.1）⇒ 不是"没看过"的遗留 |

### 4.0.1 三处「参与判定但本批判为 deferred」的判定记录（**防被当成未核查的残留**）

> 这三处的共同点：兜底的 0 **确实参与判定**，但复核后**失败方向不是"静默放行"**，
> 且修法都是跨域/跨模块的（取号要换发号器真源、Agent 前置条件要换「未知」三态），
> **不属 B14 的「0 参与放行判定」形状** ⇒ 由 controller 裁定为本批**不动**，逐条记证据，
> 出口分别是「改引发号器真源」与「改报『前置条件未知』」。取样 2026-09-20 04:19（行号为现值）。

| # | 站点 | 复核到的事实（文件:行号） | 为什么不算 fail-open（失败方向） | 出口 / 状态 |
|---|---|---|---|---|
| D1 | `S:agent/toolRegistry.ts:1080` | `const lineCount = await prisma.orderLine.count(...).catch(() => 0)` → 值进 `snapshot.lineCount`（`:1089`）→ `validateOrderSnapshot`（`:1101`）→ **`:1108 if (snapshot.lineCount <= 0) errors.push('NO_ORDER_LINES')`** → 调用方 `S:agent/toolRuntime.ts:318` 拿 `{ ok: false }` 即**拒绝继续** | 查不出来 ⇒ 被当成「这单没有行」⇒ 走进**拒绝分支**（误伤），**不是放行**。方向与 B14 相反，危害是可用性不是数据完整性 | **deferred（不改）**：语义应为「前置条件未知」而非「无行」；跨域 `src/agent` |
| D2 | `S:exceptions/exceptionService.ts:233` | `nextExceptionNumber()`（`:228-235`）`.catch(() => 0)` → `String(count + 1)`；落库方 `prisma.$transaction` 起 `:463`、`tx.dr013ExceptionRequest.create` 在 `:464`；`exceptionNumber String @unique` = **`schema.prisma:7026`** | 撞号时 `@unique` 索引在 create 处抛 **P2002**，而 create 在 `$transaction` 内 ⇒ **整笔回滚 + 报错**（响亮失败），不是静默串号。⚠️ 精确性说明：取号发生在事务**打开之前**（`:422` 调 `nextExceptionNumber()`），所以防护来自唯一索引而不是事务串行化 | **deferred（不改）**：本仓口径「取号一律走发号器真源」（`S:shared/businessNumberService.ts` + `S:paymentRequests/paymentRequestService.ts:155` 注释）⇒ 应改引 `sequenceService.nextNumber({ occupied })`；同文件 `:1110-1116` 的依赖守卫已是正确先例 |
| D3 | `S:orderChanges/orderChangeRequestService.ts:303` | `nextRequestNumber()`（`:298-304`）同上；`prisma.$transaction` 起 `:493`、`tx.orderChangeRequest.create` 在 `:494`；`requestNumber String @unique` = **`schema.prisma:6567`** | 同 D2：撞号 ⇒ P2002 ⇒ 事务回滚。危害等级 = 一次可重试的失败请求，**不是**脏数据 | 同 D2 |

**这三处的机器可读归属**：D1 在 §6.6（`E4-catch` 待核实），D2/D3 在**表 A**（L-A · 规则 E2）——
表 A 仍列它们，本小节只补「已判定 + 判定理由 + 出口」，**不改变计数**。

### 表 A · `catch → 0` 形状落在写/守卫路径（**现 3 条未了**，最高优先；首次取样为 9 条）

| # | 站点 | 规则 | 证据（值如何决定行为） | 状态（04:19 复扫） |
|---|---|---|---|---|
| 1 | `S:exceptions/exceptionService.ts:233` | E2 | `return \`${prefix}${String(count + 1).padStart(3, '0')}\`;` | **未修 · deferred，见 §4.0.1 D2** |
| 2 | `S:orderChanges/orderChangeRequestService.ts:303` | E2 | `return \`${prefix}${String(count + 1).padStart(3, '0')}\`;` | **未修 · deferred，见 §4.0.1 D3** |
| 3 | `S:shared/invoiceAppliedSum.ts:50` | E2-fn | `out.set(a.invoiceId, (out.get(a.invoiceId) ?? 0) + num(a.appliedAmount));` | **已修（v3.236 · B273）** —— "表 A 余下最危险的一处"这一格关掉；同族另外两处取号（`exceptionService.ts` · `orderChangeRequestService.ts`）仍开着，L-A 含 catch 形状 **3 → 2** |
| ~~3'~~ | ~~`S:orders/orderLifecycleService.ts:176`~~ | ~~E1~~ | ~~`if (invoiceCount > 0 \|\| …)`~~ | **✅ 已修 `35076222`**（2026-09-20 04:19 复扫已出账；测试 `deleteOrderDependencyGuardFailClosed.test.ts`） |
| ~~4'~~ | ~~`S:orders/orderLifecycleService.ts:177`~~ | ~~E1~~ | ~~同上（`invoiceAllocCount`）~~ | **✅ 已修 `35076222`**（同上） |
| ~~5'~~ | ~~`S:orders/orderLifecycleService.ts:178`~~ | ~~E1~~ | ~~同上（`shipmentCount`）~~ | **✅ 已修 `35076222`**（同上） |
| ~~6'~~ | ~~`S:orders/orderLifecycleService.ts:179`~~ | ~~E1~~ | ~~同上（`shipmentAllocCount`）~~ | **✅ 已修 `35076222`**（同上） |
| ~~7'~~ | ~~`S:orders/orderLifecycleService.ts:180`~~ | ~~E1~~ | ~~同上（`voucherCount`）~~ | **✅ 已修 `35076222`**（同上） |
| ~~8'~~ | ~~`S:orders/orderLineMutationService.ts:248`~~ | ~~E1~~ | ~~`if (linkCount > 0) {` ⇒ 不成立即跳过 EntityLink 停用~~ | **✅ 已修 `35076222`**（含 `sourceType/sourceId` → `fromType/fromId` 的字段名缺陷 ⇒ 该路此前恒抛恒被吞） |

> 另有 **8 处 `catch → 0` 落在待核实**（`S:agent/route.ts:43/44/46`、`S:devPanel/route.ts:60/61/62`、
> `S:agent/toolRegistry.ts:1080`、`S:notifications/notificationService.ts:612`）：
> 值只进 status/面板出参，或 catch 内已有 `logger.error`（非静默）⇒ **按 G3 现状① 的教训不判红**，见 §6。

### 表 B · 守卫/门禁 + 写路径 L-A（101 条，兜底形状为 `?? 0` / `|| 0`）

| 站点 | 规则 | 兜底 | 证据（消费点） |
|---|---|---|---|
| `C:BomManager.tsx:393` | E1-inline | `?? 0` | `const profitPositive = (detail.profitAmount ?? 0) >= 0;` |
| `C:CustomsManager.tsx:1540` | E3-inline | `\|\| 0` | `<input type="number" … value={line.quantity …` 数量输入非法 ⇒ 落 0 进表单载荷 |
| `C:development/SampleRoomPanel.tsx:343` | E3-inline | `\|\| 0` | `quantity: Number(itemForm.quantity) ¦¦ 0,` |
| `C:DevelopmentManager.tsx:1328` | E1 | `\|\| 0` | `if (total <= 0) return null;` |
| `C:finance/BillingItemsPanel.tsx:150` | E3-inline | `\|\| 0` | `amount: Number(form.amount ¦¦ 0),` |
| `C:finance/BillingItemsPanel.tsx:153` | E3-inline | `\|\| 0` | `waivedAmount: Number(form.waivedAmount ¦¦ 0),` |
| `C:finance/BillingItemsPanel.tsx:154` | E3-inline | `\|\| 0` | `offsetAmount: Number(form.offsetAmount ¦¦ 0),` |
| `C:finance/ReceiptClaimsPanel.tsx:102` | E1 | `\|\| 0` | `const overLimit = amountNum > maxAmount + 1e-6;` |
| `C:hr/PayrollTab.tsx:174` | E3-inline | `\|\| 0` | `overtimePay: Number(itemForm.overtimePay) ¦¦ 0,` |
| `C:hr/PayrollTab.tsx:175` | E3-inline | `\|\| 0` | `commission: Number(itemForm.commission) ¦¦ 0,` |
| `C:hr/PayrollTab.tsx:176` | E3-inline | `\|\| 0` | `bonus: Number(itemForm.bonus) ¦¦ 0,` |
| `C:hr/PayrollTab.tsx:177` | E3-inline | `\|\| 0` | `deduction: Number(itemForm.deduction) ¦¦ 0,` |
| `C:MarketingManager.tsx:200` | E1 | `\|\| 0` | `const roi = actualCost > 0 ? … : null;` |
| `C:order/BomItemsEditor.tsx:147` | E3-inline | `\|\| 0` | `updateItem(idx, { qty: Number(e.target.value) ¦¦ 0 })` |
| `C:order/OrderCommissionSection.tsx:94` | E1-inline | `?? 0` | `const hasCommission = (data?.totalCommission ?? 0) > 0;` |
| `C:order/OrderContextSection.tsx:153` | E1 | `\|\| 0` | `const pct = ar > 0 ? Math.min(100, Math.round((paid / ar) * 100)) : 0;` |
| `C:order/OrderToleranceSection.tsx:85` | E1-inline | `?? 0` | `const hasAlerts = (summary?.overLimit ?? 0) + (summary?.underLimit ?? 0) > 0;` |
| `C:order/SizeBreakdownEditor.tsx:144` | E3-inline | `\|\| 0` | `updateEntry(size, size, Number(e.target.value) ¦¦ 0)` |
| `C:OrderManager.tsx:891` | E1 | `\|\| 0` | `if (qty > 0) {` |
| `C:OrderManager.tsx:1280` | E1 | `\|\| 0` | `if (!hasLineData) {` |
| `C:OrderManager.tsx:1299` | E3-inline | `\|\| 0` | `quantity: Number(draft.quantity ¦¦ 0),` |
| `C:ProductionPipeline.tsx:318` | E1 | `?? 0` | `const inspected = accepted + rejected > 0;` |
| `C:RelatedEntitiesPanel.tsx:99` | E1-inline | `?? 0` | `setTruncated(responses.some((res) => (res.total ?? 0) >= limit));` |
| `C:SuppliersManager.tsx:1316` | E1 | `\|\| 0` | `const ratio = cap > 0 ? occupied / cap : 0;` |
| `C:tools/FabricSampleInvoiceGenerator.tsx:1370` | E3-inline | `\|\| 0` | `updateItem(item.id, 'qty', parseFloat(e.target.value) ¦¦ 0)` |
| `C:tools/FabricSampleInvoiceGenerator.tsx:1382` | E3-inline | `\|\| 0` | `updateItem(item.id, 'unitPrice', parseFloat(e.target.value) ¦¦ 0)` |
| `C:ui/RelatedWorkspacesSection.tsx:181` | E1 | `?? 0` | `if (!count) {` |
| `S:agent/toolRuntime.ts:348` | E1 | `\|\| 0` | `if (!voucherId ¦¦ !voucherAmount ¦¦ allocations.length === 0) {` |
| `S:agent/toolRuntime.ts:601` | E1 | `\|\| 0` | `if (!invoiceNumber ¦¦ amount <= 0) {` |
| `S:agent/toolRuntime.ts:5911` | E3-inline | `\|\| 0` | `const amount = new Prisma.Decimal(inv.amount ¦¦ 0);` |
| `S:bom/bomService.ts:244` | E3-inline | `?? 0` | `const eff = calcEffectiveQty(l.quantity, l.wastagePercent ?? 0);` |
| `S:bom/bomService.ts:458` | E3-inline | `?? 0` | 同上（另一条写路径） |
| `S:businessLines/businessLineService.ts:196` | E1 | `?? 0` | `const compliant = quantity >= moqValue;` |
| `S:claims/claimCaseService.ts:85` | E3-inline | `?? 0` | `const amount = new Prisma.Decimal(input.amount ?? 0);` |
| `S:claims/claimCaseService.ts:91` | E3-inline | `?? 0` | `const qty = new Prisma.Decimal(input.quantity ?? 0);` |
| `S:claims/claimCaseService.ts:185` | E3-inline | `?? 0` | `quantity: needsGoods ? new Prisma.Decimal(input.quantity ?? 0) : null,` |
| `S:claims/claimCaseService.ts:187` | E3-inline | `?? 0` | `amount: needsMoney ? new Prisma.Decimal(input.amount ?? 0) : null,` |
| `S:claims/claimRoute.ts:333` | E3-inline | `?? 0` | `appliedAmount: req.body?.appliedAmount ?? 0,`（进 `applyCreditNote` 写事务） |
| `S:claims/claimSettlement.ts:98` | E3-inline | `?? 0` | `amount: new Prisma.Decimal(d.amount ?? 0).toString(),` |
| `S:claims/claimSettlement.ts:156` | E3-inline | `?? 0` | `quantity: new Prisma.Decimal(d.quantity ?? 0).toString(),` |
| `S:claims/claimSettlement.ts:189` | E3-inline | `?? 0` | `casePatch.totalCreditAmount = { increment: new Prisma.Decimal(d.amount ?? 0) };` |
| `S:claims/claimSettlement.ts:193` | E3-inline | `?? 0` | `casePatch.totalReturnQty = { increment: new Prisma.Decimal(d.quantity ?? 0) };` |
| `S:claims/creditNoteService.ts:99` | E3-inline | `?? 0` | `const amount = new Prisma.Decimal(input.amount ?? 0);` |
| `S:claims/creditNoteService.ts:177` | E3-inline | `?? 0` | `const applied = new Prisma.Decimal(input.appliedAmount ?? 0);` |
| `S:claims/creditNoteService.ts:257` | E3-inline | `?? 0` | `const cumulative = new Prisma.Decimal(existingAlloc?.appliedAmount ?? 0).plus(applied);` |
| `S:claims/repairWorkOrderService.ts:59` | E3-inline | `?? 0` | `const qty = new Prisma.Decimal(input.quantity ?? 0);` |
| `S:credit/bankruptcyService.ts:43` | E1 | `?? 0` | `if (!Number.isFinite(n) ¦¦ n < 0) {` |
| `S:credit/creditService.ts:705` | E1-inline | `?? 0` | `status.hasCreditLimit && Number.isFinite(amount) && (amount ?? 0) > 0` |
| `S:dashboard/dashboardService.ts:211` | E1 | `?? 0` | `const need = orders.filter(o => costOfOrder(o) != null && …)` |
| `S:dashboard/dashboardService.ts:322` | E1 | `?? 0` | `if (paid <= 0) continue;` |
| `S:dashboard/dashboardService.ts:478` | E1 | `?? 0` | `row.share = total > 0 ? round4(row.salesAmount / total) : 0;` |
| `S:development/fabricDevelopmentService.ts:961` | E3-inline | `?? 0` | `cost: new Prisma.Decimal(devCase.targetPrice ?? 0),` |
| `S:events/dirtyCacheService.ts:222` | E1-inline | `?? 0` | `if ((row.failCount ?? 0) >= 3) { bucket.failedN3++; totalFailed++; }` |
| `S:finance/billingItemService.ts:417` | E1 | `?? 0` | `if (amount === null) throwFail('INVALID_AMOUNT', …, 400);` |
| `S:finance/billingItemService.ts:419` | E1 | `?? 0` | `if (waivedAmount + offsetAmount > amount) throwFail('INVALID_WAIVED', …)` |
| `S:finance/billingItemService.ts:420` | E1 | `?? 0` | 同上（`offsetAmount` 一侧） |
| `S:finance/dunningService.ts:312` | E3-inline | `\|\| 0` | `invoiceCount: Number(input.invoiceCount) ¦¦ 0,` |
| `S:finance/forwardFxService.ts:64` | E1 | `?? 0` | `if (total > 0 && settled >= total - 1e-9) return 'Settled';` |
| `S:finance/forwardFxService.ts:65` | E1 | `?? 0` | 同上（`settled` 一侧） |
| `S:finance/forwardFxService.ts:246` | E1 | `?? 0` | `if (amount > settlementRemain + 1e-9) {` |
| `S:finance/forwardFxService.ts:257` | E3-inline | `?? 0` | `actualRate: new Prisma.Decimal(num(settlement.fxRate) ?? 0),` |
| `S:finance/invoiceMutationService.ts:385` | E3 | `?? 0` | `await tx.invoiceLine.createMany({ data: lineRows });` |
| `S:finance/reportService.ts:772` | E1 | `?? 0` | `if (unapplied <= 0) continue;` |
| `S:hr/hrService.ts:863` | E3 | `?? 0` | `await db.payrollRun.update({ … data: { totalNet, headcount: … } });` |
| `S:internalTrade/internalTransferService.ts:636` | E1 | `?? 0` | `const garmentLineStatus = cumulativeReceived >= confirmedQty …` |
| `S:inventory/inventoryService.ts:637` | E3-inline | `?? 0` | `lockedQuantity: item.lockedQuantity ?? 0,` |
| `S:marketing/marketingService.ts:148` | E1 | `\|\| 0` | `const roi = actualCost > 0 ? … : null;` |
| `S:mes/mesService.ts:425` | E3-inline | `?? 0` | `processSeq: input.processSeq ?? 0,` |
| `S:orderChanges/orderAmountRecalc.ts:107` | E1 | `?? 0` | `if (plan.length && Math.abs(lineSum - targetAmount) > 0.005) {` |
| `S:orderChanges/orderChangeRequestService.ts:346` | E1 | `?? 0` | `if (!Number.isFinite(q) ¦¦ q <= 0) continue;` |
| `S:orders/orderLifecycleService.ts:342` | E1-gate | `?? 0` | `amount: Number(gateOrder.quoteAmount ?? 0) ¦¦ undefined,`（进 `checkCreditAvailable` 门禁）· ⚠️ **行号漂移**：本清单首次取样时是 `:289`，B14 修复（`35076222`）在该文件加了注释与 `try/catch` ⇒ 同一站点现位于 `:342`（04:19 `--json` 复核） |
| `S:orders/orderLinesRoute.ts:76` | E3-inline | `\|\| 0` | `quantity: Number(writable.quantity ¦¦ 0),`（进 `createOrderLine`） |
| `S:orders/orderServiceV2.ts:410` | E1-gate | `?? 0` | `amount: Number(withDefaults.quoteAmount ?? 0) ¦¦ undefined,` |
| `S:orders/orderServiceV2.ts:582` | E1-inline | `?? 0` | `if ((moqPatch.cancelledCount ?? 0) > 0) {` |
| `S:pricing/pricingService.ts:110` | E1 | `?? 0` | `if (!Number.isFinite(commissionRate) ¦¦ commissionRate < COMMISSION_RATE_MIN …)` |
| `S:pricing/profitSheetService.ts:286` | E1 | `?? 0` | `if (total === 0) continue;` |
| `S:production/stageService.ts:131` | E1 | `?? 0` | `if (pr < MIN_PASS_RATE) {` |
| `S:production/stageService.ts:132` | E1 | `?? 0` | `if (dr > MAX_DEFECT_RATE) {` |
| `S:production/stageService.ts:673` | E3-inline | `?? 0` | `totalUnits: data.totalUnits ?? 0,` |
| `S:products/fabricRecommendationService.ts:96` | E1 | `?? 0` | `if (price >= min && price <= max) {` |
| `S:products/fabricRecommendationService.ts:133` | E1 | `?? 0` | `if (weightGsm >= min && weightGsm <= max) {` |
| `S:products/productAssetMutationService.ts:68` | E3-inline | `?? 0` | `cost: new Prisma.Decimal(body.cost ?? 0),` |
| `S:products/route.ts:174` | E3-inline | `?? 0` | `amount: new Prisma.Decimal(p.amount ?? 0),` |
| `S:products/route.ts:216` | E3-inline | `?? 0` | `percentage: Number(line.percentage ?? 0),` |
| `S:qc/qcService.ts:382` | E3-inline | `?? 0` | `totalUnits: r.totalUnits ?? 0,` |
| `S:relations/relationServiceV2.ts:494` | E1-inline | `\|\| 0` | `if (Number(payload.creditLimit ¦¦ 0) > 0) {` |
| `S:relations/relationServiceV2.ts:583` | E1 | `\|\| 0` | `if (newLimit !== oldLimit) {` |
| `S:relations/relationServiceV2.ts:584` | E1 | `\|\| 0` | 同上（`oldLimit` 一侧） |
| `S:relations/relationServiceV2.ts:635` | E1-inline | `\|\| 0` | `const cascadedIds = (cascade?.count ¦¦ 0) > 0` |
| `S:samples/fabricShipmentSampleService.ts:373` | E3-inline | `?? 0` | `sampleQuantity: input.sampleQuantity ?? 0,` |
| `S:samples/sampleManageService.ts:605` | E1 | `?? 0` | `if (!Number.isFinite(Number(amount)) ¦¦ Number(amount) < 0) {` |
| `S:shared/orderAmount.ts:126` | E1 | `?? 0` | `if (lineSum != null && totalNet != null && Math.abs(lineSum - totalNet) > 0.005) {` |
| `S:shared/orderLineShippedQty.ts:96` | E1 | `?? 0` | `if (!Number.isFinite(qty) ¦¦ qty <= 0) continue;` |
| `S:shipping/allocationService.ts:318` | E1 | `\|\| 0` | `if (qty === 0) continue;` |
| `S:shipping/allocationService.ts:359` | E1 | `\|\| 0` | 同上（另一分配通道） |
| `S:shipping/allocationService.ts:411` | E1 | `\|\| 0` | 同上（第三条分配通道） |
| `S:shipping/allocationService.ts:670` | E1-inline | `?? 0` | `if (SHIPPED_LOCKED_STATUSES.has(shipment.status) && Number(existing.actualQty ?? 0) > 0) {` |
| `S:shipping/shipmentStockService.ts:114` | E1 | `?? 0` | `if (qty <= 0) {` |
| `S:shipping/shipmentStockService.ts:146` | E1 | `?? 0` | `return sufficient ?? items[0];` |
| `S:suppliers/factoryService.ts:136` | E1-inline | `?? 0` | `return (result?.count ?? 0) > 0;` |
| `S:suppliers/tcCertificateService.ts:199` | E1 | `\|\| 0` | `const usageWarning = kgLines.length > 0 && ourKg < orderUsageKg` |

### 表 C · 参与计算的 L-A（86 条；按文件聚合，**行号即站点**）

这些是"缺失/异常 → 0 → 进了加减乘除"的**口径级**存量（§6：不报错但算错 = 最危险级）。
同一文件内多条通常同一形状，故按文件列行号，逐条明细在 `--json` 里。

| 文件 | 行号 | 形状（该文件第一条的证据） |
|---|---|---|
| `S:traceability/traceabilityService.ts` | 9 处：106, 108, 109, 274, 275, 297, 333, 376, 431 | `outstanding: Math.max(0, arTotal - receiptTotal)` |
| `S:finance/forwardFxService.ts` | 4 处：49, 50, 245, 264 | `return round4(Math.max(0, total - settled));` |
| `S:finance/reportService.ts` | 4 处：963, 964, 965, 966 | `dept.revenue = round4(dept.revenue + sR);` |
| `S:templates/invoice/pdas-sample.ts` | 4 处：92, 92, 139, 140 | `sum + (Number(item.qty) ¦¦ 0) * (Number(item.unitPrice) ¦¦ 0)` |
| `C:order/OrderContextSection.tsx` | 3 处：154, 184, 187 | `Math.round((paid / ar) * 100)` |
| `C:tools/sampleInvoiceTemplate.ts` | 3 处：74, 75, 352 | `const amount = qty * (Number(item.unitPrice) ¦¦ 0);` |
| `S:relations/relationServiceV2.ts` | 3 处：809, 811, 813 | `orders.reduce((sum, o) => sum + Number(o.quoteAmount …` |
| `S:shipping/allocationService.ts` | 3 处：287, 429, 441 | `const allowedMax = round4(lineQty * (1 + tolPct / 100));` |
| `S:shipping/orderShipmentBatchService.ts` | 3 处：694, 695, 696 | `totalPlannedAmount: serialized.reduce((s, b) => s + (b.amount ?? 0), 0)` |
| `S:templates/invoice/fabric-sample.ts` | 3 处：72, 73, 350 | `const amount = qty * (Number(item.unitPrice) ¦¦ 0);` |
| `C:OrderManager.tsx` | 2 处：177, 177 | `return ((a.amount ?? 0) - (b.amount ?? 0)) * dirFactor;` |
| `C:tools/ContractGenerator.tsx` | 2 处：220, 221 | `const amount = qty * price;`（qty/price 各自来自 `\|\| 0` 兜底） |
| `S:briefing/briefingService.ts` | 2 处：147, 147 | `openMap.set(cur, (openMap.get(cur) ?? 0) + amt);`（`amt` 本身 = `Number(… ?? 0) \|\| 0`） |
| `S:customer/reconciliationAckService.ts` | 2 处：299, 355 | `Math.floor((Number(params.offset ?? 0) …) / pageSize) + 1` · `confirmedCount + disputedCount` |
| `S:marketing/marketingService.ts` | 2 处：145, 146 | `leads.reduce((sum, l) => sum + Number(l.estimatedValue …` |
| `S:pricing/profitSheetService.ts` | 2 处：177, 177 | `.reduce((s, a) => s + qtyOf(a), 0);` |
| `S:quotations/quotationService.ts` | 2 处：1485, 1490 | `negotiated.reduce((s, i) => s + (i.cutPct ?? 0), 0) / negotiated.length` |
| `S:reporting/monthlyCloseService.ts` | 2 处：169, 170 | `delta = Math.round((cur - prev) * 10000) / 10000;`（月结同环比） |
| `S:shipping/containerConsolidationService.ts` | 2 处：284, 285 | `totalPackages: rows.reduce((s, r) => s + (r.totalPackages ?? 0), 0)` |
| 单处（30 个文件） | `C:BomManager.tsx:773` · `C:CustomsManager.tsx:1064` · `C:Dashboard.tsx:389` · `C:finance/BillingItemsPanel.tsx:115` · `C:finance/FinanceCreditPanel.tsx:425` · `C:hr/PerformanceTab.tsx:551` · `C:HRManager.tsx:567` · `C:MarketingManager.tsx:199` · `C:order/OrderToleranceSection.tsx:85` · `C:ProductionPipeline.tsx:317` · `C:ProductsManager.tsx:1788` · `C:SampleManager.tsx:161` · `S:agent/newDomainQueryTools.ts:817` · `S:credit/creditService.ts:706` · `S:customer/route.ts:435` · `S:finance/dunningStageService.ts:115` · `S:finance/financeServiceV2.ts:335` · `S:finance/fxReconciliationService.ts:501` · `S:finance/fxSettlementService.ts:390` · `S:finance/route.ts:178` · `S:finance/sceneInvoiceService.ts:157` · `S:inventory/inventoryService.ts:526` · `S:mes/mesService.ts:1223` · `S:orders/toleranceService.ts:63` · `S:production/processCoverageService.ts:112` · `S:samples/earlyProductionSampleService.ts:200` · `S:scheduler/tasks/inventoryWatchdog.ts:94` · `S:shared/orderLineShippedQty.ts:186` · `svc:ttsService.ts:389` | 例：`S:scheduler/tasks/inventoryWatchdog.ts:94` `const available = qty - locked;`（库存看门狗用 0 兜底算可用量） |

> 合计（04:19 刷新）：表 A **3** + 表 B 101 + 表 C 86 = **190**（首次取样：9 + 101 + 86 = **196**；差的 6 处全在表 A，
> 逐处对账见 §1.2）。三表互斥（按形状与规则族划分），去重后仍 190。涉及 **95 个文件**（首次 96 ⇒
> `S:orders/orderLineMutationService.ts` 整文件出账，`orderLifecycleService.ts` 因表 B 的 `:342` 仍在册）。
> 全量逐条（含每条形成的规则与理由）：
> `node scripts/check-fail-open-inventory.mjs --json`（stdout 纯 JSON，`cls == "L-A"` 即本清单）。

---

## 5. L-B 基线（要冻结的数）

| 项 | 值 |
|---|---|
| **冻结值** | **L-B = 171**（server 91 · 前端主应用 78 · portal 2） |
| 取样 | 2026-09-20 03:36 · `node scripts/check-fail-open-inventory.mjs --print-baseline` |
| **复核（04:19）** | `node scripts/check-fail-open-inventory.mjs --baseline` ⇒ 打印 `✅ L-B 171 ≤ 基线 171` ⇒ **L-B 未动**（构成同值：E0-d 64 · E0-b 48 · E0-c 46 · E0-c2 13 = 171）；退出码仍 1，来自 L-A=190 |
| 已写入 | `scripts/check-fail-open-inventory.mjs` 内 `const BASELINE = { lb: 171, la: 0 }`（沿用 `check-design-tokens.sh` 的"基线写死在脚本里 + 只允许下降"写法，不另造机制） |
| 重跑/判据命令 | `node scripts/check-fail-open-inventory.mjs --baseline` ⇒ L-B > 171 即红；L-A > 0 恒红（**当前即红，因 L-A=190**，04:19 实测） |
| 复核基线是否咬得住 | `node scripts/check-fail-open-inventory.mjs --baseline --lb=170` ⇒ 实测打印 `❌ L-B 高于基线（170 → 171）` ⇒ **咬红，非恒真**（G6.3/G6.4） |
| L-B 规则构成 | E0-d 纯渲染 64 · E0-b 分页默认 48 · E0-c 聚合种子 46 · E0-c2 计数器/版本种子 13 |

> ⚠️ 冻结的只是 **L-B**。L-A 不接受基线（判据 = 0）。
> ⚠️ 当前退出码 1 由 L-A 触发；在 L-A 清零前，`--baseline` 无法单独验证 L-B 走势 ⇒ 需要看 L-B 时用 `--json` 里的计数（同一命令、同一口径）。

---

## 6. 待核实清单（367 条 = 分类器拿不出局部证据，按 §0.4 不猜）

> **04:19 复核：367 条未消化，各桶计数逐档未变**（E4 134 · E4-server-inline 123 · E5-nonbusiness 61 ·
> E4-sortkey 27 · E4-payload 14 · E4-catch 6 · E4-catch-nobind 1 · E4-logged 1 = 367）——
> B14 那 6 处全在 L-A，没有一条是"从待核实挪走"的。

按"要什么证据才能定它"分桶。**每一桶的定法都不是"再看一眼代码"，而是可指认的取证动作。**

### 6.1 `E4`（134 条）— 值被绑定/传递，但消费点在本块作用域窗口外

典型：`C:ProductsManager.tsx:1247-1249, 1359-1365, 1403, 1454-1465, 1510, 1872, 1919-1922, 2062-2064, 2947, 3006`；
`svc:apiService.ts:2598, 2742, 2870, 2933, 2967, 3610, 3836, 4483`；`C:QcWorkbenchManager.tsx:2300-2302, 2566-2568`；
`C:ui/SpotlightCard.tsx:175-186`；`svc:reconciliationService.ts:309, 338-344`；`S:index.ts:1665-1666`；`lib:orderLineItems.ts:57, 77`
（另 47 个文件，全量 `--json` 过滤 `cls=="待核实" && rule=="E4"`）。

**定它的证据**：该绑定变量在**同一文件后续行 / 其他文件**是否进 `if`、算术或写载荷 —— 需要跨函数数据流（人或 IDE 引用查找，
或给脚本加"同文件全量消费点"模式）。若只出现在 JSX 文字里 ⇒ 降 L-B 并补 `// fallback:display <理由>` 注释（G3 配套机制）。

### 6.2 `E4-server-inline`（123 条）— 服务端就地表达式，同句无判定/计算/写

集中在 `S:agent/toolRuntime.ts`（29 处：2019, 2025, 2058, 2061, 2064, 2072, 2075, 2077-2079, 4415, 4441, 4536, 4634, 4638, 4640, 4665, 4666, 4668, 4837, 5551, 5552 …）、
`S:agent/newDomainQueryTools.ts:644, 693, 703, 723, 733, 766, 786, 800`、`S:customer/reconciliationAckService.ts:315, 344, 349, 353-355`、
`S:traceability/traceabilityService.ts:130, 131, 247, 331, 373, 472`、`S:agent/jobs.ts:54-57`、`S:finance/forwardFxService.ts:348-365`、
`S:qc/qcService.ts:383-389`（另 30 个文件）。

**定它的证据**：这些多半是"响应体字段兜底"。要定性必须**顺出参找到前端消费点**（同一字段被前端拿去算数 ⇒ L-A；只渲染 ⇒ L-B）。
⇒ 需要跨端字段对账（`S:` 出参键 ↔ `C:`/`svc:` 使用点），本清单做不到，**列为下一步**。

### 6.3 `E5-nonbusiness`（61 条）— 有流向，但对象不属业务量

`App.tsx:1287-1290, 1301, 1302`（spotlight 几何）· `S:finance/dunningStageService.ts:65-68, 217` ·
`C:MapLibreProductionGlobe.tsx:1708-1711`（相机 key）· `C:finance/ReconciliationPanel.tsx:244` · `svc:ttsService.ts:258, 333, 351` ·
`C:ui/ScrollEdgeFades.tsx:66` · `P:pages/Statement.tsx:109`（另 16 个文件）。

**定它的证据**：人工 30 秒判定——该值是否进入任何金额/数量/单号口径。是 ⇒ 改回 L-A 并给脚本补词表；
否 ⇒ 就地加 `// fallback:display 几何/动画参数` 注释，永久出账（G3 配套机制）。**这一桶是 E5 闸门的代价，必须人过一遍才算收口。**

### 6.4 `E4-sortkey`（27 条）— 只落在 `sort()` 比较器

`C:ProductsManager.tsx:318, 1548, 1929, 1998, 2299`（各 2 处）· `C:OrderManager.tsx:842` · `C:QuotationManager.tsx:980` ·
`lib:orderLineItems.ts:33` · `S:dashboard/dashboardService.ts:634`（账龄排序）· `S:market/forexQuoteService.ts:83-84` 等。

**定它的证据**：排序错序是否被当作业务结论（如账龄优先催收列表）⇒ 若"是"，应升 L-A（属 G1.4 跨页一致/展示口径），
需产品侧口径确认，不是静态扫描能定的。

### 6.5 `E4-payload`（14 条）— 值只进出参/对象字面量

`S:production/stageService.ts:725, 749-751`（验货疵点数进 `metadata`）· `S:finance/fxReconciliationService.ts:268, 348, 427` ·
`S:shipping/orderShipmentBatchService.ts:117-118` · `C:InventoryManager.tsx:428` · `C:ProductsManager.tsx:4941` ·
`S:ai/route.ts:243` · `S:orders/route.ts:702` · `S:relations/route.ts:62`。

**定它的证据**：出参键的消费点（前端渲染 vs 参与再计算）。`stageService` 那 3 处进的是**审计 metadata** ⇒ 一旦是 0 会永久留在审计记录里，
建议优先定（G4.2 要求 before/after 值真实）。

### 6.6 `E4-catch`（6 条）+ `E4-catch-nobind`（1 条）— `catch→0` 但消费点未证实

`S:agent/route.ts:43, 44, 46` · `S:devPanel/route.ts:60, 61, 62`（`.catch(() => [0, 0, 0])` 元组零值）· `S:agent/toolRegistry.ts:1080`。

**定它的证据**：这些是 dev 面板 / Agent status 的统计出参 ⇒ 只需确认"面板显示 0 会不会被当成真实业务量拿去做决定"。
若确认只用于人眼看 ⇒ 加 `// fallback:display 面板统计` 出账；若面板参与切库/切环境判断 ⇒ 升 L-A。
**`S:agent/toolRegistry.ts:1080` 本桶已于 04:19 判定完成**（该 0 流向 `:1108` 的**拒绝**分支 ⇒ 方向是误伤不是放行）
⇒ 见 §4.0.1 D1，**deferred by controller ruling**，不再算"未核查"。

### 6.7 `E4-logged`（1 条）

`S:notifications/notificationService.ts:612` —— `catch` 内已 `logger.error('sweep failed (non-blocking)')` 后 `return 0`。
**定它的证据**：调用方是否拿这个 0 当"清扫成功"。需要看调用点计数用途（G6.4 断言不恒真式核查）。

### 6.8 `G3 现状①` 的 `setXxxReady(true)` 8 处 —— **本清单未覆盖，仍是待办**

`App.tsx` 的 8 处 ready 翻转（文档点名 915-917 未修、938-940 合规）**不属于这三种兜底形状**（它不是"回落 0"，是"翻状态"），
本扫描器不判 ⇒ **该项仍是 G3/B6 的独立待办**，不得因为本清单产出而被当作已处理。

---

## 7. 分类规则的边界与已知误判（承认盲点，不留白）

| # | 形状 | 分类器现在的判法 | 为什么可能错 | 影响方向 |
|---|---|---|---|---|
| 1 | 跨函数/跨文件的值流转 | 只看到"同块窗口" ⇒ 落待核实 | 服务端出参字段被前端拿去算数 ⇒ 应是 L-A | **漏报**（保守） |
| 2 | `catch` 块里的 `return 0` 且**变量在别处**被判定 | 不追（E4-fn 只追同文件、且只认算式/门禁直连） | 复杂函数体内消费 | 漏报 |
| 3 | 聚合种子 `m.get(k) ?? 0` | 判 L-B（真零） | 若该键缺失其实意味"这笔金额未知" ⇒ 应 L-A | **漏报**（E0-c 的代价） |
| 4 | 前端算错但只渲染（含 `formatAmount(a ?? 0 + b ?? 0)`） | 判 L-B"仅用于显示" | 该数被复制进单据/导出/打印模板 ⇒ 应 L-A | 漏报 |
| 5 | E5 业务量闸门靠**命名词表** | 名字不含业务量词 ⇒ 降待核实 | 命名不含量词但确是金额（如 `x.val`、`row.a`）⇒ 该判 L-A | **双向**：漏报 L-A + 把几何量留在待核实（人工成本） |
| 6 | `if (!res.ok)` 之类的"信封判定" | 排除（不算守卫） | 若 `res` 本身是该数包的对象 ⇒ 会漏掉一次真守卫 | 漏报 |
| 7 | 展示文案模板里的 `${n > 0 ? …}` | 排除（判 payload） | 模板字符串里做真分支（少见的拼装逻辑） | 漏报 |
| 8 | `sort()` 比较器 | 待核实（不判红） | 排序结果即业务结论时（账龄优先列表）| 待人工 |
| 9 | JSX 相邻 3 行内即视为渲染邻域（E0-d） | 判 L-B | 组件体内逻辑行恰好在 JSX 上方且带 `{` ⇒ 可能把真判定降级 | **误报方向已被压小，但此处可能偏松** |
| 10 | `Number.isFinite(n) ¦¦ n < 0` 类"兜底后再校验"（`S:credit/bankruptcyService.ts:43`） | 判 L-A（值进了判定） | 它其实是**加了防护**的写法（先 0 再拒）⇒ 严重度低于真 fail-open | **误报（已登记，不隐藏）**：读者可按"是否 fail-closed 校验在后"降级 |
| 11 | 形状覆盖面 | 只扫三种形状 | 同族但未捕获：`if (v == null) return 0`、`Number.isFinite(x) ? x : 0`、`try { … } catch { /* 空 */ }`、`?.x || 默认对象` | **漏报（写法面 > 覆盖面）** —— 已知，下一步扩形状 |
| 12 | 未扫目录 | `scripts/`、`server/scripts/`、`ops-panel`、`electron`、`pwa` 不在口径内 | 那些面里确有同类兜底 | 范围外，已声明 |

已用 G6.3「故意放错形状」自测覆盖的盲区方向：注释假红（S4）、分页误升 L-A（S7）、已记录错误的 catch（S8）、
聚合种子（S10）、几何量（S11）—— **11 例全过，脚本 `--selfcheck` 退出码 0**。

---

## 8. 本清单不证明什么（§1 P2 + 声明纪律）

1. **不证明任何一处运行时真的算错**。静态扫描只证明"这个 0 在代码里流进了判定/计算/写"，
   不证明对应查询真的会抛错、对应字段真的会为 null。⇒ 产出是**工作清单**，不是**判决**（§1 P2）。
2. **不构成 G3 的"通过/不通过"验收结论**。G3 还要：每条拒绝路径的**阳性对照**（G3 配套要求 2）、
   `--selfcheck` 之外的运行时构造用例（G6.3）、以及 §6.8 未覆盖的 `setXxxReady` 族。
3. **B14 的定性不由本清单给出，但已有结论**：本清单只证明"那 5 个 0 进入了拒删守卫"；
   "是否真的提交了删除"由独立构造验证给出（`docs/B14-fail-open删除守卫-构造验证-2026-09-20.md` §3b，
   真库事务 + 真 `deleteOrder`，取样 2026-09-20）⇒ 结论 **确认缺陷**（`ok = true` 且事务提交、发票成孤儿），
   存量核查 1000 条已删订单 0 条活依赖 ⇒ 无需回填。**已由 `35076222` 改为 fail-closed**（见 §4.0 ①/③ 的现状栏）。
   本条保留的范围声明是：**表 A 余下 3 处、表 B/C 全部 187 处仍未做过同类构造验证** ⇒ 不得把它们的
   "L-A"读成"已证实在运行时出错"。
4. **不证明 L-A=190（04:19 现值）都必须按 L-A 修**。其中表 C（86 条）与部分表 B 属"业务性零值"的候选，
   正确出口可能是 G3 配套机制里的 `// fallback:display <理由>` 就地豁免 ⇒ **豁免要走注释登记，不是直接改数**。
   判据本身不变：**未登记的 L-A 必须为 0**。
5. **不证明覆盖面已 ≥ 写法面**。§7 第 11 行列了未捕获的同族写法 ⇒ G6.2 在本条目上**尚未满足**，
   扩形状后 L-A 计数可能上升。
6. **不含真实数据**。全部结论基于源码静态文本（无运行时、无生产库），符合 P1/P2 的前提约束。

---

## 9. 下一步（把这份派生件变成可挂的门禁）

| # | 动作 | 判据 |
|---|---|---|
| 1 | 表 A **余 3 处**逐条改 fail-closed（取数失败 ⇒ 拒绝操作，不给 0）：`invoiceAppliedSum.ts:50` 是真危险；两处取号按 §4.0.1 的出口**改引发号器真源**（不是就地补 try/catch）。已修的 6 处见 §1.2 对账（`35076222`） | 每条配 **阳性对照 + 故意断源**（G6.3），改后 `--json` 里 L-A/catch 归 0（现值 3）—— ★ **v3.236 两次做到：3 → 2（B273 关 `invoiceAppliedSum.ts:50`）→ 0（B274 关两处取号的 `.catch(() => 0)`）**；（`invoiceAppliedSum.ts:50` 已按 B273 改抛错，同尺差集落点唯一、新增 0 处；余 2 处 = `exceptions/exceptionService.ts:234`、`orderChanges/orderChangeRequestService.ts:320` 两处取号，仍须按 §4.0.1 改引发号器真源） |
| 2 | 表 B 101 处按域分批（claims / finance / shipping / orders 四条线） | 每批 L-A 计数**只降**，且降数与提交说明一一对应 |
| 3 | 待核实 6.3（E5 61 条）人工过一遍，该豁免的写 `// fallback:display <理由>` | 走 G3 配套豁免机制，不新造第二套口径 |
| 4 | 扩形状（§7 第 11 行）+ 加"跨文件消费点"模式 | 覆盖面逼近写法面后重跑，基线随实测上调一次并在提交说明里写明 |
| 5 | 挂门禁：`npm run check:fail-open`（`--baseline`，待 L-A=0 后进 R6 三绿） | 在此之前**不得**声称 G3 L-A 达标 |

> **本次未做的两件事（不是遗漏，是边界）**：
> ① 未往 `package.json` 注册 `check:fail-open` 脚本（本批只允许新增扫描器 + 本清单两个文件）；
>    现可直接跑 `node scripts/check-fail-open-inventory.mjs --baseline`，退出码即判据。
> ② **未回写权威文档 §2 G3 的「现状」栏**（R7 落账）。本文件是派生证据附件；
>    把「尚未分离出清单」改成带出处的实测数字，需由文档负责人在权威文档内改，避免两处现状并存（§0.5）。

