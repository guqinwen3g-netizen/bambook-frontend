// @vitest-environment node
/**
 * 「外部/生产端点不当默认值用」这一族守卫的两面自证（v3.237 补 25，起因见 §9 B281/B282）。
 *
 * B281 是一次**真实误上线**：我把 `scripts/ops-upload-package.sh` 当突变对象跑了一遍，
 * 于是拿钥匙链里的 token 把包推上去并触发了重启。事后普查发现同一形状还住在三份脚本里 ——
 * **默认值指向生产，而脚本一跑就发请求**。所以这一族判据必须同时证明两件事：
 *   ① 拒绝面：默认目标（生产域名）在没有显式授权时**当场拒**，且拒在发请求之前；
 *   ② 放行面：本机目标、以及显式 `BAMBOOK_ALLOW_PROD=yes` 都放行（放行会打一行警告）。
 *
 * ★ 用例**不碰网络**：放行面走纯函数（传假 env），拒绝面走子进程 spawn ——
 *   spawn 的脚本在 guard 那一行就 exit 2，后面的 `fetch` 根本执行不到。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNonProdTarget, isLoopbackTarget } from './lib/prodTargetGuard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROD_DEFAULT = 'https://jiangsupanda.com/bambook/api';

/** 剥掉可能影响判定的外部 env（授权位、目标覆盖位），让每次跑的都是"默认形状" */
function spawnRefused(script: string): { status: number; stderr: string } {
  try {
    const stderr = execFileSync('node', [path.join(here, script)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BAMBOOK_ALLOW_PROD: '', BAMBOOK_API_BASE: '', PDML_ENDPOINT: '', BAMBOOK_ENDPOINT: '', VITE_CLOUD_ENDPOINT: '' },
    });
    return { status: 0, stderr: String(stderr) };
  } catch (e: any) {
    return { status: typeof e.status === 'number' ? e.status : -1, stderr: String(e.stderr ?? '') };
  }
}

describe('prodTargetGuard：判定本身', () => {
  it('本机形状一律认得，未知外部域名一并挡（白名单方向）', () => {
    expect([
      isLoopbackTarget('http://127.0.0.1:8090/api'),
      isLoopbackTarget('http://localhost:3002'),
      isLoopbackTarget('http://[::1]:8090'),
      isLoopbackTarget(PROD_DEFAULT),
      isLoopbackTarget('https://some-unknown-host.example.com'),
      isLoopbackTarget(''),
      isLoopbackTarget(undefined as any),
    ]).toEqual([true, true, true, false, false, false, false]);
  });

  it('无授权位时：生产默认值必须抛 REJECTED，且把是谁在打它说清楚', () => {
    let msg = '';
    try {
      assertNonProdTarget(PROD_DEFAULT, { what: 'e2e-sse-sim 的 ai/chat', env: {} });
    } catch (e: any) {
      msg = String(e.message);
    }
    expect(msg).toContain('REJECTED');
    expect(msg).toContain('e2e-sse-sim 的 ai/chat');
    expect(msg).toContain(PROD_DEFAULT);
  });

  it('显式授权=yes：放行但带 warned 标记（不许有"静默打生产"这条路）', () => {
    const r = assertNonProdTarget(PROD_DEFAULT, { what: 'w', env: { BAMBOOK_ALLOW_PROD: 'yes' } });
    expect(r).toEqual({ ok: true, target: PROD_DEFAULT, warned: true });
  });

  it('本机目标：不需要授权也不放行警告（两条通道各归各）', () => {
    expect(assertNonProdTarget('http://127.0.0.1:8090/api', { what: 'w', env: {} })).toEqual({
      ok: true,
      target: 'http://127.0.0.1:8090/api',
    });
  });
});

describe('prodTargetGuard：三份脚本的活路径', () => {
  it('e2e-sse-sim 默认目标（生产）⇒ 退出码 2 且拒在请求之前', () => {
    const { status, stderr } = spawnRefused('e2e-sse-sim.mjs');
    expect(status).toBe(2);
    expect(stderr).toContain('REJECTED');
    expect(stderr).toContain('e2e-sse-sim');
  });

  it('pdml-fabric-import 默认 PDML 端点（外部）⇒ 同样当场拒', () => {
    const { status, stderr } = spawnRefused('pdml-fabric-import.mjs');
    expect(status).toBe(2);
    expect(stderr).toContain('REJECTED');
    expect(stderr).toContain('PDML');
  });

  /**
   * test-frontend-exact 这一份**改的是默认值本身**（生产 → 本机），
   * 所以不能靠 spawn 验（它一旦过了闸门就会真打 :8090 的 ai/chat，那会花模型配额）。
   * 这里只读源码取那个字面量，并把它喂给同一个判定函数——判定只有一份实现。
   */
  it('test-frontend-exact 的默认目标已经改成本机（不需要授权闸门就碰不到外部）', () => {
    const src = readFileSync(path.join(here, 'test-frontend-exact.mjs'), 'utf8');
    const m = src.match(/const TARGET = process\.env\.BAMBOOK_CHAT_URL \|\| '([^']+)'/);
    expect(m).not.toBeNull();
    expect(isLoopbackTarget(m![1])).toBe(true);
    expect(src).not.toContain(PROD_DEFAULT);
  });
});
