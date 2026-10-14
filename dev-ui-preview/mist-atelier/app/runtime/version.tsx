import React from 'react';
import { Button, KeyValue } from '../../../../components/mist';
import { loadMistVersion, type MistVersion } from './versionData';

export type { MistVersion } from './versionData';
const time = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN', { hour12: false }); };

/** 账号面板：开发时实时读取 Git；构建版本随应用打包，数据空间来自工作空间设置。 */
export function MistVersionInfo({ demoSeed }: { demoSeed?: { version: number; seededAt: string } }) {
  const [version, setVersion] = React.useState<MistVersion | null>(null), [failed, setFailed] = React.useState(false), [loading, setLoading] = React.useState(false);
  const load = React.useCallback(() => {
    setLoading(true);
    loadMistVersion()
      .then((v: MistVersion) => { setVersion(v); setFailed(false); }).catch(() => setFailed(true)).finally(() => setLoading(false));
  }, []);
  React.useEffect(() => { load(); }, [load]);
  const code = version ? version.commit ? `${version.commit} · ${version.subject}` : '构建版本未知（未提供 Git 元数据）' : failed ? '无法读取版本信息' : '读取中';
  return <>
    <KeyValue items={[
      { label: '代码版本', value: code, mono: !!version?.commit },
      { label: '分支', value: version?.branch || '—', mono: true },
      { label: '提交时间', value: version?.committedAt ? time(version.committedAt) : '—' },
      { label: '服务启动 / 构建时间', value: version?.startedAt ? time(version.startedAt) : '—' },
      { label: '本地未提交改动', value: version ? (version.localChanges ? `${version.localChanges} 个文件` : '无') : '—' },
      { label: '数据空间', value: demoSeed ? `演示工作空间 · 示例数据第 ${demoSeed.version} 版（${time(demoSeed.seededAt)} 生成）` : '普通工作空间（无示例数据）' },
    ]} />
    <p className="mist-note">代码版本可与 GitHub 分支的最新提交核对；数据空间单独标识，旧版示例数据需新建演示工作空间才会更新。</p>
    <Button variant="quiet" loading={loading} onClick={load}>重新读取版本</Button>
  </>;
}
