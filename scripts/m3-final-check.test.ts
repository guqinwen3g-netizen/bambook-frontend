// @vitest-environment node
/**
 * M3 终检 runner 的起跑前置（v3.237 补 26）。
 *
 * 起因就在今天：整套 24 臂我跑第一次时**没给 `EXPORT_COLLIDE_PASSWORD`**，
 * 于是它照样跑完 22 臂，直到最后那两臂才报"摘要行解析不到"——看起来像**产品回归**，
 * 其实是我少给一个输入。那两臂自己是对的（缺口令就拒绝取数，不许把"没跑"读成"全等"），
 * 但 runner 把这件事藏到了最后 ⇒ 一次 3 分钟的白跑 + 一个差点写进台账的假指控。
 * ⇒ 判据挪到起跑前：缺输入就当众拒，别跑到尾巴再露。
 */
import { describe, expect, it } from 'vitest';
import { preflightEnvIssues } from './m3-final-check.mjs';

describe('m3-final-check 起跑前置', () => {
  it('什么都没给：两条输入都点名（口令 + 库连接），一条不许漏', () => {
    const issues = preflightEnvIssues({ env: {}, hasLocalEnvFile: false });
    expect(issues.map((x) => x.key).sort()).toEqual(['DATABASE_URL', 'EXPORT_COLLIDE_PASSWORD']);
  });

  it('口令给了但库连接只能从别的树借：只留库那一条（跨树借 env 是 B35 要消灭的事）', () => {
    const issues = preflightEnvIssues({ env: { EXPORT_COLLIDE_PASSWORD: 'x' }, hasLocalEnvFile: false });
    expect(issues.map((x) => x.key)).toEqual(['DATABASE_URL']);
  });

  it('两条都齐 ⇒ 空数组（不许把"齐了"读成"有问题"）', () => {
    expect(preflightEnvIssues({ env: { DATABASE_URL: 'postgresql://x', EXPORT_COLLIDE_PASSWORD: 'x' }, hasLocalEnvFile: false }))
      .toEqual([]);
  });

  /** 本树 server/.env.local 也算库连接的合法来源——判定必须与 runner 里那条同一口径 */
  it('本树有 server/.env(.local) 时不算缺库连接（口令仍算缺）', () => {
    const issues = preflightEnvIssues({ env: {}, hasLocalEnvFile: true });
    expect(issues.map((x) => x.key)).toEqual(['EXPORT_COLLIDE_PASSWORD']);
  });
});
