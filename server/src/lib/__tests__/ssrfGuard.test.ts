import { describe, expect, it, vi, afterEach } from 'vitest';
import {
    assertPublicUrl,
    isBlockedInternalUrl,
    isBlockedResolvedHost,
    isPrivateAddressLiteral,
    isPrivateV6,
    safeFetch,
    SsrfBlockedError,
    BLOCKED_MESSAGE,
    PROTOCOL_MESSAGE,
} from '../ssrfGuard';

/**
 * SSRF 守卫回归测试（2026-09-15）。
 *
 * 每条「拦截」用例都对应一个真机复现过的绕过写法或其在生产可能采取的变形：
 *  - 重定向绕过：外网 302 → http://127.0.0.1:9999/，实测读到内网标记服务响应；
 *  - IPv4-mapped IPv6：http://[::ffff:127.0.0.1]:8081/ 实测未被拦截且到达本机服务。
 * 两条「放行」对照用例用于证明守卫不是一把梭（172.15/172.32/公网 IP 必须放行）。
 */

const PRIVATE = [
    'http://127.0.0.1:8081/',
    'http://localhost:8081/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', // 云 metadata
    'http://0.0.0.0:8081/',
    'http://100.64.0.1/', // CGNAT
];

const PUBLIC = [
    'http://8.8.8.8/',
    'http://93.184.216.34/',
    'http://example.com/',
    'http://172.15.0.1/', // /12 下边界外
    'http://172.32.0.1/', // /12 上边界外
];

const PRIVATE_V6 = [
    'http://[::1]:8081/',
    'http://[::]:8081/',
    'http://[::ffff:127.0.0.1]:8081/',
    'http://[::ffff:7f00:1]:8081/',
    'http://[::ffff:10.0.0.1]:8081/',
    'http://[fd00::1]/', // ULA
    'http://[fe80::1]/', // 链路本地
    'http://[2002:7f00:1::]/', // 6to4 内嵌 127.0.0.1
];

const PUBLIC_V6 = ['http://[2606:4700::1111]/', 'http://[2400:3200::1]/'];

describe('ssrfGuard · 地址字面量判定', () => {
    it('非 http/https 协议一律拒绝（file/ftp/gopher/data）', () => {
        for (const u of ['file:///etc/passwd', 'ftp://10.0.0.1/', 'gopher://127.0.0.1:6379/_INFO', 'data:text/html,x']) {
            expect(isBlockedInternalUrl(u), u).toBe(PROTOCOL_MESSAGE);
        }
        expect(isBlockedInternalUrl('不是URL')).toBe(PROTOCOL_MESSAGE);
    });

    it('私有/回环/链路本地/CGNAT IPv4 一律拦截', () => {
        for (const u of PRIVATE) expect(isBlockedInternalUrl(u), u).toBe(BLOCKED_MESSAGE);
    });

    it('公网 IPv4 与 /12 边界外地址放行（证明不是一把梭）', () => {
        for (const u of PUBLIC) expect(isBlockedInternalUrl(u), u).toBeNull();
    });

    it('IPv6 回环 / ULA / 链路本地 / v4-mapped / 6to4 一律拦截', () => {
        for (const u of PRIVATE_V6) expect(isBlockedInternalUrl(u), u).toBe(BLOCKED_MESSAGE);
    });

    it('公网 IPv6 放行', () => {
        for (const u of PUBLIC_V6) expect(isBlockedInternalUrl(u), u).toBeNull();
    });

    it('十进制 / 八进制 / 十六进制 IPv4 写法拦截（WHATWG URL 归一化后命中）', () => {
        for (const u of ['http://2130706433:8081/', 'http://0177.0.0.1:8081/', 'http://0x7f.0.0.1:8081/']) {
            expect(isBlockedInternalUrl(u), u).toBe(BLOCKED_MESSAGE);
        }
    });

    it('isPrivateAddressLiteral / isPrivateV6 单元判定', () => {
        expect(isPrivateAddressLiteral('127.0.0.1')).toBe(true);
        expect(isPrivateAddressLiteral('8.8.8.8')).toBe(false);
        expect(isPrivateAddressLiteral('::1')).toBe(true);
        expect(isPrivateV6('::ffff:127.0.0.1')).toBe(true);
        expect(isPrivateV6('::ffff:8.8.8.8')).toBe(false);
    });
});

describe('ssrfGuard · DNS 判定（域名指向内网）', () => {
    it('解析结果为内网地址 → 拦截', async () => {
        // IP 字面量不触网：dns.lookup 直接返回自身
        expect(await isBlockedResolvedHost('127.0.0.1')).toBe(BLOCKED_MESSAGE);
        expect(await isBlockedResolvedHost('10.0.0.5')).toBe(BLOCKED_MESSAGE);
    });

    it('解析结果为公网地址 → 放行', async () => {
        expect(await isBlockedResolvedHost('93.184.216.34')).toBeNull();
    });

    it('解析失败不阻断（避免误伤可用域名，交由真实请求报错）', async () => {
        expect(await isBlockedResolvedHost('definitely-not-a-real-host.invalid')).toBeNull();
    });

    it('assertPublicUrl = 字面量判定 + DNS 判定', async () => {
        expect(await assertPublicUrl('http://127.0.0.1:9/')).toBe(BLOCKED_MESSAGE);
        expect(await assertPublicUrl('file:///etc/passwd')).toBe(PROTOCOL_MESSAGE);
        expect(await assertPublicUrl('http://93.184.216.34/')).toBeNull();
    });
});

describe('ssrfGuard · safeFetch 重定向逐跳校验', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const respond = (status: number, location?: string) =>
        new Response(status === 200 ? 'ok' : null, {
            status,
            ...(location ? { headers: { location } } : {}),
        });

    it('初始 URL 即内网 → 直接抛 SsrfBlockedError，且不发起请求', async () => {
        const spy = vi.spyOn(globalThis, 'fetch');
        await expect(safeFetch('http://127.0.0.1:9/')).rejects.toBeInstanceOf(SsrfBlockedError);
        expect(spy).not.toHaveBeenCalled();
    });

    it('正常 200 → 直接返回响应', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(200) as any);
        const res = await safeFetch('http://93.184.216.34/');
        expect(res.status).toBe(200);
    });

    it('重定向到内网 → 第二跳被拦下（这是真机实测到的绕过）', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(302, 'http://127.0.0.1:9999/') as any);
        await expect(safeFetch('http://93.184.216.34/start')).rejects.toBeInstanceOf(SsrfBlockedError);
        expect(spy).toHaveBeenCalledTimes(1); // 第二跳根本没发出去
    });

    it('重定向到 v4-mapped IPv6 内网 → 同样被拦下', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(302, 'http://[::ffff:127.0.0.1]:8081/') as any);
        await expect(safeFetch('http://93.184.216.34/start')).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('重定向到公网 → 跟随并返回最终响应（功能不被误伤）', async () => {
        const spy = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(respond(302, 'https://93.184.216.34/final') as any)
            .mockResolvedValueOnce(respond(200) as any);
        const res = await safeFetch('http://93.184.216.34/start');
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(2);
        expect((spy.mock.calls[1][0] as string)).toContain('/final');
    });

    it('公网之间无限重定向 → 超过上限抛错（非 SSRF 类型）', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any) =>
            respond(302, String(u) + 'a') as any,
        );
        await expect(safeFetch('http://93.184.216.34/start')).rejects.toThrow(/重定向次数超过上限/);
        await expect(safeFetch('http://93.184.216.34/start')).rejects.not.toBeInstanceOf(SsrfBlockedError);
    });
});
