/**
 * 验收臂的演示口令读取口 —— **不给默认值，缺了就红**（v3.237 补 40，§9 B288 的收口）。
 *
 * 为什么要有这一份：一枚演示口令原先以字符串字面量散在 17 个验收脚本里（22 处、至少 7 个不同值：
 * `.ts` 侧 1 个 + `.mjs` 侧 6 个），而 `report-export-collision` 那两臂又单独走 env
 * ⇒ 同一件凭据多份出处，且"忘了配也能跑"等于把演示凭据随源码发出去。本仓早已定过策略
 * （交付工具不许带口令默认值），这一份就是把 **M3 会调的那 8 条臂 + 导出碰撞两臂** 收到 env 上：
 * 值只住在调用者的环境里，源码里查不到它。
 *
 * ★ 未收口的部分（写在 §9 B288，不在这里假装完成）：9 个非 M3 旧脚本仍留字面量，且那 6 个 `.mjs` 值
 *   是否同一枚口令的变体还没逐个回读 ⇒ 不许默认它们可互换。
 */

export const DEMO_PASSWORD_ENV = 'BAMBOOK_DEMO_PASSWORD';
/** 旧名别名：`report-export-collision` 自 v3.237 补 26 起用的就是这个名字；一次全改会让配方与历史读数对不上 */
export const DEMO_PASSWORD_ENV_LEGACY = 'EXPORT_COLLIDE_PASSWORD';
export const DEMO_PASSWORD_ENVS = [DEMO_PASSWORD_ENV, DEMO_PASSWORD_ENV_LEGACY];

/** 取演示口令；两个名字都没给就抛（红是对的——兜住的那次才是隐患） */
export function demoLoginPassword(env: Record<string, string | undefined> = process.env): string {
  const v = DEMO_PASSWORD_ENVS.map((k) => env[k]).find(Boolean);
  if (!v) {
    throw new Error(`缺 ${DEMO_PASSWORD_ENV}（或别名 ${DEMO_PASSWORD_ENV_LEGACY}）⇒ 本件拒绝取数（也不许把「没跑」读成「全等」）。值不落源码，见本文件头注与台账 §9 B288。`);
  }
  return v;
}
