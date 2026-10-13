import{describe,it,expect,vi}from'vitest';import{authorizeDevelopmentConversion,conversionAuthorityRead,currentConversionActor,lockExistingConversionOrder}from'../developmentConversionAuthority';
function fixture(){const scopes=['products:write','quotations:write','products:read','orders:read'];const user:any={id:'sales',status:'active',deletedAt:null,primaryDeptId:null,roles:[{roleId:'role-sales',role:{id:'role-sales',permissions:scopes.map(scope=>({permission:{scope}}))}}]};const customer:any={id:'customer',ownerId:'sales',salesRepIds:[],deletedAt:null};const development:any={id:'case',type:'garment',customerRelationId:'customer',deletedAt:null};let shared:string|null=null;const db:any={userAccount:{findFirst:vi.fn(async()=>user),findUnique:vi.fn(async()=>user)},userPermissionOverrides:{findMany:vi.fn(async()=>[])},relation:{findFirst:vi.fn(async()=>customer),findMany:vi.fn(async()=>customer.ownerId==='sales'?[{id:'customer'}]:[])},developmentCase:{findFirst:vi.fn(async()=>development)},teamMember:{findMany:vi.fn(async()=>shared?[{teamId:'team'}]:[])},teamDataGrant:{findMany:vi.fn(async()=>shared?[{entityId:'customer'}]:[]),findFirst:vi.fn(async()=>shared?{permission:shared}:null)},order:{findFirst:vi.fn(async()=>({id:'order',customerRelationId:'customer'}))},$queryRaw:vi.fn(async()=>[{id:'order'}])};const actor:any={userId:'sales',roles:[],permissions:scopes,permissionCeiling:scopes};return{db,actor,user,customer,development,setShared:(x:string|null)=>shared=x};}
describe('conversion current authority',()=>{
 it('ordinary actual customer owner works without Orders leadership/write',async()=>{const f=fixture();const r=await authorizeDevelopmentConversion(f.db,'sales',f.actor,'case');expect(r.actor.userId).toBe('sales');expect(r.actor.roles).toContain('sales');expect(r.actor.permissions).not.toContain('orders:write');});
 it.each([undefined,null,{userId:'other'}])('rejects missing/mismatched verified actor %j',async actor=>{const f=fixture();await expect(currentConversionActor(f.db,'sales',actor as any,'products:write')).rejects.toMatchObject({code:'UNAUTHORIZED'});});
 it('DB grant withdrawal overrides old token scope',async()=>{const f=fixture();f.user.roles[0].role.permissions=[];await expect(authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).rejects.toMatchObject({code:'FORBIDDEN'});});
 it('signed ceiling cannot be expanded by current DB grant',async()=>{const f=fixture();await expect(authorizeDevelopmentConversion(f.db,'sales',{...f.actor,permissionCeiling:['products:read']},'case')).rejects.toMatchObject({code:'FORBIDDEN'});});
 it('cross-customer scope is rejected',async()=>{const f=fixture();f.customer.ownerId='other';await expect(authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).rejects.toMatchObject({code:'NOT_FOUND'});});
 it('current followup permits while read-only sharing rejects',async()=>{const f=fixture();f.customer.ownerId='other';f.setShared('read');await expect(authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).rejects.toMatchObject({code:'NOT_FOUND'});f.setShared('read+followup');expect((await authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).actor.userId).toBe('sales');});
 it('a Case with no customer does not gain rights from its owner label',async()=>{const f=fixture();f.development.customerRelationId=null;f.development.owner='sales';await expect(authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).rejects.toMatchObject({code:'NOT_FOUND'});});
 it('internal development uses the recorded case ownerId without inventing a customer or warehouse role',async()=>{const f=fixture();f.development.customerRelationId=null;f.development.ownerId='sales';expect((await authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).development.id).toBe('case');});
 it('internal development uses current development team scope, and revoking membership removes access',async()=>{const f=fixture();f.development.customerRelationId=null;f.development.ownerId='another-sales';f.db.teamMember.findMany.mockImplementation(async({where}:any)=>where.userId?[{teamId:'team'}]:[{userId:'sales'},{userId:'another-sales'}]);expect((await authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).actor.userId).toBe('sales');f.db.teamMember.findMany.mockResolvedValue([]);await expect(authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).rejects.toMatchObject({code:'NOT_FOUND'});});
 it.each(['userAccount','userPermissionOverrides','relation','teamMember'])('actual %s SQL fault is 503 instead of missing authority',async name=>{const f=fixture();f.customer.ownerId='other';const delegate=f.db[name];for(const key of Object.keys(delegate))delegate[key]=vi.fn(async()=>{throw Error('SYNTHETIC_DB_FAILURE')});await expect(authorizeDevelopmentConversion(f.db,'sales',f.actor,'case')).rejects.toMatchObject({code:'AUTHORIZATION_UNAVAILABLE',statusCode:503});});
 it('existing Order linkage locks and checks actual target owner',async()=>{const f=fixture();await lockExistingConversionOrder(f.db,f.actor,'order');expect(f.db.$queryRaw).toHaveBeenCalled();f.customer.ownerId='other';await expect(lockExistingConversionOrder(f.db,f.actor,'order')).rejects.toMatchObject({code:'NOT_FOUND'});});
});

describe('conversion authority over frozen read snapshots', () => {
 it('supports a nonconfigurable readonly database delegate without violating Proxy invariants', async () => {
  const f = fixture();
  Object.defineProperty(f.db, 'userAccount', { value: f.db.userAccount, writable: false, configurable: false });
  expect((await authorizeDevelopmentConversion(f.db, 'sales', f.actor, 'case')).actor.userId).toBe('sales');
 });
 it('supports nonconfigurable readonly methods while preserving the original delegate and database this', async () => {
  const delegate: any = {};
  Object.defineProperty(delegate, 'findFirst', { value: async function(this: unknown) { expect(this).toBe(delegate); return { id: 'current' }; } });
  const db: any = { userAccount: delegate };
  Object.defineProperty(db, '$queryRaw', { value: async function(this: unknown) { expect(this).toBe(db); return ['bound']; } });
  const result = await conversionAuthorityRead(db, async strict => [await strict.userAccount.findFirst(), await strict.$queryRaw()]);
  expect(result).toEqual([{ id: 'current' }, ['bound']]);
 });
 it('still fails closed when a frozen snapshot delegate read fails and a downstream reader catches it', async () => {
  const delegate: any = {};
  Object.defineProperty(delegate, 'findMany', { value: async () => { throw new Error('SYNTHETIC_FROZEN_READ_FAILURE'); } });
  const db: any = {};
  Object.defineProperty(db, 'teamMember', { value: delegate });
  await expect(conversionAuthorityRead(db, async strict => {
   try { return await strict.teamMember.findMany(); } catch { return []; }
  })).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE', statusCode: 503 });
 });
});
