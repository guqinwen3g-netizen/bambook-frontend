/**
 * BB-DEV-4 试样通知单：每轮每厂一份（面料“面料试样通知单”，服装“服装开发通知单”）。
 * 内容来自本厂在本轮的任务（共同要求 + 本厂差异、形态、数量和单位、要求日期、参考附件）。
 * 服务端按冻结快照渲染 PDF 并归档；工厂任务更新后可重新生成，旧版保留。不记录发送状态。
 */
import type { MistCompanyProfile, MistDev, MistState, MistVersion } from './mistWorkspace';
import { developmentDomain, type DevelopmentDomain } from './mistDevelopmentDomain';
import { developmentClosure, factoryTaskSync } from './mistDevelopmentRounds';
import { creditDocumentFingerprint } from './mistCreditDocuments';

export const DEV_NOTICE_TEMPLATE_VERSION = 1 as const;
export type DevNoticeContent = {
  domain: DevelopmentDomain; title: string; factory: string;
  devId: string; devCode: string; devName: string; versionId: string; versionLabel: string; roundNumber: number; roundTargetDate: string;
  style: string; category: string; season: string; color: string; fabric: string; sizeBase: string;
  fabricRequirements: Array<{ label: string; value: string }>;
  commonRequirements: string; extraRequirements: string; sampleForm: string; sampleQuantity: number; sampleUnit: string; dueDate: string;
  attachments: Array<{ fileId: string; name: string }>;
  issuer: Pick<MistCompanyProfile, 'legalName' | 'englishName' | 'address' | 'phone' | 'email'>;
};
export type DevNoticeSnapshot = DevNoticeContent & { noticeNo: string; seq: number; templateVersion: number; generatedAt: string; generatedBy: string; generatedById: string };
/** 每次生成一份记录，只追加不改写。 */
export type DevNoticeRecord = { id: string; versionId: string; seq: number; noticeNo: string; fileId: string; fileName: string; sha256: string; bytes: number; templateVersion: number; contentFingerprint: string; snapshotFingerprint: string; snapshot: DevNoticeSnapshot; generatedAt: string; generatedBy: string; generatedById: string };
export type DevNoticeFile = { id: string; name: string; mimeType: string; size: number; storageKey: string; createdAt: string; uploadedBy?: string };
/** 服务端渲染并写入私有存储后绑定到命令上下文；客户端 payload 不能提供。 */
export type DevNoticeArtifact = { requestId: string; record: DevNoticeRecord; file: DevNoticeFile };

export const developmentNoticeTitle = (domain: DevelopmentDomain) => domain === 'fabric' ? '面料试样通知单' : '服装开发通知单';
const FABRIC_LABELS: Array<[keyof NonNullable<MistVersion['fabricRequirements']>, string]> = [['composition', '成分'], ['yarn', '纱支'], ['weave', '组织'], ['usage', '用途'], ['handle', '手感'], ['finish', '后整理'], ['performance', '性能']];

/** 生成通知单的阻断原因；可以生成时返回 null。 */
export function developmentNoticeBlocker(state: MistState, dev: MistDev, version: MistVersion): string | null {
  const closure = developmentClosure(state, dev);
  if (closure && closure.kind !== 'closed') return `开发案${closure.label}，不能再生成通知单`;
  if (!factoryTaskSync(state, version)) return '本版没有轮次记录（历史版本），不能生成通知单';
  if (!state.settings.companyProfile?.legalName) return '先在 设置 › 公司档案 填写公司抬头，才能生成通知单';
  return null;
}

/** 本厂在本轮的通知单内容（不含生成人、时间与序号），用于判断工厂任务更新后是否需要重新生成。 */
export function developmentNoticeContent(state: MistState, dev: MistDev, version: MistVersion): DevNoticeContent {
  const sync = factoryTaskSync(state, version)!, round = sync.round, domain = developmentDomain(dev.values), v = dev.values;
  const task = version.task || { commonRequirements: sync.common, extraRequirements: '', sampleForm: version.sampleForm || v.sampleForm || '', sampleQuantity: version.sampleQuantity, sampleUnit: version.sampleUnit || v.sampleUnit || '', dueDate: round.targetDate };
  const fileIds = [...new Set([...round.fileIds, ...version.fileIds])];
  const req = version.fabricRequirements;
  const fabricRequirements = domain === 'fabric' && req ? [
    ...FABRIC_LABELS.map(([key, label]) => ({ label, value: String(req[key] || '').trim() })),
    { label: '克重', value: req.weightValue ? `${req.weightValue} ${req.weightUnit}`.trim() : '' },
    { label: '幅宽', value: req.widthValue ? `${req.widthValue} ${req.widthUnit}`.trim() : '' },
  ].filter(item => item.value) : [];
  const issuer = state.settings.companyProfile!;
  return {
    domain, title: developmentNoticeTitle(domain), factory: version.factory,
    devId: dev.id, devCode: dev.code, devName: dev.name, versionId: version.id, versionLabel: version.label, roundNumber: round.number, roundTargetDate: round.targetDate,
    style: v.style || '', category: v.category || '', season: v.season || '', color: v.color || '', fabric: domain === 'fabric' ? '' : (version.fabric || v.fabric || ''), sizeBase: domain === 'fabric' ? '' : (version.size || v.sizeBase || ''),
    fabricRequirements,
    commonRequirements: task.commonRequirements, extraRequirements: task.extraRequirements, sampleForm: task.sampleForm, sampleQuantity: task.sampleQuantity, sampleUnit: task.sampleUnit, dueDate: task.dueDate,
    attachments: fileIds.map(id => ({ fileId: id, name: state.files.find(file => file.id === id)?.name || '已不可用的附件' })),
    issuer: { legalName: issuer.legalName, englishName: issuer.englishName || '', address: issuer.address || '', phone: issuer.phone || '', email: issuer.email || '' },
  };
}
export const developmentNoticeFingerprint = (value: unknown) => creditDocumentFingerprint(value);
export const developmentNoticeNo = (content: Pick<DevNoticeContent, 'devCode' | 'versionLabel'>, seq: number) => `${content.devCode}-${content.versionLabel}-N${String(seq).padStart(2, '0')}`;
export const developmentNoticeFileName = (snapshot: Pick<DevNoticeSnapshot, 'noticeNo' | 'title'>) => `${snapshot.title}-${snapshot.noticeNo}.pdf`;
export const developmentNotices = (version: Pick<MistVersion, 'notices'>) => [...(version.notices || [])].sort((a, b) => b.seq - a.seq);
/** 最新一份通知单与当前工厂任务不一致（任务已更新）时为 true；没有通知单时为 false。 */
export function developmentNoticeOutdated(state: MistState, dev: MistDev, version: MistVersion): boolean {
  const latest = developmentNotices(version)[0];
  if (!latest || !factoryTaskSync(state, version) || !state.settings.companyProfile?.legalName) return false;
  return latest.contentFingerprint !== developmentNoticeFingerprint(developmentNoticeContent(state, dev, version));
}
