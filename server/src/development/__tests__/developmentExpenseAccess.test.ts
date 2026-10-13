import {describe,it,expect,vi,beforeEach} from 'vitest';
import {assertDevelopmentExpenseAccess as access,assertDevelopmentExpenseAssignee as assign,assertDevelopmentFinanceRecipient as finance,assertDevelopmentFinanceWriteAccess as financeWrite} from '../developmentExpenseAccess';
const m=vi.hoisted(()=>({scope:vi.fn(),resolver:vi.fn(),context:vi.fn(),relation:vi.fn()}));
vi.mock('../../auth/permissionService',()=>({createPermissionService:()=>({hasScope:m.scope,getDataScopeResolver:m.resolver,getUserPermissionContext:m.context})}));
vi.mock('../../teams/teamShareService',()=>({createTeamShareService:()=>({resolveRelationAccess:m.relation})}));
const actor:any={userId:'a',roles:[],permissions:['products:write'],departmentIds:[]};
function db(){return {developmentCase:{findFirst:vi.fn(async()=>({id:'d',customerRelationId:'c',owner:'a'}))},relation:{findFirst:vi.fn(async()=>({id:'c'}))},userAccount:{findFirst:vi.fn(async()=>({id:'u',displayName:'姓名'}))}};}
beforeEach(()=>{vi.clearAllMocks();m.scope.mockReturnValue(true);m.resolver.mockResolvedValue({rule:{kind:'self'}});m.relation.mockResolvedValue('owner');m.context.mockResolvedValue({legacyRoleCodes:[],roleIds:[],scopes:['products:read','products:write'],departmentIds:[]});});
describe('开发费用权限',()=>{
 it('产品写不等于客户业务可见，owner文本不授权',async()=>{m.relation.mockResolvedValue('none');await expect(access(db(),actor,'d','write')).rejects.toMatchObject({status:404,httpStatus:404});});
 it('team-read只读，team-followup可写',async()=>{m.relation.mockResolvedValue('team-read');await expect(access(db(),actor,'d','read')).resolves.toMatchObject({id:'d'});await expect(access(db(),actor,'d','write')).rejects.toMatchObject({status:404});m.relation.mockResolvedValue('team-followup');await expect(access(db(),actor,'d','write')).resolves.toBeTruthy();});
 it('开发结束后仍可按当前真实客户权限补记支出',async()=>{const p=db();p.developmentCase.findFirst.mockResolvedValue({id:'d',customerRelationId:'c',owner:'a',status:'Completed'} as any);await expect(access(p,actor,'d','write')).resolves.toMatchObject({id:'d',status:'Completed'});m.relation.mockResolvedValue('none');await expect(access(p,actor,'d','write')).rejects.toMatchObject({status:404});});
 it('失效客户和案拒绝',async()=>{const p=db();p.relation.findFirst.mockResolvedValue(null as any);await expect(access(p,actor,'d','read')).rejects.toMatchObject({status:404});p.developmentCase.findFirst.mockResolvedValue(null as any);await expect(access(p,actor,'d','read')).rejects.toMatchObject({status:404});});
 it('无客户仅all可见',async()=>{const p=db();p.developmentCase.findFirst.mockResolvedValue({id:'d',customerRelationId:null,owner:'a'} as any);await expect(access(p,actor,'d','read')).rejects.toMatchObject({status:404});m.resolver.mockResolvedValue({rule:{kind:'all'}});await expect(access(p,actor,'d','write')).resolves.toBeTruthy();});
 it('scope缺失和未登录分别拒绝',async()=>{m.scope.mockReturnValue(false);await expect(access(db(),actor,'d','write')).rejects.toMatchObject({status:403});await expect(access(db(),null,'d','read')).rejects.toMatchObject({status:401});});
 it('查询异常不能吞成无费用',async()=>{m.relation.mockRejectedValue(Error('DB'));await expect(access(db(),actor,'d','read')).rejects.toThrow('DB');});
 it('真负责人必须active且具有写scope与客户范围',async()=>{const p=db();await assign(p,actor,'d','u');expect(p.userAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:'u',deletedAt:null,status:'active'}}));p.userAccount.findFirst.mockResolvedValueOnce({id:'a',displayName:'销售'}).mockResolvedValueOnce(null as any);await expect(assign(p,actor,'d','u')).rejects.toMatchObject({code:'INVALID_ASSIGNEE'});});
 it('空scope不能从角色默认权限复活',async()=>{m.context.mockResolvedValueOnce({legacyRoleCodes:[],roleIds:[],scopes:['products:write'],departmentIds:[]}).mockResolvedValue({legacyRoleCodes:['sales'],roleIds:[],scopes:[],departmentIds:[]});await expect(assign(db(),actor,'d','u')).rejects.toMatchObject({code:'INVALID_ASSIGNEE'});});
});

describe('财务接收人权限',()=>{
 it('必须具备数据库中的读写权限，角色标签不能补空权限',async()=>{m.context.mockResolvedValue({legacyRoleCodes:['finance'],roleIds:[],scopes:[],departmentIds:[]});await expect(finance(db(),'d','u')).rejects.toMatchObject({code:'INVALID_FINANCE_RECIPIENT'});});
 it('全范围财务可以接收，来源必须真实有效',async()=>{m.context.mockResolvedValue({legacyRoleCodes:[],roleIds:[],scopes:['invoices:read','invoices:write'],departmentIds:[]});m.resolver.mockResolvedValue({rule:{kind:'all'}});m.relation.mockResolvedValue('none');await expect(finance(db(),'d','u')).resolves.toMatchObject({id:'u'});const p=db();p.relation.findFirst.mockResolvedValue(null as any);await expect(finance(p,'d','u')).rejects.toMatchObject({code:'INVALID_FINANCE_RECIPIENT'});});
 it('受限范围财务不能接无业务权限或仅共享读取的客户',async()=>{m.context.mockResolvedValue({legacyRoleCodes:[],roleIds:[],scopes:['invoices:read','invoices:write'],departmentIds:[]});for(const access of ['none','team-read']){m.relation.mockResolvedValue(access);await expect(finance(db(),'d','u')).rejects.toMatchObject({code:'INVALID_FINANCE_RECIPIENT'});}m.relation.mockResolvedValue('team-followup');await expect(finance(db(),'d','u')).resolves.toMatchObject({id:'u'});});
 it('失效账号拒绝，权限查询异常不降级为允许',async()=>{const p=db();p.userAccount.findFirst.mockResolvedValue(null as any);await expect(finance(p,'d','u')).rejects.toMatchObject({code:'INVALID_FINANCE_RECIPIENT'});m.context.mockRejectedValue(Error('DB'));await expect(finance(db(),'d','u')).rejects.toThrow('DB');});
});

it('旧会话不能恢复已撤销的开发写权限或已停用账号',async()=>{
 const p=db();m.context.mockResolvedValue({legacyRoleCodes:['sales'],roleIds:[],scopes:[],departmentIds:[]});
 await expect(access(p,actor,'d','write')).rejects.toMatchObject({status:403});
 m.context.mockResolvedValue({legacyRoleCodes:[],roleIds:[],scopes:['products:write'],departmentIds:[]});p.userAccount.findFirst.mockResolvedValue(null as any);
 await expect(access(p,actor,'d','write')).rejects.toMatchObject({status:403});
});

it('财务写命令同时检查已验证会话范围和当前接收资格，接收资格不能扩大会话上限',async()=>{
 const p=db();m.context.mockResolvedValue({legacyRoleCodes:[],roleIds:[],scopes:['invoices:read','invoices:write'],departmentIds:[]});m.resolver.mockResolvedValue({rule:{kind:'all'}});
 const financeActor:any={userId:'u',roles:['finance'],permissions:['invoices:read','invoices:write'],permissionCeiling:['invoices:read']};
 m.scope.mockImplementation((current:any,scope:string)=>current.permissionCeiling?.includes(scope));
 await expect(financeWrite(p,financeActor,'d')).rejects.toMatchObject({code:'FORBIDDEN',status:403});
 expect(m.context).not.toHaveBeenCalled();
 await expect(financeWrite(p,null,'d')).rejects.toMatchObject({code:'UNAUTHORIZED',status:401});
 m.scope.mockReturnValue(true);await expect(financeWrite(p,financeActor,'d')).resolves.toMatchObject({id:'u'});
 m.context.mockResolvedValue({scopes:[]});await expect(financeWrite(p,financeActor,'d')).rejects.toMatchObject({code:'FORBIDDEN',status:403});
 m.context.mockRejectedValue(Error('grant-query-down'));await expect(financeWrite(p,financeActor,'d')).rejects.toThrow('grant-query-down');
});
