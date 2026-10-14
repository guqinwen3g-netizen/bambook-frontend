export type MistVersion = { commit: string; committedAt: string; subject: string; branch: string; localChanges: number; startedAt: string };

declare const __MIST_BUILD_VERSION__: MistVersion | null;

export function isMistVersion(value: unknown): value is MistVersion {
  if (!value || typeof value !== 'object') return false;
  const version = value as Partial<MistVersion>;
  return ['commit', 'committedAt', 'subject', 'branch', 'startedAt'].every(key => typeof version[key as keyof MistVersion] === 'string')
    && Number.isSafeInteger(version.localChanges) && Number(version.localChanges) >= 0;
}

/** Built apps report the version of their own bundle, including Electron's file: renderer. */
export async function loadMistVersion({
  href = location.href,
  baseUrl = import.meta.env.BASE_URL,
  embeddedVersion = typeof __MIST_BUILD_VERSION__ === 'undefined' ? null : __MIST_BUILD_VERSION__,
  fetchVersion = fetch,
}: { href?: string; baseUrl?: string; embeddedVersion?: MistVersion | null; fetchVersion?: typeof fetch } = {}): Promise<MistVersion> {
  if (embeddedVersion) {
    if (!isMistVersion(embeddedVersion)) throw new Error('构建版本信息无效');
    return embeddedVersion;
  }
  if (new URL(href).protocol === 'file:') throw new Error('应用未包含构建版本信息');
  const base = new URL(baseUrl || './', href);
  const response = await fetchVersion(new URL('mist-version.json', base).href, { cache: 'no-store' });
  if (!response.ok) throw new Error(`版本信息读取失败（${response.status}）`);
  const version: unknown = await response.json();
  if (!isMistVersion(version)) throw new Error('版本信息格式无效');
  return version;
}
