/**
 * errorCodes —— 错误码 → HTTP 状态 → 业务文案 的唯一注册表。
 *
 * 为什么要有这张表：全仓曾把「给用户看什么话」当成每个 catch 点现写的手艺活，
 * 结果是要么把 Prisma 原文甩到业务员屏幕上，要么把有意的业务文案（「币种必填」）一起吞掉。
 * 文案是**每码一份**的产品资产，不是 catch 点的副产品。
 *
 * 三条语义：
 *   1. 业务错误（自带 `code:string` + `statusCode:number`）→ 原样透传，含 statusCode 与 details。
 *   2. 未预期异常 → 用 fallbackCode 查本表出文案；查不到 → 通用文案。原始 message **只进日志**。
 *   3. `details` / `gateDetails` 随附 —— 出运门禁 409 的明细是前端 ShipmentGateBlockedPanel 的输入。
 *
 * 注意：本文件**不得 import 任何东西**（跨层 import 会穿透 tsconfig exclude，
 * 且前端/脚本都可能引它 —— 判定逻辑必须独立成零引用文件）。
 */

export interface ErrorCodeSpec {
  status: number;
  message: string;
}

/** 未预期异常的统一兜底文案（不含任何内部细节；句号与注册表其余条目对齐） */
export const GENERIC_ROUTE_ERROR_MESSAGE = '服务器内部错误，请稍后重试。';


/** 有意透传给业务错误使用的通用码 */
export const ERROR_CODES: Record<string, ErrorCodeSpec> = {
  UNAUTHORIZED: { status: 401, message: '请先登录后继续。' },
  INTERNAL_ERROR: { status: 500, message: GENERIC_ROUTE_ERROR_MESSAGE },
  ACCOUNT_DISABLED: { status: 401, message: '当前账号不可用，请重新登录。' },
  SOURCE_CLAIM_CONFLICT: { status: 409, message: '索赔来源与当前财务单据不一致，请先核对关联。' },
  HAS_ALLOCATIONS: { status: 409, message: '单据已有核销记录，请先按撤销流程处理原核销。' },
  INVALID_AMOUNT: { status: 400, message: '金额或汇率不正确，请核对填写内容。' },
  INVALID_CURRENCY: { status: 400, message: '币种不正确，请选择系统支持的币种。' },
  STATUS_NOT_MANUAL_SETTABLE: { status: 400, message: '该状态由实际业务操作生成，不能手动设置。' },
  LINE_ALREADY_ALLOCATED: { status: 409, message: '费用行已被其他单据占用，请核对原单据后继续。' },
  INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH: { status: 409, message: '所选订单属于不同客户，请按客户分别开票。' },
  INVOICE_CUSTOMER_MISMATCH: { status: 409, message: '发票客户与订单签约客户不一致，请核对客户。' },
  AMOUNT_BELOW_ALLOCATED: { status: 409, message: '新金额低于已核销合计，请先处理原核销记录。' },
  UPDATE_FAILED: { status: 500, message: '保存结果暂不可确认，请刷新并核对原记录后重试。' },
  CONFLICT: { status: 409, message: '记录已被其他操作更新，请核对当前状态后重试。' },
  ORDER_MAIN_APPROVAL_REQUIRED: { status: 409, message: '订单须先完成业务主单审批，才能确认并继续履约。' },
  AMBIGUOUS_ORDER_REFERENCE: { status: 409, message: '该客户 PO 对应多张订单，请选择准确的内部订单号。' },
  APPROVAL_ALREADY_RESOLVED: { status: 409, message: '本审批已有决议，请读取原审批结果后继续。' },
  ALLOCATION_DIRECTION_MISMATCH: { status: 409, message: '发票应收应付方向与收付款凭证不一致，请重新核对单据。' },
  GARMENT_ORDER_NOT_FOUND: { status: 404, message: '成衣订单不存在或不可见，请核对订单。' },
  FABRIC_ORDER_NOT_FOUND: { status: 404, message: '面料订单不存在或不可见，请核对供料订单。' },
  FABRIC_ORDER_NOT_INTERNAL_TRADE: { status: 400, message: '面料订单尚未设为内部贸易，请核对交易方式。' },
  GARMENT_ORDER_INTERNAL_CONFLICT: { status: 400, message: '成衣订单不能作为内部供料订单，请核对订单关系。' },
  TRANSFER_ALREADY_EXISTS: { status: 409, message: '该内部供料关系已存在，请查看原记录。' },
  INVALID_TRANSFER_STATE: { status: 409, message: '内部供料当前状态不允许此操作，请刷新后核对。' },
  SETTLEMENT_PRICE_NOT_APPROVED: { status: 409, message: '当前内部结算价格尚未获批，请完成价格审批后再确认。' },
  SHIPMENT_NOT_FOUND: { status: 404, message: '出运记录不存在或不可见，请核对运单。' },
  SHIPMENT_NOT_OF_FABRIC_ORDER: { status: 409, message: '出运记录不属于该面料订单，请核对供料来源。' },
  OVER_DELIVERY: { status: 409, message: '交付数量超过剩余供料数量，请核对实际交付。' },
  TRANSFER_NOT_FOUND: { status: 404, message: '内部供料记录不存在或不可见，请刷新后核对。' },
  INVALID_DELIVERY_QUANTITY: { status: 400, message: '交付数量必须大于零，请核对数量与单位。' },
  DEV_CASE_NOT_FOUND: { status: 404, message: '开发案不存在或不可见。' },
  DECLARATION_NOT_FOUND: { status: 404, message: '报关单不存在或不可查看。' },
  TAX_REFUND_NOT_FOUND: { status: 404, message: '退税记录不存在或不可查看。' },
  CASE_CANCELLED: { status: 400, message: '开发案已取消，不能继续转换。' },
  ASSET_REQUIRED: { status: 409, message: '请先完成开发成果转档。' },
  DEVELOPMENT_NOT_READY: { status: 409, message: '开发成果尚未完成认可与转档。' },
  CONFIRMED_SOURCE_NOT_FOUND: { status: 404, message: '已认可的开发来源不存在。' },
  CONFIRMED_SOURCE_NOT_APPROVED: { status: 409, message: '开发来源尚未完成认可。' },
  MILL_MISMATCH: { status: 409, message: '开发来源与当前工厂不一致。' },
  EXCLUSIVE_FABRIC_BLOCKED: { status: 409, message: '所选面料是其他客户的专属档案，当前订单不能使用。' },
  DEVELOPMENT_PAUSED: { status: 409, message: '开发案已暂停，请先恢复后继续。' },
  DEVELOPMENT_CLOSED: { status: 409, message: '开发案已结案，不能继续写入。' },
  INVALID_LIFECYCLE_STATE: { status: 409, message: '开发案当前生命周期状态不允许执行此操作。' },
  LIFECYCLE_HISTORY_EXISTS: { status: 409, message: '开发案已有生命周期历史，不能删除。' },
  DEVELOPMENT_SOURCE_CHANGED: { status: 409, message: '开发来源已变化，请刷新后重试。' },
  DEVELOPMENT_SHIPPING_SOURCE_INVALID: { status: 400, message: '请选择当前开发案的真实寄样轮次作为费用来源。' },
  NOT_5A: { status: 400, message: '仅 5A 样品需要开发评审。' },
  QC_PASS_REQUIRED: { status: 409, message: '准确开发版本尚无通过的正式 QC 结论，请先完成该版本验货。' },
  RETURN_RESULTS_ALREADY_RECORDED: { status: 409, message: '返样成果已登记，请核对原记录；新打样须保留原版并建立新轮次。' },
  RETURN_RESULTS_REQUIRED: { status: 409, message: '请先登记实际返样成果，再发起该准确版本的 QC。' },
  QC_REVIEW_ALREADY_REQUESTED: { status: 409, message: '该准确版本已有未完成的 QC 任务，请处理原任务。' },
  QC_REVIEW_ALREADY_COMPLETED: { status: 409, message: '该次 QC 已完成，请查看原报告；复评须另行发起并保留历史。' },
  QC_REVIEW_ALREADY_ACKNOWLEDGED: { status: 409, message: '该报告已登记业务已阅，请查看原记录。' },
  QC_REVIEW_NOT_READY: { status: 409, message: 'QC 尚未完成，暂不能登记业务已阅。' },
  QC_SELF_ACKNOWLEDGEMENT_BLOCKED: { status: 403, message: '请由原业务负责人登记已阅，QC 不能代替业务确认。' },
  QC_ROUTING_TEAM_REQUIRED: { status: 409, message: '请先明确来源对应的专业 QC 团队。' },
  QC_ROUTING_HEAD_MISSING: { status: 409, message: '来源对应的 QC 团队尚未配置合资格负责人。' },
  QC_ROUTING_SOURCE_UNKNOWN: { status: 409, message: '来源业务类别未明确，不能路由专业 QC。' },
  QC_SELF_REVIEW_BLOCKED: { status: 403, message: 'QC 发起人不能代替专业 QC 完成该次评审。' },
  REVIEW_FAILED: { status: 500, message: '开发评审保存失败，请重试。' },
  BATCH_RECEIPT_STALE: { status: 409, message: '样品批次已变化，请刷新后登记。' },
  BATCH_RECEIPT_CONFLICT: { status: 409, message: '该批次已有不同的收样事实，请核对原登记。' },
  BATCH_CARDS_LEGACY_UNVERIFIED: { status: 409, message: '旧样卡数量来源未核实，请先核实盘点。' },
  BATCH_CARDS_ARCHIVED: { status: 409, message: '该批次实物已归档，请查看历史登记。' },
  AUTHORIZATION_LOAD_FAILED: { status: 500, message: '权限核对失败，请稍后重试。' },
  HR_ASSIGNMENT_GUARD_FAILED: { status: 500, message: '人事任务权限核对失败，请稍后重试。' },
  COST_ACCESS_FAILED: { status: 500, message: '费用权限核对失败，请稍后重试。' },
  BILLING_ACCESS_FAILED: { status: 500, message: '收费权限核对失败，请稍后重试。' },
  DEVELOPMENT_CLOSURE_FAILED: { status: 500, message: '结案与费用核对未完成，请刷新后重试。' },
  PENDING_EXPENSE_FAILED: { status: 500, message: '待到费用处理失败，请稍后重试。' },
  SCENE_ACCESS_FAILED: { status: 500, message: '费用来源权限核对失败，请重试。' },
  SCENE_INVOICE_PREVIEW_FAILED: { status: 500, message: '费用预览未能完成，请刷新后重试。' },
  SCENE_INVOICE_CREATE_FAILED: { status: 500, message: '开票结果暂不可确认，请刷新来源并核对发票记录。' },
  FORBIDDEN: { status: 403, message: '当前账号没有执行此操作的权限。' },
  AUTHORIZATION_UNAVAILABLE: { status: 503, message: '当前权限或数据范围暂时无法核对，请稍后重试。' },
  OVER_APPLIED: { status: 409, message: '提交金额超过当前可结算余额，请刷新核对。' },
  CLAIM_CASH_REFUND_FAILED: { status: 500, message: '客户退款未能完成，本次未确认任何改动，请稍后重试。' },
  NOT_FOUND: { status: 404, message: '目标记录不存在或已被删除。' },
  VALIDATION_FAILED: { status: 400, message: '提交内容不完整或有误，请检查后重试。' },
  VALIDATION_ERROR: { status: 400, message: '提交内容不完整或有误，请检查后重试。' },
  INVALID_RESULT: { status: 400, message: '验货结论不正确，请选择有效结论。' },
  INVALID_MULTIPLIER: { status: 400, message: 'multiplier 必须为 (0, 100] 区间数值（如 3 = 运费涨 3 倍）。' },
  REVIEW_STALE: { status: 409, message: '费用核齐依据已变化，请重新核齐。' },
  REVIEW_REQUIRED: { status: 409, message: '缺少本案费用核齐记录。' },
  COVERAGE_CONFLICT: { status: 409, message: '收费覆盖与核齐费用不一致，请重新核对。' },
  INVALID_BILLING_SOURCE: { status: 409, message: '缺少本案核齐依据。' },
  HANDOFF_CONFLICT: { status: 409, message: '收费金额、减免或客户与财务交接依据不一致，请核对原交接记录。' },
  INVALID_STATE: { status: 409, message: '当前状态不允许此操作，请刷新记录后按业务流程继续。' },
  INVALID_INPUT: { status: 400, message: '提交内容不完整或有误，请检查后重试。' },
  SOURCE_CHANGED: { status: 409, message: '业务来源已变化，请刷新来源并重新核对。' },
  QUOTATION_APPROVAL_STALE: { status: 409, message: '报价内容已变化，请重新核对本版报价并申请审批。' },
  QUOTATION_APPROVAL_UNVERIFIED: { status: 409, message: '历史审批缺少完整报价依据，请重新核对并申请审批。' },
  QUOTATION_APPROVAL_REJECTED: { status: 409, message: '本版报价审批未通过，请修订报价后重新申请审批。' },
  QUOTATION_APPROVAL_PENDING: { status: 400, message: '报价审批尚未完成，请处理本版条目或总价审批后重试。' },
  INVALID_COST_SOURCE: { status: 409, message: '成本来源与订单范围不一致，请核对关联单据。' },
  DUPLICATE_COST_SOURCE: { status: 409, message: '同一成本来源不能重复归集，请核对明细。' },
  INVALID_SUPPLY_BALANCE: { status: 409, message: '供料数量尚未平衡，请核对使用、损耗与余料。' },
  SUPPLY_QUANTITY_EXCEEDED: { status: 409, message: '供料归集数量超过实际领料，请核对数量与单位。' },
  COST_REVIEW_FACT_INVALID: { status: 409, message: '成本核对记录与原始依据不一致，请重新核对。' },
  INVALID_EVIDENCE_SOURCE: { status: 409, message: '核对附件不存在、已失效或不属于当前业务。' },
  COST_REVIEW_CONCURRENT_CHANGE: { status: 409, message: '核对来源或版本正在变化，请使用原请求刷新后重试。' },
  REQUEST_CONFLICT: { status: 409, message: '原请求编号已用于不同内容，请核对原请求结果。' },
  REVIEW_VERSION_CHANGED: { status: 409, message: '成本核对版本已变化，请刷新后重新核对。' },
  COST_REVIEW_INCOMPLETE: { status: 409, message: '实际成本依据尚未完整，请补齐后再确认。' },
  COST_REVIEW_REQUEST_RETIRED: { status: 409, message: '原成本确认请求已结束，请按当前来源重新核对。' },
  ORDER_COST_REVIEW_FAILED: { status: 500, message: '成本核对结果暂不可确认，请使用原请求重试并核对记录。' },
  RECEIPT_PROPOSAL_FAILED: { status: 500, message: '收款建议处理结果暂不可确认，请使用原请求重试并核对记录。' },
  CLAIM_SOURCE_ACCESS_FAILED: { status: 503, message: '暂时无法核对售后业务数据范围，请稍后重试。' },
  UNSUPPORTED_KIND: { status: 422, message: '当前版本尚不支持此处置类型，请选择已支持的业务路径。' },
  TAIL_LIMIT_EXCEEDED: { status: 409, message: '金额超过尾差上限，请核对余额和尾差政策。' },
  NO_OPEN_AMOUNT: { status: 409, message: '该发票已无未结金额，请刷新后核对原处理记录。' },
  SHIPMENT_FIELD_REQUIRED_MISSING: { status: 400, message: '出运资料不完整，请补齐运输方式要求的资料后重试。' },
  STOCK_INSUFFICIENT: { status: 409, message: '当前可用库存不足，请核对实际批次和锁定数量后重新安排发运。' },
  INVALID_VALID_UNTIL: { status: 400, message: '例外有效期不正确，请核对后重试。' },
  EXCEPTION_CONSUMER_REQUIRED: { status: 400, message: '例外核销必须绑定实际业务操作。' },
  EXCEPTION_NOT_FOUND: { status: 404, message: '所用例外不存在，请重新核对审批记录。' },
  EXCEPTION_SCOPE_INVALID: { status: 409, message: '例外范围与当前业务操作不一致，请重新核对审批范围。' },
  EXCEPTION_NOT_FOR_THIS_ENTITY: { status: 400, message: '该例外不适用于当前业务单据。' },
  EXCEPTION_ALREADY_CONSUMED: { status: 409, message: '该例外已被使用，请核对原业务操作，避免重复使用。' },
  EXCEPTION_EXPIRED: { status: 409, message: '该例外已过期，请按当前业务重新申请审批。' },
  EXCEPTION_NOT_ACTIVE: { status: 409, message: '该例外尚未生效或已失效，请核对审批记录。' },
  EXCEPTION_CONSUME_CONFLICT: { status: 409, message: '例外核销状态已变化，本次业务操作未提交，请刷新后核对。' },
  EXCEPTION_CONSUME_FAILED: { status: 500, message: '例外核销未完成，本次业务操作未提交，请重试；持续失败请联系管理员。' },
  CURRENCY_MISMATCH: { status: 400, message: '币种不一致。' },
  INVALID_INVOICE_STATUS: { status: 400, message: '当前发票状态不允许核销，请核对原单据。' },
  INVALID_VOUCHER_STATUS: { status: 400, message: '当前收付款凭证状态不允许核销，请核对原凭证。' },
  AMOUNT_EXCEEDS_INVOICE: { status: 400, message: '核销金额超过发票面额，请核对金额。' },
  AMOUNT_EXCEEDS_VOUCHER: { status: 400, message: '核销金额超过收付款凭证面额，请核对金额。' },
  AMOUNT_EXCEEDS_INVOICE_REMAINING: { status: 400, message: '核销金额超过发票剩余余额，请刷新后核对其他核销记录。' },
  AMOUNT_EXCEEDS_VOUCHER_REMAINING: { status: 400, message: '核销金额超过收付款凭证剩余余额，请刷新后核对其他核销记录。' },
  INVOICE_NOT_FOUND: { status: 404, message: '发票不存在或已删除，请重新选择来源单据。' },
  VOUCHER_NOT_FOUND: { status: 404, message: '收付款凭证不存在或已删除，请重新选择来源凭证。' },
  GATE_BLOCKED: { status: 409, message: '出运门禁未通过，请按明细补齐或申请受控例外。' },
  INVOICE_LINKED: { status: 409, message: '该运单已关联发票，不能撤销出运。' },
  ORDER_TERMINAL: { status: 409, message: '订单已进入终态，不能继续修改。' },

  // B68-1（v2.46）：`shipping/documentSetService` 自己声明的两个域内码之一（另一枚 SHIPMENT_NOT_FOUND
  // 映射到已有的 NOT_FOUND，不在这里造第二把同义钥匙）。登记前它已在 shipping/route.ts:485 当兜底码用，
  // 状态取 `spec?.status ?? 500` = **500**；登记后该点状态与文案都不变（文案由调用点 fallbackMessage 优先，
  // 见 routeError.ts:93），所以这一步不是改契约，只是把"装配失败=服务端故障"这档写进唯一真源，
  // 让组合文档路由不必再看一句中文。
  ASSEMBLE_FAILED: { status: 500, message: '随附单据集未能生成，请稍后重试；持续失败请联系管理员核对单据模板与出运资料。' },

  // production 域（终评 Important #1）：`StageGateError` 逃出 service try/catch 时按码取状态，
  // 不再一律落到 409 地板值。**只登记两本既有映射口径一致的码**：
  //   · INVALID_STAGE —— route.ts 映射 400，routeV2 只做入参前置校验（400）⇒ 无冲突
  //   · ORDER_NOT_FOUND —— route.ts 与 routeV2 都是 404 ⇒ 无冲突
  // `STAGE_NOT_SEQUENTIAL` **有意不登记**：route.ts 给 400、routeV2 给 409，两本映射互相打架，
  // 在这里写第三个值 = 替它们选边（属行为契约决策，已登记 §9 待拍板，不属核定）。
  INVALID_STAGE: { status: 400, message: '工序不存在或不合法，请刷新工序列表后重试。' },
  ORDER_NOT_FOUND: { status: 404, message: '订单不存在或已被删除，请刷新订单列表后重试。' },
  ORDER_LINE_NOT_FOUND: { status: 404, message: '订单行不存在或不可见，请刷新订单明细后重试。' },


  // hr 域（S0-A2 逐域收敛之一）：路由侧 fallback 码 —— 未预期异常时的可行动中文文案。
  // 状态一律 500（这些码只在"服务端自己出故障"时出现；有意的业务拒绝由 HrError 自带码与状态透传）。
  // 口径同 risk：一码一文案，文案说清"哪件事没成 + 接下来做什么"，不带内部细节。
  HR_PERSONNEL_FETCH_FAILED: { status: 500, message: '人事档案列表加载失败，请稍后重试；持续失败请联系管理员核对人事数据。' },
  HR_POSITION_CREATE_FAILED: { status: 500, message: '岗位未能新建，本次没有写入任何数据，请检查表单后重试；持续失败请联系管理员。' },
  HR_POSITION_UPDATE_FAILED: { status: 500, message: '岗位未能保存，本次没有改动原记录，请检查表单后重试；持续失败请联系管理员。' },
  HR_POSITION_DELETE_FAILED: { status: 500, message: '岗位未能删除，该岗位仍然保留，请稍后重试；持续失败请联系管理员。' },
  HR_TEAMS_FETCH_FAILED: { status: 500, message: '团队列表加载失败，请稍后重试；持续失败请联系管理员核对组织数据。' },
  HR_TEAM_CREATE_FAILED: { status: 500, message: '团队未能新建，本次没有写入任何数据，请检查填写内容后重试；持续失败请联系管理员。' },
  HR_TEAM_UPDATE_FAILED: { status: 500, message: '团队未能保存，本次没有改动原记录，请检查填写内容后重试；持续失败请联系管理员。' },
  HR_TEAM_GRANTS_FETCH_FAILED: { status: 500, message: '团队授权信息加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_TEAM_OVERVIEW_FAILED: { status: 500, message: '团队总览加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_MY_TEAMS_FETCH_FAILED: { status: 500, message: '我所在的团队加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_TEAM_MEMBER_ADD_FAILED: { status: 500, message: '成员未能加入团队，本次没有改动名单，请稍后重试；持续失败请联系管理员。' },
  HR_TEAM_MEMBER_REMOVE_FAILED: { status: 500, message: '成员未能移出团队，本次名单未变，请稍后重试；持续失败请联系管理员。' },
  HR_PROJECTS_FETCH_FAILED: { status: 500, message: '项目列表加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_PROJECT_CREATE_FAILED: { status: 500, message: '项目未能新建，本次没有写入任何数据，请检查填写内容后重试；持续失败请联系管理员。' },
  HR_PROJECT_UPDATE_FAILED: { status: 500, message: '项目未能保存，本次没有改动原记录，请检查填写内容后重试；持续失败请联系管理员。' },
  HR_PROJECT_DELETE_FAILED: { status: 500, message: '项目未能删除，该项目仍然保留，请稍后重试；持续失败请联系管理员。' },
  HR_PROJECT_MEMBER_ADD_FAILED: { status: 500, message: '成员未能加入项目，本次没有改动名单，请稍后重试；持续失败请联系管理员。' },
  HR_PROJECT_MEMBER_REMOVE_FAILED: { status: 500, message: '成员未能移出项目，本次名单未变，请稍后重试；持续失败请联系管理员。' },
  HR_ASSIGNMENTS_FETCH_FAILED: { status: 500, message: '人员调配记录加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_ASSIGNMENT_CREATE_FAILED: { status: 500, message: '调配未能新建，本次没有写入任何数据，请检查填写内容后重试；持续失败请联系管理员。' },
  HR_ASSIGNMENT_UPDATE_FAILED: { status: 500, message: '调配未能保存，本次没有改动原记录，请检查填写内容后重试；持续失败请联系管理员。' },
  HR_ASSIGNMENT_DELETE_FAILED: { status: 500, message: '调配未能删除，原记录仍然保留，请稍后重试；持续失败请联系管理员。' },
  HR_OPERATION_FAILED: { status: 500, message: '这次人事操作没有成功，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' },
  HR_EMPLOYEES_FETCH_FAILED: { status: 500, message: '员工列表加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_EMPLOYEE_FETCH_FAILED: { status: 500, message: '该员工档案加载失败，请返回列表重新进入；持续失败请联系管理员。' },
  HR_EVENTS_FETCH_FAILED: { status: 500, message: '人事事件记录加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_ATTENDANCE_FETCH_FAILED: { status: 500, message: '考勤记录加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_ATTENDANCE_SUMMARY_FAILED: { status: 500, message: '考勤汇总加载失败，请稍后重试；汇总未生成时请勿据此判断出勤情况。' },
  HR_LEAVE_FETCH_FAILED: { status: 500, message: '请假记录加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_SALARY_FETCH_FAILED: { status: 500, message: '薪资数据加载失败，请稍后重试；持续失败请联系管理员核对发薪数据。' },
  HR_PAYROLL_FETCH_FAILED: { status: 500, message: '工资单数据加载失败，请稍后重试；持续失败请联系管理员核对发薪数据。' },
  HR_CYCLES_FETCH_FAILED: { status: 500, message: '考核周期加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_REVIEWS_FETCH_FAILED: { status: 500, message: '考核记录加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_COURSES_FETCH_FAILED: { status: 500, message: '培训课程加载失败，请稍后重试；持续失败请联系管理员。' },
  HR_ENROLLMENTS_FETCH_FAILED: { status: 500, message: '培训报名记录加载失败，请稍后重试；持续失败请联系管理员。' },

  // orders 域（B14）：删除守卫的**依赖检查自身失败** —— 与「有依赖被拒」（409 HAS_DEPENDENTS）
  // 是两件事：那次校验根本没做完、服务端给不出结论，所以是 5xx 且**可重试**（503 Service Unavailable），
  // 绝不能降级成「查不到 = 没有依赖」放行删除（G3 判据「算不出来必须不给数」· L-A 零容忍）。
  DEPENDENCY_CHECK_FAILED: { status: 503, message: '关联单据校验未能完成，无法确认是否还有下游单据，为避免误删，本次删除已阻止，请稍后重试或联系管理员。' },
  ORDER_LINE_WORKFLOW_REQUIRED: { status: 409, message: '投产与出运状态由订单条目履约流程推进；请打开具体订单条目继续。' },

  // G-4：L/C 信用证门禁两码。**为什么登记在这里而不是各调用点各写一份** —— 本仓两条棘轮把它夹死了：
  //   B34 要求抛点带 `statusCode`（否则走「未预期」分支，服务层那句中文提示被兜底文案吞掉）；
  //   B32 要求 `code → status` 只有一份真源（否则新增一枚码就漏一档、被 route 的 `|| 500` 兜成服务器错误）。
  //   同时满足两条的唯一写法就是**查本表**（同 production/stageService.ts 的 StageGateError）。
  //   LC_EXCEPTION_CHECK_FAILED 取 500 而非 503：与同族确认门禁的 CREDIT_CHECK_FAILED 同档
  //   （见 orders/orderLifecycleService.ts 的 ORDER_LIFECYCLE_ERROR_HTTP_STATUS；DEPENDENCY_CHECK_FAILED
  //    那种「校验无结论 ⇒ 503」的口径是否要推广到门禁族，属对外契约决策，未擅自改）。
  LC_GATE_BLOCKED: { status: 403, message: '该订单以信用证结算，但信用证不满足条款（未登记、已注销或已过有效期），本次操作已被阻止；请先登记或核对 L/C，确需例外请按 DR-013 申请。' },
  LC_EXCEPTION_CHECK_FAILED: { status: 500, message: '信用证门禁未能完成例外状态确认，本次操作已按 fail-closed 保持阻断，请稍后重试；持续失败请联系管理员排查例外/审批服务。' },

  // risk 域（试点）：路由侧 fallback 码 —— 状态 500，文案说清「哪件事没成」，不带内部细节
  OVERVIEW_FAILED: { status: 500, message: '风险概览加载失败，请稍后重试。' },
  ALERT_LIST_FAILED: { status: 500, message: '预警列表加载失败，请稍后重试。' },
  ALERT_UPDATE_FAILED: { status: 500, message: '预警处理失败，请稍后重试。' },
  FX_LIST_FAILED: { status: 500, message: '汇率列表加载失败，请稍后重试。' },
  FX_LATEST_FAILED: { status: 500, message: '最新汇率加载失败，请稍后重试。' },
  FX_ADD_FAILED: { status: 500, message: '汇率录入失败，请稍后重试。' },
  FX_LOCK_LIST_FAILED: { status: 500, message: '锁汇列表加载失败，请稍后重试。' },
  FX_LOCK_FAILED: { status: 500, message: '锁汇操作失败，请稍后重试。' },
  FX_LOCK_DELETE_FAILED: { status: 500, message: '锁汇删除失败，请稍后重试。' },
  RATING_LIST_FAILED: { status: 500, message: '客户评级列表加载失败，请稍后重试。' },
  RATING_EVALUATE_FAILED: { status: 500, message: '客户评级计算失败，请稍后重试。' },
  CREDIT_BLOCKED: {status:409,message:'当前客户信用阻断新订单，请核对信用或获批例外。'},
  CREDIT_FROZEN_60_DAYS: {status:409,message:'当前客户信用已冻结，请核对财务解冻或有效信用例外。'},
  CREDIT_REVOKED: {status:409,message:'当前客户信用已吊销，请核对财务处置或有效信用例外。'},
  OVERDUE_60_DAYS: {status:409,message:'当前客户存在超过60天未结清逾期，请核对财务处置或有效信用例外。'},
  CREDIT_CHECK_FAILED: {status:500,message:'当前客户信用未能核验，订单未确认，请稍后重试。'},
  CREDIT_SCAN_FAILED: { status: 500, message: '授信扫描失败，请稍后重试。' },
  COMPLIANCE_LIST_FAILED: { status: 500, message: '合规核查列表加载失败，请稍后重试。' },
  COMPLIANCE_CREATE_FAILED: { status: 500, message: '合规核查登记失败，请稍后重试。' },
  HS_CODE_CHECK_FAILED: { status: 500, message: 'HS 编码核查失败，请稍后重试。' },
  EXPORT_CONTROL_CHECK_FAILED: { status: 500, message: '出口管制核查失败，请稍后重试。' },
  SANCTIONED_LIST_FAILED: { status: 500, message: '制裁名单列表加载失败，请稍后重试。' },
  SANCTIONED_UPDATE_FAILED: { status: 500, message: '制裁名单更新失败，请稍后重试。' },
  DEFECT_TRENDS_FAILED: { status: 500, message: '质量缺陷趋势加载失败，请稍后重试。' },
  QUALITY_SCAN_FAILED: { status: 500, message: '质量扫描失败，请稍后重试。' },

  // S0-A2 B42 A1（products / notifications 两域路由级直发收敛）：
  //   这 22 处此前是「catch 点自己写文案 + 把原文甩给屏幕」，现在文案登记在这里（一码一份），
  //   原始异常只进日志。**码名一律带域前缀**（照 HR_* 的先例：一支不复用）——
  //   若沿用 `LIST_FAILED` / `DELETE_FAILED` 这类全仓重名码去登记，会把别的域的同名兜底点一起改成不相干的话，
  //   那是"用一份真源的姿势制造一份错真源"。
  PRODUCT_LIST_FAILED: { status: 500, message: '产品列表加载失败，请稍后重试；持续失败请联系管理员核对产品数据。' },
  PRODUCT_EXCLUSIVITY_CHECK_FAILED: { status: 500, message: '面料独占性预检未能完成，本次没有确认能否新建，请稍后重试；持续失败请联系管理员。' },
  PRODUCT_QUERY_FAILED: { status: 500, message: '产品查询未能完成，请稍后重试，或减少筛选条件后再试。' },
  PRODUCT_DETAIL_FAILED: { status: 500, message: '产品档案加载失败，请稍后重试；若持续失败请联系管理员核对该档案数据。' },
  PRODUCT_CREATE_FAILED: { status: 500, message: '这次新建没有完成，本次未写入任何数据，请检查填写内容后重试；持续失败请联系管理员。' },
  PRODUCT_UPDATE_FAILED: { status: 500, message: '这次保存没有完成，本次未确认任何改动（产品档案或图片设置），请刷新后重试；持续失败请联系管理员。' },
  PRODUCT_DELETE_FAILED: { status: 500, message: '这次删除没有完成，要删的内容（产品档案或图片）仍然保留，请稍后重试；持续失败请联系管理员核对下游引用。' },
  PRODUCT_IMAGE_UPLOAD_FAILED: { status: 500, message: '图片上传未能完成，本次没有新增图片，请重新上传；持续失败请联系管理员。' },
  NOTIFICATION_LIST_FAILED: { status: 500, message: '通知列表加载失败，请稍后重试；持续失败请联系管理员。' },
  NOTIFICATION_STATS_FAILED: { status: 500, message: '未读统计加载失败，请稍后重试；未读数以通知列表为准。' },
  NOTIFICATION_MARK_READ_FAILED: { status: 500, message: '这条通知未能标记为已读，本次没有改动，请稍后重试。' },
  NOTIFICATION_MARK_ALL_READ_FAILED: { status: 500, message: '「全部已读」没有完成，本次未确认任何改动，请稍后重试。' },
  NOTIFICATION_DELETE_FAILED: { status: 500, message: '通知未能删除，该条仍然存在，请稍后重试；持续失败请联系管理员。' },
  NOTIFICATION_DISMISS_FAILED: { status: 500, message: '忽略通知没有成功，本次没有改动，请填好原因后重试；持续失败请联系管理员。' },
  NOTIFICATION_PREFERENCES_FAILED: { status: 500, message: '通知偏好加载失败，请稍后重试；当前开关状态以服务端为准。' },
  NOTIFICATION_PREFERENCE_UPSERT_FAILED: { status: 500, message: '该类型的通知偏好未能保存，本次没有改动，请稍后重试；持续失败请联系管理员。' },
  NOTIFICATION_CATALOG_FAILED: { status: 500, message: '通知类型清单加载失败，请稍后重试。' },
  NOTIFICATION_CONVERT_FAILED: { status: 500, message: '这条通知未能转成跟进任务，本次没有创建任务，请稍后重试；若该通知未关联客户档案，请先补齐关联再转。' },
  /**
   * DR-007（审批人解析 fail-closed）：抛方 = `approvals/approvalRoutingService.ts` 的 `noReviewerError()`，
   * 它**早就把 `err.code` 挂上去了**，只是没登记 ⇒ 路由只能靠 `msg.includes('NO_REVIEWER_RESOLVED')` 认（B68 现场）。
   * 登记后 `statusFromError` 第 2 档直接命中，那条内联三元可以删。
   * 档位取 **409**：组织归属未配置是"当前状态不允许此操作"，既不是客户端填错（400）也不是服务端坏了（500）。
   */
  NO_REVIEWER_RESOLVED: { status: 409, message: '未能为这次操作解析出审批人，请先在组织归属里配好可用的审批人再重试。' },

  /**
   * ★ 2026-09-29 登记（B32 棘轮收口）：抛方 = `finance/paymentVoucherMutationService.ts`
   * （`feeBearer` 枚举校验），档位 400 = 「调用方传错值」，不是服务端故障。
   *
   * 为什么现在才登记：M1·D7（`feeBearer` 特性）当初把它**加进了 `finance/route.ts` 的两张本地
   * `statusCodeMap`**，而没进本表 ⇒ 触发 B32 棘轮「code→status 只能有一份真源、只减不增」
   * （实测：`finance/route.ts` 从 149 条涨到 151 条，两条都是这个码）。
   * 登记后那两处本地条目可以删掉，路由改问本表 ⇒ 计数回到 149。
   *
   * ⚠️ 行为保持不变：路由侧的兜底顺序是「本地表 → 本表 → 500」，本码在两处都取 400。
   */
  INVALID_FEE_BEARER: { status: 400, message: '银行手续费承担方非法，请使用 OUR / BEN / SHA（OUR=汇款方承担，BEN=收款方承担，SHA=各自承担己方费用）。' },

  /**
   * ★★ 2026-09-29 晚登记（B32 棘轮收口 + D33「状态规则由注册表单点给出」）：
   *   抛方/返回方 = 公差标准域（`orders/toleranceStandardRoute.ts` 的 `invalid()` 出口
   *   与 `orders/toleranceStandardService.ts` 的客户标准读写）。
   *
   * 为什么必须进本表（不是顺手加的）：B32 棘轮**当场逮住了我** —— 我原先在路由里写
   *   `res.status(code === 'RELATION_NOT_FOUND' ? 404 : 400)`，判定输出
   *   「`orders/toleranceStandardRoute.ts` 出现了基线外的本地 code→status 映射」。
   *   这正是 G6.3「多套并行真源」那族的现场 ⇒ 修法不是把它登记成欠债，而是**改问本表**。
   *
   * 档位取值理由：
   *   · `INVALID_VALUE` / `RELATION_ID_REQUIRED` / `REASON_TOO_SHORT` / `ACTOR_REQUIRED` = **400**
   *     （调用方传错值/漏传，不是服务端故障）；
   *   · `RELATION_NOT_FOUND` = **404**（要挂标准的客户不存在或已删除 —— 资源不存在，
   *     与"你参数写错了"是两件事，前端要靠它给出不同的下一步）。
   */
  INVALID_VALUE: { status: 400, message: '提交的值不合法或形状不对，请检查后重试。' },
  RELATION_ID_REQUIRED: { status: 400, message: '缺少客户（关系）标识，无法定位要维护的标准。' },
  REASON_TOO_SHORT: { status: 400, message: '变更理由太短：这类变更必须写明原因（至少 5 个字），以便日后追溯。' },
  ACTOR_REQUIRED: { status: 400, message: '缺少操作人，无法为这次变更留下可追溯的审计记录。' },
  RELATION_NOT_FOUND: { status: 404, message: '该客户（关系）不存在或已被删除，请刷新后重试。' },

  /**
   * ★★ 2026-09-29 晚登记：**短装（少做）拦截** —— 抛方 = `shipping/shortShipmentGate.ts`
   * （由 `shipping/shipmentMutationService.ts` 在「运单流转至 Shipped」时抛出）。
   *
   * 档位 **409**（不是 400）：这不是"参数写错了"，而是**与资源当前状态冲突** ——
   *   该行已出运完成但总量低于合同下限，按业务规则必须先经「客户同意少发」的审批才能确认出运。
   *   ★ 与 MOQ 豁免（同族"业务规则阻断"）同档，前端可按码给出"发起/查看审批单"的入口。
   * 业务后果（不拦会怎样）：少发的货一旦确认出运并结案，客户可能拒收/索赔，
   *   而系统里**看不出**"这一票是少发的"（`ShipmentOrderAllocation.status='ShortShipped'` 全仓无人写）。
   */
  ORDER_LINE_SHORT_SHIPPED: { status: 409, message: '该订单行已出运完成，但总量低于合同约定的下限（短装）；需先反映客户、客户同意少发，经审批确认后方可出运。' },

  /**
   * ★★ 2026-09-29 晚（使用方口径）：「不存在**不知道数量**又要发起出运的情况……如果现在是不知道数量就能出运，
   *   那就是中间有巨大的缺口存在。」⇒ 下面两枚码把这个缺口堵在**确认出运**这一步。
   *
   * ⚠️ 与上面那枚的**本质区别**（写在这里免得下一个人混用）：
   *   · `ORDER_LINE_SHORT_SHIPPED` = **事实清楚**（就是少了），缺的是**客户同意** ⇒ 走审批单放行；
   *   · 这两枚 = **事实还不清楚**（数量没录 / 没有明细）⇒ **不许**用审批单放行 ——
   *     审批单解决不了"数据没填"；用它绕过，等于把"不知道发了多少"洗成"客户同意少发"。
   */
  SHIPMENT_ACTUAL_QTY_MISSING: { status: 409, message: '本票的出运明细里实际出运量未填：出运前必须先有清单/清点数量（划码、装柜清单），否则系统无法知道实际发了多少，也无法判定是否短装。请先填写实际出运量再确认出运。' },
  SHIPMENT_NO_ALLOCATION_DETAIL: { status: 409, message: '本票没有任何出运明细：确认出运前必须先录明细（发哪些订单行、各多少），否则这张票发出去了也不知道发了什么。请先录入出运明细再确认出运。' },

  /**
   * ★★ 2026-09-29 晚补齐：`ShipmentMutationErrorCode` 里还有 6 枚码**此前根本没有登记**，
   *   而 `shipping/route.ts` 的 PATCH 出口已改成"本地表查不到就问注册表、缺码即抛"（B68 口径）。
   *   ⇒ 不登记它们，这些码一旦真的返回就会**从 500 变成抛错**（更糟：那是路由回不到响应）。
   *
   * ★ 顺带修掉一处**既有的档位错误**：这批码原先一律经 `|| 500` 渲染，
   *   于是一句"运输方式不合法"（用户改一下就能好）会被显示成"服务器内部错误"。
   *   校验类 ⇒ 400；失败类 ⇒ 500 —— 与 MOQ/短装那族的"业务规则阻断 = 409"并列。
   */
  INVALID_INITIAL_STATUS: { status: 400, message: '运单的初始状态不合法，请从草稿或已订舱等合法起点创建。' },
  INVALID_SHIPMENT_STATUS: { status: 400, message: '运单状态不合法（不在允许的枚举内），请刷新后重试。' },
  INVALID_SHIPPING_METHOD: { status: 400, message: '运输方式不合法，请从下拉里选择（如海运/空运/客户自提），不支持手写别名。' },
  CREATE_FAILED: { status: 500, message: '运单创建失败，请重试；若反复失败请联系管理员查看服务端日志。' },
  DELETE_FAILED: { status: 500, message: '运单删除失败，请重试；若反复失败请联系管理员查看服务端日志。' },
  COMMIT_TRANSACTION_FAILED: { status: 500, message: '事务提交失败：本次改动已整体回滚，未产生半截数据，请重试。' },
  COMMIT_REPLAY_BLOCKED: { status: 409, message: '原开票请求结果尚未能准确核对，请保留原请求并核对原单，不要重复开票。' },
};

export function lookupErrorCode(code: unknown): ErrorCodeSpec | undefined {
  if (typeof code !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code)
    ? ERROR_CODES[code]
    : undefined;
}

/**
 * B68-1（v2.46）· **服务层抛出"自带档"错误的唯一构造器**（原先只有 `risk/riskService.ts` 里一份私有实现，
 * 现在第二个域也要用 ⇒ 上收到这里，避免同一件事两处实现）。
 *
 * 为什么要它：`shared/bizStatus.statusFromError` 的第 1、2 档（自带 `statusCode` / 已登记 `code`）
 * 只在错误**带着码逃出服务层**时才可用的；服务层只 `throw new Error('中文文案')` 的话，
 * 路由就只能回头去猜文本 —— 那正是 B68 的病灶。**先补码再换出口**，不给关键词表加词凑数。
 *
 * ⚠️ 注册表缺码 = 编程错误 ⇒ **开发期直接炸**，绝不静默兜成 200/500 把文案吞掉。
 */
/**
 * ★ 参数没做成字面量联合的原因（v2.47 复核 minor-5）：`ERROR_CODES` 现在带 `Record<string, ErrorCodeSpec>`
 *   标注 ⇒ `keyof typeof` 退化成 `string`，写了也不产生约束；去掉那行标注能拿到字面量，但那会让全仓
 *   `ERROR_CODES[某个 string 变量]` 的索引写法集体报错（改动面远超本批）。
 *   兜住"两个 string 参数写反"的其实是**下面那句未登记即抛**：反了 ⇒ `lookupErrorCode('中文文案')` 取不到 ⇒ 当场抛，
 *   不会静默给一个默认档 —— 这正是当初不留 `?? 400` 默认值的原因。
 */
/** Actual factory origin, kept separate from the legacy public shape classifier. */
export type BusinessErrorMint = Readonly<{ code: string; statusCode: number; message: string }>;
const businessErrorMints = new WeakMap<object, BusinessErrorMint>();
export function readBusinessErrorMint(error: unknown): BusinessErrorMint | null {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null;
  return businessErrorMints.get(error as object) ?? null;
}

export function businessError(
  code: string,
  message: string,
): Error & { code: string; statusCode: number } {
  const spec = lookupErrorCode(code);
  if (!spec) throw new Error(`errorCodes 注册表缺少业务码 ${code}（抛出方声明了未登记的码）`);
  const error = Object.assign(new Error(message), { code, statusCode: spec.status });
  businessErrorMints.set(error, Object.freeze({ code, statusCode: error.statusCode, message: error.message }));
  return error;
}

/**
 * 只取档位、不构造错误：给「不抛错、直接 `res.status(...).json(...)` 回响应」那类出口用。
 *
 * ★ 为什么要有它（v2.47 复核 I-3）：这类调用点原先各写一份 `lookupErrorCode(code)?.status ?? 500`，
 *   于是 ① **注册表之外又出现了一个状态码数字**（台账声称"档位数值只在注册表"这句话就不成立了），
 *   ② 同一枚未登记的码在两条路径上失败方式不同（抛错路径当场炸，这里静默答 500）。
 *   现在两条路径同一个契约：**缺码即抛 = 编程错误**，绝不静默给一个默认档。
 */
export function httpStatusOfCode(code: string): number {
  const spec = lookupErrorCode(code);
  if (!spec) throw new Error(`errorCodes 注册表缺少业务码 ${code}（调用方声明了未登记的码）`);
  return spec.status;
}

export interface ResolvedRouteError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/** 业务错误的形状（`code` / `statusCode` 是判据，其余三项是透传时要读的字段） */
export interface BusinessErrorShape {
  code: string;
  statusCode: number;
  message?: unknown;
  details?: unknown;
  gateDetails?: unknown;
}

/**
 * 本仓「有意抛给用户的业务错误」的**唯一形状判据**：`code:string` + `statusCode:number` 同时存在。
 *
 * 抽成导出的原因：`resolveError`、`shared/routeError`、`lib/asyncHandler` 都要用它 ——
 * 判据只能有一份。`routeError` 此前自己抄走了一份（内容暂时相同，但两处各一份迟早改一处漏一处），
 * `asyncHandler` 的 body-parser 排除式原来是第二份，本次一并改引这里。
 *
 * 它**只认类型，不认码名**：因此 `details` 是无条件随附的（不存在「只有登记过的码才允许带明细」这层开关，
 * 曾经的 `allowsDetails` 字段就是这种假象，已删）。真正的护栏是本判据 + 码由产出方自带。
 */
export function isBusinessError(e: unknown): e is BusinessErrorShape {
  const err = e as { code?: unknown; statusCode?: unknown } | null | undefined;
  return typeof err?.code === 'string' && typeof err?.statusCode === 'number';
}

/**
 * 把任意被捕获的值解析成「可安全外发」的错误。
 * 日志由调用方负责（本函数不记日志，也不吞原始错误 —— 保持既有日志行为不变）。
 */
export function resolveError(e: unknown, fallbackCode: string): ResolvedRouteError {
  // 1) 业务错误：本仓约定 code(string) + statusCode(number) 同时存在
  if (isBusinessError(e)) {
    const details = e.details ?? e.gateDetails;
    return {
      status: e.statusCode,
      code: e.code,
      message: String(e.message ?? e.code),
      ...(details === undefined ? {} : { details }),
    };
  }

  // 2) 未预期：按 fallback 码查表出文案；查不到 → 通用文案
  const spec = lookupErrorCode(fallbackCode);
  return {
    status: spec?.status ?? 500,
    code: fallbackCode,
    message: spec?.message ?? GENERIC_ROUTE_ERROR_MESSAGE,
  };
}
