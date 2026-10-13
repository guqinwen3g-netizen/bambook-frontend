import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({resolve:vi.fn(),users:new Map<string,any>()}));
vi.mock('../orders/orderMainApprovalService',()=>({createOrderMainApprovalService:()=>({resolveEligibleReviewerIds:mocks.resolve})}));
vi.mock('../auth/tokenHelpers',()=>({loadUserWithRoles:async(_db:any,id:string)=>mocks.users.get(id)||null,buildLoadedAuthTokenPayload:async(_db:any,user:any)=>({userId:user.id,roles:[],departmentIds:[],permissions:user.permissions,authorizationLoaded:true})}));
import {mistApprovalAuthority} from './context';
const actor={userId:'owner',roles:[],permissions:['orders:write'],departmentIds:[]} as any;
beforeEach(()=>{mocks.resolve.mockReset();mocks.users.clear();vi.stubEnv('MIST_LOCAL_WORKSPACE','0');vi.stubEnv('NODE_ENV','test');});
afterEach(()=>vi.unstubAllEnvs());
describe('Mist order reviewer authority',()=>{
 it('uses both built-in local identities for both domains without querying the old account database',async()=>{vi.stubEnv('MIST_LOCAL_WORKSPACE','1');const value=await mistApprovalAuthority({}, {...actor,mistLocal:true},'order.governance.submit');expect(value.orderReviewerIds).toEqual({garment:['local-operator','local-reviewer'],fabric:['local-operator','local-reviewer']});expect(mocks.resolve).not.toHaveBeenCalled();});
 it('reuses business-domain eligibility and filters revoked or inactive ordinary accounts',async()=>{mocks.resolve.mockImplementation(async(_db,domain)=>domain==='garment'?['garment-reviewer','revoked','inactive']:['fabric-reviewer']);for(const id of ['garment-reviewer','fabric-reviewer'])mocks.users.set(id,{id,status:'active',permissions:['orders:write']});mocks.users.set('revoked',{id:'revoked',status:'active',permissions:[]});mocks.users.set('inactive',{id:'inactive',status:'disabled',permissions:['orders:write']});const value=await mistApprovalAuthority({},actor,'order.governance.decide');expect(value.orderReviewerIds).toEqual({garment:['garment-reviewer'],fabric:['fabric-reviewer']});expect(mocks.resolve.mock.calls.map(call=>call[1])).toEqual(['garment','fabric']);});
 it('leaves an unconfigured domain unavailable rather than inventing a reviewer',async()=>{mocks.resolve.mockRejectedValue(Object.assign(new Error('missing'),{code:'ORDER_APPROVAL_AUTHORITY_MISSING'}));expect((await mistApprovalAuthority({},actor,'order.governance.submit')).orderReviewerIds).toEqual({garment:[],fabric:[]});});
});
