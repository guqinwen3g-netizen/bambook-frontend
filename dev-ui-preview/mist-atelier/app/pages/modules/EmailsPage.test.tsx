// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {MistRoot,ToastProvider} from '../../../../../components/mist';
import {createMistState,type MistState} from '../../../../../server/src/shared/mistWorkspace';
import {Nav} from '../../nav';
const store=vi.hoisted(()=>({state:null as MistState|null,loading:false,error:'',saving:false,pending:null,run:vi.fn(),refresh:vi.fn(),uploadFile:vi.fn(),downloadFile:vi.fn()}));
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
beforeEach(()=>{session.denied=new Set();store.state=createMistState(ctx,'demo');store.run.mockReset();store.run.mockResolvedValue({result:{}});go.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
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
  expect(send.title).toContain('尚未接入发信服务');
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
