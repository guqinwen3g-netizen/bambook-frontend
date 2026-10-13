const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {validateUpgradeContract,verifyProfessionalQcUpgrade}=require('./acceptance-upgrade-contract.cjs');
const migration='server/prisma/migrations/20261007200000_development_version_gates/migration.sql';
const schema='artifacts/acceptance-20261007/global-goal/schema-before.prisma';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
test('WIP upgrade uses a hashed regular pre-change schema and never guesses it from Git HEAD',()=>{
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'bambook-upgrade-contract-'));
  try {
    const file=path.join(repo,schema);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'prior working schema');
    const upgrade={fromSchema:{file:schema,sha256:digest('prior working schema')},migrations:[migration]};
    assert.deepEqual(validateUpgradeContract(repo,upgrade,true).extraFiles,[schema]);
    assert.throws(()=>validateUpgradeContract(repo,upgrade,false),/explicit WIP snapshot/);
    assert.throws(()=>validateUpgradeContract(repo,{...upgrade,fromHead:'a'.repeat(40)},true),/Invalid reviewed/);
    fs.writeFileSync(file,'later changed schema');
    assert.throws(()=>validateUpgradeContract(repo,upgrade,true),/input changed/);
  } finally {fs.rmSync(repo,{recursive:true,force:true});}
});
test('unreviewed schema paths and migration traversal cannot become upgrade inputs',()=>{
  assert.throws(()=>validateUpgradeContract('/private/tmp',{fromSchema:{file:'server/.env',sha256:'a'.repeat(64)},migrations:[migration]},true),/reviewed repository path/);
  assert.throws(()=>validateUpgradeContract('/private/tmp',{fromHead:'a'.repeat(40),migrations:['server/prisma/migrations/../../other.sql']},false),/Invalid reviewed/);
  assert.throws(()=>validateUpgradeContract('/private/tmp',{fromHead:'a'.repeat(40),migrations:[migration,migration]},false),/Invalid reviewed/);
});
test('professional QC upgrade preserves every old grant and only adds the reviewed execution permission',()=>{
  const before={permissions:[{id:'read',scope:'qc:read'}],grants:[{id:'old',roleId:'role-sales',permissionId:'read'}],
    roles:[{id:'role-qc',isSystem:true},{id:'role-super-admin',isSystem:true},{id:'role-sales',isSystem:true}]};
  const after={...before,permissions:[...before.permissions,{id:'inspect',scope:'qc:inspect'}],grants:[...before.grants,
    {id:'q',roleId:'role-qc',permissionId:'inspect'},{id:'s',roleId:'role-super-admin',permissionId:'inspect'}]};
  assert.deepEqual(verifyProfessionalQcUpgrade(before,after),{addedPermissions:1,addedRoleGrants:2});
  assert.throws(()=>verifyProfessionalQcUpgrade(before,{...after,grants:[...after.grants,{id:'sales',roleId:'role-sales',permissionId:'inspect'}]}),/unreviewed professional QC grant/);
  assert.throws(()=>verifyProfessionalQcUpgrade(before,{...after,permissions:[...after.permissions,{id:'bad',scope:'finance:write'}]}),/unreviewed permission/);
  assert.throws(()=>verifyProfessionalQcUpgrade(before,{...after,grants:after.grants.filter(g=>g.id!=='old')}),/original authorization row/);
  assert.throws(()=>verifyProfessionalQcUpgrade(before,{...after,grants:after.grants.filter(g=>g.id!=='q')}),/missing professional QC grant/);
});
