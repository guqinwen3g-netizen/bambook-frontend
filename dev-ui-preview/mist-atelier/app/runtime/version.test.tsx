// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getByRole, waitFor } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MistVersionInfo } from './version';
import { loadMistVersion, type MistVersion } from './versionData';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const version: MistVersion = { commit: 'abc1234', committedAt: '2026-10-14T02:00:00Z', subject: 'test build', branch: 'main', localChanges: 0, startedAt: '2026-10-14T03:00:00Z' };
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; host?.remove(); host = undefined; vi.unstubAllGlobals(); });

describe('Mist account version delivery', () => {
  it('uses the running bundle metadata in Web subpath, Electron file and standalone HTML builds without fetching', async () => {
    const fetchVersion = vi.fn();
    for (const href of ['https://example.invalid/bambook/api/app/index.html', 'file:///Applications/Bambook.app/Contents/Resources/app.asar/out/renderer/index.html']) {
      expect(await loadMistVersion({ href, baseUrl: '/bambook/api/app/', embeddedVersion: version, fetchVersion })).toEqual(version);
    }
    expect(fetchVersion).not.toHaveBeenCalled();
  });

  it('requests live development metadata relative to the Vite base, including a subpath', async () => {
    const fetchVersion = vi.fn(async () => new Response(JSON.stringify(version), { status: 200 }));
    for (const [baseUrl, expected] of [['/', 'https://example.invalid/mist-version.json'], ['/bambook/api/app/', 'https://example.invalid/bambook/api/app/mist-version.json'], ['./', 'https://example.invalid/bambook/api/app/mist-version.json']]) {
      await expect(loadMistVersion({ href: 'https://example.invalid/bambook/api/app/index.html?view=cockpit', baseUrl, embeddedVersion: null, fetchVersion })).resolves.toEqual(version);
      expect(fetchVersion).toHaveBeenLastCalledWith(expected, { cache: 'no-store' });
    }
  });

  it('rejects missing Electron metadata, failed requests and invalid JSON shapes instead of showing indefinite loading', async () => {
    const fetchVersion = vi.fn();
    await expect(loadMistVersion({ href: 'file:///renderer/index.html', embeddedVersion: null, fetchVersion })).rejects.toThrow('未包含');
    expect(fetchVersion).not.toHaveBeenCalled();
    await expect(loadMistVersion({ href: 'https://example.invalid/', embeddedVersion: null, fetchVersion: vi.fn(async () => new Response('', { status: 404 })) })).rejects.toThrow('404');
    await expect(loadMistVersion({ href: 'https://example.invalid/', embeddedVersion: null, fetchVersion: vi.fn(async () => new Response('{"commit":"incomplete"}', { status: 200 })) })).rejects.toThrow('格式无效');
  });

  it('renders the verified version and demo space and reads a newer development commit on explicit reload', async () => {
    const fetchVersion = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(version), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...version, commit: 'def5678', subject: 'next commit' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchVersion);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<MistVersionInfo demoSeed={{ version: 9, seededAt: '2026-10-14T03:00:00Z' }} />));
    await waitFor(() => expect(host!.textContent).toContain('abc1234 · test build'));
    expect(host.textContent).toContain('示例数据第 9 版'); expect(host.textContent).toContain('main');
    await act(async () => getByRole(host!, 'button', { name: '重新读取版本' }).click());
    await waitFor(() => expect(host!.textContent).toContain('def5678 · next commit'));
    expect(fetchVersion).toHaveBeenCalledTimes(2);
  });

  it('displays unavailable Git provenance as unknown rather than as loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...version, commit: '', subject: '', branch: '' }), { status: 200 })));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<MistVersionInfo />));
    await waitFor(() => expect(host!.textContent).toContain('构建版本未知'));
    expect(host.textContent).not.toContain('读取中');
  });
});
