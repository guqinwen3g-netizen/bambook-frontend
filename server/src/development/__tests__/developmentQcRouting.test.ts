import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({source:vi.fn(async()=>({}))}));
vi.mock('../developmentConversionAuthority',()=>({authorizeDevelopmentSource:mocks.source}));
vi.mock('../../auth/tokenHelpers',()=>({loadUserWithRoles:async(db:any,id:string)=>db.users.find((user:any)=>user.id===id),buildLoadedAuthTokenPayload:async(_db:any,user:any)=>({userId:user.id,permissions:user.permissions})}));
import { resolveDevelopmentQcRouting, developmentQcMember, listDevelopmentQcRoutingTeams } from '../developmentQcRouting';
import { DevelopmentDomainError } from '../developmentOperationalGuard';
const scopes=['qc:read','qc:inspect','qc:fabric_chain:write'];
function fixture(){const team:any={id:'fabric-qc',name:'面料QC组',leaderId:'head',status:'active',deletedAt:null,departmentId:'qc-dept',department:{parentId:'company',status:'active',metadata:{businessAttributes:['fabric_qc']}},members:[{userId:'head'},{userId:'member'}]};const db:any={users:['head','member'].map(id=>({id,primaryDeptId:'qc-dept',status:'active',deletedAt:null,permissions:[...scopes]})),team:{findMany:vi.fn(async()=>[team])}};return{db,team,input:{caseId:'case',type:'fabric',requesterId:'sales'}};}
beforeEach(()=>{mocks.source.mockReset().mockResolvedValue({development:{type:'fabric'}} as any);});
describe('development QC routing uses professional teams and current source authority',()=>{
 it('routes fabric source to its professional head',async()=>{const f=fixture();await expect(resolveDevelopmentQcRouting(f.db,f.input)).resolves.toEqual({routingTeamId:'fabric-qc',responsibleHeadId:'head'});});
 it('does not route to a similarly named fabric business department',async()=>{const f=fixture();f.team.department.metadata.businessAttributes=['fabric_business'];await expect(resolveDevelopmentQcRouting(f.db,f.input)).rejects.toMatchObject({code:'QC_ROUTING_TEAM_REQUIRED'});});
 it('does not route garment work to a fabric QC team',async()=>{const f=fixture();await expect(resolveDevelopmentQcRouting(f.db,{...f.input,type:'garment'})).rejects.toMatchObject({code:'QC_ROUTING_TEAM_REQUIRED'});});
 it('explicitly reports missing head configuration',async()=>{const f=fixture();f.team.leaderId=null;await expect(resolveDevelopmentQcRouting(f.db,f.input)).rejects.toMatchObject({code:'QC_ROUTING_HEAD_MISSING'});});
 it('rejects head with revoked professional scope',async()=>{const f=fixture();f.db.users[0].permissions=['qc:read'];await expect(resolveDevelopmentQcRouting(f.db,f.input)).rejects.toMatchObject({code:'QC_ROUTING_HEAD_MISSING'});});
 it('requires matching primary department and active team membership',async()=>{const f=fixture();f.db.users[1].primaryDeptId='other';await expect(developmentQcMember(f.db,{...f.input,teamId:f.team.id,userId:'member'})).resolves.toBeNull();});
 it('preserves exact source access as a separate prerequisite',async()=>{const f=fixture();mocks.source.mockRejectedValue(new DevelopmentDomainError('FORBIDDEN','来源不可见'));await expect(resolveDevelopmentQcRouting(f.db,f.input)).rejects.toMatchObject({code:'QC_ROUTING_HEAD_MISSING'});});
 it('does not swallow source authorization storage failures',async()=>{const f=fixture();mocks.source.mockRejectedValue(new Error('storage unavailable'));await expect(resolveDevelopmentQcRouting(f.db,f.input)).rejects.toThrow('storage unavailable');});
 it('does not let the requesting business account become its own QC',async()=>{const f=fixture();await expect(developmentQcMember(f.db,{...f.input,requesterId:'head',teamId:f.team.id,userId:'head'})).resolves.toBeNull();});
});


describe('case-scoped QC choices extend the existing personnel directory',()=>{
 it('returns only real same-family groups after exact source read authorization',async()=>{
   const f=fixture();const actor={userId:'sales',permissions:['products:read']};
   await expect(listDevelopmentQcRoutingTeams(f.db,'case','sales',actor)).resolves.toEqual([{id:'fabric-qc',name:'面料QC组',family:'fabric',configuredHeadId:'head',headId:'head',headName:null}]);
   expect(mocks.source).toHaveBeenCalledWith(f.db,'sales',actor,'case',{scope:'products:read',write:false});
 });
 it('keeps a real unconfigured group visible so missing head is actionable',async()=>{
   const f=fixture();f.team.leaderId=null;
   await expect(listDevelopmentQcRoutingTeams(f.db,'case','sales',{userId:'sales'})).resolves.toEqual([{id:'fabric-qc',name:'面料QC组',family:'fabric',configuredHeadId:null,headId:null,headName:null}]);
 });
 it('does not read organizational choices for an inaccessible development case',async()=>{
   const f=fixture();mocks.source.mockRejectedValue(new DevelopmentDomainError('NOT_FOUND','来源不可见'));
   await expect(listDevelopmentQcRoutingTeams(f.db,'case','sales',{userId:'sales'})).rejects.toMatchObject({code:'NOT_FOUND'});expect(f.db.team.findMany).not.toHaveBeenCalled();
 });
});
