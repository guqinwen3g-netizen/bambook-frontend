-- requireRole(owner/admin/manager) gates move to permission scopes. Grants mirror
-- the former role groups exactly (owner=role-super-admin, admin=role-admin,
-- manager=role-sales-manager), so no existing account gains or loses access.
-- Ids follow scripts/seed-rbac.ts so a later seed run upserts the same rows.
INSERT INTO "Permission" ("id", "scope", "description") VALUES
  ('perm_business_delete', 'business:delete', '业务记录删除（订单、货运单及分配、关系档案；原 owner/admin/manager 角色组）'),
  ('perm_emails_maintenance_write', 'emails:maintenance:write', '邮件历史维护（关联回填/分类回填）'),
  ('perm_agent_approvals_approve', 'agent:approvals:approve', 'Agent 待批工具调用的批准/驳回')
ON CONFLICT ("scope") DO NOTHING;

INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT 'rp_' || replace(r."id", '-', '_') || '__' || p."id", r."id", p."id"
FROM "Role" r CROSS JOIN "Permission" p
WHERE r."id" IN ('role-super-admin', 'role-admin', 'role-sales-manager') AND r."isSystem" = TRUE
  AND p."scope" IN ('business:delete', 'emails:maintenance:write', 'agent:approvals:approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
