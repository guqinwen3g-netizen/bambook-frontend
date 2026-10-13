import { describe, expect, it, vi } from 'vitest';
import {
  dbListUrlForBox,
  directionForBox,
  fetchDbEmailList,
  parseDbEmailList,
} from './emailListSource';

/**
 * B260 的行为证人（服务级，不需要整套 App 上下文）。
 *
 * ★ 为什么证在这里而不是组件里：本域组件惯例是"源码结构断言"（挂载要整套 App），
 *   而这条缺陷的真因是**取数路径**（屏面读 localStorage，DB 那条读接口只有 Outbox 在用）。
 *   把取数抽成本模块后，"库里放回 N 封 ⇒ 拿到 N 封"就成了可红断言；
 *   "它真的被屏面调用"由 :3002 上真点一次作证（活路径，不靠读码推断）。
 */

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `SIM-EML-${i}`, subject: `s${i}` }));

function stubFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('directionForBox：沿用服务端已有的规则，不新造语义', () => {
  it('三个"已发送"写法都是 outbound（逐字对齐 emailSyncService 的判定）', () => {
    for (const box of ['Sent Messages', 'Sent', 'Sent Items']) {
      expect(directionForBox(box)).toBe('outbound');
    }
  });
  it('其余夹一律 inbound（INBOX 是主用例）', () => {
    expect(directionForBox('INBOX')).toBe('inbound');
    expect(directionForBox('Drafts')).toBe('inbound');
    expect(directionForBox('Trash')).toBe('inbound');
  });
});

describe('dbListUrlForBox：只映射有 DB 写入路径的夹，映射不到就 null（不猜）', () => {
  it('INBOX ⇒ mailbox=INBOX + direction=inbound', () => {
    const url = dbListUrlForBox('INBOX');
    expect(url).not.toBeNull();
    expect(url).toContain('/v1/email?');
    const q = new URLSearchParams(url!.split('?')[1] ?? '');
    expect(q.get('mailbox')).toBe('INBOX');
    expect(q.get('direction')).toBe('inbound');
    expect(q.get('limit')).toBe('100');
  });
  it('Sent Messages ⇒ 同一个 mailbox 取值 + outbound（UI 夹名本来就是 IMAP 夹名）', () => {
    const url = dbListUrlForBox('Sent Messages')!;
    const q = new URLSearchParams(url.split('?')[1] ?? '');
    expect(q.get('mailbox')).toBe('Sent Messages');
    expect(q.get('direction')).toBe('outbound');
  });
  it('虚拟夹（UNREAD/STARRED/IMPORTANT）与未知夹 ⇒ null：宁可不列，也不按措辞猜一个查询', () => {
    for (const box of ['UNREAD', 'STARRED', 'IMPORTANT', 'Outbox', 'All Mail', '']) {
      expect(dbListUrlForBox(box), `夹 ${box} 不该被猜成一条 DB 查询`).toBeNull();
    }
  });
});

describe('parseDbEmailList：给几条返回几条；认不出来的形状一律抛，不许静默成"没有邮件"', () => {
  it('★ 核心那条：ok+items(8) ⇒ 交出同样 8 行（"放回 N 封 ⇒ 列出 N 封"的函数级证人）', () => {
    const got = parseDbEmailList({ ok: true, items: rows(8) });
    expect(got).toHaveLength(8);
    expect(got.map((r: any) => r.id)).toEqual(rows(8).map((r) => r.id));
  });
  it('合法的空 ⇒ 空数组（空邮箱是真的，不是缺陷）', () => {
    expect(parseDbEmailList({ ok: true, items: [] })).toEqual([]);
  });
  it.each([
    ['整个响应是 null', null],
    ['响应不是对象', 'oops'],
    ['ok 缺失', { items: rows(3) }],
    ['ok=false（接口自己说失败）', { ok: false, error: 'X' }],
    ['ok=true 但没有 items', { ok: true }],
    ['items 不是数组', { ok: true, items: { 0: 'a' } }],
  ])('★ 认不出来 ⇒ 抛：%s', (_label: string, body: unknown) => {
    expect(() => parseDbEmailList(body)).toThrow();
  });
});

describe('fetchDbEmailList：走映射出来的那条 URL，HTTP 失败也要抛', () => {
  it('200 ⇒ 8 行，且请求打到带 mailbox/direction 的 URL', async () => {
    const f = stubFetch({ ok: true, items: rows(8) });
    const got = await fetchDbEmailList({ box: 'INBOX', fetchImpl: f, headers: { Authorization: 'Bearer t' } });
    expect(got).toHaveLength(8);
    expect(f).toHaveBeenCalledTimes(1);
    const url = String((f as any).mock.calls[0][0]);
    expect(url).toContain('/v1/email?');
    expect(decodeURIComponent(url)).toContain('mailbox=INBOX');
    expect((f as any).mock.calls[0][1].headers.Authorization).toBe('Bearer t');
  });
  it('HTTP 500 ⇒ 抛（不是返回 []）', async () => {
    const f = stubFetch({ ok: false }, false, 500);
    await expect(fetchDbEmailList({ box: 'INBOX', fetchImpl: f })).rejects.toThrow(/500/);
  });
  it('没有映射的夹 ⇒ 连请求都不该发', async () => {
    const f = stubFetch({ ok: true, items: rows(1) });
    await expect(fetchDbEmailList({ box: 'UNREAD', fetchImpl: f })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});
