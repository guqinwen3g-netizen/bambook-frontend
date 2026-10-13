/**
 * 凭据脱敏回归锁。
 *
 * 背景（2026-09-15 / OPS panel 实读时发现）：
 * `/api/status` 用 `pgrep -lf cloudflared` 取进程列表，而 cloudflared 命令行里带
 * `--token eyJ...`——那是 Cloudflare Tunnel 凭据，拿到即可接管整条隧道
 * （把公网域名指向任意源站）。此前该文本原样出网，凭据会出现在面板页面、
 * 浏览器缓存、以及任何被转发/采集的日志里。
 */

import { describe, expect, it } from 'vitest';
import { redactSecrets, REDACTED } from './redact';

/** 真实形状的 tunnel token（结构仿造，非真实凭据） */
const FAKE_TOKEN =
  'eyJhIjoiOTRlMWZjZGNhYzFmZTgyOTFiZDMyNWQ2NjQwYzM0OGIiLCJ0IjoiNmI2ODljMDUtZDUzOC00MTQ2LTk5OTYtN2VkMDBjMzQ5ZjEyIn0';

const PGREP_LINE = `5165 /opt/homebrew/bin/cloudflared tunnel run --token ${FAKE_TOKEN}`;

describe('redactSecrets', () => {
  it('脱敏 cloudflared 的 --token（空格分隔写法）', () => {
    const out = redactSecrets(PGREP_LINE);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain(`--token ${REDACTED}`);
    // 进程号与可执行路径应保留——运维要靠它们判断进程状态
    expect(out).toContain('5165');
    expect(out).toContain('/opt/homebrew/bin/cloudflared tunnel run');
  });

  it('脱敏 --token= 等号写法', () => {
    const out = redactSecrets(`cloudflared tunnel run --token=${FAKE_TOKEN} --protocol http2`);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('--protocol http2');
  });

  it('兜底脱敏裸 JWT 形状串（即使没有 --token 前缀）', () => {
    const out = redactSecrets(`some output ${FAKE_TOKEN} tail`);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain(REDACTED);
    expect(out).toContain('some output');
    expect(out).toContain('tail');
  });

  it('多行文本逐行脱敏', () => {
    const out = redactSecrets([PGREP_LINE, `5166 cloudflared --token ${FAKE_TOKEN}`].join('\n'));
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(2);
  });

  it('--protocol http2 等关键判据不受影响（否则状态判定会误报）', () => {
    const out = redactSecrets(`1 cloudflared tunnel run --protocol http2 --token ${FAKE_TOKEN}`);
    expect(out).toContain('--protocol http2');
  });

  it('空值安全', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(undefined as unknown as string)).toBe(undefined);
  });

  it('不含凭据的文本原样返回（不误伤）', () => {
    const plain = 'org.httpkit.HTTPServer 1.2.3 listening';
    expect(redactSecrets(plain)).toBe(plain);
  });
});
