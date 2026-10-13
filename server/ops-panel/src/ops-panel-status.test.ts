import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');

describe('ops panel Cloudflare status', () => {
  it('reports the local Cloudflare watchdog launch agent separately from the public tunnel', () => {
    expect(source).toContain('com.cloudflare.bambook.watchdog');
    expect(source).toContain("service('Cloudflare Watchdog'");
    expect(source).toContain('userHasCloudflareWatchdog');
  });

  it('tracks the 8091 origin used by the public Bambook Cloudflare route', () => {
    expect(source).toContain('BAMBOOK_OPS_LOCAL_PUBLIC_API_URL');
    expect(source).toContain('Cloudflare Origin 8091');
    expect(source).toContain('countCloudflareOriginErrors');
    expect(source).toContain("origin = '127.0.0.1:8091'");
  });
});
