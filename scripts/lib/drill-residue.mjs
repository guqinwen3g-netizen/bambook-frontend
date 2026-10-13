/**
 * 演练残留清扫器（共享）—— 按「演练标识」**全模型**扫描并清理
 *
 * ## 为什么必须有它（2026-09-19 实测踩到）
 *
 * 本仓的写路径会触发**业务事件总线**：一次演练除了脚本自己创建的实体，
 * 还会连带产生：
 *   · `productionStage`（建单即初始化生产阶段）
 *   · `notification`（每个域事件**按用户扇出**，一次演练可达数百上千条）
 *   · `agentJob`（每个域事件入队一条 `bev:*` 作业）
 *   · 处置类动作的**衍生单据**（如 `ReturnRefund` 同时产出 ReturnReceipt + **CreditNote**）
 *
 * ⇒ **逐脚本手写回滚清单必然漏**。实测：验收第 5–7 批的演练累计留下 **416+ 行**，
 *   横跨 `creditNote` / `productionStage` / `notification` / `order` / `orderLine`，
 *   而当时的行数守卫（硬编码 23 个模型）**一个都没看见** ⇒ 假绿。
 *
 * ## 判据（本仓 REFERENCE.md）
 * **结构守卫的覆盖面必须 ≥ 代码的写法面**。
 * 手写清单会随 schema 漂移 ⇒ 本模块**从 Prisma DMMF 取全部模型与字段**，
 * 加表/改字段后覆盖面自动跟上。
 *
 * ## 用法
 * ```js
 * import { sweepResidue, cleanResidue } from './lib/drill-residue.mjs';
 * await cleanResidue({ prisma, Prisma, markers: [MARK], log: console.log });
 * ```
 */

/**
 * ★★ 2026-09-19 补盲区：**Json 字段必须全模型扫，不能只挑几个**
 *
 * 原实现只对 `agentJob.payload` / `notification.metadata` 做 JS 过滤 ⇒
 * **80 个含 Json 字段的模型里只覆盖了 2 个**。实测漏掉：
 *   · `auditLog.detail`（32 行）—— `detail.after.orderId = DRILLVAR...`，而 `targetId` 是子实体 id
 *   · `agentJob`（3 行）
 * 更糟的是：`clean-drill-residue.mjs` 用的是同一个扫描 ⇒
 * **「权威清扫」也一起失明**（自称权威却同盲 ✗）。
 *
 * ⇒ 改为**从 DMMF 自动发现 Json 字段**并对近期行做 JS 过滤（`JSON_SCAN_LIMIT` 行/模型）。
 * 代价：大表（`notification` 3 万+）需要取近期切片 —— 用 `createdAt desc` 取前 N 行；
 * 无 `createdAt` 的模型退回按主键倒序。**残留必然是「近期产生的」**，故切片合理。
 */
/** ★ v3.13：导出给只读报告算"这是下界"那句话，别让外面抄一个 5000 字面量 */
export const JSON_SCAN_LIMIT = 5000;

/** 从模型定义取 Json 字段名 */
/** ★ v3.13：导出给只读审计器算分母（原先只有本文件内部用 ⇒ 外面要抄一份筛法） */
export function jsonFields(modelDef) {
  return (modelDef.fields ?? []).filter((f) => f.type === 'Json').map((f) => f.name);
}

/** 取「近期切片」的参数（有 createdAt 就按它倒序，否则按 id 倒序） */
function recentSliceArgs(modelDef, limit) {
  const hasCreatedAt = (modelDef.fields ?? []).some((f) => f.name === 'createdAt');
  return hasCreatedAt
    ? { take: limit, orderBy: { createdAt: 'desc' } }
    : { take: limit, orderBy: { id: 'desc' } };
}

/**
 * **级联模型**：这些表只存「别的实体的 id」，字段里**不含演练标识**
 * ⇒ 只按标识扫**永远匹配不到**，必须用「已命中实体的 id 集合」再扫一轮。
 * （与本仓既有教训同源：审计/引用表的 targetId 是**子实体或间接引用**的 id。）
 */
const CASCADE_MODELS = {
  entityLink: ['fromId', 'toId'],
  entityReference: ['ownerId', 'targetId'],
  auditLog: ['targetId'],
  approvalRequest: ['targetId'],
};

/** ★ v3.13：模型名 → 客户端委托键，**这条拼写只此一份**（审计器/壳/删除器都从这里取，别再各自 lowerFirst） */
export function delegateKey(modelName) {
  return String(modelName).charAt(0).toLowerCase() + String(modelName).slice(1);
}
function delegateOf(prisma, modelName) {
  const key = delegateKey(modelName);
  return { key, delegate: prisma[key] };
}

/** 全部模型定义（DMMF） */
export function allModels(Prisma) {
  return Prisma?.dmmf?.datamodel?.models ?? [];
}

/**
 * ★ B120：**「谁引用了执行者」按 schema 派生，不靠人列清单。**
 *
 * 为什么要它（量出来的账，不是推测）：删演练执行者账号那一步会被外键挡住，而**能挡住它的表不止一张** ——
 * 实测 DMMF 里指向 `UserAccount` 的 FK 侧关系 **13 条**，其中**必选且非 cascade 的 7 条**
 * （`AgentMessage` / `ApprovalRequest.requesterId` / `AuditLog.actorId` / `EmployeeProfile` / `Notification` /
 * `NotificationPreference` / `AgentSession`），只有 `UserRole` 带 cascade ⇒
 * v2.99 为 B119 补的那一条 `notification.deleteMany` 只是**当时会红的那一张**，
 * 剩下任何一张被晚到写入命中都是同一个错，而"出一张补一张"正是本仓头号病（第 N+1 份手写清单）。
 *
 * 三条设计约束：
 *  ① **只吃 DMMF**（与 `allModels()`/`sweepResidue` 同一份真源），本函数不出现任何模型名字面量 ⇒
 *     schema 新增一条指向 UserAccount 的关系，这里**自动**多出一条，不需要谁记得来改。
 *  ② 只认 **FK 侧**（`relationFromFields` 非空）⇒ 反侧（`Department.users` 那种 `isList` 的虚拟字段）不算，
 *     它没有可 where 的列。
 *  ③ `blocking` = 「列必选 **且** onDelete ≠ Cascade」⇒ 这种行**存在就删不掉账号**，
 *     而 cascade 那些不会挡路（删账号会顺带带走它们）。区分这两类是为了把红话说准，不是为了放宽判据。
 *
 * @param models DMMF 的 `datamodel.models`（不是 PrismaClient）
 * @returns {{model:string, rel:string, fk:string, required:boolean, onDelete:string, blocking:boolean}[]}
 */
export function actorRefRelations(models) {
  const out = [];
  for (const m of models ?? []) {
    for (const f of m.fields ?? []) {
      if (f.kind !== 'object' || f.type !== 'UserAccount') continue;
      const from = f.relationFromFields;
      if (!Array.isArray(from) || from.length !== 1) continue;
      const fk = from[0];
      const scalar = (m.fields ?? []).find((x) => x.name === fk);
      const required = !!scalar?.isRequired;
      const onDelete = f.relationOnDelete ?? 'NoAction';
      out.push({ model: m.name, rel: f.name, fk, required, onDelete, blocking: required && onDelete !== 'Cascade' });
    }
  }
  return out.sort((a, b) => `${a.model}.${a.fk}`.localeCompare(`${b.model}.${b.fk}`));
}

/** 某模型的字符串字段名 */
/**
 * ★★ 演练标识的**唯一出处**（G-3 批收口，此前全仓三套并存：
 *   `clean-drill-residue.mjs` 6 个 / `audit-drill-residue.mjs` 10 个 / 新报告脚本 2 个
 *   ⇒ "报告数的演练集"与"清扫器认的那批行"不是同一批数据 = 本仓头号病"并行真源"的现形）。
 *
 * 两族**语义不同，不许合并**：
 *  · `RESIDUE_MARKERS` —— 历次验收跑完**该删而没删**的残留 ⇒ 清扫器认这些。
 *  · `SIM_DATASET_MARKERS` —— `company-sim` 那套**常驻演示数据集**（`server/scripts/company-sim/common.ts:6`
 *    约定 `SIM-` 前缀）⇒ 它是数据不是残留，**绝不能进删除清单**，只能用于"归属判定/统计"。
 *  · `BROAD_MARKERS` —— 中文宽词（"验收"/"冒烟"），会命中正常业务内容 ⇒ 只能显式开启。
 */
export const RESIDUE_MARKERS = ['DRILL', 'REQ2-', 'E2E-', 'SMOKE', 'kgkgtest', 'testdev'];
export const SIM_DATASET_MARKERS = ['SIM-'];
export const BROAD_MARKERS = ['验收', '冒烟'];
/** 归属判定（统计"这行是不是人造数据"）用的全集 = 残留族 + 演示数据集族。**不等于可删集合**。 */
export const ATTRIBUTION_MARKERS = [...RESIDUE_MARKERS, ...SIM_DATASET_MARKERS];

/**
 * ★★ v2.67（复核 IMPORTANT-1 / IMPORTANT-2）：**"代码里手抄演练标识"的探测尺要从基座派生，且要认字面量左边界。**
 *   v2.63 那把尺 `/TEST_[A-Z0-9]+_/` 两头都错：右边只认 `TEST`（`DRILL-…`/`E2E-…`/`REQ2-…`/`SIM-…` 手抄进去它不认，
 *   模板拼接也不认）；左边没锚（复核给的本仓真例：`TIMELINE_LATEST_BADGE_CLASS` 含子串 `TEST_BADGE_` 会被当手抄）。
 *   ★ 但我第一版改成"行里出现家族名就算"时，`import { DRILL_PROBE_FX }` 这种**标识符**当场误伤
 *     ⇒ 判据收窄成"**引号/反引号后面紧跟家族形状**"= 只抓字面量，不抓标识符。
 */
export const HANDCOPY_FAMILIES = ['TEST[-_][A-Z0-9]{2,}[-_]', 'DRILL[-_]', 'E2E-', 'REQ2-', 'SMOKE[-_]', 'kgkgtest', 'testdev', 'SIM-'];
export function handCopyHits(line) {
  const hits = [];
  for (const fam of HANDCOPY_FAMILIES) {
    if (new RegExp("['\"`]" + fam).test(line)) hits.push(fam);
  }
  // ★ 拼接也要抓：`'TEST' + '_X_'` 与 `'TEST_' + x` 都是"把家族名手抄进消费者"，只是换了切法
  if (/`TEST_\$\{|['"]TEST[_-]?['"]\s*\+/.test(line)) hits.push('模板拼接');
  return hits;
}

/**
 * ★★★ B35 第二刀（2026-09-22）：**逐场景字面量 = 一把会静默过时的白名单**
 *
 *   实测：清扫器认的 `RESIDUE_MARKERS` 是六个**精确前缀**，而验收脚本各自造标识
 *   （`TEST_D6FX_` / `TEST-C7WO-` / `TEST_DCNL_` …）。新场景每起一个名字，这把尺就**静默漏一次**，
 *   并且**打印"零残留"** —— 今天实测 `PaymentVoucher` 里 **453 行 `TEST[-_]C7WO`** 一行都不命中。
 *   ⇒ 白名单不会喊"我过时了"（本仓 memory: 判据的第四种沉默失效）。
 *
 *   所以这里加**族正则**（不是往字面量清单里再补几个前缀）：
 *     · `FAMILY_TEST` —— `TEST` 紧跟 `-`/`_` 再接一个字母数字 ⇒ 覆盖一切 `TEST_xxx`/`TEST-xxx` 命名
 *     · `FAMILY_DRILL`/`FAMILY_E2E`/`FAMILY_SMOKE` —— 既有族的宽松版（大小写不敏感）
 *   ★ 词边界是**必须**的：`LATEST_VERSION` / `GREATEST-2` 里也含 `TEST`，
 *     用"前面不能是字母"挡住（`[^A-Za-z]` 或串首）⇒ 否则"清扫"会把正常业务行当残留删掉，
 *     那比漏报更糟（§0.4：误报的代价在这里是**数据损失**）。
 *
 *   **两级不许混**：
 *     · 检测/报告（只读）= 字面量 ∪ 族正则 ⇒ 宁可多看见；
 *     · 删除（`--apply`）= **只有显式登记的 DELETABLE 族**，且必须先出命中清单 + 行数再删。
 */
/**
 * ★★ v2.57 收紧（独立复核 IMPORTANT 4）：族式**必须带分隔符 + 后接一个字母或数字**，且**大小写敏感**。
 *   原式三条都是 `/i` 且分隔符可选 ⇒ 实测三个假阳性，全都长在本仓自己的业务词上：
 *     · `Cotton Drill 40s 坯布` / `brushed drill 面料` / `mining drill rod` → 命中"DRILL 族"
 *       —— **drill = 斜纹布**，是本仓 §3.2 的品类词，不是演练标识。
 *   收紧后：`DRILL` 后面必须紧跟 `-_:` 再跟一个字母/数字（⇒ `DRILL-`/`DRILLVAR`/`TEST_演练` 仍命中，
 *   `Drill 40s`（空格）不命中）。用 `[\p{L}\p{N}]` 而不是 `[A-Za-z0-9]`：
 *   这样 `TEST_演练单` 这类**中文后缀**的人造数据也能被抓到（旧式漏掉，复核已实测漏）。
 *   ⚠️ 已知不覆盖（写成测试用例钉住，不许当"已清"）：`PAY-2026-TEST` 这种**标识在末尾、后面没字符**的写法
 *   ——族式是"前缀约定"，放宽成 `TEST$` 会把 `REGRESSION-TEST` 这类正常命名放进来 ⇒ 要放宽得有人拍。
 *   ⚠️ **字面量那条路（RESIDUE_MARKERS / `includes`）本批一个字都没改**：它是子串匹配，
 *   按设计就会命中 `SMOKE OIL`、`COTTON DRILL` 这类大写业务词 ⇒ 台账 **B81** 记着"删除集合启用前必须先清这个"。
 */
export const RESIDUE_MARKER_RES = [
  { name: 'TEST 族', re: /(?:^|[^A-Za-z])TEST[-_][\p{L}\p{N}]/u },
  { name: 'DRILL 族', re: /(?:^|[^A-Za-z])DRILL[-_:][\p{L}\p{N}]/u },
  { name: 'E2E 族', re: /(?:^|[^A-Za-z])E2E[-_][\p{L}\p{N}]/u },
  { name: 'SMOKE 族', re: /(?:^|[^A-Za-z])SMOKE[-_][\p{L}\p{N}]/u },
];
/** 只读检测用的合并判据：字面量 OR 族。返回命中的族名（数组，可能多个）或 null。 */
export function detectResidueMarker(text) {
  if (typeof text !== 'string' || text === '') return null;
  const byLiteral = RESIDUE_MARKERS.filter((m) => text.includes(m));
  const byFamily = RESIDUE_MARKER_RES.filter(({ re }) => re.test(text)).map(({ name }) => name);
  return byLiteral.length || byFamily.length ? { literal: byLiteral, family: byFamily } : null;
}
/**
 * 删除侧的许可集合：`TEST[-_]` 族今天**不放进可删**（它有跨业务误伤的理论可能，
 * 而 B35 那族收款凭证残留的删除本来就挂在 §12.1 等 Kevin 点头）⇒ 只用于"报告/归属"。
 * 需要升成可删时，改这里并附命中清单，不要在调用点各自加规则（= 又造一份并行真源）。
 */
export const DELETABLE_MARKER_RES = [];

/**
 * ★★ B35 第二刀（v2.62）+ 第三刀的第一步（v2.63）：**演练数据的"认领目标"只留一份，且认领判据不许是枚举**。
 *   原先这份知识散在两个脚本里各自手抄：`server/scripts/diag-test-residue.mjs` 的 `CHECKS`（只诊断）与
 *   `server/scripts/cleanup-test-residue.mjs` 的 `TARGETS`（`--apply` 真删）—— 两边**互不相容地漂着**：
 *   ① `forwardFxSettlementLink.contractId ~ TEST_D6WD_` 只有诊断看得见 ⇒ **清完还留孤儿关联行**（下一次验收读数照样被污染）；
 *   ② `auditLog.actorId` 诊断只列了演练执行者里的一部分 ⇒ 诊断报"干净"而删除器看得见另一份。
 *   ⇒ 目标从下面这一份派生，两个脚本不许再各自写字面量（守卫 `scripts/drill-targets-single-source.test.ts` 逐字面量抓）。
 *   ⚠️ 语义提醒：**清单本身就是"登记"**，而删除只在 `cleanup-test-residue.mjs --apply` 时发生 ⇒ 改这份清单
 *      等于改"将来会删什么"，必须让人在 diff 里看得见（v2.63 新增：C7WO 两表 + 演练账号面，见下面逐条注释）。
 */
/**
 * ★ v2.63 现量（`panda_hub_local`，只读）：源码里有 **18** 个 `TEST_ACTOR_*` 字面量，而此前手写的名单只有 **7** 个
 *   （少的 11 个里就包括 B35 自己用的 `TEST_ACTOR_C7WO`）⇒ 手写名单**结构性落后**，不是"这次忘了"。
 *   ⇒ 认领判据改成**前缀族**（下面的 `DRILL_ACTOR_PREFIX`），那份手写名单已从基座删除
 *      ⇒ "哪些 actor 算演练"不再需要人维护；守卫改为**从源码派生** actor 字面量来对撞。
 *   ⚠️ 18 是源码派生的**上界**（含 `allocationService.test.ts` 那种不落库的 mock 面）；库里现量到 11 个账号行。
 */
export const DRILL_ACTOR_PREFIX = 'TEST_ACTOR_';

/**
 * ★★★ v2.65（复核 BLOCK-2 命中）：**「能不能默认删」必须是每条认领目标上的显式表态，不是缺省值。**
 *   v2.63 的 `sensitive` 只在账号表那条写了 `true`，其余条目靠 `t.sensitive === true` 派生成 false
 *   ⇒ 「忘记表态」与「判过、判成可删」长得一模一样；而守卫当时只断言「恰好有 1 条 sensitive」，方向还是反的
 *   （合法地加第 2 张敏感表会红，非法地不加会绿）。
 *   ⇒ 现在：① 每条目标必须**显式**带 `sensitive: true|false`，缺字段直接抛；
 *   ② 另有一张「按模型名强制敏感」的清单 ⇒ 账号表被登记成默认可删即抛。
 *   宁可抛在派生阶段，也不要让一次 `--apply` 替人做决定。
 */
export const MUST_BE_SENSITIVE_MODELS = ['userAccount'];

/**
 * ★★ v2.66（复核 IMPORTANT-3 命中）：`sensitive` 说的是**类别不可逆**（可登录主体），
 *   而"这一族的删除还等人点头"是**另一件事** —— 两者此前挤在同一个词里，于是
 *   一次普通 `--apply` 实际会删 495 行 `paymentVoucher`（同样在 §12.1 第 5 条待批范围内），
 *   而账面读起来像"该保的都保住了"。⇒ 拆成两个轴：下表里的族**命中 > 0 就必须显式 `approved`，否则拒绝执行**
 *   （拒绝，不是跳过——半删半留更难收拾）。
 */
export const APPROVAL_REQUIRED_MODELS = ['paymentVoucher', 'creditNote', 'userAccount'];
export function assertSensitiveVerdict(t) {
  if (t.sensitive !== true && t.sensitive !== false) {
    throw new Error(`认领目标必须显式表态 sensitive: true|false（${t.label ?? t.model}）⇒ 缺省即「可删」就是复核 BLOCK-2 的形状`);
  }
  if (MUST_BE_SENSITIVE_MODELS.includes(t.model) && t.sensitive !== true) {
    throw new Error(`${t.model} 在 MUST_BE_SENSITIVE_MODELS 里（可登录 / 带真凭据的主体面），不许登记成默认可删`);
  }
}
/** @type {Array<{label:string, model:string, field:string, prefix?:string, ids?:string[], extra?:object, sensitive?:boolean}>} */
export const DRILL_TARGETS = [
  { label: 'D6 远期合约（演练）', model: 'forwardFxContract', field: 'contractNumber', prefix: 'TEST_D6FX_', sensitive: false },
  { label: 'D6 远期合约（看门狗演练）', model: 'forwardFxContract', field: 'id', prefix: 'TEST_D6WD_', sensitive: false },
  { label: 'D6 交割关联（演练）★ 本批起删除器也覆盖', model: 'forwardFxSettlementLink', field: 'contractId', prefix: 'TEST_D6WD_', sensitive: false },
  { label: 'D6 结汇水单（演练·服务生成号）', model: 'fxSettlement', field: 'settlementNumber', prefix: 'TEST_D6FX_', sensitive: false },
  { label: 'D6 收款凭证（演练·服务生成号）', model: 'paymentVoucher', field: 'voucherNumber', prefix: 'TEST_D6FX_', sensitive: false },
  { label: 'D4 佣金应付发票（演练·服务生成 sourceId）', model: 'invoice', field: 'sourceId', prefix: 'TEST_D4CM_', extra: { sourceType: 'CommissionPayable' }, sensitive: false },
  { label: 'D4 定价行（演练）', model: 'pricingCalculation', field: 'id', prefix: 'TEST_D4CM_', sensitive: false },
  { label: 'D4 佣金规则（演练）', model: 'commissionRule', field: 'id', prefix: 'TEST_D4CM_', sensitive: false },
  { label: 'D5 运单（演练）', model: 'shipment', field: 'id', prefix: 'TEST_D5SCH_', sensitive: false },
  { label: 'D2 订单（演练）', model: 'order', field: 'id', prefix: 'TEST_D2PC_', sensitive: false },
  { label: 'C6 库存项（演练）', model: 'inventoryItem', field: 'id', prefix: 'TEST_C6OWN_', sensitive: false },
  { label: 'C5 面料取样（演练）', model: 'fabricShipmentSample', field: 'sampleCode', prefix: 'TEST_C5SH_', sensitive: false },
  { label: 'C4 库存项（演练·实测源码 MARK=TEST_C4OWN_）', model: 'inventoryItem', field: 'id', prefix: 'TEST_C4OWN_', sensitive: false },
  { label: 'D1 库存项（演练）', model: 'inventoryItem', field: 'id', prefix: 'TEST_D1LOT_', sensitive: false },
  // ★★ v2.63（复核 1 命中）：**把 B35 重开的那一族补回来**。`writeOffTailDrill.test.ts` 写的是
  //   `id: TEST_C7WO_INV_…` / `invoiceNumber: TEST-C7WO-…` / `id: TEST_C7WO_PAY_…` / `voucherNumber: TEST-C7WO-PAY-…`
  //   —— 业务号用**连字符**，而 v2.62 的清单与守卫都只认下划线族 ⇒ 那批收款凭证残留**根本进不了认领清单**，
  //   收口看着完成、其实把最贵的那一族留在了外面。`id` 两行都是下划线形 ⇒ 按 `id` 认领，不依赖连字符拼写。
  //   现量（同日两次，只读）：`paymentVoucher` 按 `id startsWith TEST_C7WO_` 与按 `voucherNumber startsWith TEST-C7WO-` **同为同一批行**，
  //   invoice 那侧该测试自己删干净了（命中 0）⇒ 保留条目是为了"下次它没删干净时要能看见"，不是为了今天的数。
  { label: 'C7WO 核销尾差演练·发票', model: 'invoice', field: 'id', prefix: 'TEST_C7WO_', sensitive: false },
  { label: 'C7WO 核销尾差演练·收款凭证（B35 重开的那一族）', model: 'paymentVoucher', field: 'id', prefix: 'TEST_C7WO_', sensitive: false },
  // ★★ v2.63：认领走**前缀族**而不是枚举（见上面 `DRILL_ACTOR_PREFIX` 的现量）。
  { label: '审计留痕（演练执行者·整族）', model: 'auditLog', field: 'actorId', prefix: DRILL_ACTOR_PREFIX, sensitive: false },
  // ★★ v2.63（量出来的新面，不是设想）：`userAccount` 里 `TEST_ACTOR_*` 账号 **11 行，且 11 行全部 status=active**
  //   （⚠️ 时点值：v3.02 复量已是 **21 行** ⇒ 引用这句必须带"v2.63 时点"，见 §9.1「演练收件箱与账号」行）
  //   ⇒ 它们不是"多余的一行数据"，是**能登录的主体**（≈ 账号面的 21%，全表 53 行）。
  //   此前认领清单**根本没有这张表** ⇒ 诊断永远看不见。本批把它纳进清单，但打上 `sensitive` ⇒
  //   删除器默认**跳过**，只有显式 `--allow-sensitive` 才动它（"登记"与"授权删"必须是两件事）。
  { label: '演练账号（⚠️ 可登录主体，默认不删，需 --allow-sensitive + Kevin 点头）', model: 'userAccount', field: 'id', prefix: DRILL_ACTOR_PREFIX, sensitive: true },
];
/**
 * ★★ v2.63（复核 2 命中）：交割关联**不能只按前缀认领**。
 *   `forwardFxSettlementLink.contractId` 指的是合同的 **id**，而 D6FX 那批合同的 id 是服务生成的（`FFX__…`，
 *   本文件 `DRILL_PROBE_FX` 就是为证明这点而存在的）⇒ 只按 `contractId startsWith TEST_D6WD_` 删，
 *   另一族的关联行**永远删不掉**，而 schema 里 `contractId` 只有索引没有 `@relation` ⇒ 数据库也不会拦。
 *   ⇒ 正确做法是**两段式**：先按合同目标查出真实 id，再用 `in` 删关联。这里只声明纯函数，取数在调用方。
 */
export function derivedLinkTargets(contractIds) {
  const ids = [...new Set((contractIds ?? []).filter((x) => typeof x === 'string' && x))];
  if (!ids.length) return [];   // ★ 空集合必须返回空目标：`{ in: [] }` 会让"删 0 行"看起来像成功
  // ★ v2.65（复核 IMPORTANT-5）：派生目标也必须带**显式档位**，否则它绕过 sensitive 判据（此前返回 undefined）。
  return [{ label: `D6 交割关联（按合同 id 反查，${ids.length} 个 id）`, model: 'forwardFxSettlementLink', where: { contractId: { in: ids } }, sensitive: false }];
}
/**
 * 目标 → prisma where。
 * ★ v2.63：**只承认"前缀族 + 固定条件"这一种形状**。原先还认 `ids: [...]` 枚举，
 *   而 B35 的病根恰恰是"手写枚举追不上新场景"（actor 名单实测 7 vs 源码 18）⇒ 这里直接**拒收枚举**，
 *   让"想改成手写清单"这件事在派生阶段就炸，而不是安静地少删几行。
 *   需要按 id 反查的场景（交割关联）走 `derivedLinkTargets()`，它自带"空集合 ⇒ 不产生目标"的保护。
 */
export function drillWhere(t) {
  if (t.ids) throw new Error(`枚举式认领已撤下（${t.label ?? t.model}）⇒ 改用 prefix 族或 derivedLinkTargets()`);
  if (typeof t.prefix !== 'string' || !t.prefix) throw new Error(`认领目标缺少非空 prefix（${t.label ?? t.model}）⇒ 空前缀会命中全表，绝不许进删除面`);
  return { ...(t.extra ?? {}), [t.field]: { startsWith: t.prefix } };
}
/** 两个消费者唯一的取数口：诊断与删除必须吃同一份清单 */
export function drillTargets() {
  // ★ v2.63：`sensitive` 必须**跟着派生出去**；★ v2.65：且每条必须**显式**表态（见 assertSensitiveVerdict）。
  return DRILL_TARGETS.map((t) => {
    assertSensitiveVerdict(t);
    return { label: t.label, model: t.model, where: drillWhere(t), sensitive: t.sensitive === true };
  });
}

/**
 * ★ 对照**探针**（不是删除目标）：同一张远期合约表，按 `id` 前缀查会漏、按 `contractNumber` 前缀查才看得见
 *   —— 服务生成的 id 不带演练前缀。`diag-test-residue.mjs` 用它证明
 *   "演练自报的零其实是按 id 查出来的 ⇒ 空过"。前缀放基座只为**同一份知识只有一处拼写**。
 */
export const DRILL_PROBE_FX = { model: 'forwardFxContract', fieldA: 'id', fieldB: 'contractNumber', prefix: 'TEST_D6FX_' };
export const deletableMarkers = () => [...RESIDUE_MARKERS];

/**
 * 三态判定（B35 的"结论分支必须覆盖没有输入"）：
 *   clean      —— 有标识列、有行、没命中 ⇒ 才可以说"零残留"
 *   unrecognized —— 这个模型**没有任何可承载标识的列**（既无 String 也无 Json）⇒ 不许说"干净"，只能说"认不出"
 *   no-input   —— 该表 0 行（或本次没喂数据）⇒ 任何"零残留"都是空话
 */
export function judgeResidue({ rowCount, markerCapableColumns, hitCount }) {
  if (!Number.isFinite(rowCount) || rowCount <= 0) return { state: 'no-input', canClaimClean: false, why: '该表 0 行/本次无输入 ⇒ 不构成"已清干净"的证据' };
  if (!markerCapableColumns) return { state: 'unrecognized', canClaimClean: false, why: '该模型没有可承载标识的列 ⇒ 判定为"认不出"，不许当"没毛病"' };
  return hitCount > 0
    ? { state: 'residue', canClaimClean: false, why: `命中 ${hitCount} 行` }
    : { state: 'clean', canClaimClean: true, why: '有列、有行、无命中' };
}

/** ★ v2.87：排除列表标量（`String[]` 不支持 contains）—— 带着它会让整表 count 抛错。
 *     以前这种抛错被 catch 静默成零（假干净），v2.76 起被点名成数不了（D1 演练实测抓到）。
 */
export function stringFields(modelDef) {
  return (modelDef.fields ?? [])
    .filter((f) => f.kind === 'scalar' && f.type === 'String' && f.isList !== true)
    .map((f) => f.name);
}

/**
 * ★ v3.02（B120）：**"标记可能落在哪些列"这件事只有这一份写法。**
 *   此前基座内部有 6 处各自手写 `for f of stringFields: for m of markers: push({f:{contains:m}})`
 *   （`sweepResidue` 的字面量通道 + 族通道、`fetchAllResidue`、`cleanResidue` 的敏感面计数与删除通道……）
 *   ⇒ 与 §9 反复立的"一份知识多处手写 = 迟早各写各的"同族。现在壳的"执行者引用普查"要按**同一批列**
 *   再切一刀（"带本次标记、但不在本次执行者名下"），必须复用这里，不能再抄一份。
 *   ⚠️ 只覆盖标量 String 列（Json 通道另有其形状，见 `sweepResidue` 的 ②）。
 */
export function markerOr(modelDef, terms) {
  const OR = [];
  for (const f of stringFields(modelDef)) for (const m of terms) OR.push({ [f]: { contains: m } });
  return OR;
}

/**
 * ★ B120 第②半：**"带本次 run 的标记，但行主不是任何演练执行者"** 的 where（= 落在真用户名下）。
 *
 * 为什么要单列这一类（不是并进 dirty 的一个数字）：两类红的**修法完全不同** ——
 *  · `dirty` = "我自己写过没清" ⇒ 修在本文件（补一条定向删除）；
 *  · 这一类 = "**隔离面不闭合**" ⇒ 本文件里没有安全修法：业务事件的收件人是"全体 active 用户"
 *    （`notificationService.resolveRecipients()`，实测库里 40 个 ⇒ 见 §9 B120），要清就等于**删真用户的收件箱**。
 *  把它并进 `dirty` 会让读者去找一条根本不存在的"我自己的清理行"，所以必须单独报出来并指名去向（§12.1）。
 *
 * 五个口径细节（都是为了让它不误伤）：
 *  ① 排除**任何** `TEST_ACTOR_` 前缀的执行者，不只是本次的 ⇒ 一份演练合法地用两个执行者账号
 *     （业务员 / 审批人）时不算污染；那些账号若没清掉，会由 `dirty` 自己抓到。
 *  ② 只走 String 通道（`markerOr`）⇒ 这一类是**下界**：只写在 Json 列里的标记不会被切成 foreign。
 *     宁可少报这一类，也不把"该自己清"的行说成"别人的行"（那会变成不去清理的理由）。
 *     一张表有**多根**挂执行者的列时（实测只有 `ApprovalRequest`：`requesterId` + `reviewerId`），
 *     用**一次** count + 行内 OR 取并集 ⇒ 绝不"按列相加"（同族教训 B110：两条通道各数一次会把 1212 行报成 2424）。
 *  ③ `ownerCol` 由 `actorRefRelations()` 从 schema 派生，不是人列的清单 ⇒ schema 新增一张挂执行者的表，这里自动覆盖。
 *  ④ 归属列为 **NULL** 的行**不算 foreign**：那些行"关于本次 run"是真的、"落在某个真用户名下"是猜不出来的，
 *     把它们说成"别人的行"等于给"不去清理"找一个理由 ⇒ 仍归 `dirty` 处理。
 *  ⑤ **只有可空的归属列才加 `null` 那一档**（本批现量撞出来的，不是洁癖）：Prisma 5 对**必选列**过滤 `null` 会直接拒绝整条 where
 *     （实测：`notification.count({where:{… {userId:null} …}})` ⇒ `Argument \`userId\` is missing.`），
 *     而必选列本来就不可能有 NULL ⇒ 这一档只在 `required === false` 的那些列上有意义
 *     （`AgentMemory` / `AgentToolRun` / `ApprovalRequest.reviewerId` / `WorkflowInstance` / `WorkflowStep`）。
 *     ⚠️ 这条**替身客户端测不出来**：手搓的求值器对必选列的 `null` 照样求值 ⇒ 只跑单测会以为它是好的。
 * @param ownerRels `actorRefRelations()` 里属于该模型的条目（要 `{fk, required}`，不是裸列名）
 * @returns where 对象；该模型没有可承载标记的列 / 没有归属列时返回 null（= 不适用，不是"零"）
 */
export function markerOwnedElsewhereWhere(modelDef, terms, ownerRels, runActor) {
  const OR = markerOr(modelDef, terms);
  const rels = [];
  for (const r of ownerRels ?? []) {
    // ★ 传成裸列名（旧签名）时**炸**，不许悄悄退化成"没有归属列 ⇒ 不适用"（少删几行比炸便宜，正是本仓栽过的方向）
    if (!r || typeof r !== 'object' || !r.fk) {
      throw new Error(`markerOwnedElsewhereWhere 要的是 actorRefRelations() 的条目（{fk, required}），拿到 ${JSON.stringify(r)} ⇒ `
        + '裸列名会被当成"该表没有归属列"，那一刀就静默不数了（与 drillWhere 的 ids 分支同一条规矩）');
    }
    rels.push(r);
  }
  if (OR.length === 0 || rels.length === 0) return null;
  const ours = [];
  for (const r of rels) {
    ours.push({ [r.fk]: runActor }, { [r.fk]: { startsWith: DRILL_ACTOR_PREFIX } });
    if (!r.required) ours.push({ [r.fk]: null });
  }
  return { AND: [{ OR }, { NOT: { OR: ours } }] };
}

/**
 * 扫描：返回 [{ model, key, count, sample }]，仅含命中 > 0 的模型。
 * 只读，不改任何数据。
 *
 * ⚠️ `count` 用 `count()` 取**精确值**，`sample` 单独 `take:2`
 * —— 早期版本用 `findMany({take:1000}).length` 当计数，会显示成「1000+」，
 * 让人**低估残留规模**（实测真实 3690 条被报成 1000+）。
 *
 * ★ B35 第二刀：`count`（精确，字面量）之外再加 `family`（**族检测**，见 RESIDUE_MARKER_RES）：
 *   Prisma 的 where 没有正则 ⇒ 族只能"SQL 取词干粗筛 + JS 按锚定式判实"。
 *   于是族数**天然是下界**（受切片上限约束）⇒ 报告里必须写成 `≥ N（在 M 行切片内）`，
 *   **不许**把下界当精确数写进台账（§9.1 只收有命令可复现的数）。
 *   字面量那条路**一个数都不改** ⇒ 删除侧行为与本批之前完全一致（族只加在检测/报告侧）。
 */
const FAMILY_STEMS = ['TEST', 'DRILL', 'E2E', 'SMOKE'];

export async function sweepResidue({ prisma, Prisma, markers, withFamily = true, unreadableOut = null, scanStatOut = null }) {
  const hits = [];
  /**
   * ★ B35 第三刀复核 **B-1** 的修法：原来两处 `catch { x = 0 }` 把"**这张表数不了**"
   *   直接翻译成"这张表干净"⇒ 上层看到 `hits=[]` 就打印零残留（实测：抛错桩 → hits=[]，
   *   正常桩 → hits=[CreditNote:7]）。现在把失败**显式带出去**（`unreadableOut`），
   *   由调用方决定是红还是降级；不传该参数的老调用方行为不变（仍返回 hits，不会炸）。
   */
  const markUnreadable = (model, why) => { if (unreadableOut) unreadableOut.push({ model, why }); };
  /**
   * ★ v2.93（B109）：**分母为空就必须炸**。
   *   实测踩法：把 `Prisma` 传成 { datamodel: { models } }（少一层 dmmf）⇒ allModels 拿到 []
   *   ⇒ 循环一次不进 ⇒ 返回 hits=[] 且 unreadable=[] ⇒ 上层照样打印"零残留"。
   *   我自己就在只读取证时踩到：同一份数据，错形状读成 0 行，对形状读成 2424 行。
   *   "扫了 0 张表"和"扫了 12 张表都干净"是两件事，绝不能都返回空数组。
   */
  const modelDefs = allModels(Prisma);
  // ★ v3.41（B165 第二刀）：把"数过了几张表"带出去 —— 否则"扫了 0 张"与"扫了 225 张都干净"同值。
  if (scanStatOut) Object.assign(scanStatOut, { scannable: modelDefs.length, scanned: 0 });
  if (modelDefs.length === 0) {
    throw new Error('sweepResidue 扫到 0 个模型 ⇒ 拒绝返回"干净"。'
      + '最常见成因：Prisma 参数少了一层 dmmf（要 { dmmf: { datamodel: { models } } }）。');
  }
  if (!Array.isArray(markers) || markers.length === 0) {
    throw new Error('sweepResidue 的 markers 为空 ⇒ 任何计数都恒为 0，这是恒绿判据，拒绝执行。');
  }
  for (const modelDef of modelDefs) {
    const { key, delegate } = delegateOf(prisma, modelDef.name);
    // ★ v3.13（B133 同族最后一格）：原先这里 `continue` ⇒ **这张表根本没被数，却和"数过且干净"共用一个返回值**。
    //   今天本树实测没有这种模型（225 个模型里 0 个拿不到 delegate），但它恰好是 B122 那族会踩的形状
    //   （`server/node_modules` 与主 checkout 共享 ⇒ 生成物与本树 schema 漂移时，DMMF 有、客户端没有）。
    //   所以按"数不了"报出去，而不是继续静默跳过。
    if (!delegate || !delegate.findMany) {
      markUnreadable(modelDef.name, '客户端里没有该模型的 delegate/findMany ⇒ 这张表**一行都没被数过**');
      continue;
    }
    const sf = stringFields(modelDef);
    const jf = jsonFields(modelDef);
    // ★ 复核 #12：原先 scanned 先 +1 再 continue ⇒ 一张没有任何字符串/Json 列的表**一次查询都不发**
    //   却被记成"数过了"（实测 6 张这种表 ⇒ scanned=6/6、count()/findMany() 调用 0 次、判决 clean）。
    //   这种表按演练标识本来就数不了 ⇒ 归入"数不了"，不计入 scanned。
    if (sf.length === 0 && jf.length === 0) {
      markUnreadable(modelDef.name, '无字符串/Json 列 ⇒ 演练标识无处可匹配，这张表一次查询都没发');
      continue;
    }
    if (scanStatOut) scanStatOut.scanned += 1;   // 走到这里 = 这张表真的会发查询

    let stringCount = 0;
    let jsonRows = [];
    // ① 字符串字段
    const OR = markerOr(modelDef, markers);
    // ★ B110：OR 提到 if 外面 —— 下面 Json 通道要用它做同一行的去重（不再建第二份）。
    if (OR.length > 0) {
      // ★ v3.43（复核 #11 B-1）：原来 `delegate.count ? count() : 0` 把"这张表没有 count 能力"
      //   直接翻译成"这张表 0 行"——而 scanned 已经 +1 ⇒ 本批刚立的"数过了"这个前提当场变成谎报。
      //   现在按"数不了"报出去（与 B-1 同族的 :513 那条也一样），删除面一字未动。
      if (!delegate.count) {
        markUnreadable(modelDef.name, '客户端里没有 count 能力 ⇒ String 列一行都没被数过，本表的"零"不可信');
      } else {
        try { stringCount = await delegate.count({ where: { OR } }); }
        catch (e) { stringCount = 0; markUnreadable(modelDef.name, `String 列计数失败（${String(e.message || e).slice(0, 120)}）⇒ 本表"零"不可信`); }
      }
    }
    // ② Json 字段（全模型，自动发现）—— JS 过滤近期切片
    if (jf.length > 0) {
      try {
        const rows = await delegate.findMany({
          ...recentSliceArgs(modelDef, JSON_SCAN_LIMIT),
          // ★ B110 修法：排除已被字符串通道命中的行。
          //   原来两条通道直接相加 ⇒ 同一物理行数两次（实测 EntityLink 真 1212 行、被报成 2424）：
          //   Json 的 select 里带 id，而 id 自己就含演练标识 ⇒ 每个字符串命中必然再命中一次 Json。
          //   现在取并集：字符串命中的不重复计，Json 通道只补「只有 Json 里才有标识」那批。
          ...(OR.length > 0 ? { where: { NOT: { OR } } } : {}),
          select: { id: true, ...Object.fromEntries(jf.map((f) => [f, true])) },
        });
        jsonRows = rows.filter((r) => {
          const s = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
          return markers.some((m) => s.includes(m));
        });
      } catch (e) { jsonRows = []; markUnreadable(modelDef.name, `Json 列切片失败（${String(e.message || e).slice(0, 120)}）⇒ 本表"零"不可信`); }
    }

    const count = stringCount + jsonRows.length;

    // ③ 族检测（只读，报告侧）：SQL 取词干 → JS 判实，给出**下界**与被截掉的信号
    let family = null;
    if (withFamily && (sf.length > 0 || jf.length > 0)) {
      let coarse = 0;
      let real = 0;
      let sliced = false;
      try {
        if (sf.length > 0) {
          const OR = markerOr(modelDef, FAMILY_STEMS);
          coarse = delegate.count ? await delegate.count({ where: { OR } }) : 0;
          if (coarse > 0) {
            const rows = await delegate.findMany({ where: { OR }, take: JSON_SCAN_LIMIT, select: { id: true } });
            sliced = coarse > rows.length;
            const vals = await delegate.findMany({ where: { OR }, take: JSON_SCAN_LIMIT, select: Object.fromEntries(sf.map((f) => [f, true])) });
            real = vals.filter((r) => sf.some((f) => detectResidueMarker(String(r[f] ?? '')))).length;
          }
        }
      } catch (e) {
        coarse = 0; real = 0;
        // ★ v3.13（B120 收编那一刀的顺手补）：这一路原先**静默吞错** ⇒ 报出来的"族下界 0"其实可能是"数不了"。
        //   只写进 `unreadableOut`（opt-in），不传该参数的老调用方行为不变 ⇒ 不影响任何删除面。
        markUnreadable(modelDef.name, `族检测计数失败（${String(e.message || e).slice(0, 100)}）⇒ 本表的"族下界"不可信`);
      }
      if (coarse > 0 || count > 0) family = { coarse, realLowerBound: real, sliced };
    }

    if (count > 0 || (family && family.realLowerBound > 0)) {
      let sample = [];
      if (stringCount > 0 && sf.length > 0) {
        const OR = markerOr(modelDef, markers);
        try { sample = await delegate.findMany({ where: { OR }, take: 2 }); } catch { sample = []; }
      } else {
        sample = jsonRows.slice(0, 2);
      }
      hits.push({ model: modelDef.name, key, count, stringCount, jsonCount: jsonRows.length, family, sample });
    }
  }
  return hits;
}

/**
 * **沉淀式清扫**：业务事件总线是**异步投递**的 —— 通知（`notification`）与作业（`agentJob`）
 * 由**服务端进程**在其事件队列里陆续落库，实测窗口从**数秒到一分钟不等**
 * ⇒ 只清一次**必然漏**（实测清完仍留 `notification +150` / `agentJob +3`）。
 *
 * ⚠️ **诚实边界**：窗口不可控 ⇒ 脚本退出时的清扫是**尽力而为**，
 * **不能保证**「退出即零残留」。真正的兜底是：
 *   ① `scripts/clean-drill-residue.mjs --apply`（按标识全模型清）
 *   ② `scripts/db-rowcount.mjs --compare`（行数对撞，跑完批量后核）
 *
 * @param settleMs  每轮等待（默认 2500ms）
 * @param maxRounds 最多轮数（默认 6 ⇒ 最长约 15s）
 */
export async function settleAndClean({ prisma, Prisma, markers, log = () => {}, settleMs = 2500, maxRounds = 6, deletedRowsOut = null }) {
  const byModel = {};
  let total = 0;
  let quietRounds = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    await new Promise((r) => setTimeout(r, settleMs));
    const r = await cleanResidue({ prisma, Prisma, markers, log: () => {}, deletedRowsOut });
    total += r.deleted;
    for (const [m, c] of Object.entries(r.byModel)) byModel[m] = (byModel[m] ?? 0) + c;
    if (r.deleted === 0) {
      quietRounds += 1;
      if (quietRounds >= 3) break; // 连续三轮无新增 ⇒ 总线基本沉淀
    } else {
      quietRounds = 0;
      log(`     · 沉淀第 ${round} 轮补删 ${r.deleted} 行：${JSON.stringify(r.byModel)}`);
    }
  }
  return { deleted: total, byModel };
}

/**
 * 取全部命中行（**用于删除前备份** —— 只备份抽样无法回溯 ✗）。
 * @returns {Promise<Record<modelKey, rows[]>>}
 */
export async function fetchAllResidue({ prisma, Prisma, markers, unreadableOut = null }) {
  const out = {};
  const mark = (model, why) => { if (unreadableOut) unreadableOut.push({ model, why }); };
  for (const modelDef of allModels(Prisma)) {
    const { key, delegate } = delegateOf(prisma, modelDef.name);
    // ★ v3.13（复核 I-4）：这里原先 `continue` ⇒ 上层照样打印"已全量备份 N 行"，而"全量"里根本没有这张表
    if (!delegate || !delegate.findMany) { mark(modelDef.name, '客户端没有该模型的 delegate ⇒ 备份里没有这张表'); continue; }
    const OR = markerOr(modelDef, markers);
    if (OR.length === 0) continue;
    try {
      const rows = await delegate.findMany({ where: { OR } });
      if (rows.length > 0) out[key] = rows;
    } catch (e) {
      // ★ v3.13（复核 I-4）：原先 `catch { /* 跳过 */ }` ⇒ 备份少了一张表，上层照样报「已全量备份」
      mark(modelDef.name, `取备份行失败（${String(e.message || e).slice(0, 100)}）⇒ 「全量备份」不完整`);
    }
  }
  return out;
}

/**
 * 清理：**多轮删除直到无进展**（用轮次代替手写依赖顺序 —— 有 FK 的表会在前几轮被挡下，
 * 待引用方删净后自然成功）。每轮同时做**级联**：把已命中实体的 id 拿去清
 * `entityLink` / `entityReference` / `auditLog` / `approvalRequest`（它们不含标识，只存 id）。
 *
 * @returns {Promise<{ deleted: number, byModel: Record<string, number>, stuck: string[] }>}
 */
function recordDeletedRows(out, model, rows) {
  // ★ v3.72（B184）：清扫这一路也要能报"删了哪几行"。第十一程只有链上手写清单那 32 处接了预读，
  //   兜底清扫那三张（`AgentJob/Notification/ProductionStage`，422 行）整表落进"判不了"
  //   ⇒ 行级证人的覆盖面被这 422 行挡住。这里加的只是**删除前的同谓词预读**，删除条件一字未动。
  //   `rows = null` 是显式的"预读没对上"（少报/多报/抛错）⇒ 上层按行判不了处理，不许当 0 行放行。
  if (!out || !Object.prototype.hasOwnProperty.call(out, model)) { /* 首次见这张表时下面建桶 */ }
  if (!out) return;
  const list = (out[model] = out[model] ?? { rows: [], broken: false });
  if (rows === null) { list.broken = true; return; }
  for (const r of rows) if (r && r.id !== undefined) list.rows.push({ id: String(r.id), createdAt: r.createdAt ?? null });
}

export async function cleanResidue({ prisma, Prisma, markers, log = () => {}, maxPasses = 8, allowSensitive = false, deletedRowsOut = null }) {
  // ★ v3.73：委托键 → 模型定义（预读要不要带 createdAt 由 DMMF 决定，不靠试抛）
  const modelsByKey = {};
  for (const md of allModels(Prisma)) modelsByKey[delegateKey(md.name)] = md;
  /**
   * ★ v2.65（复核 IMPORTANT-3，已自己现量确认）：本函数按 RESIDUE_MARKERS **子串**匹配且**扫全模型**，
   *   而 `REQ2-` 就在那六个标记里 ⇒ 现量 2026-09-22：`UserAccount` 有 **6 行 REQ2-*，5 行 active、passwordHash 长度 60（真实 bcrypt）**，
   *   一次普通 `--apply` 就会删掉它们 —— 而认领清单认的是 `TEST_ACTOR_`，**根本不包含这 6 行**。
   *   ⇒「账号面默认不删」此前只在 cleanup 那一个脚本里成立；现在在**这里**也拦：默认只报不删，要 allowSensitive:true 才动。
   */
  const isSensitiveModel = (name) => MUST_BE_SENSITIVE_MODELS.includes(name);
  /** ★ 同一批行会被多轮扫描重复看见 ⇒ 按 model 只记一次，否则 skippedSensitive 会算成「轮数 × 行数」这种没定义的数 */
  const skippedByModel = new Map();
  const skippedTotal = () => [...skippedByModel.values()].reduce((x, c) => x + c, 0);
  const byModel = {};
  const stuck = [];
  let total = 0;
  /** 已命中实体的 id（用于级联） */
  const seenIds = new Set();

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let passDeleted = 0;

    // ── ① 级联：用上一轮收集到的 id 清「只存 id」的表 ──
    if (seenIds.size > 0) {
      const idArr = [...seenIds];
      for (const [key, fields] of Object.entries(CASCADE_MODELS)) {
        const d = prisma[key];
        if (!d || !d.deleteMany) continue;
        if (!allowSensitive && isSensitiveModel(key)) continue;   // ★ v2.65
        try {
          const w = { OR: fields.map((f) => ({ [f]: { in: idArr } })) };
          // ★ v3.73（B184 续）：这一处原来只 select id ⇒ 拿到的行没有 createdAt，而这几张表**是有**
          //   createdAt 的（所以也不在跑前主键快照那 33 张里）⇒ 第十二程剩的 52 行"判不了"全来自这条臂。
          //   修法就是把预读的 select 跟着 DMMF 走，与 ② 同一套判断（不是再猜一层 try/catch）。
          const md = modelsByKey[key];
          const hasCreated = !!(md && (md.fields || []).some((x) => x.name === 'createdAt'));
          const got = await d.findMany({ where: w, select: hasCreated ? { id: true, createdAt: true } : { id: true } }).catch(() => null);
          const r = await d.deleteMany({ where: w });
          if (r?.count) {
            if (got && got.length === r.count) recordDeletedRows(deletedRowsOut, key, got);
            else recordDeletedRows(deletedRowsOut, key, null);
            byModel[key] = (byModel[key] ?? 0) + r.count; passDeleted += r.count;
          }
        } catch { /* 下一轮再试 */ }
      }
    }

    // ── ② 按标识扫全模型（字符串字段 + Json 提示字段）──
    for (const modelDef of allModels(Prisma)) {
      const { key, delegate } = delegateOf(prisma, modelDef.name);
      if (!delegate || !delegate.deleteMany) continue;
      if (!allowSensitive && isSensitiveModel(key)) {
        const orv = markerOr(modelDef, markers);
        const n = orv.length ? await delegate.count({ where: { OR: orv } }).catch(() => 0) : 0;
        if (n && !skippedByModel.has(key)) { skippedByModel.set(key, n); log(`  ⓘ 跳过 ${key}：命中 ${n} 行但属敏感面（MUST_BE_SENSITIVE_MODELS）⇒ 要 allowSensitive:true 才动`); }
        continue;
      }
      const OR = markerOr(modelDef, markers);

      if (OR.length > 0) {
        try {
          // 先取 id 入 seenIds（供级联），再删
          // ★ B184：这条 findMany 与下面的 deleteMany 共用同一个 `OR` 数组 ⇒ 谓词同构。
          //   `take: 5000` 是原有上限：命中数触顶时预读会少、实删会多 ⇒ 走"不等长 ⇒ 判不了"那一条。
          const hasCreated = (modelDef.fields || []).some((x) => x.name === 'createdAt');
          const rows = await delegate.findMany({ where: { OR },
            select: hasCreated ? { id: true, createdAt: true } : { id: true }, take: 5000 });
          for (const r of rows) if (r?.id) seenIds.add(r.id);
          const r = await delegate.deleteMany({ where: { OR } });
          if (r?.count) {
            if (rows.length === r.count) recordDeletedRows(deletedRowsOut, modelDef.name, rows);
            else recordDeletedRows(deletedRowsOut, modelDef.name, null);
            byModel[modelDef.name] = (byModel[modelDef.name] ?? 0) + r.count; passDeleted += r.count;
          }
        } catch { /* FK 挡下 ⇒ 下一轮再试 */ }
      }

      // ② Json 字段（**全模型自动发现**）：字符串 contains 扫不到 ⇒ 取近期切片 + JS 过滤后按 id 删
      const jf = jsonFields(modelDef);
      if (jf.length > 0 && delegate.findMany) {
        try {
          // ★ v3.74（复核 #17 B-1）：这一路原本只 select `{id, ...Json}` ⇒ 记进台账的 createdAt 恒 null，
          //   而 `AgentJob/Notification` 这类表**有** createdAt（因此也不在"无可用 createdAt"那 33 张的
          //   跑前主键快照里）⇒ 两条归类路都落空，第十二/十三程那 52 行"判不了"全部出自这里
          //   （12 + 40 = 52，且没有 Json 列的 `ProductionStage` 走 ② 那条、被正常分类 ⇒ 读数自洽）。
          const jHasCreated = (modelDef.fields || []).some((x) => x.name === 'createdAt');
          const rows = await delegate.findMany({
            ...recentSliceArgs(modelDef, JSON_SCAN_LIMIT),
            select: { id: true, ...(jHasCreated ? { createdAt: true } : {}), ...Object.fromEntries(jf.map((f) => [f, true])) },
          });
          // 命中判定只看 id + Json 字段（把 createdAt 摘出去）：多带一列不许改变"哪些行算命中"
          const hit = rows.filter((r) => {
            const { createdAt, ...rest } = r;
            const s = JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
            return markers.some((m) => s.includes(m));
          });
          const ids = hit.map((r) => r.id);
          if (ids.length > 0) {
            for (const id of ids) seenIds.add(id);
            const r2 = await delegate.deleteMany({ where: { id: { in: ids } } });
            // ★ B184：这一路的删除谓词就是 `id in ids` ⇒ 预读与实删天然同构，只在等长时记账
            if (r2?.count) {
              if (r2.count === ids.length) recordDeletedRows(deletedRowsOut, modelDef.name, hit);
              else recordDeletedRows(deletedRowsOut, modelDef.name, null);
              byModel[modelDef.name] = (byModel[modelDef.name] ?? 0) + r2.count; passDeleted += r2.count;
            }
          }
        } catch { /* 同上 */ }
      }
    }

    total += passDeleted;
    if (passDeleted > 0) log(`     · 第 ${pass} 轮删除 ${passDeleted} 行（累计 id 池 ${seenIds.size}）`);
    if (passDeleted === 0) break;
  }

  // 收尾：仍有命中的模型 = 删不掉的（多为 FK 或需人工确认）
  const remaining = await sweepResidue({ prisma, Prisma, markers });
  for (const h of remaining) stuck.push(`${h.model}(${h.count})`);

  return { deleted: total, byModel, skippedSensitiveRows: skippedTotal(), skippedSensitiveTargets: skippedByModel.size, skippedByModel: Object.fromEntries(skippedByModel), stuck };
}

/**
 * 只留代码行（剥掉整行注释与 JSDoc 续行）。
 * 为什么放在基座：多把尺都要"看代码不注释"，各写各的 = 本仓头号病（多套并行真源）。
 */
/**
 * ★ **B121 第二层（v3.00）：已接壳的演练文件里出现 `.skip` / `.only` / `.todo` ⇒ 判红。**
 *
 * 为什么"壳自己在文件级挂钩子"还不够（这一条是**实测出来的负结果**，不是推理）：
 *   把一份真演练整份 `describe.skip` ⇒ vitest 把**整个文件**记成 skipped，
 *   **连文件级 `afterAll` 都不跑**（实测输出 `Test Files 1 skipped (1)`、exit 0）
 *   ⇒ 运行时那层只盖得住"文件里还有活用例"那一档（那一档确实会红，实测点名 B121）。
 *   剩下的这一档只能靠**文本判据**兜住。
 *
 * 口径与边界（照 B114 的规矩写清，别把下界读成"都干净"）：
 *   · 只认 `it` / `test` / `describe` 上的修饰符（`skip` / `only` / `todo` / `skipIf` / `runIf`），
 *     且**允许跨 `each(...)` 这种带括号的中间修饰符**（`describe.each(rows).skip(...)` 是真实存在的形状）；
 *   · 整行注释（`//` / `*` / `/*` 开头）不算落点，其余**整行都查**（不截行内注释 ⇒ 宁假红不漏报）。
 *   ⚠️ 仍未覆盖（v3.00 复核实测，按"漏报方向"记账，别读成"都拦得住"）：
 *      `it['skip']` / `it .skip`（带空格）/ `describe\n  .skip`（跨行）/ `const S='skip'; it[S](...)`。
 *      这些都是**刻意改写才能躲过**的形状 ⇒ 靠"改判据要同批改 §9"这条流程约束，不靠这把尺。
 */
export const SKIP_MODIFIER = /(?:^|[^\w$.])(?:it|test|describe)(?:\.\w+(?:\([^()]*\))?)*\.(?:skip|only|todo|skipIf|runIf)\s*[(.]/;

/** @returns {Array<{line:number, text:string}>} 命中的行（1-based，按原文行号） */
export function skipCallsInCode(src) {
  const out = [];
  String(src).split(String.fromCharCode(10)).forEach((raw, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(raw)) return;                 // 整行注释不是落点
    // ⚠️ v3.00 复核后改成**偏向报红**：先前是"行内 `//` 之后一律截掉"，那会把
    //   `const url = 'https://x'; it.skip('a', …)` 这种**真落点**静默放过（漏报 = 判据失效）。
    //   现在整行都查 ⇒ 代价是"代码后面挂一句提到 it.skip 的注释"会假红一次，
    //   而假红是**响的**（改注释措辞即可），漏报是**哑的**（B121 那个洞原地复活）。
    if (SKIP_MODIFIER.test(raw)) out.push({ line: i + 1, text: raw.trim().slice(0, 90) });
  });
  return out;
}

/**
 * ★ B121 的**逃逸口封堵**（v3.00 复核 BLOCKER-1/2 的处置，两条都是"接壳判据说不清的事让文本判据说清"）：
 *  · `injectsStubClient` —— 壳只在**没有注入客户端**时登记文件级断言（注入 = 替身 = 壳自己的单测）。
 *    那"注入一个替身"就成了**只要写一行就能拿到'已接壳'称号却没有运行时保证**的旁路 ⇒ 必须判红。
 *  · `registersCtxAtTopLevel` —— 壳用的是**调用点的钩子作用域**：把 `createDrillContext()` 写进
 *    `describe(...)` 里面的话，登记的就是 suite 级钩子 ⇒ B121 那个洞原地复活。所以钉"必须在第 0 列"。
 * 两条都住在基座 ⇒ 壳与棘轮读同一份定义（两份各自漂 = 本仓头号病）。
 */
/**
 * ★ B121 ⑥（v3.01 复核）：**只有"一行字面量、且参数里没有 `client`"这一种写法，才能证明壳一定挂了文件级断言。**
 *   光靠 `injectsStubClient` 是漏的：`{ prefix, client }`（对象简写，没有冒号）、`createDrillContext(cfg)`（参数外提）、
 *   `{ prefix: mk(), client: stub }`（中间有右括号）三种都能绕过去，而绕过去之后**文件里什么都不用写**
 *   （v3.01 删掉了手抄断言 ⇒ 原来那条"文件必须自己调 writtenModels()"顺带兜住的口子没了）。
 *   ⇒ 改成**正面要求**：调用必须长成 `createDrillContext({ …… })` 的一行字面量且不含 `client`，否则判"没接上保证"。
 */
export function ctxCallIsPlainLiteral(src) {
  const m = String(codeOnly(src)).match(/createDrillContext\s*\(\s*\{([^{}]*)\}\s*\)/);
  return !!m && !/\bclient\b/.test(m[1]);
}

export const injectsStubClient = (src) =>
  /createDrillContext\s*\([^)]*\bclient\s*:/.test(codeOnly(src));

/** 顶层登记 = 形如 `const ctx = createDrillContext(` 且**行首无缩进**（缩进说明它在某个 suite 里） */
export function registersCtxAtTopLevel(src) {
  return String(codeOnly(src)).split(String.fromCharCode(10)).some((l) => /^\s*(?:export\s+)?const\s+\w+\s*=\s*createDrillContext\s*\(/.test(l)
    && !/^[ \t]/.test(l));
}

export function codeOnly(src) {
  return String(src).split(String.fromCharCode(10)).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(String.fromCharCode(10));
}

/* ════════════════════════════════════════════════════════════════════════════
 * ★ B114（v2.98）：演练身份 / 是否接壳 / 删除谓词落点 —— 三把尺的**唯一实现**
 *
 * 为什么要搬进基座（不是重构癖，是量出来的）：
 *   v2.93 立宽尺时 `isDrillName` / `isDrillMarker` / `isAdopted` 写在 `scripts/drill-adoption-ratchet.test.ts` 里，
 *   v2.96 我做"删除谓词落在谁的命名空间"的普查时又在 `/tmp` 写了第二份 walk + 第二份身份判据
 *   ⇒ 同一件事两份实现各自漂 = 本仓头号病（R2 / B77）。而 `/tmp` 那份还连续暴露两个盲区：
 *   ① 只看单行（跨行 `OR: [...]` 里的判据看不见 ⇒ 漏掉 B111 自己那一处）；
 *   ② 一行只取第一个 match（`{ fromId: {startsWith}, toId: {startsWith} }` 少算一处）。
 *   ⇒ 这两条现在都钉成基座的**可测实现**，并由 `scripts/drill-cleanup-scope.test.ts` 当门禁跑。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 演练身份的**窄**口径：命名族（改名就逃 ⇒ 只能当上界之一） */
export const isDrillFileName = (rel) => /Drill.*\.test\.ts$/.test(String(rel).split('/').pop());
/** 演练身份的**宽**口径（落点）：代码行里自造 `TEST_<族>_` 演练标记 ⇒ 改名逃不掉 */
export const containsDrillMarker = (src) => /['"`]TEST_[A-Z0-9]{2,}[_-]['"`]/.test(codeOnly(src));
/** 接壳判据：客户端由壳给（两处都在**代码行**里才算，注释里写满不算 —— B107 ①） */
export function isShellAdopted(src) {
  const code = codeOnly(src);
  return /createDrillContext\s*\(/.test(code) && /const\s+prisma\s*=\s*ctx\.prisma/.test(code);
}

/** 遍历某目录下的 `*.test.ts`（相对 rootDir 的路径，斜杠统一） */
export function walkTestFiles(rootDir, fs) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = d + '/' + e;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.test\.ts$/.test(e)) out.push(p.replace(rootDir + '/', '').split('\\').join('/'));
    }
  };
  walk(rootDir);
  return out.sort();
}

const DELETE_CALL = /\.delete(?:Many)?\s*\(/;
/**
 * 谓词抽取。三条设计决定都来自 v2.98 复核（我第一版各错了一次，逐条有对应用例钉住）：
 *  · **在整块文本上 matchAll**（不是逐行）⇒ `where: {`↵`id: {`↵`startsWith: 'SHPA__'` 这种**跨行谓词**不再漏算；
 *  · **块内注释行不算落点** ⇒ 否则一块里的一句注释能凭空造出"必须登记的越界"（假红方向）；
 *  · **同文件字符串常量要还原** ⇒ `const NS = 'SHPA__'; startsWith: NS` 曾是**完全未声明**的漏洞（复核 A①）。
 * 一行多个谓词天然由 matchAll 覆盖（v2.96 那版"每行只取第一个 match"的盲区一并修掉）。
 */
const STARTS_WITH_PREDICATE = /([A-Za-z_$][\w]*)\s*:\s*\{\s*startsWith:\s*(?:(['"`])([^'"`]*)\2|([A-Za-z_$][\w.]*))/g;
const STRING_CONST = /(?:const|let)\s+([A-Za-z_$][\w]*)\s*=\s*(['"`])([^'"`]*)\2/g;
const isCommentLine = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

/**
 * 全部删除落点。**一把尺一个名字**：这是"删除调用出现次数"，
 * 不许与下面 `deletePrefixPredicates().length`（含 `startsWith` 的谓词数）共用"落点"这个叫法。
 */
export function countDeleteCalls(src) {
  let n = 0;
  for (const line of String(src).split(String.fromCharCode(10))) {
    if (isCommentLine(line)) continue;
    const m = line.match(new RegExp(DELETE_CALL.source, 'g'));
    if (m) n += m.length;
  }
  return n;
}

/**
 * 取一份源码里所有**删除落点**及其 `startsWith` 前缀谓词。
 * @returns {Array<{callStart:number,callEnd:number,line:number,field:string,value:string,rawValue:string,literal:boolean,resolvedFrom:string|null,foreign:boolean}>}
 *   `foreign` = 还原成字面量之后**不以 TEST 开头** ⇒ 判据指向别人/服务的命名空间（B111 / B113 那一族）。
 *   ⚠️ 已知仍看不见（**写成契约，不是假装没有**）：① 跨文件持有的常量；② where 对象外提
 *      （`const where = {…}; deleteMany({ where })`）；③ 等值 / `in` / `contains` 式判据；④ 服务层内部的删除。
 *      ⇒ 所以本尺的读数是**下界**，"越界 0" 不等于"删除面都干净"。
 */
export function deletePrefixPredicates(src) {
  const raw = String(src).split(String.fromCharCode(10));
  const consts = new Map();                                  // 同文件字符串常量表（一层，不解析表达式）
  for (const line of raw) {
    if (isCommentLine(line)) continue;
    for (const m of line.matchAll(STRING_CONST)) consts.set(m[1], m[3]);
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (isCommentLine(raw[i])) continue;
    if (!DELETE_CALL.test(raw[i])) continue;
    let depth = 0;
    const block = [];
    let j = i;
    for (; j < raw.length; j += 1) {                          // 向后取到括号平衡（跨行块不瞎）
      block.push(raw[j]);
      for (const ch of raw[j]) { if (ch === '(') depth += 1; else if (ch === ')') depth -= 1; }
      if (depth <= 0) break;
    }
    const text = block.join(String.fromCharCode(10));
    for (const m of text.matchAll(STARTS_WITH_PREDICATE)) {
      const lineNo = i + (text.slice(0, m.index).split(String.fromCharCode(10)).length - 1) + 1;
      if (isCommentLine(raw[lineNo - 1])) continue;            // 块内注释不算落点
      const isLit = m[2] !== undefined;
      const rawValue = isLit ? m[3] : m[4];
      const resolved = isLit ? null : (consts.get(rawValue) ?? null);
      const effective = isLit ? m[3] : resolved;               // 还原不出来的变量交给接壳 + 认领清单两条判据
      out.push({
        callStart: i + 1, callEnd: j + 1, line: lineNo, field: m[1],
        value: effective === null ? rawValue : effective, rawValue,
        literal: isLit, resolvedFrom: resolved === null ? null : rawValue,
        foreign: effective !== null && !effective.startsWith('TEST'),
      });
    }
  }
  return out;
}
