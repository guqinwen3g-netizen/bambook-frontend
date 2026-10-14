/**
 * Mist 财务动作沿用岗位矩阵里已有的财务权限点（财务岗位持有，业务岗位没有）：
 * - 收付款凭证录入 vouchers:write：导入到账流水、登记付款凭证、登记供应商付款；
 * - 发票核销 invoices:reconcile：收款核销、采纳匹配建议、付款分配到应付、资金归属；
 * - 发票创建/登记 invoices:write：登记/作废供应商票据。
 * 原先使用的 'finance:write' 不在权限矩阵中，只有超级管理员能通过，财务岗位反而办不了。
 */
export const MIST_FINANCE_SCOPES = { voucher: 'vouchers:write', reconcile: 'invoices:reconcile', invoice: 'invoices:write' } as const;
export const MIST_FINANCE_WRITE_PERMISSIONS: string[] = Object.values(MIST_FINANCE_SCOPES);