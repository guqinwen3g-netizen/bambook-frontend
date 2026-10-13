# 06 · 验收清单（每个模块 PR 必须逐条打勾）

把下面整段复制进 PR 描述，逐条勾选。任何一条不满足 = 不合入。

```md
### Mist 迁移验收 · <模块名>（<view>）
**自动检查**
- [ ] `node scripts/check-mist.mjs` 0 error（warning 已逐条说明）
- [ ] `npm run build` 通过
- [ ] 本模块文件已登记到 `docs/mist-atelier/migrated.txt`，已运行 `node scripts/gen-mist-docs.mjs`

**结构（对照参考页 ?view=<模板页>）**
- [ ] 使用了 module-map 指定的模板（列表：Tx；详情：Tx；新建：T9）
- [ ] 页面结构与参考页一致：PageHeader → (Tabs) → Toolbar → 主体
- [ ] 每屏只有 1 个 primary 按钮
- [ ] 旧页面的所有字段、所有操作都还在（PR 里附「旧 → 新」对照清单）

**视觉（Flat Frost）**
- [ ] 没有描边、没有投影（浮层除外）
- [ ] 选中/聚焦用填充加深，不是边框
- [ ] 状态颜色只出现在 Pill/圆点/进度/Banner，且符合 03-components 的 tone 对照表
- [ ] 紫色只出现在 AI 功能
- [ ] 编号用 Mono，金额右对齐、tabular 数字

**状态**
- [ ] 加载中（表格骨架/Skeleton，非 spinner）
- [ ] 空数据（EmptyState + 下一步按钮）
- [ ] 筛选无结果（EmptyState + 清除筛选）
- [ ] 请求失败（Banner tone="bad" + 重试）
- [ ] 无权限（EmptyState icon=Lock）

**主题与尺寸（截图贴在 PR 里）**
- [ ] 浅色 1440  - [ ] 深色 1440  - [ ] 1180（侧栏自动收起）  - [ ] 390 手机（次要列隐藏、无横向溢出）
- [ ] 深色下没有白底块、没有看不清的文字

**交互**
- [ ] 列表：单击/双击/回车行为符合模板
- [ ] 危险操作有 Dialog 确认；成功/失败有 toast
- [ ] Tab 键可以走完主要操作，焦点可见
- [ ] 控制台无报错
```

## 截图命令
```bash
# 参考页（对照用）
node scripts/mist-shots.mjs ref orders,orders/detail
# 真实 App（dev server 已启动）
node scripts/mist-shots.mjs http://localhost:5173 orders
```
输出在 `mist-shots/`（不要提交到仓库）。

## 人工对比方法
左边参考页截图、右边新页面截图，同宽同主题并排。检查：页头位置、卡片间距（统一 `--mist-gap`）、表格行高、按钮数量与位置、空白比例。差异要么修掉，要么在 PR 里写明原因（例如旧页面有模板里没有的功能）。
