import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptDir = path.resolve(__dirname);

const readScript = (name: string) => readFileSync(path.join(scriptDir, name), 'utf8');

describe('Cloudflare tunnel scripts', () => {
  it('starts cloudflared with the stable http2 protocol expected by ops checks', () => {
    const script = readScript('run-cloudflared-tunnel.sh');

    expect(script).toContain('--protocol http2');
  });

  it('includes a local watchdog that can restart the tunnel without public ops access', () => {
    const script = readScript('watch-cloudflared-tunnel.sh');
    const plist = readScript('com.cloudflare.bambook.watchdog.plist');

    expect(script).toContain('https://jiangsupanda.com/bambook/api/health');
    expect(script).toContain('launchctl kickstart -k');
    expect(script).toContain('com.cloudflare.bambook.api');
    expect(script).toContain('RESTART_COOLDOWN_SECONDS');
    expect(script).toContain('LAST_RESTART_FILE');
    expect(plist).toContain('StartInterval');
    expect(plist).toContain('watch-cloudflared-tunnel.sh');
  });
});
