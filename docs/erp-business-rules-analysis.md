# 庞大服饰业务规定 → Bambook ERP 映射分析

> 来源：`样衣管理规定` + `大货订单操作十条规定`
> 整理时间：2026-07-06
> 用途：Bambook ERP 模块设计参考

---

## 一、角色体系（ERP 权限基础）

文件中出现的三个核心角色：

| 角色 | 系统对应 | 关键权限 |
|------|---------|---------|
| **业务部** | merchandiser / sales | 下单、确认面辅料、确认产前样、批准发货、协调交期 |
| **生产部** | production_manager | 排生产计划、组织评审、跟踪进度、验布验料、出具验货报告 |
| **工厂** | factory（外部协作者） | 裁剪/缝制/整烫/检验/入库执行、自检 |

**ERP 启示**：当前 Bambook 的角色体系（owner/admin/manager/merchandiser/finance/sales/viewer/agent_operator）缺少 `production_manager` 和 `factory` 角色。生产部是独立审批节点，不能和 merchandiser 混用。

---

## 二、样衣生命周期（Sample Module）

### 分类体系

```
样衣
├── 普通样衣
│   ├── 开发样 (Development Sample)
│   └── 普通确认样 (Confirmation Sample)
└── 5A 重点样衣
    ├── 产前样 (PP Sample)
    └── 公司指定 5A 样衣
```

### 审批流

| 类别 | 审批方 | 能否直接寄出 |
|------|--------|------------|
| 普通样衣 | 生产单位自行确认 | ✅ 生产部不参与 |
| 5A 重点样衣 | **生产部必须组织评审** | ❌ 评审通过后才能寄出 |

### ERP 状态机

```
待安排 → 生产中 → 生产完成
  │                    │
  │                    ├─ [普通样衣] 自行确认 → 已寄出
  │                    │
  │                    └─ [5A样衣] 待评审 → 评审通过 → 已寄出
  │                                       └─ 评审不通过 → 返工
  │
  └─ 延期风险 → 通知业务部 → 协调 → 调整交期（需业务部确认）
```

**关键约束**：未经业务部确认，不得擅自调整交样日期。这是一个硬审批门。

---

## 三、大货订单生命周期（Order Module · 核心）

### 完整流程链（10 个阶段）

```
① 业务下单 → ② 面辅料确认 → ③ 生产计划 → ④ 货期管理
→ ⑤ 面辅料到厂 → ⑥ 裁剪前检查 → ⑦ 产前样确认
→ ⑧ 生产过程 → ⑨ 成品确认 → ⑩ 验货发货
```

### 每阶段的 ERP 映射

| 阶段 | 负责方 | ERP 状态 | 必需数据/文档 | 审批门 |
|------|--------|---------|-------------|--------|
| ① 业务下单 | 业务部 | `order_placed` | 交货期 + 尺码表 + 分色表 + 面辅料图片/实物 + 特殊要求 | — |
| ② 面辅料确认 | 业务部 | `materials_confirmed` | 面料/里布/辅料样卡、正反面确认、特殊商标/辅料 | 裁剪前必须完成 |
| ③ 生产计划 | 生产部 | `production_planned` | 生产计划表 | **7天内完成 + 业务部确认** |
| ④ 货期管理 | 生产部 | `in_production` | 进度跟踪记录 | **延期需提前15天通知** |
| ⑤ 面辅料到厂 | 业务部+生产部 | `materials_arrived` | 到厂时间、验布/验料记录 | **禁止带病生产** |
| ⑥ 裁剪前检查 | 生产部 | `pre_cut_checked` | 推码确认 + 耗料确认 + 样板确认 + 产前会议 | 四项全部完成才可裁剪 |
| ⑦ 产前样确认 | 生产部+业务部 | `pp_sample_approved` | 产前样 (PP Sample) | **双方共同确认后才可上线** |
| ⑧ 生产过程 | 生产部 | `manufacturing` | 裁剪→缝制→整烫→检验→入库 + 巡查报告 | 发现问题即出具巡查报告 |
| ⑨ 成品确认 | 生产部+业务部 | `final_review` | 每款整烫≥10件评审 | **评审通过才可大批包装** |
| ⑩ 验货发货 | 生产部→业务部 | `qc_passed` → `shipped` | 验货报告 | **自检≥90% + 不合格<3% + 业务部批准** |

### 量化阈值（硬规则，适合写进 ERP 校验）

| 指标 | 阈值 | 触发动作 |
|------|------|---------|
| 生产计划完成时限 | 下单后 **7天** | 超时告警 |
| 延期通知提前量 | **≥15天** | 否则升级 |
| 工厂自检合格率 | **≥90%** | 低于则不可发货 |
| 不合格率上限 | **≤3%** | 超过则禁止发货 |
| 成品评审最低数量 | **≥10件/款** | 不足则不可批量包装 |

---

## 四、对 Bambook Agent 的启示

### 应支持的 Agent 工作流（语义级动作）

1. **下单检查**：`create_order` 时自动校验是否附带 交货期/尺码表/分色表/面辅料/特殊要求，缺失则阻断并提示
2. **生产计划超时监控**：订单状态 `order_placed` 超过 7 天无 `production_planned`，Agent 自动提醒生产部
3. **延期预警**：距离交货期不足 15 天且进度落后，Agent 自动通知业务部
4. **裁剪前门禁**：状态要从 `materials_arrived` 切到 `pre_cut_checked`，必须四项检查全部标记完成
5. **产前样双签**：`pp_sample_approved` 状态需要生产部 + 业务部双方确认（当前审批体系可以复用）
6. **发货校验**：`shipped` 状态前置条件 = 验货报告已提交 + 合格率≥90% + 不合格率≤3% + 业务部批准

### ToolManifest 映射

这些业务流程对应总设计师提出的「流程级语义 API」（domain='workflow'）：

| 语义动作 | 涉及的 ERP 操作 | risk | approval |
|---------|----------------|------|---------|
| `workflow.submit_order` | 创建订单 + 校验必需附件 | medium | risk_based |
| `workflow.confirm_materials` | 面辅料确认 + 记录样卡 | medium | always |
| `workflow.plan_production` | 生成生产计划 + 7天倒计时 | medium | always |
| `workflow.pp_sample_review` | 产前样双签审批 | high | always |
| `workflow.start_cutting` | 裁剪前四项检查门禁 | high | always |
| `workflow.qc_inspection` | 提交验货报告 + 合格率校验 | high | always |
| `workflow.approve_shipment` | 发货最终审批 | high | always |

---

## 五、数据模型补充建议

基于这两份规定，当前 Bambook 数据模型需要补充的字段/表：

### Order 表补充

- `sample_type`: enum('development', 'confirmation', 'pp_sample', '5a_designated')
- `sample_review_status`: enum('pending', 'self_confirmed', 'review_passed', 'review_failed')
- `production_plan_deadline`: timestamp（下单 +7天）
- `delay_notice_deadline`: timestamp（交货期 -15天）
- `qc_self_pass_rate`: decimal（自检合格率）
- `qc_defect_rate`: decimal（不合格率）
- `final_review_qty`: int（成品评审件数）

### 新增：ProductionChecklist 表（裁剪前检查门禁）

- `order_id` → Order
- `grading_confirmed` boolean（推码确认）
- `consumption_confirmed` boolean（耗料确认）
- `pattern_confirmed` boolean（样板确认）
- `pre_production_meeting` boolean（产前会议）
- `all_passed` boolean（generated = AND of above four）

### 新增：InspectionReport 表（验货报告）

- `order_id` → Order
- `total_units`: int
- `passed_units`: int
- `defect_rate`: decimal（generated）
- `pass_rate`: decimal（generated）
- `report_file`: string（报告附件）
- `approved_by_business`: boolean + `approver_id`
