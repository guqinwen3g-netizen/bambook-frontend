import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { productionHost, sameCommit, verifyDelivery } from '../../scripts/verify-dev-delivery';

/** 本地桩服务：只模拟前端 mist-version.json 与 /api/health，不连任何真实环境。 */
const servers: http.Server[] = [];
async function stub(routes: Record<string, [number, unknown]>) {
  const server = http.createServer((req, res) => { const hit = routes[req.url || '/']; res.statusCode = hit ? hit[0] : 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(hit ? hit[1] : { error: 'not found' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve)))); });
const MAIN = '170eb43132cde7d7e021217ed2efcc591dadfdc0';

describe('开发环境交付核验', () => {
  it('前端与服务端都健康、提交与 main 一致时通过', async () => {
    const frontend = await stub({ '/': [200, {}], '/mist-version.json': [200, { commit: '170eb43', branch: 'main', localChanges: 0, committedAt: '', subject: '', startedAt: '' }] });
    const server = await stub({ '/api/health': [200, { status: 'ok', database: 'ok', build: '170eb43' }] });
    const mist = await stub({ '/api/health': [200, { status: 'ok', service: 'mist-workspace', database: 'ok' }] });
    const checks = await verifyDelivery({ frontend, server, mist, expected: MAIN });
    expect(checks.map(c => [c.name, c.ok])).toEqual([['前端首页可访问', true], ['前端版本与 main 一致', true], ['服务端健康且版本与 main 一致', true], ['Mist 工作空间服务健康', true]]);
  });
  it('版本落后、有未提交改动、数据库不可用或服务不可达时逐项失败', async () => {
    const frontend = await stub({ '/': [200, {}], '/mist-version.json': [200, { commit: '90239ad', branch: 'main', localChanges: 3 }] });
    const server = await stub({ '/api/health': [503, { status: 'error', database: 'unavailable', build: '170eb43' }] });
    const checks = await verifyDelivery({ frontend, server, mist: 'http://127.0.0.1:1', expected: MAIN, timeoutMs: 2000 });
    expect(checks.map(c => c.ok)).toEqual([true, false, false, false]);
    expect(checks[1].detail).toContain('commit=90239ad'); expect(checks[1].detail).toContain('localChanges=3');
    expect(checks[3].detail).toContain('请求失败');
  });
  it('build 缺失或为 unknown 时不能算一致；拒绝正式环境主机', () => {
    expect(sameCommit('unknown', MAIN)).toBe(false); expect(sameCommit(undefined, MAIN)).toBe(false); expect(sameCommit('170eb4', MAIN)).toBe(false);
    expect(sameCommit('170EB43', MAIN)).toBe(true);
    expect(productionHost('https://jiangsupanda.com/bambook')).toBe('jiangsupanda.com'); expect(productionHost('https://api.jiangsupanda.com')).toBe('jiangsupanda.com');
    expect(productionHost('http://127.0.0.1:3001')).toBeNull(); expect(productionHost('https://prod.example.test', 'prod.example.test')).toBe('prod.example.test');
  });
});
