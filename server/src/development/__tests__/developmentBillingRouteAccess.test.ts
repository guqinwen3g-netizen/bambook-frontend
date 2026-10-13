import {describe,it,expect,vi,beforeEach} from 'vitest';
import {developmentBillingReadWhere,assertDevelopmentBillingRouteAccess} from '../developmentBillingRouteAccess';
const m=vi.hoisted(()=>({context:vi.fn(),resolver:vi.fn(),visible:vi.fn(),recipient:vi.fn()}));
vi.mock('../../auth/permissionService',async original=>({...await original<any>(),createPermissionService:()=>({getUserPermissionContext:m.context,getDataScopeResolver:m.resolver})}));
vi.mock('../../teams/teamShareService',()=>({createTeamShareService:()=>({resolveVisibleRelationIds:m.visible})}));
vi.mock('../developmentExpenseAccess',()=>({assertDevelopmentFinanceRecipient:m.recipient}));
const actor:any={userId:'u',roles:['admin'],permissions:['invoices:read']};
function db(){return {userAccount:{findFirst:vi.fn(async()=>({id:'u'}))},developmentCase:{findMany:vi.fn(async()=>[{id:'allowed'}]),findFirst:vi.fn(async()=>({id:'allowed'}))},sample:{findMany:vi.fn(async()=>[])},sampleBatch:{findMany:vi.fn(async()=>[])},sealSample:{findMany:vi.fn(async()=>[])},costRecord:{findMany:vi.fn(async()=>[])},billingItem:{findFirst:vi.fn(async()=>({id:'b',sourceType:'DevelopmentCase',sourceId:'allowed'}))}};}
beforeEach(()=>{vi.clearAllMocks();m.context.mockResolvedValue({scopes:['invoices:read','invoices:write'],legacyRoleCodes:['sales'],roleIds:[],departmentIds:[]});m.resolver.mockResolvedValue({rule:{kind:'self'}});m.visible.mockResolvedValue(['customer']);m.recipient.mockResolvedValue({id:'u'});});
describe('既有收费入口中的开发案范围',()=>{
 it('以当前数据库权限构造来源过滤，不能使用旧令牌的admin',async()=>{const d=db();const where=await developmentBillingReadWhere(d,actor);expect(m.resolver).toHaveBeenCalledWith(expect.objectContaining({roles:['sales']}),'invoices');expect(d.developmentCase.findMany).toHaveBeenCalledWith({where:{deletedAt:null,customerRelationId:{in:['customer']}},select:{id:true}});expect(where.OR[1]).toEqual({sourceType:'DevelopmentCase',sourceId:{in:['allowed']}});});
 it('空scope不能用令牌恢复权限',async()=>{m.context.mockResolvedValue({scopes:[]});await expect(developmentBillingReadWhere(db(),actor)).rejects.toMatchObject({status:403});});
 it('没有业务客户时开发案过滤为空而不是去掉条件',async()=>{const d=db();m.visible.mockResolvedValue([]);d.developmentCase.findMany.mockResolvedValue([]);expect((await developmentBillingReadWhere(d,actor)).OR[1]).toEqual({sourceType:'DevelopmentCase',sourceId:{in:[]}});});
 it('详情先带范围查询，找不到不泄露存在性',async()=>{const d=db();d.billingItem.findFirst.mockResolvedValue(null as any);await expect(assertDevelopmentBillingRouteAccess(d,actor,'hidden','read')).rejects.toMatchObject({status:404});expect(d.billingItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'hidden',AND:expect.any(Array)})}));});
 it('可读不代表可写，写侧另查当前财务接手资格',async()=>{m.recipient.mockRejectedValue(Object.assign(new Error('denied'),{code:'INVALID_FINANCE_RECIPIENT'}));await expect(assertDevelopmentBillingRouteAccess(db(),actor,'b','write')).rejects.toMatchObject({status:404});});
 it('权限数据库失败不能降级放行',async()=>{m.context.mockRejectedValue(new Error('DB'));await expect(developmentBillingReadWhere(db(),actor)).rejects.toThrow('DB');});
});
