## PR Checklist: 新增 财务管理 模块

参考 docs/MODULE_CONTRACT.md §3 PR 模板。

### L1 数据层
- [ ] prisma/schema.prisma 新增 model Invoice（含 createdAt/updatedAt）
- [ ] prisma/schema.prisma 新增 model PaymentVoucher（收付款凭证）
- [ ] 跑 `npx prisma migrate dev --name add_finance`
- [ ] seed 脚本（如需要）写入 发票/收付款凭证 样例数据

### L2 API 层
- [ ] server/src/finance/route.ts 已生成（生成器产物）
- [ ] server/src/index.ts 注册 `app.use('/api/v1/finance', createFinanceRouter({ prisma, ... }))`
- [ ] 子表 `PaymentVoucher` 的 CRUD 路由（/finance/vouchers）已挂载
- [ ] mutation 端点接入 `syncFinanceReferences`
- [ ] mutation 端点接入 `syncVoucherReferences`（收付款凭证）
- [ ] 错误码：CREATE_FAILED / UPDATE_FAILED / NOT_FOUND / 业务码

### L3 EntityLink 同步
- [ ] server/src/entities/sync.ts 已加 `syncFinanceReferences`（patch 片段）
- [ ] server/src/entities/sync.ts 已加 `syncVoucherReferences`（收付款凭证，patch 片段）
- [ ] linkKind `aboutOrder` 已登记到 MODULE_CONTRACT §L3 R3.1 表格
- [ ] linkKind `billTo` 已登记到 MODULE_CONTRACT §L3 R3.1 表格
- [ ] linkKind `aboutOrder` 已登记到 MODULE_CONTRACT §L3 R3.1 表格
- [ ] linkKind `billTo` 已登记到 MODULE_CONTRACT §L3 R3.1 表格
- [ ] linkKind `settlesInvoice` 已登记到 MODULE_CONTRACT §L3 R3.1 表格

### L4 审批
- [ ] `finance.create_invoice` manifest.safety.approval = required
- [ ] `finance.create_voucher` manifest.safety.approval = required
- [ ] `finance.apply_voucher_to_invoice` manifest.safety.approval = required
- [ ] approval RBAC：['owner', 'admin', 'manager']

### L5 Agent 4 处同步（最高频踩坑点）
- [ ] manifest.ts MANIFEST_SEEDS 追加 8 条
- [ ] defaults.ts DEFAULT_AGENT_TOOLS 追加 8 条（同步 RBAC）
- [ ] toolRuntime.ts dispatch + 8 个实现函数
- [ ] planner.ts 触发规则正则：`/(财务|发票|应收|应付|核销|收款|付款|结汇|往来|账期|invoice|payment|voucher|finance|settle|receivable|payable)/i`

### L7 测试
- [ ] e2e-agent-test.ts EXECUTOR_CASES 追加 8 个用例
- [ ] e2e-agent-test.ts PLANNER_CASES 追加 1 个触发用例
- [ ] 跑 `npx tsx scripts/e2e-agent-test.ts` 全绿

### L8 前端
- [ ] 模块骨架 FinanceManager 已生成
- [ ] moduleRegistry 注册 `{ id: 'finance', label: '财务管理', ... }`
- [ ] DetailPanel "关联视图"识别 finance entity type

### 验收
- [ ] tsc --noEmit 全量 exit 0
- [ ] vite build 通过
- [ ] 数据回归：EntityLink/EntityReference 1:1 对齐
