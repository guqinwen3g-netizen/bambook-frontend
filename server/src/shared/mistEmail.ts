/** 智能邮箱工作空间切片：只保存邮件标记、关联、跟进与草稿。本轮没有收发服务，不伪造收信或发送结果。 */
import { MistCommandError, type MistContext, type MistState } from './mistWorkspace';

export type EmailAddress = { name: string; address: string };
export type EmailFolder = 'inbox' | 'drafts' | 'outbox' | 'sent' | 'archive' | 'trash';
export type EmailMessageFolder = 'inbox' | 'sent' | 'archive' | 'trash';
export type EmailLinkKind = 'customer' | 'development' | 'order' | 'invoice';
export type EmailLink = { kind: EmailLinkKind; id: string };
export type EmailAccount = { id: string; address: string; displayName: string; kind: 'personal' | 'shared'; ownerName: string; memberNames: string[]; aliases: string[]; signature: string; connection: 'not_connected' | 'example'; lastSyncAt: string | null; failedFolders: string[]; example: boolean };
export type EmailAttachment = { id: string; name: string; size: number; contentType: string };
export type EmailCategory = { label: string; source: 'rule' | 'ai' | 'none' | 'failed'; detail: string };
export type EmailMessage = {
  id: string; accountId: string; folder: EmailMessageFolder; previousFolder?: EmailMessageFolder; threadId: string;
  from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; subject: string; body: string; at: string; attachments: EmailAttachment[];
  read: boolean; starred: boolean; important: boolean; category: EmailCategory; extracted: Array<{ field: string; value: string }>;
  links: EmailLink[]; followUpTaskIds: string[]; submissions: Array<{ at: string; actor: string; link: EmailLink; taskId: string }>; example: boolean;
};
export type EmailDraftInput = { accountId: string; from: string; to: string; cc: string; bcc: string; subject: string; body: string; template: string; links: EmailLink[]; fileIds: string[]; replyToId?: string };
export type EmailDraft = EmailDraftInput & { id: string; createdAt: string; updatedAt: string; updatedBy: string };
export type EmailState = { accounts: EmailAccount[]; messages: EmailMessage[]; drafts: EmailDraft[] };
export type EmailCommand =
  | { type: 'email.flag'; payload: { id: string; flag: 'read' | 'starred' | 'important'; value: boolean } }
  | { type: 'email.move'; payload: { id: string; folder: 'inbox' | 'archive' | 'trash' | 'restore' } }
  | { type: 'email.link'; payload: { id: string; link: EmailLink } }
  | { type: 'email.unlink'; payload: { id: string; link: EmailLink } }
  | { type: 'email.followUp'; payload: { id: string; owner: string; due: string; note: string } }
  | { type: 'email.submitExtraction'; payload: { id: string; link: EmailLink } }
  | { type: 'email.draft.save'; payload: { id?: string; input: EmailDraftInput } }
  | { type: 'email.draft.delete'; payload: { id: string } };

const fail = (message: string, code = 'VALIDATION'): never => { throw new MistCommandError(code, message, code === 'NOT_FOUND' ? 404 : 422); };
const text = (value: unknown, label: string, required = false, max = 2000) => { const v = typeof value === 'string' ? value.trim() : ''; if (required && !v) fail(`请填写${label}`); if (v.length > max) fail(`${label}过长`); return v; };
const LINK_KINDS: EmailLinkKind[] = ['customer', 'development', 'order', 'invoice'];
export const EMAIL_LINK_LABEL: Record<EmailLinkKind, string> = { customer: '客户', development: '开发案', order: '订单', invoice: '发票' };

export function createEmailState(_context: MistContext, _root: unknown): EmailState { return { accounts: [], messages: [], drafts: [] }; }
export function emailCommandPermission(_command: EmailCommand) { return 'emails:write'; }

/** 关联目标必须是当前工作空间里真实存在的对象。 */
export function emailLinkTarget(root: MistState, link: EmailLink): { label: string; view: string; id: string } | null {
  if (link.kind === 'customer') { const row = root.customers.find(item => item.id === link.id); return row ? { label: row.name, view: 'crm', id: row.id } : null; }
  if (link.kind === 'development') { const row = root.devs.find(item => item.id === link.id); return row ? { label: `${row.code} · ${row.name}`, view: 'development/detail', id: row.id } : null; }
  if (link.kind === 'order') { const row = root.orders.find(item => item.id === link.id); return row ? { label: `${row.code} · ${row.customer}`, view: 'orders/detail', id: row.id } : null; }
  const row = root.invoices.find(item => item.id === link.id); return row ? { label: `${row.code} · ${row.customer}`, view: 'payment-vouchers', id: row.id } : null;
}
function link(root: MistState, value: EmailLink): EmailLink {
  if (!value || !LINK_KINDS.includes(value.kind)) fail('关联对象类型无效');
  const id = text(value.id, '关联对象', true, 200); if (!emailLinkTarget(root, { kind: value.kind, id })) fail('关联对象不在当前工作空间', 'NOT_FOUND');
  return { kind: value.kind, id };
}
const sameLink = (a: EmailLink, b: EmailLink) => a.kind === b.kind && a.id === b.id;
function message(root: MistState, id: string) { return root.email.messages.find(row => row.id === id) || fail('邮件不存在或已移除', 'NOT_FOUND'); }
function log(root: MistState, context: MistContext, entityId: string, textValue: string) { root.events.unshift({ id: context.id(), entityType: 'email', entityId, actor: context.actorName, at: context.now, text: textValue, fileIds: [] }); }
const addressList = (value: string, label: string) => { const parts = value.split(/[,;，；\s]+/).map(item => item.trim()).filter(Boolean); for (const item of parts) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item)) fail(`${label}中的地址格式无效：${item}`); return parts.join(', '); };

export function applyEmailCommand(root: MistState, command: EmailCommand, context: MistContext): { id: string } {
  const p = command.payload as Record<string, unknown>;
  switch (command.type) {
    case 'email.flag': {
      const row = message(root, String(p.id)); const flag = command.payload.flag; if (!['read', 'starred', 'important'].includes(flag)) fail('标记类型无效');
      row[flag] = !!command.payload.value; return { id: row.id };
    }
    case 'email.move': {
      const row = message(root, String(p.id)), target = command.payload.folder;
      if (target === 'restore') { if (row.folder !== 'trash') fail('只有已删除的邮件可以恢复', 'PRECONDITION'); row.folder = row.previousFolder || 'inbox'; delete row.previousFolder; log(root, context, row.id, '恢复邮件 ' + row.subject); return { id: row.id }; }
      if (!['inbox', 'archive', 'trash'].includes(target)) fail('目标文件夹无效');
      if (row.folder === 'sent' && target === 'inbox') fail('已发送邮件不能移到收件箱', 'PRECONDITION');
      if (row.folder === target) return { id: row.id };
      if (target === 'trash') row.previousFolder = row.folder;
      row.folder = target; log(root, context, row.id, (target === 'trash' ? '删除邮件 ' : target === 'archive' ? '归档邮件 ' : '移回收件箱 ') + row.subject); return { id: row.id };
    }
    case 'email.link': {
      const row = message(root, String(p.id)), value = link(root, command.payload.link);
      if (!row.links.some(item => sameLink(item, value))) { row.links.push(value); log(root, context, row.id, `关联${EMAIL_LINK_LABEL[value.kind]} ${emailLinkTarget(root, value)!.label}`); }
      return { id: row.id };
    }
    case 'email.unlink': {
      const row = message(root, String(p.id)), value = command.payload.link;
      if (row.submissions.some(item => sameLink(item.link, value))) fail('已向该对象提交过资料，关联不能移除', 'PRECONDITION');
      row.links = row.links.filter(item => !sameLink(item, value)); log(root, context, row.id, '移除邮件关联'); return { id: row.id };
    }
    case 'email.followUp': {
      const row = message(root, String(p.id)), owner = text(p.owner, '负责人', true, 80), note = text(p.note, '说明', false, 500), due = text(p.due, '截止日', true, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) fail('截止日格式无效');
      const id = context.id(), target = { view: 'emails', id: row.id };
      root.tasks.unshift({ id, title: `跟进邮件：${row.subject}`, due, done: false, kind: 'email-follow-up', target });
      root.calendar.push({ id: context.id(), title: `邮件跟进 · ${row.subject}`, date: due, time: '', note: `${owner}${note ? ' · ' + note : ''} · 来源：${row.from.name || row.from.address}`, target });
      row.followUpTaskIds.push(id); log(root, context, row.id, `生成邮件跟进（${owner}，${due}）`); return { id };
    }
    case 'email.submitExtraction': {
      const row = message(root, String(p.id)), value = link(root, command.payload.link);
      if (!row.extracted.length) fail('这封邮件没有可提交的抽取资料', 'PRECONDITION');
      if (!row.links.some(item => sameLink(item, value))) fail('请先确认关联该业务对象', 'PRECONDITION');
      if (row.submissions.some(item => sameLink(item.link, value))) fail('已向该对象提交过这份资料', 'PRECONDITION');
      const target = emailLinkTarget(root, value)!, id = context.id();
      root.tasks.unshift({ id, title: `复核邮件资料：${row.extracted.map(item => `${item.field} ${item.value}`).join('，')}`.slice(0, 180), due: context.now.slice(0, 10), done: false, kind: 'email-extraction-review', target: { view: target.view, id: target.id } });
      row.submissions.push({ at: context.now, actor: context.actorName, link: value, taskId: id });
      log(root, context, row.id, `提交邮件抽取资料到${EMAIL_LINK_LABEL[value.kind]} ${target.label}（待复核，不改正式数据）`); return { id: row.id };
    }
    case 'email.draft.save': {
      const input = command.payload.input || ({} as EmailDraftInput), account = root.email.accounts.find(row => row.id === input.accountId) || fail('请选择发件邮箱', 'NOT_FOUND');
      const from = text(input.from, '发件身份', true, 200); if (from !== account.address && !account.aliases.includes(from)) fail('发件身份不在该邮箱允许的别名中');
      const draft = { accountId: account.id, from, to: addressList(text(input.to, '收件人', false, 2000), '收件人'), cc: addressList(text(input.cc, '抄送', false, 2000), '抄送'), bcc: addressList(text(input.bcc, '密送', false, 2000), '密送'), subject: text(input.subject, '主题', false, 300), body: text(input.body, '正文', false, 20000), template: text(input.template, '模板', false, 40), links: (input.links || []).map(item => link(root, item)), fileIds: [...new Set((input.fileIds || []).map(String))], ...(input.replyToId ? { replyToId: message(root, String(input.replyToId)).id } : {}) };
      for (const fileId of draft.fileIds) if (!root.files.some(file => file.id === fileId)) fail('附件不在当前工作空间', 'NOT_FOUND');
      const existing = command.payload.id ? root.email.drafts.find(row => row.id === command.payload.id) || fail('草稿不存在或已删除', 'NOT_FOUND') : undefined;
      if (existing) { Object.assign(existing, draft, { updatedAt: context.now, updatedBy: context.actorName }); if (!draft.replyToId) delete existing.replyToId; return { id: existing.id }; }
      const id = context.id(); root.email.drafts.unshift({ ...draft, id, createdAt: context.now, updatedAt: context.now, updatedBy: context.actorName }); return { id };
    }
    case 'email.draft.delete': {
      const before = root.email.drafts.length; root.email.drafts = root.email.drafts.filter(row => row.id !== String(p.id)); if (before === root.email.drafts.length) fail('草稿不存在或已删除', 'NOT_FOUND'); return { id: String(p.id) };
    }
  }
  return fail('未知邮件操作');
}

/** 示例空间的合成邮件：全部标注示例、使用 example.invalid 地址，不代表真实收信。 */
export function seedEmailExamples(root: MistState, context: MistContext) {
  const day = (offset: number, time: string) => { const date = new Date(context.now); date.setUTCDate(date.getUTCDate() - offset); return date.toISOString().slice(0, 10) + 'T' + time + ':00Z'; };
  const me = context.actorName || '顾言';
  root.email.accounts.push(
    { id: 'mail-personal', address: 'gu.yan@bambook.example.invalid', displayName: `${me}（示例个人邮箱）`, kind: 'personal', ownerName: me, memberNames: [], aliases: ['sales@bambook.example.invalid'], signature: `${me}\n竹衍服饰 · 业务部\n示例签名`, connection: 'example', lastSyncAt: day(0, '07:40'), failedFolders: [], example: true },
    { id: 'mail-shared', address: 'orders@bambook.example.invalid', displayName: '订单共享邮箱（示例）', kind: 'shared', ownerName: '沈禾', memberNames: [me, '沈禾'], aliases: [], signature: '竹衍服饰 · 订单组', connection: 'example', lastSyncAt: day(0, '07:35'), failedFolders: ['已发送'], example: true },
  );
  const customer = root.customers[0], order = root.orders.find(row => row.code === 'SO-G-2026-018') || root.orders[0], dev = root.devs[0], invoice = root.invoices[0];
  const buyer = { name: 'Emma Clarke', address: 'emma.clarke@cedarcrown.example.invalid' }, ops = { name: 'Sophie Hale', address: 'sophie.hale@cedarcrown.example.invalid' };
  const mine = { name: me, address: 'gu.yan@bambook.example.invalid' }, shared = { name: '订单组', address: 'orders@bambook.example.invalid' };
  const base = (id: string, patch: Partial<EmailMessage>): EmailMessage => ({ id, accountId: 'mail-personal', folder: 'inbox', threadId: id, from: buyer, to: [mine], cc: [], subject: '', body: '', at: day(0, '08:00'), attachments: [], read: false, starred: false, important: false, category: { label: '', source: 'none', detail: '未配置分类规则' }, extracted: [], links: [], followUpTaskIds: [], submissions: [], example: true, ...patch });
  root.email.messages.push(
    base('mail-ex-1', { subject: `PO 确认：${order?.code || '大货订单'} 首批大衣与西装`, body: `Hi ${me},\n\n附件是我方正式 PO CC-PO-88231，请按以下内容安排：\n- 双面羊毛城市大衣 1,200 件，交期 11 月 8 日前离港\n- 雾蓝精纺羊毛西装 800 件\n单价按 10 月报价执行。请回传 PI。\n\nBest,\nEmma\n（示例邮件）`, at: day(0, '08:12'), important: true, attachments: [{ id: 'att-1', name: 'CC-PO-88231.pdf', size: 248000, contentType: 'application/pdf' }], category: { label: '订单确认', source: 'rule', detail: '规则：主题含“PO”且发件人为客户联系人' }, extracted: [{ field: 'PO 号', value: 'CC-PO-88231' }, { field: '数量', value: '大衣 1,200 件；西装 800 件' }, { field: '交期', value: '11 月 8 日前离港' }], links: [...(customer ? [{ kind: 'customer' as const, id: customer.id }] : []), ...(order ? [{ kind: 'order' as const, id: order.id }] : [])] }),
    base('mail-ex-2', { from: ops, subject: `${dev?.code || '开发案'} 二轮样品反馈`, body: `Hi,\n\n二轮样已收到。袖长偏长约 1.2cm，领口挺度可以接受。请确认三轮样寄出日期。\n\nSophie\n（示例邮件）`, at: day(1, '15:20'), read: true, starred: true, attachments: [{ id: 'att-2', name: '二轮样照片.zip', size: 5120000, contentType: 'application/zip' }], category: { label: '样品反馈', source: 'ai', detail: 'AI 结果 · 置信度中，需人工复核' }, extracted: [{ field: '修改意见', value: '袖长偏长约 1.2cm' }], links: dev ? [{ kind: 'development', id: dev.id }] : [] }),
    base('mail-ex-3', { from: { name: 'Sophie Hale', address: 'sophie@cedarcrown.co.uk' }, subject: '付款通知：本周汇出尾款', body: `Hello,\n\n我方本周五会汇出 ${invoice?.code || '发票'} 对应款项，请留意查收。\n\nSophie\n（示例邮件）`, at: day(2, '09:05'), category: { label: '付款', source: 'rule', detail: '规则：正文含“汇出 / 付款”' }, extracted: invoice ? [{ field: '发票号', value: invoice.code }] : [] }),
    base('mail-ex-4', { accountId: 'mail-shared', from: { name: '江南成衣 · 王厂长', address: 'wang@jiangnan-garment.example.invalid' }, to: [shared], subject: '面料到货延迟两天', body: '各位好：\n\n雾蓝精纺面料染厂通知延迟两天到货，西装车缝相应顺延，请业务知悉并评估是否需要告知客户。\n\n王\n（示例邮件）', at: day(0, '07:30'), category: { label: '', source: 'failed', detail: 'AI 分类失败：服务暂不可用，可手动关联' } }),
    base('mail-ex-5', { folder: 'sent', from: mine, to: [buyer], subject: `Re: ${dev?.code || '开发案'} 首样寄出`, body: `Hi Emma,\n\n首样已于今天寄出，运单 SF1234567890（示例）。\n\n${me}\n（示例邮件）`, at: day(5, '10:00'), read: true, category: { label: '样品寄出', source: 'rule', detail: '规则：已发送 · 含运单号' }, links: dev ? [{ kind: 'development', id: dev.id }] : [] }),
  );
}
