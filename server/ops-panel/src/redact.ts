/**
 * 命令行 / 日志文本脱敏（2026-09-15 加固）。
 *
 * 背景：`pgrep -lf cloudflared` 会输出完整命令行，其中 `--token eyJ...` 是 Cloudflare
 * Tunnel 凭据——拿到它等于能接管整条隧道（可把公网域名指向任意源站）。
 * 此前该文本原样进入 /api/status 响应，进而出现在运维面板页面、浏览器缓存，
 * 以及任何被转发 / 采集的日志里。运维面板虽需 ops token 才能访问，但凭据一旦出网
 * 就不再受控，属于应当彻底避免的泄漏面。
 *
 * 独立成模块的原因：可被单测直接引用做行为验证（index.ts 一 import 就会起服务）。
 */

export const REDACTED = '***REDACTED***';

/**
 * 两道规则：
 *   1. `--token <值>` / `--token=<值>` → 值替换（cloudflared 的写法，主路径）
 *   2. `eyJ` 开头的长 base64url 串 → 兜底替换。
 *      注意 Cloudflare tunnel token 是 base64url(JSON)，**不含点**，不是标准 JWT 三段式——
 *      所以点号段必须写成可选，否则这道兜底对真正的隧道凭据反而无效（实测踩过：
 *      按 JWT 三段式写正则，兜底用例直接红）。同时这样也能盖住标准 JWT。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/--token[=\s]+[^\s]+/gi, `--token ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/g, REDACTED);
}
