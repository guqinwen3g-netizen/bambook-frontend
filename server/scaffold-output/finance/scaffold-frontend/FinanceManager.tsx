/**
 * 财务管理 前端模块骨架
 * 由 scaffold-module.ts 生成于 2026-06-15T00:39:31.883Z.
 *
 * 契约钩子（来自 docs/MODULE_CONTRACT.md）：
 *   - L8.1 路由注册：在 moduleRegistry 加 { id: 'finance', label: '财务管理', view: FinanceManager }
 *   - L8.2 跨模块跳转：DetailPanel "关联视图"卡片需要识别本模块的 entity type
 *   - L8.3 i18n：把 displayName 抽到 i18n key 'finance.title'
 */
import React from 'react';

export const FinanceManager: React.FC = () => {
  return (
    <div className="finance-manager">
      <h1>财务管理</h1>
      <p>TODO[L8]: 列表 + 详情 + 创建表单</p>
    </div>
  );
};

export default FinanceManager;
