/**
 * devSource.ts —— 开发来源（`DevelopmentCase.source`）的**唯一真源**（G-5 批，零依赖文件）
 *
 * ★ 为什么单独成文件、且不 import 任何东西：同 `finance/allocationCustomerGuard.ts` 的理由 ——
 *   这份枚举要同时被**服务端两条链**（面料转档 / 成衣转档）和**前端表单**（`components/DevelopmentManager.tsx`）消费，
 *   放在任一域内都会把重依赖拖过 tsconfig 的跨层边界。判定/枚举必须独立成零引用文件。
 *
 * ★ 动手前实测到的四处并行真源（这就是本批要收掉的，全部 file:line 现读核实）：
 *   ① `fabricDevelopmentService.ts:34` `DEV_SOURCES` —— 声明后**全仓零引用**（写了等于没写）；
 *   ② `fabricDevelopmentService.ts:944-947` `DEV_SOURCE_MAP`（source → ProductAsset.source）—— 只有面料转档在用；
 *   ③ `garmentDevelopmentService.ts:108` `assetSource = 'development'` **硬编码**，
 *      注释还断言"成衣案无 DR-050 面料立项 source" ⇒ 成衣案即便录了来源，**转档时被销毁**；
 *   ④ 前端两份且**已经漂移**：`DevelopmentManager.tsx:198-202` 的 `DEV_SOURCE_LABELS`
 *      （internal = '内部开发（本司部门）'）vs `:2032-2037` select 里硬编码的 options
 *      （internal = '内部开发（本司部门提出）'）⇒ 同一个值两个说法。
 *
 * ⚠️ 本文件的取值/映射**不是新口径**：三个值与映射表逐字抄自②③处既有实现（DR-054 阶段 D 已拍板并在跑），
 *   只是把"三份"并成"一份"。新增行为只有一件：成衣转档改为与面料同一张映射表（此前恒 'development'）。
 */

/** `DevelopmentCase.source` 的三个合法取值（**这是值集合，不是展示顺序** —— 顺序由下面的 DEV_SOURCE_OPTIONS 决定） */
export const DEV_SOURCES = ['customer-sample', 'customer-colorcard', 'internal'] as const;
export type DevSource = (typeof DEV_SOURCES)[number];

/** source → 展示文案（详情页与表单下拉共用同一份，杜绝再漂移） */
export const DEV_SOURCE_LABELS: Record<DevSource, string> = {
  'customer-sample': '客户来样开发',
  'customer-colorcard': '客户色卡/规格开发',
  internal: '内部开发（本司部门提出）',
};

/** 表单下拉用：首项"不指定"= 不写 source（保持 null，转档按默认 development）。
 *  ★ 由 `DEV_SOURCE_ORDER` + `DEV_SOURCES` **派生**，不再手抄一份（此前正是"labels 一份、options 一份"漂了字）。
 *    `DEV_SOURCE_ORDER` 单列是因为展示顺序与值集合是两件事：内部开发排最前是既有的屏面习惯。 */
export const DEV_SOURCE_ORDER: readonly DevSource[] = ['internal', 'customer-sample', 'customer-colorcard'];
export const DEV_SOURCE_OPTIONS: Array<{ value: '' | DevSource; label: string }> = [
  { value: '', label: '不指定' },
  ...DEV_SOURCE_ORDER.map((v) => ({ value: v, label: DEV_SOURCE_LABELS[v] })),
];

/** source → `ProductAsset.source`（DR-054 阶段 D 既有口径，逐字来自 fabricDevelopmentService.ts:944-947） */
export const DEV_SOURCE_TO_ASSET_SOURCE: Record<DevSource, string> = {
  internal: 'development',
  'customer-sample': 'customer_sample',
  'customer-colorcard': 'customer_sample',
};

/** 无立案来源（null / 空串 / 认识不了的值）默认 development —— 与既有面料侧行为逐字一致 */
export const ASSET_SOURCE_DEFAULT = 'development';

/** Historical request labels recorded by full-business-sim/developmentDriver.ts.
 * Display only: these aliases do not extend legal form values or conversion rules. */
const DEV_REQUEST_SOURCE_LABELS: Record<string, string> = {
  'customer-request': '客户要求开发',
  'internal-request': '内部发起开发',
};

/** 展示文案：已知历史来源按业务含义显示，其余未知值原样回显。 */
export function devSourceLabel(source: string | null | undefined): string | null {
  const key = String(source ?? '').trim();
  if (!key) return null;
  return (DEV_SOURCE_LABELS as Record<string, string>)[key] ?? DEV_REQUEST_SOURCE_LABELS[key] ?? key;
}

/** 两条链共用：开发案 → 产品档案来源。**未知值不猜**（落默认值，与改动前面料侧同行为） */
export function assetSourceFromDevCase(source: unknown): string {
  const key = String(source ?? '').trim();
  return (DEV_SOURCE_TO_ASSET_SOURCE as Record<string, string>)[key] ?? ASSET_SOURCE_DEFAULT;
}

/**
 * 「这个 ProductAsset.source 是开发转档产出的吗」—— 给**档案详情里那个跳转开发案链接**用。
 *
 * ★ 为什么必须和映射表同源（R4-T4 复核抓到的一处静默功能丢失）：
 *   `components/ProductsManager.tsx` 的跳转链接此前只认 `source === 'development'`，
 *   而 G-5 让成衣案带上来源后，转档产出的值是 `customer_sample` ⇒ **点进详情的"跳转到开发案"会静默变回纯文本**。
 *   面料侧其实早就有同一个洞（客户来样转档产出的档案也一样）。
 *   规则只有一处：映射表**值域之内** + 默认值 = 开发转档可能产出的那批值。
 */
export const DEV_CONVERTED_ASSET_SOURCES: ReadonlySet<string> = new Set([
  ASSET_SOURCE_DEFAULT,
  ...Object.values(DEV_SOURCE_TO_ASSET_SOURCE),
]);

export function isDevConvertedAssetSource(source: string | null | undefined): boolean {
  return DEV_CONVERTED_ASSET_SOURCES.has(String(source ?? '').trim());
}
