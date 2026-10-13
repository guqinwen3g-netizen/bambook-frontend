import { View } from '../types';
import { VIEW_TO_MAIN_SCOPES } from './rolePermissionMatrix';

export type ViewPermissionPolicy = 'public-authenticated' | 'permission' | 'dev-only' | 'role';

export type ViewPermissionDefinition = {
  policy: ViewPermissionPolicy;
  required?: string;
  roles?: readonly string[];
};

/**
 * 视图访问策略覆盖（仅非 permission 类）。
 * permission 视图的 required scope 一律派生自真源 VIEW_TO_MAIN_SCOPES[view].read
 * （lib/rolePermissionMatrix.ts）——2026-08-27 W-C 起不再允许本文件手写 scope，
 * 从机制上根除「视图门族 scope vs 矩阵域 scope」双源漂移（走查曾挖出 19 处）。
 */
const VIEW_POLICY_OVERRIDES: Partial<Record<View, ViewPermissionDefinition>> = {
  // 落地页与账号设置：任何登录用户可达
  [View.Dashboard]: { policy: 'public-authenticated' },
  // Company V1 personal home; domain data remain guarded by their original scopes.
  [View.Cockpit]: { policy: 'public-authenticated' },
  [View.Settings]: { policy: 'public-authenticated' },
  [View.AccountSettings]: { policy: 'public-authenticated' },
  // 日历页（2026-09-02 新增）：业务节点总览，任何登录用户可达（聚合数据各自页面另有门禁）
  [View.Calendar]: { policy: 'public-authenticated' },
  // 开发实验视图：仅 dev 环境
  [View.UiLab]: { policy: 'dev-only' },
};

function buildViewPermissionDefinitions(): Record<View, ViewPermissionDefinition> {
  const defs = {} as Record<View, ViewPermissionDefinition>;
  for (const view of Object.values(View)) {
    const override = VIEW_POLICY_OVERRIDES[view];
    if (override) {
      defs[view] = override;
    } else {
      const read = VIEW_TO_MAIN_SCOPES[view]?.read;
      if (!read) throw new Error(`VIEW_TO_MAIN_SCOPES 缺 ${view} 的 read scope（视图门禁无法派生）`);
      defs[view] = { policy: 'permission', required: read };
    }
  }
  return defs;
}

export const VIEW_PERMISSION_DEFINITIONS: Record<View, ViewPermissionDefinition> = buildViewPermissionDefinitions();

export function getViewPermissionDefinition(view: View): ViewPermissionDefinition {
  return VIEW_PERMISSION_DEFINITIONS[view];
}

export function getViewPermission(view: View): string | undefined {
  const permissions = getViewPermissionDefinition(view);
  return permissions.policy === 'permission' ? permissions.required : undefined;
}

export function isAuthenticatedPublicView(view: View): boolean {
  return getViewPermissionDefinition(view).policy === 'public-authenticated';
}

export function isDevOnlyView(view: View): boolean {
  return getViewPermissionDefinition(view).policy === 'dev-only';
}
