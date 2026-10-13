/**
 * apiKeySafety 回归测试
 *
 * 背景（2026-09-15 实测）：服务端把 VITE_BAMBOOK_API_KEY 当合法 API Key 接受，
 * 而 Vite 会把 VITE_* 内联进客户端产物 —— 线上 assets/App-*.js 里能直接 grep 出
 * 48 位密钥，且前端在 13 个业务接口上真实携带它。
 * 本文件锁死「VITE_ 变量绝不能成为服务端凭证」这条口径。
 */
import { describe, it, expect } from 'vitest';
import {
  collectClientExposedValues,
  partitionApiKeys,
  redactKey,
} from '../apiKeySafety';

describe('collectClientExposedValues', () => {
  it('只收集 VITE_ 前缀变量（Vite 的公开契约）', () => {
    const exposed = collectClientExposedValues({
      VITE_BAMBOOK_API_KEY: 'pub-key-1',
      BAMBOOK_API_KEY: 'server-key-1',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect([...exposed]).toEqual(['pub-key-1']);
  });

  it('忽略空值与纯空白', () => {
    const exposed = collectClientExposedValues({
      VITE_A: '',
      VITE_B: '   ',
      VITE_C: 'real',
    } as NodeJS.ProcessEnv);
    expect([...exposed]).toEqual(['real']);
  });
});

describe('partitionApiKeys', () => {
  it('与 VITE_ 变量无交集 → 全部接受', () => {
    const { accepted, rejected } = partitionApiKeys(
      ['server-key-1', 'server-key-2'],
      new Set(['public-key']),
    );
    expect(accepted).toEqual(['server-key-1', 'server-key-2']);
    expect(rejected).toEqual([]);
  });

  it('核心：与 VITE_ 变量同值的密钥被剔除（等同已公开）', () => {
    const { accepted, rejected } = partitionApiKeys(
      ['server-key-1', 'leaked-key'],
      new Set(['leaked-key']),
    );
    expect(accepted).toEqual(['server-key-1']);
    expect(rejected).toEqual(['leaked-key']);
  });

  it('文档化的装机口径「BAMBOOK_API_KEY 与 VITE_BAMBOOK_API_KEY 一致」必须被挡住', () => {
    // 这是 server/.env.local 原注释教给运维的做法，也是本缺陷最容易复发的地方
    const env = {
      BAMBOOK_API_KEY: 'same-value-abc',
      VITE_BAMBOOK_API_KEY: 'same-value-abc',
    } as NodeJS.ProcessEnv;
    const { accepted, rejected } = partitionApiKeys(
      [env.BAMBOOK_API_KEY],
      collectClientExposedValues(env),
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['same-value-abc']);
  });

  it('去重 + 忽略空值，且不改变相对顺序', () => {
    const { accepted, rejected } = partitionApiKeys(
      ['a', 'a', '', '  ', 'b', 'leak', 'leak'],
      new Set(['leak']),
    );
    expect(accepted).toEqual(['a', 'b']);
    expect(rejected).toEqual(['leak']);
  });

  it('空候选 → 空集合（fail-closed，不启用任何 API-Key 通道）', () => {
    const { accepted, rejected } = partitionApiKeys([], new Set());
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([]);
  });
});

describe('redactKey', () => {
  it('只暴露前 4 位与长度，不泄漏可用密钥', () => {
    const masked = redactKey('abcdefghijklmnop');
    expect(masked).toContain('abcd');
    expect(masked).not.toContain('efghijklmnop');
    expect(masked).toContain('16');
  });

  it('短值完全打码，空值有兜底文案', () => {
    expect(redactKey('abc')).toBe('****（长度 3）');
    expect(redactKey('')).toBe('(空)');
  });
});
