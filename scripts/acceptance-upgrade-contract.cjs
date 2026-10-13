'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateUpgradeContract(repo, upgrade, workingSource) {
  if (!upgrade) return { extraFiles: [] };
  const fromHead = typeof upgrade.fromHead === 'string' && /^[a-f0-9]{40}$/.test(upgrade.fromHead);
  const fromSchema = upgrade.fromSchema != null;
  if (Number(fromHead) + Number(fromSchema) !== 1 || upgrade.fromHead != null && !fromHead
    || upgrade.professionalQcScope != null && upgrade.professionalQcScope !== true
    || !Array.isArray(upgrade.migrations) || !upgrade.migrations.length
    || new Set(upgrade.migrations).size !== upgrade.migrations.length
    || upgrade.migrations.some(file => typeof file !== 'string' || !/^server\/prisma\/migrations\/[a-zA-Z0-9_]+\/migration\.sql$/.test(file))) {
    throw Error('Invalid reviewed schema upgrade contract');
  }
  const extraFiles = [];
  const checked = (value, pattern) => {
    if (!value || !pattern.test(value.file) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw Error('Upgrade input must have a reviewed repository path and content hash');
    }
    const absolute = path.join(repo, value.file), stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(fs.readFileSync(absolute)) !== value.sha256) {
      throw Error('Reviewed upgrade input changed or is not a regular file');
    }
    extraFiles.push(value.file);
  };
  if (fromSchema) {
    if (!workingSource || upgrade.restorePrivateUi) throw Error('A working-schema upgrade requires an explicit WIP snapshot and no data restore');
    checked(upgrade.fromSchema, /^artifacts\/acceptance-20261007\/global-goal\/schema-before\.prisma$/);
  }
  if (upgrade.syntheticLegacySql) checked(upgrade.syntheticLegacySql, /^server\/acceptance-tests\/fixtures\/legacy-version-upgrade\.sql$/);
  return { extraFiles };
}
// The only reviewed authorization addition is professional QC execution.
function verifyProfessionalQcUpgrade(before, after) {
  for (const key of ['permissions', 'grants', 'roles']) {
    const current = new Map(after[key].map(row => [row.id, row]));
    for (const row of before[key]) {
      if (JSON.stringify(row) !== JSON.stringify(current.get(row.id))) throw Error('Migration changed an original authorization row');
    }
  }
  const oldPermissions = new Set(before.permissions.map(row => row.id));
  const addedPermissions = after.permissions.filter(row => !oldPermissions.has(row.id));
  if (addedPermissions.some(row => row.scope !== 'qc:inspect')) throw Error('Migration added an unreviewed permission');
  const permission = after.permissions.filter(row => row.scope === 'qc:inspect');
  if (permission.length !== 1) throw Error('Professional QC permission must exist exactly once');
  const eligibleRoles = new Set(after.roles.filter(row => row.isSystem === true && ['role-qc', 'role-super-admin'].includes(row.id)).map(row => row.id));
  const oldGrants = new Set(before.grants.map(row => row.id));
  const addedGrants = after.grants.filter(row => !oldGrants.has(row.id));
  if (addedGrants.some(row => row.permissionId !== permission[0].id || !eligibleRoles.has(row.roleId))) {
    throw Error('Migration added an unreviewed professional QC grant');
  }
  for (const roleId of eligibleRoles) {
    if (!after.grants.some(row => row.roleId === roleId && row.permissionId === permission[0].id)) throw Error('Migration is missing professional QC grant');
  }
  return { addedPermissions: addedPermissions.length, addedRoleGrants: addedGrants.length };
}
module.exports = { validateUpgradeContract, verifyProfessionalQcUpgrade };
