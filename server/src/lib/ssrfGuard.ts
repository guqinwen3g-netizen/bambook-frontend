import dns from 'node:dns';

/**
 * SSRF 防护（2026-09-15 重写，取代原先内联在 index.ts 的版本）。
 *
 * 背景：`GET /api/fetch-url` 让服务端代用户抓取任意 URL。原先只有一层
 * 「初始 URL 字符串黑名单」，实测存在两个绕过（均有真机复现记录）：
 *   1. **重定向绕过**：`fetch` 默认跟随 3xx，黑名单只校初始 URL。
 *      用 `http://httpbin.org/redirect-to?url=http://127.0.0.1:9999/`
 *      实测**读到了内网标记服务的响应**。
 *   2. **IPv4-mapped IPv6 绕过**：`http://[::ffff:127.0.0.1]:8081/`
 *      既不在 hostname 黑名单里、也不是四段点分十进制，实测**未被拦截**且请求到达本机服务。
 *
 * 因此本模块把防护收口为三件事：
 *   a. **地址判定**：覆盖 v4 私网/回环/链路本地/CGNAT，v6 回环/ULA/链路本地/
 *      v4-mapped(::ffff:)/NAT64(64:ff9b::)/6to4(2002::)；十进制/八进制/十六进制写法
 *      由 WHATWG URL 归一化后自动命中（实测 2130706433 / 0177.0.0.1 / 0x7f.0.0.1 均已拦）。
 *   b. **DNS 判定**：域名解析出的**每一个** A/AAAA 都要过一遍，防「域名指向内网」
 *      （如 *.internal、或攻击者自持域名 A 记录写 127.0.0.1）。
 *   c. **逐跳校验**：手动跟随重定向，最多 `maxRedirects` 跳，**每一跳都重新做 a+b**。
 *
 * 用法：
 *   const blocked = await assertPublicUrl(url);        // 只判不请求
 *   const res = await safeFetch(url, init);            // 请求 + 逐跳校验
 */

export class SsrfBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SsrfBlockedError';
    }
}

export const BLOCKED_SSRF_HOSTNAMES = new Set([
    'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
    '0.0.0.0', '::', '::1',
]);

export const BLOCKED_MESSAGE = '不允许访问内网/回环地址';
export const PROTOCOL_MESSAGE = '仅支持 http/https 协议';

/** 判定是否是私有/保留 IPv4（点分四段数值）。 */
export function isPrivateV4(nums: number[]): boolean {
    if (nums.length !== 4) return false;
    const [a, b] = nums;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16（含云 metadata 169.254.169.254）
    if (a === 127 || a === 0) return true;            // 回环 / 本网络
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && nums[2] === 0) return true; // 192.0.0.0/24
    // 注：198.18.0.0/15（benchmark）**不**纳入拦截——本机与部分开发机的 DNS 代理
    // （fake-ip 模式）会把所有域名解析到该段，纳入会导致全部公网域名被误拦。
    if (a >= 224) return true;                        // 组播/保留/实验
    return false;
}

/** 把 IPv6 字面量展开成 8 个 16 位组；非 IPv6 返回 null。 */
export function expandIpv6(host: string): number[] | null {
    const h = host.replace(/^\[|\]$/g, '');
    if (!h.includes(':')) return null;
    // 尾部可能是嵌入式 IPv4，如 ::ffff:127.0.0.1
    let text = h;
    const embedded = h.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (embedded) {
        // hi/lo 各是 16 位组（不是字节）：a.b → a<<8|b
        const hi = Number(embedded[1]) * 256 + Number(embedded[2]);
        const lo = Number(embedded[3]) * 256 + Number(embedded[4]);
        text = h.slice(0, embedded.index) + hi.toString(16) + ':' + lo.toString(16);
    }
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const toGroups = (s: string): number[] =>
        s === '' ? [] : s.split(':').map((g) => parseInt(g === '' ? '0' : g, 16));
    const head = toGroups(halves[0]);
    const tail = halves.length === 2 ? toGroups(halves[1]) : [];
    if (halves.length === 1) return head.length === 8 ? head : null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array(fill).fill(0), ...tail];
}

/** 从 IPv6 组里还原出内嵌的 IPv4（v4-mapped / NAT64 / 6to4），无则 null。 */
function embeddedV4(groups: number[]): number[] | null {
    if (groups.length !== 8) return null;
    // 注意：这里必须用显式下标。写成 `const [g0,g1,g2,g5,g6,g7] = groups` 是按位置解构，
    // 取到的是下标 0,1,2,3,4,5 —— 会让 v4-mapped 判定永远落空（本模块第一版就踩了这个坑）。
    const g = (i: number) => groups[i];
    const tailV4 = () => [(g(6) >> 8) & 0xff, g(6) & 0xff, (g(7) >> 8) & 0xff, g(7) & 0xff];
    if (g(0) === 0 && g(1) === 0 && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0xffff) {
        return tailV4(); // ::ffff:0:0/96 v4-mapped
    }
    if (g(0) === 0x64 && g(1) === 0xff9b && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
        return tailV4(); // 64:ff9b::/96 NAT64
    }
    if (g(0) === 0x2002) {
        return [(g(1) >> 8) & 0xff, g(1) & 0xff, (g(2) >> 8) & 0xff, g(2) & 0xff]; // 2002::/16 6to4
    }
    return null;
}

/** 判定 IPv6 字面量是否是私有/保留地址。 */
export function isPrivateV6(host: string): boolean {
    const groups = expandIpv6(host);
    if (!groups) return false;
    const g0 = groups[0];
    if (groups.every((g) => g === 0)) return true;              // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
    if ((g0 & 0xfe00) === 0xfc00) return true;                   // fc00::/7 唯一本地
    if ((g0 & 0xffc0) === 0xfe80) return true;                   // fe80::/10 链路本地
    if ((g0 & 0xff00) === 0xff00) return true;                   // 组播
    const v4 = embeddedV4(groups);
    if (v4 && isPrivateV4(v4)) return true;                      // v4-mapped / NAT64 / 6to4
    return false;
}

/** 判定一个「地址字面量」（IP，非域名）是否私有。 */
export function isPrivateAddressLiteral(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (BLOCKED_SSRF_HOSTNAMES.has(h)) return true;
    const dotted = h.split('.');
    if (dotted.length === 4 && dotted.every((p) => /^\d{1,3}$/.test(p))) {
        return isPrivateV4(dotted.map(Number));
    }
    if (h.includes(':')) return isPrivateV6(h);
    return false;
}

/**
 * 同步判定：只看 URL 字符串本身（协议 + 主机名字面量），**不查 DNS**。
 * 返回阻断原因，null 表示放行。
 */
export function isBlockedInternalUrl(raw: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return PROTOCOL_MESSAGE;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return PROTOCOL_MESSAGE;
    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_SSRF_HOSTNAMES.has(host)) return BLOCKED_MESSAGE;
    if (isPrivateAddressLiteral(host)) return BLOCKED_MESSAGE;
    return null;
}

/** 异步补强：把主机名解析成 IP 后逐个判定（防「域名指向内网」）。 */
export async function isBlockedResolvedHost(host: string): Promise<string | null> {
    let records: Array<{ address: string }>;
    try {
        records = await dns.promises.lookup(host, { all: true });
    } catch {
        // 解析失败交给后续真实请求去报错，此处不阻断（避免误伤可用域名）
        return null;
    }
    for (const r of records) {
        if (isPrivateAddressLiteral(r.address)) return BLOCKED_MESSAGE;
    }
    return null;
}

/** 完整校验：字符串判定 + DNS 判定。返回阻断原因，null 表示放行。 */
export async function assertPublicUrl(raw: string): Promise<string | null> {
    const literal = isBlockedInternalUrl(raw);
    if (literal) return literal;
    try {
        return await isBlockedResolvedHost(new URL(raw).hostname);
    } catch {
        return PROTOCOL_MESSAGE;
    }
}

/**
 * 带 SSRF 守卫的 fetch：**手动**跟随重定向，且**每一跳**都重新校验。
 * 被拦截时抛 `SsrfBlockedError`（按类型判，便于上层回 400 而不是 500）。
 */
export async function safeFetch(
    rawUrl: string,
    init: RequestInit = {},
    opts: { maxRedirects?: number } = {},
): Promise<Response> {
    const maxRedirects = opts.maxRedirects ?? 3;
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const blocked = await assertPublicUrl(current);
        if (blocked) throw new SsrfBlockedError(blocked);

        const res = await fetch(current, { ...init, redirect: 'manual' });
        const location = res.headers.get('location');
        const isRedirect = res.status >= 300 && res.status < 400 && Boolean(location);
        if (!isRedirect) return res;
        if (hop === maxRedirects) throw new Error(`重定向次数超过上限（${maxRedirects}）`);
        current = new URL(location as string, current).toString();
    }
    throw new Error(`重定向次数超过上限（${maxRedirects}）`);
}
