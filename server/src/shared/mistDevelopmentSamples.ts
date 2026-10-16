/**
 * 面料版本多形态实物与寄样（BB-DEV-6 / BB-DEV-8）。
 * 一个面料大版本可以分批登记多条实物（色样、手织样、米样……），全部同步到样品仓库同一来源档案；
 * 寄样从本版准确实物出库，扣减样品仓库余额，出库流水回链本开发案。
 */
import type { MistDev, MistState, MistVersion } from './mistWorkspace';
import { developmentDomain } from './mistDevelopmentDomain';
import { developmentClosure } from './mistDevelopmentRounds';

export type MistSampleRef = { sampleId: string; code: string; form: string; unit: string };
export type MistSampleFee = { amount: number; currency: string };
export type MistSampleDispatch = {
  id: string; sampleId: string; sampleCode: string; form: string; unit: string; quantity: number;
  recipient: string; trackingNo: string; fee: MistSampleFee | null; note: string; movementId: string;
  recordedAt: string; recordedBy: string; feeRecordedAt?: string; feeRecordedBy?: string;
};
type VersionSample = MistState['fulfillment']['samples'][number];

/** 实物所在的版本：小版本沿用大版本实物。 */
export function physicalVersionId(version: MistVersion): string { return version.minor?.parentVersionId || version.id; }
/** 本版（含小版本所沿用的大版本）在样品仓库中的全部实物行，按登记顺序。 */
export function developmentVersionSamples(state: MistState, version: MistVersion | null | undefined): VersionSample[] {
  if (!state || !version) return [];
  const id = physicalVersionId(version);
  return (state.fulfillment?.samples || []).filter(sample => sample.source.kind === 'version' && sample.source.versionId === id);
}
export const sampleRef = (sample: VersionSample): MistSampleRef => ({ sampleId: sample.id, code: sample.code, form: sample.form, unit: sample.unit });
/** 追加实物形态的阻断原因；可以追加时返回 null。 */
export function sampleFormBlocker(state: MistState, dev: MistDev, version: MistVersion): string | null {
  if (developmentDomain(dev.values) !== 'fabric') return '只有面料版本可以追加实物形态';
  if (version.minor) return '小版本沿用大版本实物，不登记新实物';
  if (developmentClosure(state, dev)?.kind === 'cancelled') return '开发案已取消';
  if (version.qcDecision?.kind === 'abandon') return '本版已放弃';
  if (!version.returnedAt || !developmentVersionSamples(state, version).length) return '请先登记本版返样';
  return null;
}
/** 寄样的阻断原因；可以寄样时返回 null。 */
export function sampleDispatchBlocker(state: MistState, dev: MistDev, version: MistVersion): string | null {
  if (developmentClosure(state, dev)?.kind === 'cancelled') return '开发案已取消';
  const samples = developmentVersionSamples(state, version);
  if (!samples.length) return '本版还没有入库实物';
  if (!samples.some(sample => sample.available > 0)) return '本版实物已无可用余额';
  return null;
}
/** 需求方确认是否必须写明针对哪些形态：面料版本有多条实物时必须。 */
export function confirmationNeedsForms(state: MistState, dev: MistDev, version: MistVersion): boolean {
  return developmentDomain(dev.values) === 'fabric' && developmentVersionSamples(state, version).length > 1;
}
