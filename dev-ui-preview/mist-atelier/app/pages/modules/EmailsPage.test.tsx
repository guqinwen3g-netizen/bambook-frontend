// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn(),mail:vi.fn()}));
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
beforeEach(()=>{session.denied=new Set();store.state=createMistState(ctx,'demo');store.run.mockReset();store.run.mockResolvedValue({result:{}});store.mail.mockReset();store.downloadFile.mockReset();go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
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
  const send=()=>[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='发送').at(-1)!;
  expect(send().disabled).toBe(false);
  await click(send());
  expect(host.textContent).toContain('网络中断，请重试');
  const first=store.mail.mock.calls[0][0];
  expect(first).toMatchObject({kind:'send',input:{accountId:'acc-real',to:'buyer@partner.test',subject:'报价'}});
  expect(first.requestKey).toMatch(/^[A-Za-z0-9]{8,80}$/);
  store.mail.mockResolvedValueOnce({send:{id:'send-new',status:'unknown',message:'连接中断'}});
  await click(send());
  expect(store.mail.mock.calls[1][0].requestKey).toBe(first.requestKey);
  expect(document.body.textContent).toContain('发送结果不确定');
  expect(document.body.textContent).toContain('系统不会自动重发');
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
