-- Preserve existing grants; separate professional execution from dispatch.
INSERT INTO "Permission" ("id", "scope", "description")
VALUES ('permission-qc-inspect', 'qc:inspect', '专业 QC 检验与正式样品评审执行')
ON CONFLICT ("scope") DO NOTHING;

INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT 'role-permission-qc-inspect-' || r."id", r."id", p."id"
FROM "Role" r CROSS JOIN "Permission" p
WHERE r."id" IN ('role-qc', 'role-super-admin') AND r."isSystem" = TRUE AND p."scope" = 'qc:inspect'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
