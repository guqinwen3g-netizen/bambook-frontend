# ProductionPipeline 组件规格 · 10 阶段门禁可视化管线

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `ProductionPipeline` |
| 定位 | 大货生产 10 阶段门禁引擎的可视化面板——给定 `orderId`,自取 10 阶段管线 + 裁剪前检查清单 + 验货报告 + 外协进度,渲染阶段进度/门禁标识/当前态高亮,并提供阶段推进、双签、检查清单、验货录入交互。是订单详情页的生产执行出口 |
| 文件路径 | `components/ProductionPipeline.tsx`(556 行) |
| 消费方 | `OrderManager.tsx`(`<div id="order-detail-pipeline"><ProductionPipeline orderId isDarkMode /></div>`) |
| 范式 | 自取数据 + 可写型——`orderId` 由父注入;内部 `useEffect` 自取管线全量数据;`handleAdvance / handleChecklistToggle / handleInspectionSave / signStage` 直接调用 productionService 写回 |
| 优先级 | P0(大货生产核心门禁引擎 + Phase B4 终期验货 + 阶段 D / D5 外协) |
| 实现状态 | ✅ 已落地(10 阶段进度 + 3 道门禁[⑥ 裁剪前检查 / ⑦ 产前样双签 / ⑩ 验货发货]+ 外协只读 + 中期/终期双验货报告 + AQL/三级疵点 + 合格率/不合格率实时计算 + 事件广播);⚠️ 阶段进度为纵向列表(非横向管线),门禁标识通过门禁子区块呈现(非阶段行内徽章) |
| PRD 关联 | PRD §7.1(大货生产 10 阶段门禁)/ §7.2(裁剪前检查四项门禁)/ §7.3(产前样双签)/ §7.4(终期验货 AQL)/ §19.8(生产跟单看板) |
| 代码关联 | [ProductionPipeline.tsx](../../components/ProductionPipeline.tsx) / [productionService.ts](../../services/productionService.ts) `getPipeline / advanceStage / saveChecklist / saveInspection / signStage` / [stageService.ts](../../server/src/production/stageService.ts) `PRODUCTION_STAGES / advanceStage / savePreCutChecklist / saveInspectionReport / signStage` / [production/route.ts](../../server/src/production/route.ts) / [SidePanelContainer.tsx](../../components/ui/SidePanelContainer.tsx) / [OrderSectionHeader.tsx](../../components/order/OrderSectionHeader.tsx) `iconKey="pipeline"` / [orderUiSpec.ts](../../components/order/orderUiSpec.ts) `panelClass / insetSurface / field / btnBase / btnGhost / toggleShell / bannerDanger / emptyText` / [rdlBusinessStatusTokens.ts](../../components/rdlBusinessStatusTokens.ts) `statusSemanticClass / statusSemanticText` / [ToggleSwitch.tsx](../../components/ui/ToggleSwitch.tsx) / [CapsuleDateInput.tsx](../../components/ui/CapsuleDateInput.tsx) / [audit/routeAudit.ts](../../server/src/audit/routeAudit.ts) `writeRouteAuditLog` / [events/businessEventBus.ts](../../server/src/events/businessEventBus.ts) `publishBusinessEvent` |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架(Props 接口 + 内部结构)

```ts
interface ProductionPipelineProps {
  orderId: string;
  isDarkMode?: boolean;
}

export const ProductionPipeline: React.FC<ProductionPipelineProps> = ({ orderId, isDarkMode = false }) => {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [checklist, setChecklist] = useState<PreCutChecklist | null>(null);
  const [inspections, setInspections] = useState<InspectionReport[]>([]);
  const [outsourcing, setOutsourcing] = useState<OutsourcingProgress[]>([]);
  const [inspType, setInspType] = useState<'final' | 'midline'>('final');
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ...
};
```

### 渲染结构

```
<SidePanelContainer materialRole="raisedCard" edgeFadeItem spotlight>
  ├─ OrderSectionHeader(iconKey="pipeline", kicker="Production Pipeline", title="生产管线", meta=`${doneCount}/${stages.length} 阶段已完成`)
  ├─ error → bannerDanger「{error}」
  └─ flex.flex-col.gap-3.5
      ├─ ① 10-stage progress(insetSurface 子卡)
      │   └─ per stage: 图标(CheckCircle2 done / Circle current / Circle pending)+ 序号+标签 + doneAt + 推进按钮(仅 canAdvance)
      ├─ ② 外协加工进度(insetSurface 子卡,只读)
      │   └─ per OutsourcingOrder: 单号·工厂·工序 + 数量·验收·交期 + 状态 chip
      ├─ ③ 产前样双签确认(insetSurface 子卡,仅 pp_sample_approved 阶段存在时渲染)
      │   └─ 生产部签字 / 业务部签字 双按钮(grid-cols-2)
      ├─ ④ 裁剪前检查四项门禁(insetSurface 子卡,仅 pre_cut_checked 阶段存在时渲染)
      │   └─ 推码确认 / 耗料确认 / 样板确认 / 产前会议 四 ToggleSwitch
      └─ ⑤ 验货报告(insetSurface 子卡,仅 qc_shipped 阶段存在时渲染)
          ├─ 终期/中期 tab 切换
          ├─ 验货日期 / 验货方 / AQL / 结论 / 批量抽样 / 三级疵点 / 总检验件数 / 合格件数(grid-cols-2)
          ├─ 疵点描述
          └─ 合格率/不合格率实时计算 + 业务部批准发货 Toggle(仅终期)
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `orderId` | `string` | 是 | — | 订单 id;管线数据全量锚点。订单须存在且未软删,否则 `getPipeline` 抛 ORDER_NOT_FOUND |
| `isDarkMode` | `boolean` | 否 | `false` | 主题标志;传给 SidePanelContainer / OrderSectionHeader / orderUiSpec / statusSemanticClass |

> **极简 Props**:ProductionPipeline 仅需 `orderId` 即可自取全部管线数据(10 阶段 + 检查清单 + 验货报告 + 外协)。所有写操作(推进/双签/检查清单/验货)内部闭环,不向父组件冒泡事件——父组件(OrderManager)仅作为容器。

---

## §4 10 阶段定义与门禁规则

### §4.1 PRODUCTION_STAGES 真源(`stageService.ts`)

```ts
export const PRODUCTION_STAGES = [
  { key: 'order_placed',        seq: 1,  label: '业务下单' },
  { key: 'materials_confirmed', seq: 2,  label: '面辅料确认' },
  { key: 'production_planned',  seq: 3,  label: '生产计划' },
  { key: 'in_production',       seq: 4,  label: '货期管理' },
  { key: 'materials_arrived',   seq: 5,  label: '面辅料到厂' },
  { key: 'pre_cut_checked',     seq: 6,  label: '裁剪前检查' },
  { key: 'pp_sample_approved',  seq: 7,  label: '产前样确认' },
  { key: 'manufacturing',       seq: 8,  label: '生产过程' },
  { key: 'final_review',        seq: 9,  label: '成品确认' },
  { key: 'qc_shipped',          seq: 10, label: '验货发货' },
] as const;
```

### §4.2 三道业务门禁

| 门禁 | 阶段 | 判据 | 错误码 |
|---|---|---|---|
| 裁剪前检查 | ⑥ `pre_cut_checked` | PreCutChecklist 四项全 true(推码/耗料/样板/产前会议) | `PRECUT_CHECKLIST_INCOMPLETE` |
| 产前样双签 | ⑦ `pp_sample_approved` | 生产部 + 业务部各签一次(`signedByProduction` + `signedByBusiness`) | `PP_SAMPLE_NOT_SIGNED` |
| 验货发货 | ⑩ `qc_shipped` | 终期验货(final)报告存在 + result≠fail + criticalDefects=0 + passRate≥90% + defectRate≤3% + 业务部批准 | `INSPECTION_NOT_QUALIFIED` / `BUSINESS_APPROVAL_REQUIRED` |

### §4.3 阶段推进通用约束

- **顺序门禁**:`advanceStage` 校验所有前序阶段 `status === 'done'`,否则 `STAGE_NOT_SEQUENTIAL`
- **不可重复推进**:`stage.status === 'done'` 时拒绝(`STAGE_NOT_SEQUENTIAL`)
- **订单存在性**:`order.deletedAt === null`,否则 `ORDER_NOT_FOUND`
- **阶段初始化**:`initProductionStages` 幂等 upsert 10 阶段,seq=1 默认 done(业务下单随订单创建完成),其余 pending

### §4.4 StageGateErrorCode 全集

```ts
export type StageGateErrorCode =
  | 'ORDER_NOT_FOUND'
  | 'INVALID_STAGE'            // stageKey 不在 PRODUCTION_STAGES
  | 'STAGE_NOT_SEQUENTIAL'     // 前序未完成 / 已 done
  | 'PRECUT_CHECKLIST_INCOMPLETE'
  | 'PP_SAMPLE_NOT_SIGNED'
  | 'INSPECTION_NOT_QUALIFIED'
  | 'BUSINESS_APPROVAL_REQUIRED'
  | 'STAGE_UPDATE_FAILED';     // 兜底
```

---

## §5 内部状态管理

| 类别 | 字段 | 数据源 | 用途 |
|---|---|---|---|
| 阶段列表 | `stages` | `productionService.getPipeline(orderId).stages` | 10 阶段进度渲染 |
| 检查清单 | `checklist` | `getPipeline.checklist` | 裁剪前检查四项门禁 |
| 验货报告 | `inspections` | `getPipeline.inspections`(全部类型) | 中期/终期双报告 |
| 外协进度 | `outsourcing` | `getPipeline.outsourcing` | 外协只读区块 |
| 验货类型 | `inspType` | 内部 state(`final`/`midline`) | 验货报告 tab 切换 |
| 加载态 | `loading` | 内部 state | 全屏 Loader2 |
| 推进中 | `advancing` | 内部 state(stageKey 或 null) | 推进按钮 disabled + spin |
| 错误 | `error` | 内部 state | bannerDanger |

### useEffect 数据拉取

```ts
const fetchPipeline = useCallback(async () => {
  try {
    const data = await productionService.getPipeline(orderId);
    setStages(data.stages);
    setChecklist(data.checklist);
    setInspections(data.inspections?.length > 0 ? data.inspections : (data.inspection ? [data.inspection] : []));
    setOutsourcing(data.outsourcing ?? []);
  } catch { /* ignore */ }
  setLoading(false);
}, [orderId]);

useEffect(() => { fetchPipeline(); }, [fetchPipeline]);
```

**容错**:`inspections` 兼容新旧字段(`inspections` 数组优先,回退 `inspection` 单对象);拉取失败静默(ignore),不阻塞面板渲染。

---

## §6 阶段状态判定与当前态高亮

### §6.1 三态判定

```ts
stages.map((stage, idx) => {
  const isDone = stage.status === 'done';
  const isCurrent = !isDone && stages.slice(0, idx).every(s => s.status === 'done');
  const canAdvance = isCurrent;  // 仅当前阶段可推进
  // ...
});
```

| 状态 | 判定 | 图标 | 文字色 |
|---|---|---|---|
| 已完成 | `status === 'done'` | `CheckCircle2 size=16` + `successText`(statusSemanticText success) | textPrimary |
| 当前阶段 | `!isDone && 前序全 done` | `Circle size=16` + `accentText`(`text-[var(--os-vnext-brand-blue)]` 品牌蓝锚点) | textPrimary |
| 待解锁 | `!isDone && 前序非全 done` | `Circle size=16` + `spec.textFaint` | textSecondary |

### §6.2 推进按钮

仅 `canAdvance`(当前阶段)渲染推进按钮:

```tsx
{canAdvance && (
  <button
    onClick={() => handleAdvance(stage.stageKey)}
    disabled={advancing === stage.stageKey}
    className={cx(spec.btnBase, spec.btnGhost, advancing === stage.stageKey && 'opacity-50')}
  >
    {advancing === stage.stageKey ? <Loader2 size=12 className="animate-spin" /> : <ChevronRight size={12} />}
    推进
  </button>
)}
```

### §6.3 阶段标签与完成时间

```tsx
<span className={cx('text-xs font-light', isDone || isCurrent ? textPrimary : textSecondary)}>
  {stage.stageSeq}. {STAGE_LABELS[stage.stageKey] || stage.stageKey}
</span>
{stage.doneAt && (
  <span className={cx('ml-2 text-[10px]', textSecondary)}>{formatYmd(stage.doneAt)}</span>
)}
```

`STAGE_LABELS` 前端镜像(与 `stageService.ts` PRODUCTION_STAGES 同步),兜底显示原始 stageKey。

---

## §7 四态规范

| 状态 | 触发条件 | 视觉 | 文案 |
|---|---|---|---|
| 加载中 | `loading === true` | SidePanelContainer + `Loader2 size=14 animate-spin` + emptyText | 「加载生产管线...」 |
| 错误 | `error !== null` | `bannerDanger`(mb-3) | 「{error}」(如「阶段推进失败」「签字失败」) |
| 推进中 | `advancing === stageKey` | 推进按钮 `Loader2 spin` + `opacity-50` + disabled | — |
| 门禁子区块 | 对应阶段存在时渲染 | insetSurface 子卡 | 裁剪前检查/产前样双签/验货报告 |
| 外协空 | `outsourcing.length === 0` | emptyText | 「无外协加工」 |

---

## §8 联动(门禁子区块 + 事件广播)

### §8.1 裁剪前检查(⑥ pre_cut_checked)

四项 ToggleSwitch,乐观更新 + 后端 upsert:

```ts
const handleChecklistToggle = async (field: keyof PreCutChecklist) => {
  // 后端仅返回已存在的 checklist 行;新订单为 null。以全 false 基底乐观更新,
  // 让后端 upsert 建行,否则新订单的四项门禁开关永远失效(无法初始化)。
  const base: PreCutChecklist = checklist ?? { orderId, gradingConfirmed: false, ... };
  const updated = { ...base, [field]: !base[field] };
  setChecklist(updated);  // 乐观更新
  try {
    const saved = await productionService.saveChecklist(orderId, { [field]: updated[field] });
    setChecklist(saved);  // 服务端权威值回填
  } catch { /* ignore */ }
};
```

**新订单初始化铁律**:checklist 为 null 时以全 false 基底乐观更新,触发后端 upsert 建行——否则新订单四项门禁开关永远失效。

### §8.2 产前样双签(⑦ pp_sample_approved)

生产部/业务部各签一次,签字后按钮变 success chip:

```tsx
<button onClick={async () => {
  const updated = await productionService.signStage(orderId, 'pp_sample_approved', 'production');
  setStages(prev => prev.map(s => s.id === updated.id ? updated : s));
}} className={cx(spec.btnBase, ppStage.signedByProduction ? signedChipCls : spec.btnGhost)}>
  {ppStage.signedByProduction ? <CheckCircle2 size=12} : <Circle size=12 />}
  生产部 {ppStage.signedByProduction ? '已签' : '签字'}
</button>
```

### §8.3 验货报告(⑩ qc_shipped)

中期/终期双报告 tab 切换,字段级即时保存:

```ts
const handleInspectionSave = async (field: string, value: any) => {
  try {
    const report = await productionService.saveInspection(orderId, { inspectionType: inspType, [field]: value });
    setInspections(prev => { /* upsert by inspectionType */ });
  } catch { /* ignore */ }
};
```

**门禁判据实时计算**(前端镜像后端阈值):
- 合格率 `passRate = passedUnits / totalUnits`,阈值 ≥90%
- 不合格率 `defectRate = (total - passed) / total`,阈值 ≤3%
- 致命疵点 `criticalDefects`,零容忍(=0)

```tsx
<span>合格率: <span className={inspection.passRate >= 0.9 ? successText : dangerText}>
  {(inspection.passRate * 100).toFixed(1)}%
</span></span>
```

### §8.4 后端事件广播

`advanceStage` 事务提交后 fire-and-forget 发布业务事件:
- `ProductionStageAdvanced`——每次阶段完成都发布
- `ProductionCompleted`——`qc_shipped`(第 10 阶段)完成时发布,用于 Phase 1 Sprint 3 触发自动创建发货单联动

事件发布失败不影响业务(catch 静默)。

---

## §9 状态机

```
组件 mount / orderId 变化
  ↓
  setLoading(true)
  ↓
  productionService.getPipeline(orderId)
  ↓
  ├─ 成功 → setStages/checklist/inspections/outsourcing → 渲染
  └─ 失败 → ignore(静默,不阻塞)
  ↓
  setLoading(false)

用户点「推进」(canAdvance 阶段)
  ↓
  setAdvancing(stageKey)
  ↓
  productionService.advanceStage(orderId, stageKey)
  ↓
  ├─ 成功 → setStages(prev.map 替换该 stage) → 后端发 ProductionStageAdvanced 事件
  ├─ 门禁失败 → setError(message)(如「裁剪前检查未完成:推码确认、耗料确认」)
  └─ setAdvancing(null)

用户切换 Toggle(裁剪前检查)
  ↓
  乐观 setChecklist(updated)
  ↓
  productionService.saveChecklist(orderId, {[field]: value})
  ↓
  ├─ 成功 → setChecklist(saved) 权威回填
  └─ 失败 → ignore(乐观值保留,不回滚——容忍弱一致)

用户签字(产前样双签)
  ↓
  productionService.signStage(orderId, stageKey, signType)
  ↓
  ├─ 成功 → setStages(prev.map 替换)
  └─ 失败 → setError(message)

用户录入验货字段
  ↓
  productionService.saveInspection(orderId, {inspectionType, [field]: value})
  ↓
  ├─ 成功 → setInspections(upsert by inspectionType)
  │        → 若终期 fail 迁移 → 后端广播 critical 通知(QC+业务员+管理层)
  └─ 失败 → ignore
```

---

## §10 数据模型

### §10.1 PipelineStage(前端接口)

```ts
interface PipelineStage {
  id: string;
  stageKey: string;        // PRODUCTION_STAGES.key
  stageSeq: number;        // 1-10
  status: string;          // 'done' | 'pending' | 'blocked'
  note?: string | null;
  operator?: string | null;
  doneAt?: number | null;
  signedByProduction?: string | null;   // ⑦ 产前样生产部签字人
  signedByBusiness?: string | null;     // ⑦ 产前样业务部签字人
  signedAtProduction?: number | null;
  signedAtBusiness?: number | null;
}
```

### §10.2 PreCutChecklist(⑥ 门禁)

```ts
interface PreCutChecklist {
  orderId: string;
  gradingConfirmed: boolean;        // 推码确认
  consumptionConfirmed: boolean;    // 耗料确认
  patternConfirmed: boolean;        // 样板确认
  preProductionMeeting: boolean;    // 产前会议
  meetingNote?: string | null;
}
```

### §10.3 InspectionReport(⑩ 门禁)

```ts
interface InspectionReport {
  orderId: string;
  inspectionType?: string | null;   // 'midline' | 'final'(缺省 final)
  totalUnits: number;
  passedUnits: number;
  passRate: number;                 // 前端计算: passed/total
  defectRate: number;               // 前端计算: (total-passed)/total
  approvedByBusiness: boolean;      // 业务部批准发货(仅终期)
  inspectedBy?: string | null;
  inspectionDate?: string | null;
  inspectorOrg?: string | null;     // 自有 QC / SGS / BV / 客户验货员
  aqlLevel?: string | null;         // 如 2.5/4.0 II
  lotSize?: number | null;          // 批量
  sampleSize?: number | null;       // 抽样数
  criticalDefects?: number | null;  // 致命疵点(零容忍)
  majorDefects?: number | null;     // 主要疵点
  minorDefects?: number | null;     // 次要疵点
  defectSummary?: string | null;
  result?: string | null;           // 'pass' | 'conditional' | 'fail'
}
```

### §10.4 OutsourcingProgress(外协只读)

```ts
interface OutsourcingProgress {
  id: string;
  orderNumber: string;
  supplierId: string | null;
  supplierName: string | null;      // 后端 join Relation.name
  processType: string;              // Sewing/Cutting/Washing/Printing/Embroidery/Dyeing/Other
  status: string;                   // Draft/Sent/Confirmed/InProduction/Received/Cancelled
  quantity: number;
  unit: string;
  plannedDeliveryDate?: string | null;
  actualDeliveryDate?: string | null;
  qualityAcceptedQty?: number | null;
  qualityRejectedQty?: number | null;
}
```

---

## §11 API 端点清单

| 端点 | 方法 | 用途 | 调用方 |
|---|---|---|---|
| `/v1/production/:orderId` | GET | 管线全量数据(stages + checklist + inspections + outsourcing) | `productionService.getPipeline` |
| `/v1/production/:orderId/advance/:stageKey` | POST | 阶段推进(门禁校验 + 审计 + 事件广播) | `productionService.advanceStage` |
| `/v1/production/:orderId/checklist` | POST | 裁剪前检查清单 upsert | `productionService.saveChecklist` |
| `/v1/production/:orderId/inspection` | POST | 验货报告 upsert(含 fail 通知 + 自动评分) | `productionService.saveInspection` |
| `/v1/production/:orderId/sign/:stageKey` | POST | 产前样双签(production/business) | `productionService.signStage` |

**响应约定**:所有端点返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`;前端 `data?.error?.message || data?.error?.code || HTTP {status}` 兜底。

**审计**:每次 `advanceStage` 事务内调用 `writeRouteAuditLog`(`operation: advance_production_stage`,`targetType: ProductionStage`,`before/after: status`)。

---

## §12 权限与可见性

| 角色 | 可见 ProductionPipeline | 可推进阶段 | 可签字 | 可录入验货 |
|---|---|---|---|---|
| owner / admin | ✅ | ✅ | ✅ | ✅ |
| manager | ✅ | ✅ | ✅ | ✅ |
| merchandiser(跟单) | ✅ | ✅ | ✅(生产部/业务部签字不区分角色,前端开放) | ✅ |
| sales(业务) | ✅ | ⚠️ 视业务约定 | ✅ | ✅ |
| finance / logistics | ⚠️ 视订单读权限 | ❌ | ❌ | ❌ |

> **铁律**:ProductionPipeline 嵌入订单详情页,需 `orders:read` scope。阶段推进/签字/验货写入由后端 `production/route.ts` 做角色门禁(与订单模块 guard 一致)。门禁失败返回结构化错误码(`PRECUT_CHECKLIST_INCOMPLETE` 等),前端 `setError(message)` 展示。
>
> **签字角色未细分**:当前 `signStage` 不区分签字人角色(`signType` 仅区分 production/business 两个签字槽位),任何有写权限的角色均可签。未来若需角色细分(如生产部签字须 merchandiser/manager 角色),应在后端 `signStage` 增加 actorRoles 校验。

---

## §13 设计系统约束(BDS)

- **主容器**:`SidePanelContainer materialRole="raisedCard" edgeFadeItem spotlight`——与详情页所有面板同构
- **面板配方**:`createOrderUiSpec(isDarkMode)` 一次求值,取 `panelClass` / `panelContentClass` / `insetSurface` / `field` / `fieldNoSpinner` / `btnBase` / `btnGhost` / `btnActive` / `toggleShell` / `bannerDanger` / `emptyText` / `subGroupTitle` / `chevronColor`
- **分区头**:`OrderSectionHeader iconKey="pipeline" kicker="Production Pipeline"`——图标取 `ORDER_SECTION_ICONS.pipeline`(Factory 图标),meta=`${doneCount}/${stages.length} 阶段已完成`
- **阶段进度子卡**:`rounded-inset border p-4 ${spec.insetSurface}`——内嵌二级玻璃面板
- **阶段图标**:`CheckCircle2`(done, success 语义)/ `Circle`(current, accent 品牌蓝)/ `Circle`(pending, textFaint),size=16
- **状态色唯一来源**:`statusSemanticText('success'/'danger', isDarkMode)` 中性 opacity;当前态锚点用 `accentText = 'text-[var(--os-vnext-brand-blue)]'` 品牌蓝;`signedChipCls = statusSemanticClass('success', isDarkMode)` 已签 chip
- **外协状态 chip**:`statusSemanticClass('success'/'neutral'/'active', isDarkMode)` 三态(Received/Cancelled/其他)
- **推进按钮**:`spec.btnBase + spec.btnGhost`,推进中 `opacity-50` + Loader2
- **签字按钮**:未签 `btnGhost`,已签 `signedChipCls`(success chip)
- **验货 tab 切换**:`spec.btnBase + (选中 ? spec.btnActive : spec.btnGhost)`
- **字段输入**:`spec.field + spec.fieldNoSpinner`(recessedField 雕刻质感 + 去 number spinner)
- **Toggle**:`spec.toggleShell + ToggleSwitch`(boolean 字段 h-10 胶囊,与 recessedField 同源)
- **合格率/不合格率色**:`successText`(达标)/ `dangerText`(超标)实时切换
- **字重**:仅 font-extralight / font-light / font-normal,禁 medium+
- **防回退**:`scripts/check-design-tokens.sh` 扫描硬编码

---

## §14 待补设计缺口

| 编号 | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-PP1 | **阶段进度为纵向列表,非横向管线**——PRD 描述为「10 阶段横向管线」,当前实现为纵向 CheckCircle2 列表 | 横向管线视觉语义缺失,阶段间连接关系不直观 | P2 |
| GAP-PP2 | **门禁标识未在阶段行内呈现**——门禁通过子区块(裁剪前检查/双签/验货)呈现,阶段行无门禁徽章 | 用户无法一眼看出哪些阶段有门禁、门禁是否满足 | P2 |
| GAP-PP3 | **签字角色未细分**——任何写权限角色均可签生产部/业务部签字槽位 | 签字责任归属不严格 | P2 |
| GAP-PP4 | **checklist/验货写入失败静默 ignore**——乐观值保留不回滚,容忍弱一致 | 网络异常时 UI 与后端不一致,用户无感知 | P3 |
| GAP-PP5 | **无「门禁未满足」前置提示**——用户点推进才报错,无提前预警 | 门禁未满足时用户需试错才知道缺什么 | P3 |
| GAP-PP6 | **验货报告无附件上传**——`reportFile` 字段后端存在,前端无上传入口 | 验货报告 PDF/图片无法在面板内上传 | P3 |
| GAP-PP7 | **阶段无 `blocked` 态可视化**——后端支持 `status: 'blocked'`,前端仅判 done/pending | 阻塞阶段无区分标识 | P3 |

---

## §15 相关文档索引

- [../00-索引.md](../00-索引.md) — 设计文档真源总索引
- [DetailPanel.md](./DetailPanel.md) — Relations 详情主面板(同属详情页通用面板族)
- [RelatedEntitiesPanel.md](./RelatedEntitiesPanel.md) — EntityLink 跨模块关联面板(订单详情页同面板族)
- [AuditHistorySection.md](./AuditHistorySection.md) — 审计 diff 展开面板(阶段推进审计的消费方)
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板容器(本组件底层材质)
- [BDS组件族7规格.md](./BDS组件族7规格.md) — CompiledSurfacePanel / SidePanelContainer 原语规格
- [../../components/ProductionPipeline.tsx](../../components/ProductionPipeline.tsx) — 组件源码
- [../../server/src/production/stageService.ts](../../server/src/production/stageService.ts) — 10 阶段定义 + 门禁引擎真源(PRODUCTION_STAGES / advanceStage)

---

## §16 补充说明

1. **10 阶段真源单一**:`PRODUCTION_STAGES` 定义在 `stageService.ts`,前端 `STAGE_LABELS` 是其镜像。`ProductionBoard.tsx`(看板)亦用同一中文标签集——三处保持同步,新增/调整阶段须同步改 stageService + 前端镜像
2. **三道门禁是业务铁律**:⑥ 裁剪前检查四项全 true / ⑦ 产前样双签 / ⑩ 验货 passRate≥90% + defectRate≤3% + criticalDefects=0 + 业务部批准。门禁校验在后端 `advanceStage` 事务内执行,前端无法绕过——前端阈值计算仅用于实时提示,后端为权威判据
3. **新订单 checklist 初始化铁律**:后端仅返回已存在的 checklist 行,新订单为 null。前端 `handleChecklistToggle` 以全 false 基底乐观更新,触发后端 upsert 建行——否则新订单四项门禁开关永远失效(无法初始化)。这是兼容后端「不主动建行」设计的必要前端补偿
4. **验货 fail 通知链**:`saveInspectionReport` 检测终期验货结论从非 fail 迁移到 fail 瞬间,广播 critical 通知(QC + 业务员 + 管理层)。状态迁移触发天然幂等——重复保存相同 fail 结论不再通知;整改后再次 fail 属新事件重新通知。同时 H1c 自动追加供应商质量评分(幂等:同报告只评一次)
5. **事件广播 fire-and-forget**:`advanceStage` 事务提交后 `publishBusinessEvent` 发布 `ProductionStageAdvanced`(每次)/ `ProductionCompleted`(qc_shipped)。事件发布失败 catch 静默——业务成功优先,事件丢失不回滚业务。`ProductionCompleted` 用于 Phase 1 Sprint 3 触发自动创建发货单联动
6. **当前态高亮用 accent 品牌蓝**:`isCurrent` 阶段的 Circle 图标用 `text-[var(--os-vnext-brand-blue)]` 品牌蓝锚点,与 RDL 中性契约一致——accent 蓝仅用于品牌锚点(当前态/主按钮/hover),不用于状态语义(success/danger 走 statusSemanticClass 中性 opacity)
7. **外协区块只读**:外协进度(OutsourcingOrder)在本面板为只读展示,管理入口在 MES 可选模块。后端 `getProductionPipeline` 直接查表 OutsourcingOrder + join Relation.name 解析供应商名——production 不反向依赖 mes 服务,保持模块边界
8. **纵向列表 vs 横向管线**:当前实现为纵向 CheckCircle2 列表(GAP-PP1),PRD 描述为「10 阶段横向管线」。横向管线需考虑 10 阶段在窄屏的换行/滚动,当前纵向列表在详情页侧栏可读性更优——视觉语义补全(横向 + 连接线)列为 P2 待补
