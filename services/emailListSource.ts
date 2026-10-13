import { getApiBaseUrl } from './apiBase';
import { checkedDbEmail, emailRequestJson } from './emailReadService';

/**
 * 智能邮箱「列表」的服务端取数路径（台账 §9 **B260** 的修法）
 *
 * ★ 为什么要有这个模块：这一站的缺陷不是"没数据"，是**取数接错了源**——
 *   `App.tsx` / `EmailManager` 的收件箱读的是 `localStorage`，而服务端 `GET /v1/email`
 *   明明认得库里那 8 封（同登录态实测 200 / items 8），前端只有 Outbox 视图在用这条接口。
 *   把"该打哪条 URL、响应怎么算合法"抽到这里，它就能被单测钉住；
 *   组件侧只做"调用 + 渲染"，可达性由 :3002 上真点一次作证。
 *
 * ★ 两条设计约束（都是本仓踩过的）：
 *   ① **映射不到的夹返回 null**，不按名字猜一个查询——虚拟夹（UNREAD/STARRED/IMPORTANT）
 *      与自定义夹今天没有 DB 写入路径，猜出来的列表会把"没接"伪装成"确实没有"。
 *   ② **认不出来的响应一律抛**，不降级成 `[]`。"接口报错"和"这个邮箱是空的"必须是两件事。
 */

/** UI 的 currentBox 取值 ⇒ 服务端 `Email.mailbox` 取值。
 *  只列 `emailSyncService` 会真正写入的四夹（键就是 IMAP 夹名，与 DB 列取值一致）。 */
const DB_BOXES: Readonly<Record<string, string>> = {
  INBOX: 'INBOX',
  'Sent Messages': 'Sent Messages',
  Drafts: 'Drafts',
  Trash: 'Trash',
  Spams: 'Spams',
};

/** 方向规则**沿用服务端已有的那一条**（`server/src/email/emailSyncService.ts:279`），不另立一套。 */
export function directionForBox(box: string): 'outbound' | 'inbound' {
  return box === 'Sent Messages' || box === 'Sent' || box === 'Sent Items' ? 'outbound' : 'inbound';
}

/** 该夹的 DB 列表 URL；映射不到 ⇒ null（调用方必须保持原行为，不许退化成空列表）。 */
export function dbListUrlForBox(box: string, limit: number = 100): string | null {
  const mailbox = DB_BOXES[box];
  if (!mailbox) return null;
  const q = new URLSearchParams({ mailbox, direction: directionForBox(box), limit: String(limit) });
  return `${getApiBaseUrl()}/v1/email?${q.toString()}`;
}

export interface DbEmailRow {
  id: string;
  [key: string]: unknown;
}

/** 响应体 ⇒ 行数组。**任何认不出来的形状都抛**（含 `ok:false`、缺 `items`、`items` 非数组）。 */
export function parseDbEmailList(json: unknown): DbEmailRow[] {
  if (!json || typeof json !== 'object') throw new Error('邮件列表响应不是对象');
  const o = json as { ok?: unknown; items?: unknown };
  if (o.ok !== true) throw new Error('邮件列表接口未返回 ok:true');
  if (!Array.isArray(o.items)) throw new Error('邮件列表响应缺 items 数组');
  return o.items as DbEmailRow[];
}

export interface FetchDbEmailListOptions {
  box: string;
  limit?: number;
  /** 注入点：单测给桩，产品走浏览器全局 fetch。 */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/** 拉一个夹的 DB 列表。映射不到 / HTTP 非 2xx / 响应形状不认识 ⇒ **抛**，由调用方显示失败。 */
export async function fetchDbEmailList(opts: FetchDbEmailListOptions): Promise<DbEmailRow[]> {
  const url = dbListUrlForBox(opts.box, opts.limit ?? 100);
  if (!url) throw new Error(`夹「${opts.box}」没有已核实的 DB 映射`);
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(url, { headers: opts.headers });
  if (!res.ok) throw new Error(`邮件列表 HTTP ${res.status}`);
  return parseDbEmailList(await res.json());
}

export interface DbEmailPage {
  items: DbEmailRow[]; total: number; offset: number; hasMore: boolean;
  sources: Array<{ mailbox: string; total: number; offset: number }>;
}
/** Sent is a logical folder with two existing DB writers. Offsets apply to each
 * physical source; they are not falsely advertised as one globally sorted SQL page. */
export async function fetchDbEmailPage(opts: FetchDbEmailListOptions & { offset?: number; signal?: AbortSignal }): Promise<DbEmailPage> {
  const offset = opts.offset ?? 0, limit = opts.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('邮件分页参数无效。');
  const mailboxes = opts.box === 'Sent Messages' || opts.box === 'Sent' ? ['Sent', 'Sent Messages']
    : opts.box === 'Outbox' ? ['Outbox'] : DB_BOXES[opts.box] ? [DB_BOXES[opts.box]] : [];
  if (!mailboxes.length) throw new Error(`夹「${opts.box}」没有已核实的 DB 映射`);
  const pages = await Promise.all(mailboxes.map(async mailbox => {
    const direction = mailbox === 'Outbox' ? 'outbound' : directionForBox(mailbox);
    const query = new URLSearchParams({ mailbox, direction, limit: String(limit), offset: String(offset) });
    const json = await emailRequestJson(`/v1/email?${query}`, { headers: opts.headers, signal: opts.signal }, opts.fetchImpl);
    if (json?.ok !== true || !Array.isArray(json.items) || !Number.isSafeInteger(json.total) || json.total < 0
      || json.items.length > limit || (json.items.length > 0 && offset + json.items.length > json.total)) throw new Error('邮件分页响应不完整，请重新读取。');
    const items = json.items.map((row: any) => {
      checkedDbEmail(row);
      if (row.mailbox !== mailbox || row.direction !== direction) throw new Error('邮件列表文件夹来源不一致，请重新读取。');
      return row;
    });
    return { items, total: json.total, mailbox, offset };
  }));
  const ids = new Set<string>(), items: DbEmailRow[] = [];
  for (const page of pages) for (const item of page.items) {
    if (ids.has(item.id)) throw new Error('邮件列表出现重复记录，请重新读取。');
    ids.add(item.id); items.push(item);
  }
  return { items, total: pages.reduce((n, p) => n + p.total, 0), offset,
    hasMore: pages.some(p => offset + limit < p.total), sources: pages.map(({ mailbox, total, offset }) => ({ mailbox, total, offset })) };
}
