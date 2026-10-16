/** BB-DEV-4：本版（本轮本厂）试样通知单——生成、重新生成（旧版保留）、下载、打印。不记录发送状态。 */
import React from 'react';
import { Download, FileText, Printer, RefreshCw } from 'lucide-react';
import { Button, Card, CardHeader, Mono, Pill } from '../../../../components/mist';
import type { MistDev, MistState, MistVersion } from '../../../../server/src/shared/mistWorkspace';
import { developmentNoticeBlocker, developmentNoticeOutdated, developmentNotices, developmentNoticeTitle } from '../../../../server/src/shared/mistDevelopmentNotice';
import { developmentDomain } from '../../../../server/src/shared/mistDevelopmentDomain';

export function DevNoticeCard({ state, dev, version, busy, onGenerate, onDownload, onPrint }: {
  state: MistState; dev: MistDev; version: MistVersion; busy: boolean;
  onGenerate: () => void; onDownload: (fileId: string) => void; onPrint: (fileId: string) => void;
}) {
  const title = developmentNoticeTitle(developmentDomain(dev.values)), notices = developmentNotices(version);
  const blocker = developmentNoticeBlocker(state, dev, version), outdated = developmentNoticeOutdated(state, dev, version);
  return <Card id="mist-dev-notice">
    <CardHeader title={title} sub={`${version.label} · ${version.factory} · 每轮每厂一份，不记录发送状态`} tools={<Button size="sm" icon={notices.length ? RefreshCw : FileText} disabled={busy || !!blocker} title={blocker || undefined} onClick={onGenerate}>{notices.length ? '重新生成' : '生成通知单'}</Button>} />
    {(blocker || outdated) && <div className="mist-row" style={{ padding: '0 22px 8px', gap: 8, flexWrap: 'wrap' }}>
      {outdated && <Pill tone="warn">工厂任务已更新，可重新生成</Pill>}{blocker && <span className="mist-note">{blocker}</span>}</div>}
    <div role="list" aria-label={`${version.label} ${title}`} style={{ padding: '0 22px 14px' }}>
      {notices.length ? notices.map((notice, index) => <div key={notice.id} role="listitem" className="mist-row" data-notice={notice.noticeNo} style={{ gap: 8, flexWrap: 'wrap', padding: '8px 0' }}>
        <Pill tone={index === 0 ? (outdated ? 'warn' : 'ok') : 'neutral'}>{index === 0 ? '最新' : '旧版'}</Pill>
        <span className="mist-col" style={{ gap: 0, minWidth: 0 }}><Mono>{notice.noticeNo}</Mono><small className="mist-muted">{notice.generatedBy} · {notice.generatedAt.replace('T', ' ').slice(0, 16)} · 要求 {notice.snapshot.dueDate}</small></span>
        <span className="mist-spacer" />
        <Button size="sm" variant="quiet" icon={Download} disabled={busy} onClick={() => onDownload(notice.fileId)}>下载</Button>
        <Button size="sm" variant="quiet" icon={Printer} disabled={busy} onClick={() => onPrint(notice.fileId)}>打印</Button>
      </div>) : <span className="mist-note">尚未生成。生成后按本厂任务冻结内容；任务更新后可重新生成，旧版保留。</span>}
    </div>
  </Card>;
}
