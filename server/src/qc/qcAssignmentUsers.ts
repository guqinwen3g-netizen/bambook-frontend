import { Prisma } from '@prisma/client';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasActualQcScope } from './qcExecutionScope';
import type { TokenPayload } from '../auth/service';
import { currentQcAssignmentActor, QcAssignmentError } from './qcAssignmentAccess';
import { isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';

export interface QcAssignmentUserOption { id: string; displayName: string; departmentName: string | null }
const canExecute = (actor: TokenPayload) => hasActualQcScope(actor, 'qc:read')
  && hasActualQcScope(actor, 'qc:inspect');
const name = (user: any): QcAssignmentUserOption => ({ id: user.id,
  displayName: user.displayName?.trim() || '未命名员工', departmentName: user.primaryDepartment?.name ?? null });
const unavailable = () => new QcAssignmentError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验执行人员，请稍后重试。');

/** Actual effective grants, independent of role labels or the dispatcher's token. */
export async function assertQcAssignmentUser(tx: any, id: string,
  chainScope?: 'qc:fabric_chain:write' | 'qc:garment_chain:write' | null): Promise<void> {
  if (typeof id !== 'string' || !id.trim()) throw new QcAssignmentError('VALIDATION_FAILED', 'qcUserId 必填');
  if (chainScope === null) throw new QcAssignmentError('VALIDATION_FAILED', '须先明确订单业务线，才能选择专业检验执行人。');
  try {
    // Order/source -> Assignment locks precede this recipient/account lock.
    // SHARE conflicts with non-key status UPDATE; KEY SHARE would not.
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "UserAccount" WHERE "id" = ${id} FOR SHARE`);
    if (!rows.length) throw new QcAssignmentError('NOT_FOUND', 'QC 人员不存在');
    // Keep the actual grant sources stable until commit. Revocation which won
    // a lock first is observed by the subsequent current-DB reload.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "UserRole" WHERE "userId" = ${id} ORDER BY "id" FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT r."id" FROM "Role" r WHERE r."id" IN
      (SELECT "roleId" FROM "UserRole" WHERE "userId" = ${id}) ORDER BY r."id" FOR SHARE OF r`);
    await tx.$queryRaw(Prisma.sql`SELECT rp."id" FROM "RolePermission" rp WHERE rp."roleId" IN
      (SELECT "roleId" FROM "UserRole" WHERE "userId" = ${id}) AND rp."permissionId" IN
      (SELECT "id" FROM "Permission" WHERE "scope" IN ('qc:read', 'qc:inspect', 'qc:fabric_chain:write', 'qc:garment_chain:write', '*')) ORDER BY rp."id" FOR SHARE OF rp`);
    await tx.$queryRaw(Prisma.sql`SELECT p."id" FROM "Permission" p WHERE p."id" IN
      (SELECT "permissionId" FROM "RolePermission" WHERE "roleId" IN
        (SELECT "roleId" FROM "UserRole" WHERE "userId" = ${id})) AND p."scope" IN ('qc:read', 'qc:inspect', 'qc:fabric_chain:write', 'qc:garment_chain:write', '*') ORDER BY p."id" FOR SHARE OF p`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "UserPermissionOverrides" WHERE "userId" = ${id} AND "scope" IN ('qc:read', 'qc:inspect', 'qc:fabric_chain:write', 'qc:garment_chain:write', '*') ORDER BY "id" FOR SHARE`);
    const user = await loadUserWithRoles(tx, id);
    if (!user || user.deletedAt != null) throw new QcAssignmentError('NOT_FOUND', 'QC 人员不存在');
    if (user.status !== 'active') throw new QcAssignmentError('VALIDATION_FAILED', 'QC 人员必须是 active 状态');
    const actor = await buildLoadedAuthTokenPayload(tx, user);
    if (!canExecute(actor)) {
      throw new QcAssignmentError('VALIDATION_FAILED', '执行人员当前必须有验货查看和专业检验权限，请重新选择。');
    }
    if (chainScope && !hasActualQcScope(actor, chainScope)) {
      throw new QcAssignmentError('VALIDATION_FAILED', '执行人员当前没有该订单业务线的专业 QC 权限，请重新选择。');
    }
  } catch (error) {
    if (error instanceof QcAssignmentError) throw error;
    if (isOrderLineStorageConflict(error)) throw new QcAssignmentError('CONFLICT', '执行人员正在被修改，请重新读取后重试。');
    throw unavailable();
  }
}

/** A QC business directory, never an HR account-list envelope. */
export async function listQcAssignmentUsers(db: any, prior: TokenPayload) {
  try {
    return await db.$transaction(async (tx: any) => {
      await currentQcAssignmentActor(tx, prior, 'qc:write');
      const candidates = await tx.userAccount.findMany({ where: { status: 'active', deletedAt: null },
        select: { id: true }, orderBy: { id: 'asc' } });
      const users: QcAssignmentUserOption[] = [];
      for (const candidate of candidates) {
        const user = await loadUserWithRoles(tx, candidate.id);
        if (!user || user.status !== 'active' || user.deletedAt != null) continue;
        if (canExecute(await buildLoadedAuthTokenPayload(tx, user))) users.push(name(user));
      }
      await currentQcAssignmentActor(tx, prior, 'qc:write');
      return { ok: true, users };
    });
  } catch (error) { if (error instanceof QcAssignmentError) throw error; throw unavailable(); }
}

/** Names belong only to already-authorized actual assignment rows. This is
 * not a company directory and does not alter the assignment visibility query. */
export async function attachQcAssignmentUsers<T extends { qcUserId: string | null }>(tx: any, rows: T[]): Promise<Array<T & { qcUser: { id: string; displayName: string } | null }>> {
  const ids = [...new Set(rows.map(row => row.qcUserId).filter((id): id is string => typeof id === 'string'))];
  const users = ids.length ? await tx.userAccount.findMany({ where: { id: { in: ids }, deletedAt: null },
    select: { id: true, displayName: true } }) : [];
  const names = new Map<string, { id: string; displayName: string }>(users.map((user: any) =>
    [user.id, { id: user.id, displayName: user.displayName?.trim() || '未命名员工' }]));
  return rows.map(row => ({ ...row, qcUser: row.qcUserId ? names.get(row.qcUserId) ?? null : null }));
}
