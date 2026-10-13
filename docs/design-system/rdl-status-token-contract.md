# RDL Status Token 契约（v2.0）

> 最后更新：2026-07-09
> 约束 statusTone/getStatusStyles 语境下的色彩/token/层级使用

---

## 1. Accent vs Status 边界

### Accent（单一品牌色）
- **唯一 token**: `var(--os-vnext-brand-blue)` / `var(--os-vnext-brand-blue-strong)` / `var(--os-vnext-brand-blue-soft)`
- **RGB 变体**: `rgb(var(--os-vnext-brand-blue-rgb))` / `rgb(var(--os-vnext-brand-blue-rgb)/opacity)`
- **用途**: 交互态（hover/active/focus）、仪表/进度填充、选中态强调
- **禁止**: 用于普通文本/静态标签/背景色块

### Status（中性表达状态）
- **唯一方式**: 中性 opacity 差异 + 文案 + 图标
- **dark**: `bg-white/[0.04~0.08]` + `text-white/[0.55~0.70]` + `border-white/[0.08]`
- **light**: `bg-slate-100/[0.50~0.60]` + `text-slate-[500~600]` + `border-slate-300/40`
- **禁止**: 任何语义彩色（emerald/rose/red/amber/sky/green/purple/cyan）

---

## 2. 状态层级（3 档透明度）

```
statusTone 层级（中性，靠 opacity 区分）:
  inactive:  bg-white/[0.02] text-white/40  (dark)  /  bg-transparent text-slate-400  (light)
  normal:    bg-white/[0.04] text-white/55  (dark)  /  bg-slate-100/50 text-slate-500  (light)
  active:    bg-white/[0.06] text-white/70  (dark)  /  bg-slate-100/60 text-slate-600  (light)
```

状态语义靠文案表达，不靠色：
- 完成/成功 → normal 层级 + "已完成"/"已交付" 文案 + ✓ 图标
- 进行中 → active 层级 + "生产中"/"运输中" 文案
- 失败/异常 → inactive 层级 + "已取消"/"异常" 文案 + ⚠ 图标
- 警告 → normal 层级 + "待确认" 文案

---

## 3. 禁用色清单

### 绝对禁止（statusTone 语境）
- ❌ `emerald-*` / `rose-*` / `red-*` / `amber-*` / `sky-*` / `green-*` / `purple-*` / `cyan-*`
- ❌ 硬编码 hex 蓝/青: `#5DE0E6` / `#2F95CA` / `#CFE5FF` / 任何 `#xxx` 蓝色
- ❌ Tailwind `blue-*` / `indigo-*` / `teal-*`
- ❌ `os-vnext-brand-blue` 任何变体（accent token 不用于 statusTone 函数体）
- ❌ `bg-gradient-to-r` 含彩色（accent gradient 只可用于非 status 的交互/进度/spotlight）
- ❌ `shadow-xl/lg/md/2xl`（box-shadow: none）

### 保留（仅非 statusTone 场景）
- ✅ `var(--os-vnext-brand-blue)` 系列用于交互态/focus/progress/spotlight（非业务状态）
- ✅ accent gradient 用于非 status 的进度条/spotlight/交互强调
- ✅ `text-[var(--os-vnext-brand-blue)]` 用于可点击链接/强调（非 status）
- ✅ `slate-*` 中性灰阶
- ✅ `white/[opacity]` dark mode 透明度

> **v2.0 升级注记**：上述禁色适用于**组件文件直接散写**。低饱和语义色（含 teal=rebate）已集中到 `components/rdlBusinessStatusTokens.ts` 统一管理，组件以语义名引用（详见 §8）。故 §3 的 `teal-*` 禁令在「helper 内部」不适用——helper 是唯一合法的彩色持有者。

---

## 4. statusTone/getStatusStyles 实现规范

### 函数命名约定
- `statusTone(status, isDarkMode)` → 返回中性 className 字符串
- `getStatusStyles(status)` → 返回 `{ bg, text, border }` 中性对象
- 禁止返回彩色 token

### 实现模板
```typescript
const statusTone = (status: string, isDarkMode: boolean): string => {
  // 状态语义靠文案，视觉靠透明度
  if (isDarkMode) {
    return 'border-white/[0.08] bg-white/[0.06] text-white/70';  // active 层级
  }
  return 'border-slate-300/40 bg-slate-100/60 text-slate-600';  // light active
};
```

### 当前分布
- `ShipmentManager.statusTone` — Shipping 状态（Delivered/Booked/Shipped）
- `OrderManager.statusTone` — Order 状态（Delivered/Production/Shipping/Alert）
- `FinanceManager.financeStatusTone` — Finance 状态（中性 opacity 驱动 ✓ 已对齐）
- `AgentTimeline.eventTone` — Agent event 状态

---

## 5. Batch2/3 使用方式

### Batch2（Email/Products）
- statusTone 函数按本契约实现：中性 opacity，禁彩色
- 进度条/仪表可用 `var(--os-vnext-brand-blue)` 填充
- 错误/警告用中性 + 图标 + 文案，不用 red/amber 色块

### Batch3（Settings/Data Center）
- 全局 shell token（nav glass 等）走 shell token 独立路径，不纳入 status token
- Settings 开关/选项的 active 态用 accent，非 active 用中性

### 实施铁律
- statusTone 语境零彩色（仅中性 slate + white/opacity）
- 唯一允许的彩色是 `var(--os-vnext-brand-blue*)` 用于交互态
- 每批 source guard 覆盖 statusTone 语境的禁用色断言

---

## 6. Guard 断言模板

```typescript
// statusTone 语境禁用色断言（每批 guard 必含）
it('statusTone 禁硬编码彩色 + accent token + gradient', () => {
  expect(fnBody).not.toContain('#5DE0E6');
  expect(fnBody).not.toContain('#2F95CA');
  expect(fnBody).not.toContain('#CFE5FF');
  expect(fnBody).not.toMatch(/blue-[0-9]/);
  expect(fnBody).not.toContain('os-vnext-brand-blue');
  expect(fnBody).not.toContain('bg-gradient-to-r');
});

it('statusTone 仅用中性 opacity（slate/white），不用 accent', () => {
  // 允许: slate-* / white/[opacity]
  // 禁止: accent token / 语义彩色 / gradient
});
```

---

## 7. 当前状态（2026-07-09）

### 已对齐（本契约 guard 覆盖）
- ✅ ShipmentManager.statusTone
- ✅ OrderManager.statusTone
- ✅ FinanceManager.financeStatusTone（中性 opacity 驱动）

### 待 Batch2/3 处理
- ⏳ AgentTimeline.eventTone（残留 emerald/rose/amber，约 8 处）


---

## 8. 低饱和 Semantic Tokens（v2.0 升级）

> 2026-07-09 升级：在 v1.0「status 全中性 opacity」基础上，引入**低饱和 semantic token**——
> 保留 danger / warning / active / info / neutral / success / rebate / destructive 八档语义层级差，
> 但不用高饱和 Tailwind 彩色，改用极低 opacity 的语义色系。

### 8.1 单一管理点：`components/rdlBusinessStatusTokens.ts`

所有低饱和语义色 token **集中**在此 helper，导出 1 个类型 + 4 个函数：

| 导出 | 用途 | 返回示例 |
|---|---|---|
| `StatusSemantic` | 八档语义类型 | `'neutral' \| 'active' \| 'info' \| 'warning' \| 'danger' \| 'success' \| 'destructive' \| 'rebate'` |
| `statusSemanticClass(s, dark)` | 完整 chip 容器（bg+text+border） | `'bg-red-300/[0.06] text-red-200/60 border-red-300/[0.10]'` |
| `statusSemanticText(s, dark)` | 仅文字色（icon/label） | `'text-red-200/60'` |
| `statusSemanticBg(s, dark)` | 仅背景色（dot/pulse） | `'bg-red-400/60'` |
| `statusSemanticGradient(s, dark)` | 渐变强调态（bg+border） | `'from-red-300/[0.10] to-transparent border-red-300/[0.14]'` |

### 8.2 八档语义

| semantic | 语义 | 色相（低饱和） | 典型场景 |
|---|---|---|---|
| `neutral` | 中性灰 | slate / white-opacity | 默认 / 已完成 |
| `active` | 活跃 | 天青 sky（低饱和） | 进行中 / 在线 |
| `info` | 信息 | 蓝 blue（低饱和） | 规划中 / 已分配 |
| `warning` | 警告 | 琥珀 amber（低饱和） | 搁置 / 待审批 |
| `danger` | 危险 | 红 red（低饱和） | 已取消 / 逾期 / 错误 |
| `success` | 成功 | 翠绿 emerald（低饱和） | 正常 / 活跃用户 |
| `destructive` | 销毁操作 | 中性 + 强调 | 删除 / 移除按钮 |
| `rebate` | 退税专用 | 墨青 teal（低饱和） | 退税核算汇率 / 退税额 |

### 8.3 铁律

1. **组件零彩色字面量**：HRManager / ExchangeRateTool / ShippingNoticeGenerator 等业务组件**禁止**直接散写 `emerald-*` / `red-*` / `teal-*` / `sky-*` 等彩色 token，必须 `import` helper 并以语义名引用。
2. **helper 是唯一彩色持有者**：所有低饱和彩色字面量集中在 `rdlBusinessStatusTokens.ts`（Tailwind JIT 能从该 `.ts` 静态扫描到完整类名，故动态拼接安全）。
3. **accent 边界不变**：`var(--os-vnext-brand-blue*)` 仅用于**交互态**（hover / active / focus / 选中 / 进度 / 链接），**绝不**用于 status / rebate / destructive 语义。
4. **rebate = teal**：退税相关视觉统一走 `rebate` 语义（teal 墨青），是 v1.0 禁色清单中 `teal-*` 的唯一合法出口（且只在 helper 内）。

### 8.4 已对齐组件（2026-07-09）

- ✅ `HRManager.tsx` — `statusChipCls` / `priorityChipCls` / `loadError` alert 消费 helper
- ✅ `tools/ExchangeRateTool.tsx` — 全部 emerald 残留 → `rebate` token（含渐变 / pulse / icon / label）
- ✅ `tools/ShippingNoticeGenerator.tsx` — success / error alert → `success` / `danger` token；删除按钮 → `danger`；`blue-*` → accent
