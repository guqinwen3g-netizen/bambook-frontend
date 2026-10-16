import {expect,it} from 'vitest';
import {applyMistCommand,createMistState,MistCommandError,mistCommandPermission,type MistContext} from './mistWorkspace';
const ctx:MistContext={now:'2026-10-13T08:00:00.000Z',actorName:'验证员',id:(()=>{let n=0;return()=>`p-${++n}`;})()};
const full={legalName:'示例公司',englishName:'Sample Co',address:'示例地址',englishAddress:'Sample Address',phone:'000',email:'ops@example.com',taxId:'TAX-SAMPLE',customsCode:'CUS-SAMPLE',bankName:'示例银行',bankAccount:'0000',swift:'SAMPLEXX',defaultCurrency:'USD'};
const save=(state:ReturnType<typeof createMistState>,companyProfile:unknown)=>applyMistCommand(state,{type:'settings.update',payload:{companyProfile}} as never,ctx).state;

it('saves all twelve fields and reads them back unchanged',()=>{expect(save(createMistState(ctx,'empty'),full).settings.companyProfile).toEqual(full);});
it('keeps every other field when one field or only the currency changes, and clears only an explicit blank',()=>{
 const base=save(createMistState(ctx,'empty'),full);
 expect(save(base,{defaultCurrency:'EUR'}).settings.companyProfile).toEqual({...full,defaultCurrency:'EUR'});
 expect(save(base,{phone:'111'}).settings.companyProfile).toEqual({...full,phone:'111'});
 expect(save(base,{swift:''}).settings.companyProfile).toEqual({...full,swift:''});
});
it('starts from an empty profile when none exists',()=>{expect(save(createMistState(ctx,'empty'),{defaultCurrency:'CNY'}).settings.companyProfile).toMatchObject({legalName:'',defaultCurrency:'CNY'});});
it.each([[{email:'not-an-email'},/公司邮箱格式无效.*name@example.com/],[{defaultCurrency:'usd'},/三位大写代码.*USD/],[{seal:'x'},/未知字段/],[[],/格式无效/]])('rejects %j with an actionable error and leaves state untouched',(input,message)=>{
 const base=save(createMistState(ctx,'empty'),full),before=structuredClone(base);
 expect(()=>save(base,input)).toThrow(MistCommandError);expect(()=>save(base,input)).toThrow(message);expect(base).toEqual(before);
});
it('stays an owner-only workspace setting rather than a scoped business permission',()=>{expect(mistCommandPermission({type:'settings.update',payload:{companyProfile:full}} as never)).toBeNull();});
