import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
import { writeRouteAuditLog } from '../audit/routeAudit';

type Context = { prisma: any; actorId: string; trustedActor?: TokenPayload; ip?: string | null };
export type TrimAttachment = { name: string; url: string };
export type TrimTaskInput = { requirements: string; supplierRelationId: string; quantity: string | number; unit: string; dueDate?: string | null; attachments?: TrimAttachment[]; requestKey: string; expectedRevision?: number };
export type MaterialUseInput = { productAssetId: string; sampleVersionId?: string | null; trimTaskId?: string | null; position: string; specification?: string | null; color?: string | null; perPiece?: string | number | null; unit?: string | null; provider: 'factory' | 'company'; colorMode: 'dtm' | 'specified' | 'contrast' | 'unspecified'; colorReference?: string | null; sourceNature: 'existing' | 'developed' | 'substitute'; requestKey: string; expectedRevision?: number };
const json = (value: any) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v));
const fingerprint = (value: any) => createHash('sha256').update(JSON.stringify(json(value))).digest('hex');
const reject = (message: string, code = 'INVALID_INPUT'): never => { throw new DevelopmentDomainError(code, message); };
const text = (value: unknown, label: string, max = 4000, optional = false): string | null => {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) reject(`${label}未填写或过长`);
  return (value as string).trim();
};
const positive = (value: unknown, label: string): string => {
  const result = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(result) || Number(result) <= 0) reject(`${label}须为正数，最多四位小数`);
  return result;
};
function attachments(value: unknown): TrimAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) reject('附件最多 30 项');
  return (value as any[]).map(item => {
    const url = text(item?.url, '附件地址', 2048)!;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/api/')) reject('附件须使用文件地址或有效网页地址');
    return { name: text(item?.name, '附件名称', 200)!, url };
  });
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) reject('请使用当前记录修订号'); return Number(value); }
async function inCase<T>(context: Context, caseId: string, write: boolean, work: (tx: any, development: any) => Promise<T>): Promise<T> {
  return context.prisma.$transaction(async (tx: any) => {
    await authorizeDevelopmentSource(tx, context.actorId, context.trustedActor, caseId, { write });
    if (write) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    const { development } = await authorizeDevelopmentSource(tx, context.actorId, context.trustedActor, caseId, { write });
    if (development.type !== 'garment') reject('辅料任务仅在成衣开发案办理');
    return work(tx, development);
  });
}
async function replay(tx: any, context: Context, caseId: string, requestKey: string, command: any) {
  const prior = await tx.auditLog.findFirst({ where: { action: 'garment_trim_command', targetType: 'DevelopmentCase', targetId: caseId,
    detail: { path: ['after', 'requestKey'], equals: requestKey } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!prior) return null;
  if (prior.actorId !== context.actorId || prior.detail?.after?.fingerprint !== fingerprint(command)) reject('原请求编号已对应其他内容，请核对原请求', 'REQUEST_CONFLICT');
  return prior.detail.after.result;
}
async function receipt(tx: any, context: Context, caseId: string, requestKey: string, command: any, result: any, before?: any) {
  await writeRouteAuditLog({ prisma: tx, actorId: context.actorId, source: 'route:dev:garment-trim', operation: 'garment_trim_command', targetType: 'DevelopmentCase', targetId: caseId,
    before: before == null ? undefined : json(before), after: { requestKey, fingerprint: fingerprint(command), command: json(command), result: json(result) }, ip: context.ip ?? null });
  return json(result);
}
async function assetSnapshot(tx: any, productAssetId: string) {
  const asset = await tx.productAsset.findFirst({ where: { id: productAssetId, mainCategory: 'Trimmings', deletedAt: null }, include: { trimmingProfile: true } });
  if (!asset || !asset.trimmingProfile || asset.trimmingProfile.deletedAt != null) reject('请选择有效的独立辅料档案');
  return json({ id: asset.id, sku: asset.sku, name: asset.name, imageUrl: asset.imageUrl ?? null, subCategoryId: asset.subCategoryId ?? null, trimmingProfile: asset.trimmingProfile });
}
function normalizedTask(input: TrimTaskInput) {
  const dueDate = text(input.dueDate, '交期', 10, true);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) reject('交期须为 YYYY-MM-DD');
  return { requirements: text(input.requirements, '辅料要求', 8000)!, supplierRelationId: text(input.supplierRelationId, '供应商', 200)!, quantity: positive(input.quantity, '数量'), unit: text(input.unit, '数量单位', 30)!, dueDate, attachments: attachments(input.attachments) };
}
export async function readGarmentTrims(context: Context, caseId: string) {
  return inCase(context, caseId, false, async tx => {
    const [tasks, materialUses] = await Promise.all([
      tx.garmentTrimTask.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      tx.garmentMaterialUse.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    return json({ tasks, materialUses });
  });
}
export async function saveGarmentTrimTask(context: Context, caseId: string, input: TrimTaskInput, taskId?: string) {
  const values = normalizedTask(input), requestKey = text(input.requestKey, '原请求编号', 128)!;
  const command = { kind: taskId ? 'edit_task' : 'create_task', taskId: taskId ?? null, ...values, expectedRevision: taskId ? revision(input.expectedRevision) : null };
  return inCase(context, caseId, true, async tx => {
    const prior = await replay(tx, context, caseId, requestKey, command); if (prior) return prior;
    await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
    const supplier = await tx.relation.findFirst({ where: { id: values.supplierRelationId, deletedAt: null } });
    if (!supplier) reject('供应商不存在或已归档');
    const existing = taskId ? await tx.garmentTrimTask.findFirst({ where: { id: taskId, developmentCaseId: caseId, deletedAt: null } }) : null;
    if (taskId && !existing) reject('辅料任务不存在', 'NOT_FOUND');
    if (existing?.confirmedAt != null) reject('已确认辅料任务不能覆盖最终资料', 'INVALID_STATE');
    if (existing && existing.revision !== command.expectedRevision) reject('辅料任务已变化，请刷新后重试', 'DEVELOPMENT_SOURCE_CHANGED');
    const now = BigInt(Date.now()), data = { ...values, quantity: new Prisma.Decimal(values.quantity), supplierName: supplier.name ?? supplier.fullName ?? null, updatedAt: now };
    const item = existing ? await tx.garmentTrimTask.update({ where: { id: existing.id }, data: { ...data, revision: existing.revision + 1 } }) : await tx.garmentTrimTask.create({ data: {
      ...data, id: `GTT_${randomUUID()}`, developmentCaseId: caseId, revision: 1, requestKey, createdBy: context.actorId, createdAt: now,
    } });
    return receipt(tx, context, caseId, requestKey, command, { task: item }, existing);
  });
}
export async function confirmGarmentTrimTask(context: Context, caseId: string, taskId: string, input: { requestKey: string; expectedRevision: number; finalDetails: { name: string; notes?: string; [key: string]: unknown }; productAssetId?: string | null }) {
  const requestKey = text(input.requestKey, '原请求编号', 128)!, expectedRevision = revision(input.expectedRevision);
  const finalDetails = input.finalDetails;
  if (!finalDetails || typeof finalDetails !== 'object' || Array.isArray(finalDetails)) reject('请补充最终辅料资料');
  text(finalDetails.name, '最终辅料名称', 200);
  if (JSON.stringify(finalDetails).length > 30000) reject('最终辅料资料过长');
  const productAssetId = text(input.productAssetId, '辅料档案', 200, true);
  const command = { kind: 'confirm_task', taskId, expectedRevision, finalDetails, productAssetId };
  return inCase(context, caseId, true, async tx => {
    const prior = await replay(tx, context, caseId, requestKey, command); if (prior) return prior;
    await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
    const task = await tx.garmentTrimTask.findFirst({ where: { id: taskId, developmentCaseId: caseId, deletedAt: null } });
    if (!task) reject('辅料任务不存在', 'NOT_FOUND');
    if (task.confirmedAt != null) reject('该辅料任务已经确认，请查看原最终资料', 'INVALID_STATE');
    if (task.revision !== expectedRevision) reject('辅料任务已变化，请刷新后确认', 'DEVELOPMENT_SOURCE_CHANGED');
    const catalog = productAssetId ? await assetSnapshot(tx, productAssetId) : null;
    const now = BigInt(Date.now());
    const updated = await tx.garmentTrimTask.update({ where: { id: task.id }, data: { confirmedAt: now, confirmedBy: context.actorId, finalDetails: { ...finalDetails, catalogSnapshot: catalog }, productAssetId, revision: task.revision + 1, updatedAt: now } });
    return receipt(tx, context, caseId, requestKey, command, { task: updated }, task);
  });
}
export async function readGarmentTrimNotice(context: Context, caseId: string, taskId: string) {
  return inCase(context, caseId, false, async (tx, development) => {
    const task = await tx.garmentTrimTask.findFirst({ where: { id: taskId, developmentCaseId: caseId, deletedAt: null } });
    if (!task) reject('辅料任务不存在', 'NOT_FOUND');
    return json({ notice: { kind: 'garment_trim', taskId: task.id, revision: task.revision, caseId, caseCode: development.code, caseName: development.name,
      supplierRelationId: task.supplierRelationId, supplierName: task.supplierName, requirements: task.requirements, quantity: task.quantity, unit: task.unit, dueDate: task.dueDate, attachments: task.attachments ?? [] } });
  });
}
export async function saveGarmentMaterialUse(context: Context, caseId: string, input: MaterialUseInput, useId?: string) {
  const requestKey = text(input.requestKey, '原请求编号', 128)!;
  const productAssetId = text(input.productAssetId, '辅料档案', 200)!, sampleVersionId = text(input.sampleVersionId, '准确打样版本', 200, true), trimTaskId = text(input.trimTaskId, '辅料任务', 200, true);
  const values = { productAssetId, sampleVersionId, trimTaskId, position: text(input.position, '用途部位', 300)!, specification: text(input.specification, '选定规格', 2000, true), color: text(input.color, '选定颜色', 500, true),
    perPiece: input.perPiece == null || input.perPiece === '' ? null : positive(input.perPiece, '每件用量'), unit: text(input.unit, '用量单位', 30, true), provider: input.provider,
    colorMode: input.colorMode, colorReference: text(input.colorReference, '配色参照', 2000, true), sourceNature: input.sourceNature };
  if (!['factory', 'company'].includes(values.provider) || !['dtm', 'specified', 'contrast', 'unspecified'].includes(values.colorMode) || !['existing', 'developed', 'substitute'].includes(values.sourceNature)) reject('提供方式、配色方式及辅料来源须有效');
  if ((values.perPiece == null) !== (values.unit == null)) reject('每件用量与单位须一起填写');
  if (['specified', 'contrast'].includes(values.colorMode) && !values.color?.trim()) reject('指定色或撞色须填写具体颜色');
  if (values.colorMode === 'dtm' && !values.colorReference) reject('配同色须填写参照');
  const command = { kind: useId ? 'edit_material' : 'create_material', useId: useId ?? null, ...values, expectedRevision: useId ? revision(input.expectedRevision) : null };
  return inCase(context, caseId, true, async tx => {
    const prior = await replay(tx, context, caseId, requestKey, command); if (prior) return prior;
    await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
    const existing = useId ? await tx.garmentMaterialUse.findFirst({ where: { id: useId, developmentCaseId: caseId, deletedAt: null } }) : null;
    if (useId && !existing) reject('用料关联不存在', 'NOT_FOUND');
    if (existing && existing.revision !== command.expectedRevision) reject('用料关联已变化，请刷新后重试', 'DEVELOPMENT_SOURCE_CHANGED');
    if (sampleVersionId) {
      const version = await tx.developmentSampleVersion.findFirst({ where: { id: sampleVersionId, developmentCaseId: caseId, deletedAt: null } });
      if (!version) reject('请选择本案准确打样版本');
      const physicalVersionId = version.versionKind === 'minor' ? version.parentVersionId : version.id;
      const returned = await tx.sampleBatch.findFirst({ where: { developmentCaseId: caseId, sampleVersionId: physicalVersionId, returnedAt: { not: null }, deletedAt: null } });
      if (returned && existing) reject('该版本已产生实物，用料快照不能覆盖，请安排新的准确版本', 'INVALID_STATE');
    }
    if (existing?.sampleVersionId && existing.sampleVersionId !== sampleVersionId) reject('已关联准确版本的用料不得改绑其他版本，请另加关联', 'INVALID_STATE');
    if (trimTaskId) {
      const task = await tx.garmentTrimTask.findFirst({ where: { id: trimTaskId, developmentCaseId: caseId, deletedAt: null } });
      if (!task || task.confirmedAt == null || task.productAssetId && task.productAssetId !== productAssetId) reject('辅料任务须已确认且与所选档案一致');
    }
    const catalog = existing?.productAssetId === productAssetId ? existing.snapshot.catalog : await assetSnapshot(tx, productAssetId);
    const now = BigInt(Date.now()), snapshot = json({ schemaVersion: 1, catalog, usage: values, capturedAt: String(now), capturedBy: context.actorId });
    const data = { ...values, perPiece: values.perPiece == null ? null : new Prisma.Decimal(values.perPiece), snapshot, updatedAt: now };
    const item = existing ? await tx.garmentMaterialUse.update({ where: { id: existing.id }, data: { ...data, revision: existing.revision + 1 } }) : await tx.garmentMaterialUse.create({ data: {
      ...data, id: `GMU_${randomUUID()}`, developmentCaseId: caseId, revision: 1, requestKey, createdBy: context.actorId, createdAt: now,
    } });
    return receipt(tx, context, caseId, requestKey, command, { materialUse: item }, existing);
  });
}
