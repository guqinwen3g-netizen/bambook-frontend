/**
 * 「别拿生产当默认目标」这一族的一份实现（v3.237 补 25）。
 *
 * 起因：本批自曝了一次误上线（§9 B281）之后去普查"还有哪些入口默认就会碰外部"，现读到三份脚本
 *   默认 base 指向 `jiangsupanda.com`（生产）且直接 `POST`：
 *     · `scripts/e2e-sse-sim.mjs`      → `POST {prod}/ai/chat`（会真调模型、花配额）
 *     · `scripts/test-frontend-exact.mjs` → `POST {prod}/ai/chat`（同上）
 *     · `scripts/pdml-fabric-import.mjs`  → 往生产云端点写面料档案
 *   ⇒ 与那次部署同一条形状：**危险动作是默认值**。所以闸只做一件事——
 *   指向非本机地址就必须显式授权，否则拒绝，而且**在发请求之前**拒。
 *
 * 用法：`assertNonProdTarget(API_BASE, { what: 'e2e-sse-sim 的 ai/chat' })`
 *   环境变量 `BAMBOOK_ALLOW_PROD=yes` 才放行（放行时大声打一行警告，不留"静默打生产"的路径）。
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);

/** 只判"是不是本机"，不判"是不是已知生产域名" ⇒ 未知外部域名也一并挡（白名单方向才对） */
export function isLoopbackTarget(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  let url;
  try {
    url = new URL(s.startsWith('http') ? s : `http://${s}`);
  } catch {
    return false;
  }
  return LOOPBACK.has(url.hostname);
}

export function assertNonProdTarget(raw, { what = '目标端点', env = process.env } = {}) {
  if (isLoopbackTarget(raw)) return { ok: true, target: raw };
  if (String(env.BAMBOOK_ALLOW_PROD ?? '').trim() === 'yes') {
    // 放行，但不许安静：这一行会留在现场/日志里，事后能归因
    console.warn(`⚠️ 显式授权打非本机端点（BAMBOOK_ALLOW_PROD=yes）：${what} → ${raw}`);
    return { ok: true, target: raw, warned: true };
  }
  throw new Error(
    `REJECTED: ${what} 的目标不是本机（${raw}）。` +
    `要真打外部请显式给 BAMBOOK_ALLOW_PROD=yes —— 生产/外部端点不当默认值用（见台账 §9 B281/B282）。`,
  );
}

/** CLI 用的一层：拒绝时只打一行 + 退出码 2，不要甩一整段栈（栈会让人以为是脚本坏了而不是被拦）。 */
export function enforceNonProdTarget(raw, opts = {}) {
  try {
    return assertNonProdTarget(raw, opts);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
