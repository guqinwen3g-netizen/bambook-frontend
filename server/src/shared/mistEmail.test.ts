import {describe,it,expect} from 'vitest';
import {emailSendRecipients} from './mistEmail';
import {applyMistCommand,createMistState,mistCommandPermission,type MistContext,type MistCommand} from './mistWorkspace';

function fixture(seed:'demo'|'empty'='demo'){
  let id=0;const ctx:MistContext={id:()=>`mail-${++id}`,now:'2026-10-14T02:00:00Z',actorId:'sales',actorName:'顾言'} as MistContext;
  let state=createMistState(ctx,seed);
  const run=(command:MistCommand)=>{const result=applyMistCommand(state,command,ctx);state=result.state;return result.result;};
  return {ctx,run,get state(){return state;}};
}

describe('智能邮箱工作空间切片',()=>{
  it('空白空间没有任何邮箱或邮件，示例空间全部标注示例',()=>{
    expect(fixture('empty').state.email).toEqual({accounts:[],messages:[],drafts:[],sends:[]});
    const f=fixture();
    expect(f.state.email.accounts.length).toBe(2);
    expect(f.state.email.accounts.every(a=>a.example)).toBe(true);
    expect(f.state.email.messages.every(m=>m.example&&m.body.includes('示例'))).toBe(true);
    expect(mistCommandPermission({type:'email.flag',payload:{id:'x',flag:'read',value:true}})).toBe('emails:write');
  });
  it('标记、删除与恢复回到原文件夹',()=>{
    const f=fixture();
    f.run({type:'email.flag',payload:{id:'mail-ex-1',flag:'starred',value:true}});
    f.run({type:'email.move',payload:{id:'mail-ex-5',folder:'trash'}});
    expect(f.state.email.messages.find(m=>m.id==='mail-ex-5')!.folder).toBe('trash');
    f.run({type:'email.move',payload:{id:'mail-ex-5',folder:'restore'}});
    const sent=f.state.email.messages.find(m=>m.id==='mail-ex-5')!;
    expect(sent.folder).toBe('sent');
    expect(f.state.email.messages.find(m=>m.id==='mail-ex-1')!.starred).toBe(true);
    expect(()=>f.run({type:'email.move',payload:{id:'mail-ex-5',folder:'inbox'}})).toThrow('已发送邮件不能移到收件箱');
    expect(()=>f.run({type:'email.move',payload:{id:'mail-ex-1',folder:'restore'}})).toThrow('只有已删除');
  });
  it('关联必须指向真实对象；抽取资料只生成复核任务且之后不能移除关联',()=>{
    const f=fixture();const customer=f.state.customers[0];
    expect(()=>f.run({type:'email.link',payload:{id:'mail-ex-3',link:{kind:'customer',id:'missing'}}})).toThrow('不在当前工作空间');
    expect(()=>f.run({type:'email.submitExtraction',payload:{id:'mail-ex-3',link:{kind:'customer',id:customer.id}}})).toThrow('请先确认关联');
    f.run({type:'email.link',payload:{id:'mail-ex-3',link:{kind:'customer',id:customer.id}}});
    const before=JSON.stringify(f.state.customers);
    f.run({type:'email.submitExtraction',payload:{id:'mail-ex-3',link:{kind:'customer',id:customer.id}}});
    expect(JSON.stringify(f.state.customers)).toBe(before);
    expect(f.state.tasks[0].kind).toBe('email-extraction-review');
    expect(()=>f.run({type:'email.unlink',payload:{id:'mail-ex-3',link:{kind:'customer',id:customer.id}}})).toThrow('关联不能移除');
  });
  it('生成跟进写入待办和日历；草稿校验发件别名与地址',()=>{
    const f=fixture();
    const {id}=f.run({type:'email.followUp',payload:{id:'mail-ex-4',owner:'沈禾',due:'2026-10-16',note:'告知客户'}}) as {id:string};
    expect(f.state.tasks.find(t=>t.id===id)!.target).toEqual({view:'emails',id:'mail-ex-4'});
    expect(f.state.calendar.some(c=>c.date==='2026-10-16'&&c.title.includes('面料到货延迟'))).toBe(true);
    const input={accountId:'mail-personal',from:'sales@bambook.example.invalid',to:'a@b.co; c@d.co',cc:'',bcc:'',subject:'PI',body:'正文',template:'PI 发送',links:[],fileIds:[]};
    const draft=f.run({type:'email.draft.save',payload:{input}}) as {id:string};
    expect(f.state.email.drafts[0]).toMatchObject({id:draft.id,to:'a@b.co, c@d.co'});
    expect(()=>f.run({type:'email.draft.save',payload:{input:{...input,from:'boss@other.co'}}})).toThrow('别名');
    expect(()=>f.run({type:'email.draft.save',payload:{input:{...input,to:'bad-address'}}})).toThrow('地址格式无效');
    f.run({type:'email.draft.delete',payload:{id:draft.id}});
    expect(f.state.email.drafts).toEqual([]);
  });
  it('同步期间改了收信来源：旧代际写回作废；旧发送记录没有收件人明细时按整封状态推导',()=>{
    const f=fixture('empty');
    const transport={imapHost:'mail.sylway.cloud',imapPort:993,imapSecure:true,smtpHost:'mail.sylway.cloud',smtpPort:587,smtpSecure:false,username:'sales@sylway.cloud'};
    const {id}=f.run({type:'email.account.save',payload:{input:{address:'sales@sylway.cloud',displayName:'sales',kind:'personal',memberIds:[],aliases:[],signature:'',transport}}}) as {id:string};
    f.run({type:'email.account.save',payload:{id,input:{address:'sales@sylway.cloud',displayName:'sales',kind:'personal',memberIds:[],aliases:[],signature:'',transport:{...transport,imapHost:'imap.other.cloud'}}}});
    expect(f.state.email.accounts[0].sourceGeneration).toBe(2);
    expect(()=>f.run({type:'email.server.sync',payload:{accountId:id,source:1,at:f.ctx.now,folders:[],messages:[],files:[],lastError:null}})).toThrow('同步结果作废');
    expect(emailSendRecipients({to:'a@b.co, c@d.co',cc:'A@b.co',bcc:'e@f.co',status:'sent',updatedAt:f.ctx.now}).map(r=>[r.address,r.role,r.status])).toEqual([['a@b.co','to','accepted'],['c@d.co','to','accepted'],['e@f.co','bcc','accepted']]);
    expect(emailSendRecipients({to:'a@b.co',cc:'',bcc:'',status:'failed',updatedAt:f.ctx.now})[0].status).toBe('failed');
  });
});
