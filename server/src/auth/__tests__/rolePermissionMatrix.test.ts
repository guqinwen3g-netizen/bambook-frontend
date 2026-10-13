/**
 * rolePermissionMatrix.test.ts — 角色容器回归测试（DR-041 QC/后勤内置 + GAP-R11 FinMan 删除收编）
 *
 * 锁定契约：
 *   1. 7 个系统内置角色（GAP-R11：FinanceManager 已删除）在 SYSTEM_ROLE_META /
 *      DEFAULT_ROLE_PERMISSION_MATRIX / DEFAULT_DATA_SCOPE_BY_ROLE 三处注册完整
 *   2. GAP-R11 位移闭合：FinMan 原独有 scope 全部在新落点（SM/Finance/Admin/QC/Logistics）
 *   3. QC_BASE / LOGISTICS_BASE 引用的 scope 全部存在于 PERMISSION_SCOPES（否则 seed 静默跳过）
 *   4. ROLE_ID_TO_LEGACY_AGENT_ROLE 覆盖全部 7 个系统角色（登录写 JWT legacy roles 链路闭合）
 *   5. SYSTEM_ROLE_META 描述无 "≤5万 / >5万" 阈值残留（审批阈值分级已废止，统一走审批策略）
 *   6. 双文件逐字同步守卫（GAP-R2）：根 lib/rolePermissionMatrix.ts 与
 *      server/src/_shared/rolePermissionMatrix.ts 自 SYSTEM_ROLE_IDS 定义起至文件末尾逐字一致
 *      —— 此前发生过副本漂移导致 seed 与运行时守卫判定冲突，此处固化为测试断言
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_META,
  PERMISSION_SCOPES,
  DEFAULT_ROLE_PERMISSION_MATRIX,
  DEFAULT_DATA_SCOPE_BY_ROLE,
  getDefaultScopeListForRole,
  type SystemRoleId,
} from '../../_shared/rolePermissionMatrix';
import { ROLE_ID_TO_LEGACY_AGENT_ROLE } from '../permissionService';

const ALL_SYSTEM_ROLE_IDS = Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[];

describe('系统内置角色注册（DR-041 + GAP-R11）', () => {
  it('系统内置角色共 7 个（含 role-qc / role-logistics；无 role-finance-manager）', () => {
    expect(ALL_SYSTEM_ROLE_IDS).toHaveLength(7);
    expect(SYSTEM_ROLE_IDS.QC).toBe('role-qc');
    expect(SYSTEM_ROLE_IDS.LOGISTICS).toBe('role-logistics');
    expect(ALL_SYSTEM_ROLE_IDS).not.toContain('role-finance-manager');
    expect((SYSTEM_ROLE_IDS as Record<string, string>).FINANCE_MANAGER).toBeUndefined();
  });

  it('7 角色在 META / 权限矩阵 / 行级范围三处注册完整', () => {
    for (const roleId of ALL_SYSTEM_ROLE_IDS) {
      expect(SYSTEM_ROLE_META[roleId], `SYSTEM_ROLE_META 缺 ${roleId}`).toBeDefined();
      expect(DEFAULT_ROLE_PERMISSION_MATRIX[roleId], `DEFAULT_ROLE_PERMISSION_MATRIX 缺 ${roleId}`).toBeDefined();
      expect(DEFAULT_DATA_SCOPE_BY_ROLE[roleId], `DEFAULT_DATA_SCOPE_BY_ROLE 缺 ${roleId}`).toBeDefined();
    }
  });

  it('GAP-R11 位移闭合：FinMan 原独有 scope 全部在新落点，无 capability 丢失', () => {
    const sm = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.SALES_MANAGER);
    const fin = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.FINANCE);
    const admin = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.ADMIN);
    const qc = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.QC);
    const logistics = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.LOGISTICS);
    // SM：本团队小单付款审批 + 价格双签之一 + BOM 共享 + 付款申请审批
    for (const s of ['vouchers:approve:pay_lt5', 'orders:approve:change_price', 'bom:admin', 'finance:payment_request:approve']) {
      expect(sm, `SALES_MANAGER 缺 ${s}`).toContain(s);
    }
    // Finance：佣金可见 + 退税审批（财务专业合规工作）
    for (const s of ['sensitive:commission', 'tax:approve']) {
      expect(fin, `FINANCE 缺 ${s}`).toContain(s);
    }
    // Admin（总领导）：大单付款/首单+1级/坏账核销/订单取消/风控总监级/定价管理员级/审计导出
    for (const s of ['vouchers:approve:pay_gt5', 'vouchers:approve:pay_new_supplier', 'invoices:approve:writeoff', 'orders:approve:cancel', 'risk:admin', 'pricing:admin', 'audit:export']) {
      expect(admin, `ADMIN 缺 ${s}`).toContain(s);
    }
    // QC：BOM 共享管理权；Logistics：单证模板/签章配置
    expect(qc).toContain('bom:admin');
    expect(logistics).toContain('customs:admin');
  });

  it('财务禁止拥有业务审批 scope（审批/执行分离铁律）', () => {
    const fin = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.FINANCE);
    for (const denied of ['vouchers:approve:pay_lt5', 'vouchers:approve:pay_gt5', 'vouchers:approve:pay_new_supplier', 'invoices:approve:writeoff', 'orders:approve:cancel', 'risk:admin', 'pricing:admin', 'audit:export']) {
      expect(fin, `FINANCE 不得持有 ${denied}`).not.toContain(denied);
    }
  });

  it('QC 容器：qc:read/write 可写 + 订单/产品/生产/运单/报关只读', () => {
    const scopes = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.QC);
    expect(scopes).toContain('qc:read');
    expect(scopes).toContain('qc:write');
    for (const ro of ['orders:read', 'products:read', 'production:read', 'shipments:read', 'customs:read']) {
      expect(scopes).toContain(ro);
    }
    // 业务域不可写
    for (const denied of ['orders:write', 'shipments:write', 'customs:write']) {
      expect(scopes).not.toContain(denied);
    }
  });

  it('专业检验执行与业务派单分开授权', () => {
    expect(getDefaultScopeListForRole(SYSTEM_ROLE_IDS.QC)).toContain('qc:inspect');
    for (const role of [SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.SALES_MANAGER, SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.LOGISTICS]) {
      expect(getDefaultScopeListForRole(role)).not.toContain('qc:inspect');
    }
  });

  it('后勤容器：shipments:write + customs:write 可写 + 订单/产品/生产只读', () => {
    const scopes = getDefaultScopeListForRole(SYSTEM_ROLE_IDS.LOGISTICS);
    for (const w of ['shipments:read', 'shipments:write', 'customs:read', 'customs:write']) {
      expect(scopes).toContain(w);
    }
    for (const ro of ['orders:read', 'products:read', 'production:read']) {
      expect(scopes).toContain(ro);
    }
    expect(scopes).not.toContain('orders:write');
    expect(scopes).not.toContain('qc:write');
  });

  it('采购与库存是业务模块：业务员和业务主管可按对象范围经办', () => {
    for (const role of [SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.SALES_MANAGER]) {
      const scopes = getDefaultScopeListForRole(role);
      for (const scope of ['procurement:read', 'procurement:write', 'inventory:read', 'inventory:write']) {
        expect(scopes, `${role} 缺 ${scope}`).toContain(scope);
      }
    }
  });

  it('QC/后勤矩阵引用的 scope 全部存在于 PERMISSION_SCOPES（seed 不得静默跳过）', () => {
    for (const roleId of [SYSTEM_ROLE_IDS.QC, SYSTEM_ROLE_IDS.LOGISTICS] as SystemRoleId[]) {
      for (const scope of getDefaultScopeListForRole(roleId)) {
        expect(
          Object.prototype.hasOwnProperty.call(PERMISSION_SCOPES, scope),
          `角色 ${roleId} 引用未定义 scope：${scope}`,
        ).toBe(true);
      }
    }
  });

  it('GAP-R11 位移落点引用的 scope 全部存在于 PERMISSION_SCOPES', () => {
    for (const roleId of ALL_SYSTEM_ROLE_IDS) {
      for (const scope of getDefaultScopeListForRole(roleId)) {
        expect(
          Object.prototype.hasOwnProperty.call(PERMISSION_SCOPES, scope),
          `角色 ${roleId} 引用未定义 scope：${scope}`,
        ).toBe(true);
      }
    }
  });

  it('ROLE_ID_TO_LEGACY_AGENT_ROLE 覆盖全部 7 个系统角色', () => {
    for (const roleId of ALL_SYSTEM_ROLE_IDS) {
      expect(ROLE_ID_TO_LEGACY_AGENT_ROLE[roleId], `legacy 映射缺 ${roleId}`).toBeDefined();
    }
    expect(ROLE_ID_TO_LEGACY_AGENT_ROLE[SYSTEM_ROLE_IDS.QC]).toBe('viewer');
    expect(ROLE_ID_TO_LEGACY_AGENT_ROLE[SYSTEM_ROLE_IDS.LOGISTICS]).toBe('logistics');
    expect(Object.values(ROLE_ID_TO_LEGACY_AGENT_ROLE)).toHaveLength(7);
  });

  it('SYSTEM_ROLE_META 描述无 ≤5万/>5万 阈值残留', () => {
    for (const roleId of ALL_SYSTEM_ROLE_IDS) {
      const { description } = SYSTEM_ROLE_META[roleId];
      expect(description, `${roleId} description 残留阈值`).not.toMatch(/[≤＞>]?\s*5\s*万/);
      expect(description).not.toContain('≤5万');
      expect(description).not.toContain('>5万');
    }
  });
});

describe('GAP-R2 双文件逐字同步守卫', () => {
  it('根 lib 真源与 server/_shared 副本自 SYSTEM_ROLE_IDS 起逐字一致', () => {
    // server/src/auth/__tests__/ → 仓库根：向上 4 级（__tests__→auth→src→server→根）
    const repoRoot = path.resolve(__dirname, '../../../..');
    const rootFile = readFileSync(path.join(repoRoot, 'lib/rolePermissionMatrix.ts'), 'utf8');
    const sharedFile = readFileSync(path.join(repoRoot, 'server/src/_shared/rolePermissionMatrix.ts'), 'utf8');
    const MARKER = 'export const SYSTEM_ROLE_IDS';
    const rootBody = rootFile.slice(rootFile.indexOf(MARKER));
    const sharedBody = sharedFile.slice(sharedFile.indexOf(MARKER));
    expect(rootBody.length).toBeGreaterThan(0);
    expect(sharedBody).toBe(rootBody);
  });
});
