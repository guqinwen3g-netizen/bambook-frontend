# ImportWizard 组件规格 · 三步订单导入向导

> ## ⛔ 2026-09-25 下线（Kevin 拍板）—— 本页描述的功能**当前不在产品里**
>
> PDF 导入订单功能已下线：前端两处入口按钮与 `<ImportWizard …/>` 渲染块已从
> `components/OrderManager.tsx` 撤除；后端 `/api/v1/import` 已不再挂载（`server/src/index.ts`）
> ⇒ `POST /api/v1/import/order` 返回 404。
>
> **本页保留为"设计存档"**（组件本体未删，可一键恢复：见 index.ts 挂载点原位注释）。
> 阅读时请把全篇视为**历史设计**，不要当作现状；恢复后再把本横幅撤掉。
> 防回挂守卫：`server/src/__tests__/erpCrossModuleSmoke.test.ts` 的 Import 一条（方向＝"必须不挂载"）、
> `components/OrderManager.glass.test.tsx` 的 add-modal 一条（方向＝"不得有导入按钮"）。

## §1 元信息

| 项 | 值 |
|---|---|
| 组件名 | `ImportWizard` |
| 定位 | 订单批量导入向导——三步流（选择 PDF → 预览/修正 → 确认入库），调用后端 `uploadPdfsForParsing` 上传 PDF 自动解析客户/订单结构，允许用户在预览态修正解析结果后批量入库；不直接写库，由父级 `OrderManager.onConfirm` 调用 `saveParsedOrders` 持久化 |
| 文件路径 | `components/import/ImportWizard.tsx`（287 行）+ 子组件 `StepUpload.tsx`（180 行）/ `StepPreview.tsx`（293 行）/ `StepConfirm.tsx`（110 行） |
| 消费方 | `components/OrderManager.tsx`（订单列表页"导入"按钮 + 订单新建弹窗"从 PDF 导入"按钮 → 第 1006 行挂载） |
| 范式 | 模态对话框 + 三步状态机——内部维护 `step` / `files` / `results` / `isParsing` / `parseError` 五个 state；ESC 关闭；关闭时重置全部 state |
| 优先级 | P1（订单批量录入核心入口，替代手工逐字段录入） |
| 实现状态 | ✅ 已落地（三步流 + 拖拽上传 + PDF 解析 + 预览修正 + 确认入库 + 解析失败兜底）；⚠️ 当前仅支持 PDF 格式，不支持 Excel/CSV；⚠️ 字段映射固定不可配置 |
| PRD 关联 | PRD §3.1（订单录入流程）/ §5.2（PDF 自动解析与字段映射）/ §8.3（导入权限） |
| 代码关联 | [ImportWizard.tsx](../../components/import/ImportWizard.tsx) / [StepUpload.tsx](../../components/import/StepUpload.tsx) / [StepPreview.tsx](../../components/import/StepPreview.tsx) / [StepConfirm.tsx](../../components/import/StepConfirm.tsx) / [importService.ts](../../services/importService.ts) `uploadPdfsForParsing` / [OrderManager.tsx](../../components/OrderManager.tsx)（消费方，第 1006 行）/ [types.ts](../../types.ts) `ParsedOrder`（第 1618 行）/ `ImportFileResult`（第 1641 行）/ `ImportResponse`（第 1649 行） |
| 文档版本 | v1.0 |
| 最后更新 | 2026-08-15 |

---

## §2 组件骨架（Props 接口 + 渲染结构）

```ts
interface Props {
  /** 是否打开 */
  isOpen: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /**
   * 用户在最后一步点击"完成"时触发。
   * `orders` 仅包含解析成功且可能被用户修正过的订单。
   * 持久化（DB 写入）有意不在此处进行——由父级决定落库时机。
   */
  onConfirm: (orders: ParsedOrder[]) => void;
  isDarkMode: boolean;
  /** 可选 API Key，仅服务端 BAMBOOK_REQUIRE_AUTH=true 时需要 */
  apiKey?: string;
}

type Step = 1 | 2 | 3;

const ImportWizard: React.FC<Props> = ({ isOpen, onClose, onConfirm, isDarkMode, apiKey }) => {
  const [step, setStep] = useState<Step>(1);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [results, setResults] = useState<ImportFileResult[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // 关闭时重置全部 state
  useEffect(() => { if (!isOpen) { setStep(1); setFiles([]); setResults([]); setParseError(null); setIsParsing(false); } }, [isOpen]);

  // ESC 关闭
  useEffect(() => { /* keydown Escape → onClose */ }, [isOpen, onClose]);

  const goNext = async () => { /* §5.1 三步流转 */ };
  const goBack = () => { /* §5.2 回退 */ };
  const canNext = (() => { /* §5.3 门禁 */ })();
  const nextLabel = step === 1 ? (isParsing ? '解析中…' : '上传并解析') : step === 2 ? '继续' : '完成';

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div className="overlay" onClick={onClose}>
        <motion.div className="dialog" onClick={stopPropagation}>
          {/* Header */}
          <header>标题 + 关闭按钮</header>
          {/* Step indicator */}
          <StepIndicator step={step} />
          {/* Body */}
          <body>
            {parseError && <ErrorBanner />}
            {step === 1 && <StepUpload files={files} onFilesChange={setFiles} isParsing={isParsing} />}
            {step === 2 && <StepPreview results={results} onResultsChange={setResults} />}
            {step === 3 && <StepConfirm results={results} />}
          </body>
          {/* Footer */}
          <footer>
            <button onClick={goBack} disabled={step === 1}>上一步</button>
            <button onClick={onClose}>关闭</button>
            <button onClick={goNext} disabled={!canNext}>{nextLabel}</button>
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
```

### 渲染结构

```
<motion.div overlay z-[60] bg-black/70 backdrop-blur-sm>  ← 遮罩层
  <motion.div dialog max-w-5xl max-h-[88vh] rounded-floating bg-card>  ← 对话框
    ├─ <header px-6 py-4 border-b>
    │   ├─ 图标徽章（Upload icon + accent 底色）
    │   ├─ 标题"批量导入订单" + 副标题"上传 PDF → 自动识别客户 → 预览并修正 → 完成"
    │   └─ 关闭按钮（X icon，圆形 hover）
    ├─ <StepIndicator px-6 py-3 border-b bg-recessed>
    │   ├─ StepDot n=1 "选择文件" active={step>=1} current={step===1} icon=<Upload>
    │   ├─ Connector active={step>=2}
    │   ├─ StepDot n=2 "预览 / 修正" active={step>=2} current={step===2} icon=<ScanLine>
    │   ├─ Connector active={step>=3}
    │   └─ StepDot n=3 "确认" active={step>=3} current={step===3} icon=<ShieldCheck>
    ├─ <body flex-1 overflow-y-auto px-6 py-5>
    │   ├─ {parseError && <ErrorBanner>}  ← 解析错误横幅
    │   ├─ {step===1 && <StepUpload>}
    │   ├─ {step===2 && <StepPreview>}
    │   └─ {step===3 && <StepConfirm>}
    └─ <footer px-6 py-4 border-t>
        ├─ <button goBack> 上一步（disabled when step===1 || isParsing）
        └─ <div flex gap-2>
            <button onClose> 关闭
            <button goNext disabled={!canNext}>  ← nextLabel 动态切换 + Loader2 旋转图标
          </div>
</motion.div>
```

---

## §3 Props 逐项说明

| Prop | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `isOpen` | `boolean` | 是 | — | 是否打开；false 时组件返回 null（不渲染 DOM） |
| `onClose` | `() => void` | 是 | — | 关闭回调；触发场景：点击遮罩 / 点击关闭按钮 / 按 ESC / 完成后自动关闭 |
| `onConfirm` | `(orders: ParsedOrder[]) => void` | 是 | — | 用户点击"完成"时触发；`orders` 仅包含 `r.order && !r.error` 的成功解析订单；持久化由父级决定 |
| `isDarkMode` | `boolean` | 是 | — | 深色模式标志，透传给子组件 |
| `apiKey` | `string` | 否 | `undefined` | 可选 API Key，仅服务端 `BAMBOOK_REQUIRE_AUTH=true` 时需要；透传给 `uploadPdfsForParsing` |

**渲染门禁**：`!isOpen` 时返回 null，不渲染任何 DOM（包括 AnimatePresence exit 动画——exit 动画在 `isOpen` 从 true → false 时触发，但组件已卸载，故实际无 exit 效果；这是已知限制）。

**数据所有权**：组件内部持有 `files` / `results` / `step` / `isParsing` / `parseError` 五个 state，关闭时全部重置；父级不感知中间状态，仅在 `onConfirm` 时接收最终结果。

---

## §4 三步流转详解

### §4.1 Step 1：选择文件（StepUpload）

**职责**：让用户拖拽或点击选择 PDF 文件，展示已选文件列表与解析状态。

**关键交互**：
- 拖拽上传：`onDragOver` / `onDragLeave` / `onDrop` 三事件；`dragOver` 状态切换 dropzone 视觉
- 点击选择：隐藏 `<input type="file" accept="application/pdf,.pdf" multiple>`，点击 dropzone 触发
- 文件过滤：`f.type === 'application/pdf' || /\.pdf$/i.test(f.name)`——仅接收 PDF
- 文件列表：每项展示文件名 + 大小 + 状态徽章（待处理/解析中/完成/失败）+ 删除按钮
- 全部清空：`clearAll` 一键清空（`isParsing` 时禁用）

**FileEntry 数据结构**：
```ts
export type FileStatus = 'pending' | 'parsing' | 'done' | 'error';
export interface FileEntry {
  id: string;        // `${Date.now()}-${i}-${f.name}`
  file: File;
  status: FileStatus;
  message?: string;  // 解析失败时的错误信息
}
```

### §4.2 Step 2：预览/修正（StepPreview）

**职责**：展示后端解析结果，允许用户修正字段；支持多文件 Tab 切换。

**关键交互**：
- Tab 切换：每个文件一个 Tab，展示文件名 + 客户识别 ID；点击切换 `activeIdx`
- 解析失败展示：`active.error || !active.order` 时展示 danger 横幅，提示"确认时该文件会被跳过"
- 解析成功展示：`OrderPreview` 组件，含：
  - **检测横幅**：客户识别 + 置信度 + 页数
  - **字段映射提示**：列出 PDF 字段 → Order schema 字段的映射关系
  - **订单抬头**：PO 号 / 季节 / PO 日期 / 联系人 / 联系电话 / 币种 / 交付条款 / 付款条款 / 合计（可编辑）
  - **收货/交付**：Ship-to / Deliver-to（只读）
  - **行项目表格**：物料 / Mill / 描述 / 数量 / 单价 / 小计 / 出厂-到港日期（可编辑）

**编辑回写**：
- `updateOrder(idx, patch)`：更新订单抬头字段
- `updateLine(idx, lineIdx, patch)`：更新行项目字段
- 两者都通过 `onResultsChange` 回写父级 `results` state

### §4.3 Step 3：确认（StepConfirm）

**职责**：展示导入摘要，让用户最终确认。

**摘要内容**：
- 文件数 / 可入库订单数 / 解析失败数（三列统计）
- 按币种汇总合计金额
- 逐文件状态列表（文件名 + PO 号 + 行数 / 错误信息）
- "预览模式"提示横幅：点击"完成"会把订单交还给上层，暂不直接写库（实际写库由父级 `onConfirm` 回调处理）

---

## §5 内部逻辑

### §5.1 goNext（下一步流转）

```ts
const goNext = async () => {
  if (step === 1) {
    // 步骤 1 → 2：上传并解析
    if (files.length === 0) return;
    setIsParsing(true);
    setParseError(null);
    setFiles(prev => prev.map(f => ({ ...f, status: 'parsing' })));
    try {
      const resp = await uploadPdfsForParsing(files.map(f => f.file), { apiKey });
      // 按文件名重排结果（服务端保留输入顺序，但防御性处理）
      const byName = new Map<string, ImportFileResult[]>();
      for (const r of resp.results) { /* 按 filename 聚合 */ }
      const ordered: ImportFileResult[] = [];
      const updated: FileEntry[] = files.map(f => {
        const r = byName.get(f.file.name)?.shift();
        if (r) {
          ordered.push(r);
          return { ...f, status: r.error || !r.order ? 'error' : 'done', message: r.error ?? undefined };
        }
        return { ...f, status: 'error', message: '服务端没有返回此文件的解析结果' };
      });
      setFiles(updated);
      setResults(ordered);
      setStep(2);
    } catch (e) {
      setParseError(String(e?.message ?? e));
      setFiles(prev => prev.map(f => ({ ...f, status: 'error' })));
    } finally {
      setIsParsing(false);
    }
    return;
  }
  if (step === 2) { setStep(3); return; }
  if (step === 3) {
    const ok = results.filter(r => r.order && !r.error).map(r => r.order!) as ParsedOrder[];
    onConfirm(ok);
    onClose();
  }
};
```

**关键点**：
- 步骤 1 → 2 是异步操作（上传 + 解析），期间 `isParsing=true`，按钮显示"解析中…"+ Loader2 旋转图标
- 解析失败时不前进，展示 `parseError` 横幅，所有文件状态置为 `error`
- 步骤 2 → 3 是同步操作，无门禁（即使所有文件都解析失败也允许前进，让用户在 Step 3 看到摘要）
- 步骤 3 → 完成：过滤出成功订单，调用 `onConfirm`，然后 `onClose` 关闭对话框

### §5.2 goBack（回退）

```ts
const goBack = () => {
  if (step === 1) return;
  setStep(s => (s - 1) as Step);
};
```

- 步骤 1 时不响应
- 步骤 2 → 1：保留 `files` 与 `results`，用户可重新上传或直接再点"上传并解析"
- 步骤 3 → 2：保留 `results`，用户可继续修正

### §5.3 canNext（下一步门禁）

```ts
const canNext = (() => {
  if (step === 1) return files.length > 0 && !isParsing;
  if (step === 2) return results.some(r => r.order && !r.error);
  return true;
})();
```

- 步骤 1：至少选了 1 个文件且未在解析中
- 步骤 2：至少有 1 个文件解析成功（`r.order && !r.error`）
- 步骤 3：无门禁（始终可完成）

### §5.4 重置与 ESC

```ts
useEffect(() => {
  if (!isOpen) {
    setStep(1); setFiles([]); setResults([]); setParseError(null); setIsParsing(false);
  }
}, [isOpen]);

useEffect(() => {
  if (!isOpen) return;
  const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [isOpen, onClose]);
```

- 关闭时全部 state 重置——下次打开是干净状态
- ESC 键监听仅在 `isOpen` 时挂载，关闭时卸载

---

## §6 子组件渲染规则

### §6.1 StepDot（步骤指示器圆点）

```tsx
<div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-light transition-all">
  {current ? 'bg-accent text-white' : active ? 'bg-accent/60 text-white' : 'ghost text-tertiary'}
</div>
<span>{label}</span>
```

- `current`（当前步）：accent 实心填充 + 白字
- `active`（已完成步）：accent 60% 半透明 + 白字 + 展示图标（而非数字）
- 默认（未到达步）：ghost 控件 + tertiary 文字 + 展示数字

### §6.2 Connector（连接线）

```tsx
<div className="flex-1 h-px transition-colors" />
```

- `active`：accent 60% 半透明
- 默认：recessed-bg-strong

### §6.3 StepUpload dropzone

- 默认态：`border-[rgba(100,116,139,0.50)] bg-[rgba(255,255,255,0.60)] text-tertiary`
- 拖拽态：`border-accent bg-accent/10 text-accent`
- **rgba 任意值绕开 flat-experimental 护栏**：拖拽区的虚线描边是核心视觉可供性，必须保持可见（flat-experimental 的 `border-white//border-slate/bg-white/ + rounded → border:0 !important` 会吞掉描边）

### §6.4 StepPreview OrderPreview

- 检测横幅：`bg-accent/10 border-accent/30` + ShieldCheck 图标 + 客户识别 + 置信度
- 字段映射提示：`bg-recessed border-default` + 列表说明 PDF 字段 → Order schema 字段映射
- 订单抬头卡：`rounded-card p-4` + 9 字段网格（`grid-cols-2 md:grid-cols-3`）
- 行项目表格：`overflow-x-auto` + 8 列（#/物料/Mill/描述/数量/单价/小计/出厂-到港）
- 输入框统一 `rounded-full h-10 px-4`（抬头）/ `px-3 py-1`（单元格）

### §6.5 StepConfirm 摘要

- 三列统计：文件数 / 可入库订单数 / 解析失败数（`text-3xl font-light`）
- 按币种汇总：`font-mono` 列表
- 逐文件状态：CheckCircle2 / AlertCircle + 文件名 + PO 号/错误
- 预览模式提示：`bg-recessed border-default` + Info 图标

---

## §7 四态规范

### §7.1 空态（empty）

- **Step 1 文件列表空态**：仅展示 dropzone，无文件列表
- **Step 2 无可预览结果**：`<p>没有可预览的解析结果。</p>`
- **Step 3 无成功订单**：摘要显示"可入库订单 0"，逐文件状态全为失败

### §7.2 加载态（loading）

- **Step 1 解析中**：`isParsing=true`，所有文件状态置为 `parsing`，StatusBadge 展示 Loader2 旋转 + "解析中"；下一步按钮展示"解析中…"+ Loader2 旋转
- **未来扩展**：Step 2 / Step 3 无加载态（数据已在内存）

### §7.3 错误态（error）

- **全局解析错误**：`parseError` 非空时，body 顶部展示 danger 横幅（`statusSemanticClass('danger', isDarkMode)`）
- **单文件解析失败**：Step 1 文件列表 StatusBadge 展示 AlertCircle + "失败"；Step 2 该文件 Tab 展示 danger 横幅，提示"确认时该文件会被跳过"
- **入库失败**：由父级 `OrderManager.onConfirm` 的 try/catch 处理，展示 `window.alert`——本组件不感知

### §7.4 交互态（interactive）

| 交互 | 触发 | 反馈 |
|---|---|---|
| 拖拽文件 | `onDragOver` / `onDrop` | dropzone 切换为 accent 描边 + accent 底色 |
| 点击 dropzone | `onClick` | 触发隐藏 input 的 click |
| 选择文件 | input `onChange` | `addFiles` 追加到列表 + AnimatePresence 入场动画 |
| 移除文件 | 点击删除按钮 | `removeOne` 过滤 + AnimatePresence 出场动画 |
| 全部清空 | 点击"全部清空" | `clearAll` 置空 |
| 切换 Tab | 点击 Tab 按钮 | `setActiveIdx` 切换 |
| 编辑字段 | input `onChange` | `updateOrder` / `updateLine` 回写 results |
| 上一步 | 点击"上一步" | `goBack` step-1 |
| 下一步 | 点击"下一步"/"完成" | `goNext` 异步流转 |
| 关闭 | 点击遮罩 / 关闭按钮 / ESC | `onClose` + state 重置 |

---

## §8 联动

### §8.1 上游：OrderManager（订单列表页主控）

- 触发入口：订单列表页"导入"按钮（第 980 行）+ 订单新建弹窗"从 PDF 导入"按钮（第 1865 行）
- 数据流：`OrderManager.showImportWizard` state → 本组件 `isOpen` prop
- 回写链路：`onConfirm(parsed)` → `OrderManager` 调用 `saveParsedOrders(parsed)` 持久化 → 刷新订单列表

### §8.2 下游：importService（上传与解析服务）

- `uploadPdfsForParsing(files, { apiKey })`：POST FormData 到 `/api/import/parse-pdf`
- 返回 `ImportResponse { count, results: ImportFileResult[] }`
- 每个 `ImportFileResult` 含 `filename` / `pages` / `detection` / `order: ParsedOrder | null` / `error: string | null`

### §8.3 下游：saveParsedOrders（持久化服务）

- 由父级 `OrderManager` 调用，不在本组件内
- POST 到 `/api/import/persist`，按 PO 号去重（存在则更新，不存在则创建）
- 返回 `PersistImportResponse { ok, created, updated, results }`

### §8.4 同级：QuotationImportWizard（报价导入向导）

- 同属 `components/import/` 目录，范式一致（三步流 + 模态对话框）
- 区别：报价导入支持 Excel/CSV，订单导入仅支持 PDF
- 未来可抽象为通用 `Wizard` 基类 + 步骤配置（GAP-3）

### §8.5 下游：OrderLinesTable（订单行表格）

- 导入生成的 `ParsedOrder.lines` 经 `saveParsedOrders` 持久化后，`OrderManager` 刷新订单列表
- 用户打开订单详情时，`OrderLinesTable` 展示这些行

---

## §9 状态机

### §9.1 主状态机

```
[closed] --isOpen=true--> [step 1: 选择文件]
                              |
                              | goNext (files.length > 0)
                              ↓
                         [parsing] --isParsing=true-->
                              |
                              | uploadPdfsForParsing 成功
                              ↓
                         [step 2: 预览/修正]
                              |
                              | goNext (results.some(ok))
                              ↓
                         [step 3: 确认]
                              |
                              | goNext → onConfirm(ok) → onClose
                              ↓
                         [closed] (state 重置)
```

### §9.2 异常分支

- 步骤 1 解析失败：`parseError` 设置，所有文件状态置 `error`，不前进
- 步骤 1 → 2 部分失败：成功的文件进入 results，失败的文件状态为 `error`；步骤 2 Tab 展示失败横幅
- 步骤 2 → 3 无门禁：即使全部失败也允许前进，让用户看到摘要
- 步骤 3 → 完成：`onConfirm` 仅传成功订单；若成功订单为 0，父级 `OrderManager` 收到空数组

### §9.3 回退分支

- 步骤 2 → 1：保留 `files` 与 `results`，用户可重新上传或直接再解析
- 步骤 3 → 2：保留 `results`，用户可继续修正

### §9.4 中断分支

- 任何步骤点击"关闭" / ESC / 点击遮罩 → `onClose` → state 重置 → 下次打开是干净状态
- **注意**：解析中关闭不会取消 HTTP 请求——`uploadPdfsForParsing` 的 fetch 仍会完成，但结果被丢弃（GAP-2）

---

## §10 数据模型

### §10.1 ParsedOrder（types.ts 第 1618 行）

```ts
export interface ParsedOrder {
  customerId: string;      // e.g. 'peerless'
  poNumber: string;
  season: string;
  poDate: string;
  contactPerson: string;
  contactPhone: string;
  currency: string;
  deliveryTerms: string;
  paymentTerms: string;
  totalNet: number;
  totalActual: number;
  shipTo: { contactName: string; company: string; addressLines: string[]; country?: string };
  deliverTo?: string;
  lines: ParsedLine[];
}
```

### §10.2 ImportFileResult（types.ts 第 1641 行）

```ts
export interface ImportFileResult {
  filename: string;
  pages: number;
  detection: DetectionResult;  // { customerId, confidence }
  order: ParsedOrder | null;   // null 表示解析失败
  error: string | null;        // 非 null 表示有错误
}
```

### §10.3 ImportResponse（types.ts 第 1649 行）

```ts
export interface ImportResponse {
  count: number;
  results: ImportFileResult[];
}
```

### §10.4 ParsedLine（行项目）

```ts
export interface ParsedLine {
  itemNo: string;
  materialCode: string;
  millQuality: string;
  description: string;
  quantity: number;
  unitPrice: number;
  netValue: number;
  exMillDate?: string;
  deliveryDate?: string;
}
```

### §10.5 字段映射（StepPreview 展示）

| PDF 字段 | Order schema 字段 | 说明 |
|---|---|---|
| Ship-to 公司 | `consigneeName` | 收货方公司名 |
| Ship-to 地址 | `consigneeAddress` | 收货方地址 |
| Ship-to 联系人 | `consigneeContact` | 收货方联系人 |
| 币种 | `salesCurrency` | 默认 USD |
| 采购币种 | `purchaseCurrency` | 默认 CNY，需手填 |
| 面料工厂 | `millName` | 留空，需手填 |
| PDF 来源标记 | 字段 `source: 'pdf'` | 后续手填/手改不会被同 PO 的 PDF 重导覆盖 |

---

## §11 API

### §11.1 上传并解析

- 端点：`POST /api/import/parse-pdf`
- 请求：`multipart/form-data`，field 名 `files`，支持多文件
- 鉴权：可选 API Key（`BAMBOOK_REQUIRE_AUTH=true` 时需要）
- 响应：`ImportResponse { count, results: ImportFileResult[] }`
- 前端服务：`services/importService.ts` `uploadPdfsForParsing`

### §11.2 持久化（父级调用）

- 端点：`POST /api/import/persist`
- 请求：`{ orders: ParsedOrder[] }`
- 响应：`PersistImportResponse { ok, created, updated, results }`
- 前端服务：`services/importService.ts` `saveParsedOrders`
- 去 重：按 `poNumber` 去重，存在则更新，不存在则创建

### §11.3 后端服务

- `server/src/import/` 目录
- PDF 解析：`pdfParser.ts`（PDF 文本提取）
- 客户识别：`customerDetector.ts`（基于文本特征匹配客户 ID）
- 字段提取：`fieldExtractor.ts`（正则 + LLM 提取订单字段）

---

## §12 权限

### §12.1 操作权限

- 导入订单需要"销售"或"管理层"角色——由父级 `OrderManager` 控制导入按钮的可见性
- 本组件不感知角色——`isOpen` 由父级决定

### §12.2 API 鉴权

- `apiKey` prop 透传给 `uploadPdfsForParsing`
- 服务端 `BAMBOOK_REQUIRE_AUTH=true` 时校验 API Key；否则匿名访问
- 生产环境建议启用鉴权（OPS Panel 配置）

### §12.3 数据权限

- 导入的订单默认归属当前用户——后端 `persist` 时关联 `userId`
- 后续若引入"销售仅看自己客户订单"，导入时需校验 `customerId` 是否在当前用户管辖范围内

---

## §13 BDS 设计系统对齐

### §13.1 三层治理

| 层 | 文件 | 本组件消费点 |
|---|---|---|
| 宪法 | `styles/os-vnext.css` | `--os-vnext-brand-blue`（accent 强调色）/ `--bg-card` / `--text-primary` / `--text-secondary` / `--text-tertiary` / `--border-c-default` / `--border-c-subtle` / `--recessed-bg` / `--recessed-bg-hover` / `--recessed-bg-strong` / `--hover-darken` / `--active-darken` |
| 契约 | `styles/flat-experimental.css` | flat 四特征——无阴影（`shadow-none`）/ 无 rim（`border` 极淡）/ 大圆角（`rounded-floating` 对话框 + `rounded-full` 按钮 + `rounded-card` 卡片 + `rounded-inset` 横幅）/ 半透明膜色（`bg-black/70 backdrop-blur-sm` 遮罩 + `bg-card` 对话框） |
| 基线 | `tailwind.config.js` + `check-design-tokens.sh` | `rounded-floating` / `rounded-card` / `rounded-inset` / `rounded-control` / `rounded-full` 语义类 |

### §13.2 配方来源

| 配方 | 来源 | 用途 |
|---|---|---|
| `BAMBOOK_OS.controls.actionControl.base` | `bambookOsTokens.ts` | StepDot 默认态控件底色 |
| `statusSemanticClass('danger', isDarkMode)` | `rdlBusinessStatusTokens.ts` | 错误横幅语义色 |
| `bg-[var(--os-vnext-brand-blue)]` | CSS 变量 | accent 强调色（按钮 / StepDot current / 检测横幅） |
| `bg-[var(--recessed-bg)]` / `-hover` / `-strong` | CSS 变量 | recessed 层级（StepIndicator 底色 / hover 态 / Connector 默认） |
| `bg-[var(--bg-card)]` | CSS 变量 | 对话框底色 |
| `text-[var(--text-primary)]` / `-secondary` / `-tertiary` | CSS 变量 | 文字三层级 |
| `border-[var(--border-c-default)]` / `-subtle` | CSS 变量 | 边框两层级 |

### §13.3 设计纪律

- ❌ 禁止硬编码颜色——所有颜色走 CSS 变量 `var(--*)` 或 `BAMBOOK_OS.*`
- ❌ 禁止 `box-shadow`——`shadow-none` 明确声明；flat 设计无阴影
- ❌ 禁止 `rounded-[Npx]`——用 `rounded-floating` / `rounded-card` / `rounded-inset` / `rounded-control` / `rounded-full` 语义类
- ✅ rgba 任意值绕开 flat-experimental 护栏——拖拽区描边 / 卡片描边 / 单元格输入框边框必须保持可见（代码注释已标注原因）
- ✅ 字重仅 `font-light`（300）——所有文字统一 `font-light`；摘要数字用 `text-3xl font-light` 形成视觉锚点
- ✅ 动效用 framer-motion `spring` 弹簧过渡（damping=24, stiffness=220）——与全局对话框动效一致

### §13.4 视觉特征

- **遮罩**：`bg-black/70 backdrop-blur-sm`——半透明黑色 + 背景模糊
- **对话框**：`max-w-5xl max-h-[88vh] rounded-floating bg-card`——大圆角浮层 + 卡片底色
- **入场动效**：`y: 24 → 0, opacity: 0 → 1, scale: 0.98 → 1`（spring 弹簧）
- **StepIndicator**：圆点 + 连接线，三态色编码（current accent 实心 / active accent 半透明 / default ghost）
- **按钮**：`rounded-full h-10 min-w-[96px]` 胶囊形；主按钮 accent 实心 + 白字；次按钮 ghost + tertiary 文字

---

## §14 缺口与后续

### §14.1 已知缺口

| ID | 缺口 | 影响 | 优先级 |
|---|---|---|---|
| GAP-1 | 仅支持 PDF，不支持 Excel/CSV | 用户无法批量导入历史 Excel 订单数据 | P2 |
| GAP-2 | 解析中关闭不取消 HTTP 请求 | 关闭后 fetch 仍完成但结果被丢弃，浪费后端资源 | P3 |
| GAP-3 | 字段映射固定不可配置 | 不同客户的 PDF 格式差异需后端硬编码适配 | P2 |
| GAP-4 | 无字段级校验 | 用户可输入非法值（如负数数量、空 PO 号） | P2 |
| GAP-5 | 无批量操作 | 无法批量清空/批量重试失败的文件 | P3 |
| GAP-6 | 无进度条 | 多文件解析时仅看到"解析中…"，不知整体进度 | P3 |
| GAP-7 | 无解析日志 | 解析失败时仅展示错误信息，无详细日志供调试 | P3 |
| GAP-8 | AnimatePresence exit 动效失效 | `isOpen` false 时组件直接返回 null，exit 动画不触发 | P3 |

### §14.2 推荐扩展方向

1. **多格式支持**：StepUpload 增加 Excel/CSV 文件类型检测，分发到不同的解析端点
2. **字段映射配置**：Step 2 增加字段映射配置面板，允许用户手动指定 PDF 字段 → Order schema 字段的映射关系
3. **字段级校验**：Step 2 输入框增加 `required` / `min` / `pattern` 校验，错误时展示红色边框 + 提示
4. **批量操作**：Step 1 增加"全部重试"按钮，对失败的文件重新解析
5. **进度条**：`isParsing` 时展示整体进度（已解析 N/M 文件）
6. **解析日志**：Step 2 失败文件增加"查看日志"按钮，展示后端解析详细日志
7. **Exit 动效修复**：将 `if (!isOpen) return null` 改为 `<AnimatePresence>{isOpen && <motion.div>...</motion.div>}</AnimatePresence>`，让 exit 动画正常触发

### §14.3 不推荐扩展

- ❌ 不在本组件内做持久化——保持"预览 + 交还"范式，持久化由父级决定
- ❌ 不在本组件内做客户识别——客户识别在后端 `customerDetector.ts`，前端仅展示结果
- ❌ 不在本组件内做字段映射 LLM 调用——LLM 调用在后端，前端仅展示解析结果

---

## §15 索引

### §15.1 交叉链接

- [OrderLinesTable.md](./OrderLinesTable.md) — 订单行表格，导入生成的行经持久化后在此展示
- [OrderClusterBlock.md](./OrderClusterBlock.md) — 行级字段簇，导入后的订单详情编辑路径
- [RelationCombobox.md](./RelationCombobox.md) — 关联选择器，导入后订单详情中客户/工厂字段的编辑
- [SidePanelContainer.md](./SidePanelContainer.md) — 玻璃面板外壳，本组件的对话框视觉范式与之同源
- [BDS组件族7规格.md](./BDS组件族7规格.md) — x-overlay 对话框原语，本组件的模态对话框配方源头
- [PageHeader.md](./PageHeader.md) — 页面头部组件，订单列表页"导入"按钮的宿主
- [NotificationCenter-通知与审批中心.md](./NotificationCenter-通知与审批中心.md) — 导入完成后的通知推送

### §15.2 代码真源

- 主组件：[components/import/ImportWizard.tsx](../../components/import/ImportWizard.tsx)
- 子组件：[StepUpload.tsx](../../components/import/StepUpload.tsx) / [StepPreview.tsx](../../components/import/StepPreview.tsx) / [StepConfirm.tsx](../../components/import/StepConfirm.tsx)
- 消费方：[components/OrderManager.tsx](../../components/OrderManager.tsx)（第 1006 行）
- 服务：[services/importService.ts](../../services/importService.ts) `uploadPdfsForParsing` / `saveParsedOrders`
- 类型：[types.ts](../../types.ts) `ParsedOrder`（第 1618 行）/ `ImportFileResult`（第 1641 行）/ `ImportResponse`（第 1649 行）
- 后端：[server/src/import/](../../server/src/import/) 目录

### §15.3 设计文档关联

- [01-产品总览/4. 设计系统规范.md](../01-产品总览/4.%20设计系统规范.md) — BDS 三层治理 + flat 四特征
- [04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md](../04-模块设计/03-订单与生产/Orders-订单管理/订单详情页.md) — 订单录入流程与导入向导的关系
