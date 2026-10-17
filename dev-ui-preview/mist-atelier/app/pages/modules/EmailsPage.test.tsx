// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null as any,run:vi.fn(),refresh:vi.fn(),recover:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn(),mail:vi.fn(),closeMailReview:vi.fn()}));
const session=vi.hoisted(()=>({denied:new Set<string>()}));
vi.mock('../../runtime/workspace',()=>({useMistWorkspace:()=>store}));
vi.mock('../../runtime/auth',()=>({useMistSession:()=>({user:{id:'sales',displayName:'顾言'},sessionKey:'s',hasPermission:(p:string)=>!session.denied.has(p),canAccessView:()=>true})}));
import {EmailsPage,contactSuggestion} from './EmailsPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLElement,root:Root;const go=vi.fn();let n=0;
const ctx={id:()=>'id-'+(++n),now:'2026-10-14T02:00:00Z',actorName:'顾言'} as any;
function render(id?:string){act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'emails',id},go,theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn(),openAI:vi.fn()}}><EmailsPage/></Nav.Provider></ToastProvider></MistRoot>));}
const button=(label:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===label) as HTMLButtonElement|undefined;
async function click(node:HTMLElement){await act(async()=>node.click());}
beforeEach(()=>{session.denied=new Set();store.state=createMistState(ctx,'demo');store.run.mockReset();store.run.mockResolvedValue({result:{}});store.mail.mockReset();store.recover.mockReset();store.closeMailReview.mockReset();store.pending=null;store.saving=false;store.downloadFile.mockReset();go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});

it('shows an honest empty state when no mailbox is connected',()=>{
  store.state=createMistState(ctx,'empty');render();
  expect(host.textContent).toContain('未接入任何邮箱');
  expect(button('写邮件')!.disabled).toBe(true);
  expect(button('同步')!.disabled).toBe(true);
});

it('lists inbox mail with partial sync failure and confirms a contact-based customer suggestion',async()=>{
  render('mail-ex-3');
  expect(host.textContent).toContain('部分文件夹同步失败');
  expect(host.textContent).toContain('面料到货延迟两天');
  expect(host.textContent).not.toContain('首样寄出');
  const s=store.state!,m=s.email.messages.find(row=>row.id==='mail-ex-3')!;
  expect(contactSuggestion(s,m)?.customer.id).toBe(s.customers[0].id);
  expect(host.textContent).toContain('建议关联客户');
  await click(button('确认关联')!);
  expect(store.run).toHaveBeenCalledWith({type:'email.link',payload:{id:'mail-ex-3',link:{kind:'customer',id:s.customers[0].id}}});
});

it('replies into a saved draft while sending stays blocked with the reason',async()=>{
  render('mail-ex-1');
  await click(button('回复')!);
  const send=[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='发送').at(-1)!;
  expect(send.disabled).toBe(true);
  expect(send.title).toContain('示例邮箱只用于演示');
  await click(button('保存草稿')!);
  const command=store.run.mock.calls.at(-1)![0];
  expect(command.type).toBe('email.draft.save');
  expect(command.payload.input).toMatchObject({accountId:'mail-personal',to:'emma.clarke@cedarcrown.example.invalid',replyToId:'mail-ex-1'});
  expect(command.payload.input.subject).toMatch(/^Re: PO 确认/);
});

it('creates a follow-up and keeps example attachments undownloadable',async()=>{
  render('mail-ex-2');
  const download=button('下载')!;expect(download.disabled).toBe(true);expect(download.title).toContain('示例附件');
  await click(button('生成跟进')!);
  const dialogButtons=[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='生成跟进');
  await click(dialogButtons.at(-1)!);
  expect(store.run).toHaveBeenCalledWith(expect.objectContaining({type:'email.followUp',payload:expect.objectContaining({id:'mail-ex-2',owner:'顾言'})}));
});

it('is read-only without email write permission',()=>{
  session.denied=new Set(['emails:write']);render('mail-ex-1');
  expect(host.textContent).toContain('只读查看');
  expect(button('写邮件')).toBeUndefined();
  expect(button('确认关联')).toBeUndefined();
  expect(button('归档')).toBeUndefined();
});

const transport={imapHost:'mail.sylway.cloud',imapPort:993,imapSecure:true,smtpHost:'mail.sylway.cloud',smtpPort:587,smtpSecure:false,username:'sales@sylway.cloud'};
function realState(owner='sales'){
  const s=createMistState(ctx,'empty') as any;
  s.files=[{id:'file-a',name:'报价单.pdf',mimeType:'application/pdf',size:2048,storageKey:'k',createdAt:'2026-10-14T01:00:00Z'}];
  s.email.accounts=[{id:'acc-real',address:'sales@sylway.cloud',displayName:'业务邮箱',kind:'personal',ownerName:'顾言',memberNames:[],aliases:[],signature:'',connection:'connected',lastSyncAt:'2026-10-14T01:00:00Z',failedFolders:[],example:false,ownerId:owner,memberIds:[],transport,credentialSet:true,lastError:null,folders:[]}];
  s.email.messages=[{id:'mail-real-1',accountId:'acc-real',folder:'inbox',threadId:'t1',from:{name:'客户',address:'buyer@partner.test'},to:[{name:'',address:'sales@sylway.cloud'}],cc:[],subject:'询价单',body:'请报价',at:'2026-10-14T01:00:00Z',
    attachments:[{id:'att-1',name:'报价单.pdf',size:2048,contentType:'application/pdf',fileId:'file-a'},{id:'att-2',name:'超大.zip',size:60*1024*1024,contentType:'application/zip',omitted:'附件超过 50 MB，未保存内容'}],
    read:true,starred:false,important:false,category:{label:'',source:'none',detail:''},extracted:[],links:[],followUpTaskIds:[],submissions:[],example:false,remote:{folder:'INBOX',uid:7,uidValidity:1},messageId:'<m1@partner.test>'}];
  const base={requestKey:'abcdefgh12',accountId:'acc-real',from:'sales@sylway.cloud',to:'buyer@partner.test',cc:'',bcc:'',body:'正文',links:[],fileIds:[],messageId:'<s@sylway.cloud>',response:'',createdBy:'顾言',createdById:'sales',createdAt:'2026-10-14T01:00:00Z',updatedAt:'2026-10-14T01:00:00Z'};
  s.email.sends=[{...base,id:'send-unknown',subject:'结果不确定的邮件',status:'unknown',attempts:[{at:base.createdAt,actor:'顾言',outcome:'unknown',code:'SMTP_NO_REPLY',message:'连接在投递过程中中断'}]},
    {...base,id:'send-failed',requestKey:'abcdefgh13',subject:'被拒的邮件',status:'failed',response:'550 mailbox unavailable',attempts:[{at:base.createdAt,actor:'顾言',outcome:'failed',code:'SMTP_REJECTED',message:'收件服务器拒绝'}]}];
  return s as MistState;
}
function type(label:string,value:string){const el=document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;act(()=>{Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});}

it('syncs bound real mailboxes and reports connection state',async()=>{
  store.state=realState();store.mail.mockResolvedValue({sync:{remaining:0,failedFolders:[],error:null}});render();
  expect(host.textContent).toContain('已连接 · 同步于');
  await click(button('同步')!);
  expect(store.mail).toHaveBeenCalledWith({kind:'sync',accountId:'acc-real'});
});

it('sends with one stable request key, keeps the compose open on network failure and routes an uncertain result to the outbox',async()=>{
  store.state=realState();render();
  await click(button('写邮件')!);
  type('收件人','buyer@partner.test');type('主题','报价');
  store.mail.mockRejectedValueOnce(new Error('网络中断，请重试'));
  const send=async()=>{await click([...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='发送').at(-1)!);await click(button('确认发送')!);};
  await send();
  expect(host.textContent).toContain('网络中断，请重试');
  const first=store.mail.mock.calls[0][0];
  expect(first).toMatchObject({kind:'send',input:{accountId:'acc-real',to:'buyer@partner.test',subject:'报价'}});
  expect(first.requestKey).toMatch(/^[A-Za-z0-9]{8,80}$/);
  store.mail.mockResolvedValueOnce({send:{id:'send-new',status:'unknown',message:'连接中断'}});
  await send();
  expect(store.mail.mock.calls[1][0].requestKey).toBe(first.requestKey);
  expect(document.body.textContent).toContain('发送结果不确定');
  expect(document.body.textContent).toContain('系统不会自动重发');
});

it('confirms recipients and attachments before sending; cancelling sends nothing and keeps the compose',async()=>{
  store.state=realState();render();
  await click(button('写邮件')!);
  type('收件人','buyer@partner.test；Second@Partner.test third@partner.test');type('主题','报价');
  await click([...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='发送').at(-1)!);
  const dialog=[...document.querySelectorAll('[role="dialog"]')].at(-1)!;
  expect(dialog.textContent).toContain('确认发送');expect(dialog.textContent).toContain('业务邮箱 · sales@sylway.cloud');
  expect(dialog.textContent).toContain('收件人（3）');expect(dialog.textContent).toContain('buyer@partner.test、second@partner.test、third@partner.test');
  expect(dialog.textContent).toContain('附件（0）');
  await click([...dialog.querySelectorAll('button')].find(b=>b.textContent?.trim()==='取消')!);
  expect(store.mail).not.toHaveBeenCalled();expect(button('确认发送')).toBeUndefined();
  expect((document.querySelector('[aria-label="收件人"]') as HTMLInputElement).value).toBe('buyer@partner.test；Second@Partner.test third@partner.test');
});

it('sending a draft is one stable intent; an unresolved earlier send is reopened instead of delivered again',async()=>{
  const s=realState() as any;
  s.email.drafts=[{id:'draft-1',accountId:'acc-real',from:'sales@sylway.cloud',to:'buyer@partner.test',cc:'',bcc:'',subject:'草稿报价',body:'见附件',template:'',links:[],fileIds:['file-a'],createdAt:'2026-10-14T01:00:00Z',updatedAt:'2026-10-14T01:30:00Z',updatedBy:'顾言'}];
  store.state=s;store.mail.mockResolvedValue({send:{id:'send-unknown',status:'unknown',replayed:true,recovered:true}});render('draft-1');
  await click(button('发送')!);
  expect(document.body.textContent).toContain('报价单.pdf（2 KB）');
  await click(button('确认发送')!);
  const key=store.mail.mock.calls[0][0].requestKey;
  expect(store.mail.mock.calls[0][0]).toMatchObject({kind:'send',draftId:'draft-1'});expect(key).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  expect(document.body.textContent).toContain('已有发送记录，未重复投递');
  expect(host.textContent).toContain('结果不确定的邮件');expect(button('核对是否已发出')).toBeDefined();
  // 重开后再发送同一草稿：仍是同一请求编号
  act(()=>root.unmount());root=createRoot(host);render('draft-1');
  await click(button('发送')!);await click(button('确认发送')!);
  expect(store.mail.mock.calls[1][0].requestKey).toBe(key);
});

it('searches attachment names, including omitted attachments, and hides superseded failed sends',async()=>{
  const s=realState() as any;s.email.sends[1].supersededById='send-unknown';
  store.state=s;render();
  const search=document.querySelector('input[placeholder^="搜索主题"]') as HTMLInputElement;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'超大.zip');search.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(host.textContent).toContain('询价单');
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'不存在的附件');search.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(host.querySelector('table')?.textContent||'').not.toContain('询价单');
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}));});
  await click([...document.querySelectorAll('button')].find(b=>b.textContent?.includes('待发送'))!);
  expect(host.textContent).toContain('结果不确定的邮件');expect(host.textContent).not.toContain('被拒的邮件');
});

it('explains a copy found only in Sent: no recipient is confirmed',async()=>{
  store.state=realState();store.mail.mockResolvedValue({send:{id:'send-unknown',status:'unknown',found:true,foundIn:['sent'],confirmed:false}});render('send-unknown');
  await click(button('核对是否已发出')!);
  expect(document.body.textContent).toContain('只在已发送 / 归档中找到副本');expect(document.body.textContent).toContain('不能证明任何收件人已收到');
});

it('never blindly resends an uncertain send: verify first, resend only after explicit confirmation',async()=>{
  store.state=realState();store.mail.mockResolvedValue({send:{id:'send-unknown',status:'unknown'}});render('send-unknown');
  expect(host.textContent).toContain('不会自动重发');
  expect(button('重发')).toBeUndefined();
  await click(button('核对是否已发出')!);
  expect(store.mail).toHaveBeenLastCalledWith({kind:'verify',sendId:'send-unknown'});
  await click(button('确认未送达后重发')!);
  expect(store.mail).toHaveBeenCalledTimes(1);
  await click(button('确认未送达，重新发送')!);
  expect(store.mail).toHaveBeenLastCalledWith({kind:'retry',sendId:'send-unknown',confirmUnknown:true});
});

it('retries a definite failure and shows the server reply',async()=>{
  store.state=realState();store.mail.mockResolvedValue({send:{id:'send-failed',status:'sent'}});render('send-failed');
  expect(host.textContent).toContain('550 mailbox unavailable');
  await click(button('重发')!);
  expect(store.mail).toHaveBeenLastCalledWith({kind:'retry',sendId:'send-failed'});
});

it('partial acceptance is shown per recipient; resend targets only unaccepted recipients and the sent copy says so',async()=>{
  const s=realState() as any;
  const rec={requestKey:'abcdefgh14',accountId:'acc-real',from:'sales@sylway.cloud',to:'buyer@partner.test, bounce@partner.test',cc:'',bcc:'',body:'正文',links:[],fileIds:[],messageId:'<p@sylway.cloud>',response:'250 queued',createdBy:'顾言',createdById:'sales',createdAt:'2026-10-14T01:00:00Z',updatedAt:'2026-10-14T01:00:00Z',
    id:'send-partial',subject:'部分被拒的邮件',status:'partial',sentMessageId:'mail-sent-p',
    recipients:[{address:'buyer@partner.test',role:'to',status:'accepted',reply:'250 queued',at:'2026-10-14T01:00:00Z'},{address:'bounce@partner.test',role:'to',status:'rejected',reply:'550 5.1.1 <bounce@partner.test>: User unknown',at:'2026-10-14T01:00:00Z'}],
    attempts:[{at:'2026-10-14T01:00:00Z',actor:'顾言',outcome:'claimed',code:'SEND_STARTED',message:'已登记，开始投递'},{at:'2026-10-14T01:00:00Z',actor:'顾言',outcome:'partial',code:'SMTP_PARTIAL',message:'发信服务器只接收了部分收件人；被拒：bounce@partner.test'}]};
  s.email.sends=[rec];
  s.email.messages.push({...s.email.messages[0],id:'mail-sent-p',folder:'sent',subject:'部分被拒的邮件',from:{name:'业务邮箱',address:'sales@sylway.cloud'},to:[{name:'',address:'buyer@partner.test'},{name:'',address:'bounce@partner.test'}],attachments:[],remote:undefined,messageId:'<p@sylway.cloud>',sendId:'send-partial'});
  store.state=s;store.mail.mockResolvedValue({send:{id:'send-partial',status:'partial',recipients:[{address:'buyer@partner.test',status:'accepted'},{address:'bounce@partner.test',status:'rejected'}]}});render('send-partial');
  expect(host.textContent).toContain('部分收件人未被接收');
  expect(host.textContent).toContain('550 5.1.1 <bounce@partner.test>: User unknown');
  expect(document.querySelector('[data-recipient="buyer@partner.test"]')!.textContent).toContain('服务器已接受');
  expect(document.querySelector('[data-recipient="bounce@partner.test"]')!.textContent).toContain('被拒收');
  expect(button('重发')).toBeUndefined();
  await click(button('仅重发未接收的收件人')!);
  expect(store.mail).toHaveBeenLastCalledWith({kind:'retry',sendId:'send-partial'});
  expect(document.body.textContent).toContain('以下收件人未被接收：bounce@partner.test');
  render('mail-sent-p');
  expect(host.textContent).toContain('发件服务器已接受：buyer@partner.test；未接收或无法确认：bounce@partner.test（被拒收）');
  expect(host.textContent).not.toContain('已接受全部收件人');
});

it('downloads synced attachments and explains omitted ones; forwarding carries the stored attachment',async()=>{
  store.state=realState();render('mail-real-1');
  const downloads=[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='下载') as HTMLButtonElement[];
  expect(downloads[0].disabled).toBe(false);expect(downloads[1].disabled).toBe(true);
  expect(host.textContent).toContain('附件超过 50 MB');
  await click(downloads[0]);
  expect(store.downloadFile).toHaveBeenCalledWith(expect.objectContaining({id:'file-a'}));
  await click(button('转发')!);
  store.mail.mockResolvedValue({send:{id:'s2',status:'sent'}});type('收件人','colleague@partner.test');
  await click([...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='发送').at(-1)!);
  // 确认弹窗列出转发携带的附件名称与大小
  expect(document.body.textContent).toContain('附件（1）');expect(document.body.textContent).toContain('报价单.pdf（2 KB）');
  await click(button('确认发送')!);
  expect(store.mail.mock.calls.at(-1)![0]).toMatchObject({kind:'send',forwardOfId:'mail-real-1',input:{fileIds:['file-a']}});
  expect(store.mail.mock.calls.at(-1)![0].input.replyToId).toBeUndefined();
});

it('connects a mailbox: saves settings without the password, then binds the credential separately',async()=>{
  store.state=createMistState(ctx,'empty');store.run.mockResolvedValue({result:{id:'acc-new'}});store.mail.mockResolvedValue({});render();
  await click(button('打开邮箱账号')!);
  await click(button('接入邮箱')!);
  type('邮箱地址','sales@sylway.cloud');type('显示名称','业务邮箱');type('IMAP 服务器','mail.sylway.cloud');type('SMTP 服务器','mail.sylway.cloud');type('密码或授权码','s3cret-value');
  await click(button('保存并验证登录')!);
  const command=store.run.mock.calls.at(-1)![0];
  expect(command).toMatchObject({type:'email.account.save',payload:{input:{address:'sales@sylway.cloud',kind:'personal',transport:{imapHost:'mail.sylway.cloud',imapPort:993,smtpPort:587,username:'sales@sylway.cloud'}}}});
  expect(JSON.stringify(command)).not.toContain('s3cret-value');
  expect(store.mail).toHaveBeenCalledWith({kind:'bind',accountId:'acc-new',password:'s3cret-value'});
});

it('only the connecting user can change a mailbox; examples cannot send',()=>{
  store.state=realState('other-user');render();
  act(()=>button('邮箱账号')!.click());
  expect(document.body.textContent).toContain('只有接入人可以修改设置或凭据');
  expect(button('绑定凭据')).toBeUndefined();expect(button('修改设置')).toBeUndefined();
});

const mailPending=(requestKey:string,input:Record<string,unknown>,extra:Record<string,unknown>={})=>({workspaceId:'w',requestId:requestKey,expectedRevision:0,kind:'mail-send',mail:{requestKey,input,...extra}});
it('a reply whose receipt was lost stays open, blocks other mail work and is checked with the original request instead of resent',async()=>{
  store.state=realState();render('mail-real-1');
  await click(button('回复')!);
  store.mail.mockRejectedValueOnce(new Error('连接断开；发送结果尚未确认，请核对原请求'));
  await click([...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='发送').at(-1)!);await click(button('确认发送')!);
  const sent=store.mail.mock.calls[0][0];expect(sent.input.replyToId).toBe('mail-real-1');
  expect(host.textContent).toContain('发送结果尚未确认');
  // 运行时已把原意图存本机：页面显示专门的核对横幅，写信内容仍在
  store.pending=mailPending(sent.requestKey,sent.input);render('mail-real-1');
  expect(host.textContent).toContain(`上次发送「${sent.input.subject}」未收到服务器回执`);expect(host.textContent).toContain('收件人：buyer@partner.test');
  expect(document.querySelector('[aria-label="收件人"]')).not.toBeNull();
  expect(button('写邮件')!.disabled).toBe(true);
  store.recover.mockImplementation(async()=>{store.pending=null;return {requestId:sent.requestKey,revision:1,result:{send:{id:'send-new',status:'sent',replayed:true}}};});
  await click(button('核对发送结果')!);render('mail-real-1');
  expect(store.recover).toHaveBeenCalledTimes(1);expect(store.mail).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('该邮件此前已发送，未重复投递');
  expect(button('核对发送结果')).toBeUndefined();expect(document.querySelector('[aria-label="收件人"]')).toBeNull();
});

it('a restored draft or forward intent reports an uncertain recovered result and keeps a failed check visible',async()=>{
  const s=realState() as any;s.email.sends.push({...s.email.sends[0],id:'send-new',requestKey:'draft-d1-1',subject:'草稿报价',status:'unknown'});store.state=s;
  store.pending=mailPending('draft-d1-1',{accountId:'acc-real',to:'buyer@partner.test',cc:'boss@partner.test',subject:'草稿报价'},{draftId:'d1'});render();
  expect(host.textContent).toContain('上次发送「草稿报价」未收到服务器回执');expect(host.textContent).toContain('buyer@partner.test；boss@partner.test');
  store.recover.mockRejectedValueOnce(new Error('网络仍不可用；发送结果尚未确认，请稍后再核对'));
  await click(button('核对发送结果')!);
  expect(host.textContent).toContain('网络仍不可用');expect(button('核对发送结果')).toBeDefined();
  store.recover.mockImplementation(async()=>{store.pending=null;return {requestId:'draft-d1-1',revision:1,result:{send:{id:'send-new',status:'unknown',message:'连接在投递过程中中断'}}};});
  await click(button('核对发送结果')!);render();
  expect(document.body.textContent).toContain('发送结果不确定');expect(document.body.textContent).toContain('系统不会自动重发');
  expect(host.textContent).toContain('草稿报价');
});

it('a send intent held for manual review never offers verification or resend; closing only clears the local record',async()=>{
  const s=realState() as any;store.state=s;
  store.pending=mailPending('intent-b-0001',{accountId:'acc-real',to:'buyer@partner.test',subject:'草稿报价'});
  store.pending.mail.review='发送回执与原请求不符：该回执已被其他发送意图认领；不算已发送，也不会重发，已停在待人工核对';render();
  expect(host.textContent).toContain('发送「草稿报价」待人工核对');expect(host.textContent).toContain('已被其他发送意图认领');
  expect(button('核对发送结果')).toBeUndefined();
  store.closeMailReview.mockImplementation(async()=>{store.pending=null;});
  await click(button('已人工核对，关闭记录')!);render();
  expect(store.closeMailReview).toHaveBeenCalledTimes(1);expect(store.recover).not.toHaveBeenCalled();expect(store.mail).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('未发送任何邮件');expect(host.textContent).not.toContain('发送「草稿报价」待人工核对');expect(button('已人工核对，关闭记录')).toBeUndefined();
});

it('a server-confirmed recovered result for a lost intent says nothing was resent and opens the original record',async()=>{
  const s=realState() as any;s.email.sends.push({...s.email.sends[0],id:'send-a',requestKey:'intent-a-0001',aliasKeys:['intent-b-0001'],subject:'草稿报价',status:'sent'});store.state=s;
  store.pending=mailPending('intent-b-0001',{accountId:'acc-real',to:'buyer@partner.test',subject:'草稿报价'});render();
  store.recover.mockImplementation(async()=>{store.pending=null;return {requestId:'intent-b-0001',revision:1,result:{send:{id:'send-a',status:'sent',replayed:true,recovered:true,recoveredFor:'intent-b-0001'}}};});
  await click(button('核对发送结果')!);render();
  expect(document.body.textContent).toContain('已有发送记录，未重复投递');expect(host.textContent).not.toContain('待人工核对');
  expect(store.mail).not.toHaveBeenCalled();expect(store.recover).toHaveBeenCalledTimes(1);
});
