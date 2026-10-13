import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { renderHtmlToPdf } from '../templates/pdf';
import { businessError } from '../shared/errorCodes';
import { currentCiActor, ciHash, readDevelopmentCiVersionInTx } from './developmentCiSource';
import { renderDevelopmentCiDocument } from './developmentCiDocument';

const uploadRoot = () => process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
const read = async (db: any, documentId: string, actor: TokenPayload | null | undefined, version?: number) => {
  await currentCiActor(db, actor, ['customs:read']);
  return readDevelopmentCiVersionInTx(db, documentId, actor, { version, finance: true });
};

/** Archive bytes derive only from the exact issued business version. */
export async function generateDevelopmentCiArchive(prisma: any, document: any,
  params: { version?: number; actorId: string; trustedActor?: TokenPayload | null }) {
  if (!params.trustedActor?.userId || params.trustedActor.userId !== params.actorId) throw businessError('UNAUTHORIZED', '归档需要当前可信账号。');
  const actor = params.trustedActor;
  await currentCiActor(prisma, actor, ['customs:write']);
  const selected = await prisma.$transaction((tx: any) => read(tx, document.id, actor, params.version));
  if (selected.document.status !== 'Issued' || selected.version.id !== selected.latestVersion.id || !selected.snapshot.issuedAt)
    throw businessError('CONFLICT', '只有已签发的当前开发 CI 版本可以正式归档。');
  const pdf = await renderHtmlToPdf(renderDevelopmentCiDocument(selected), { format: 'A4' });
  const name = selected.document.documentNumber.replace(/[^\w.-]/g, '_');
  const fileName = `${name}-v${selected.version.version}.pdf`;
  const physicalName = `ci-development-${selected.document.id.replace(/[^\w.-]/g, '_')}-${crypto.randomUUID()}.pdf`;
  const filePath = `trade-documents/${physicalName}`, directory = path.join(uploadRoot(), 'trade-documents');
  fs.mkdirSync(directory, { recursive: true }); const absolute = path.join(directory, physicalName);
  let written = false;
  try {
    fs.writeFileSync(absolute, pdf.pdf, { flag: 'wx' }); written = true;
    await prisma.$transaction(async (tx: any) => {
      await currentCiActor(tx, actor, ['customs:write']);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${document.id} FOR UPDATE`);
      const final = await read(tx, document.id, actor, selected.version.version);
      if (final.document.status !== 'Issued' || final.version.id !== final.latestVersion.id || ciHash(final.document) !== ciHash(selected.document)
        || final.version.id !== selected.version.id || final.snapshot.snapshotFingerprint !== selected.snapshot.snapshotFingerprint)
        throw businessError('CONFLICT', '开发 CI 原票在归档期间变化，请刷新核对。');
      await tx.tradeDocument.update({ where: { id: document.id }, data: { filePath, fileName, updatedAt: BigInt(Date.now()) } });
      await tx.auditLog.create({ data: { id: `AUD_DEVCI_${crypto.randomUUID()}`, actorId: actor.userId, action: 'TRADE_DOCUMENT_FILE_GENERATED',
        targetType: 'TradeDocument', targetId: document.id, detail: { version: selected.version.version, filePath, fileName, sha: pdf.sha,
          fileSize: pdf.bytes, developmentCiVersionId: selected.version.id, developmentCiVersion: selected.version.version,
          developmentCiSnapshotFingerprint: selected.snapshot.snapshotFingerprint, developmentCiSourceFingerprint: selected.snapshot.sourceFingerprint } } });
      await currentCiActor(tx, actor, ['customs:write']);
      await read(tx, document.id, actor, selected.version.version);
    });
    return { filePath, fileName, fileSize: pdf.bytes };
  } catch (error) {
    if (written) {
      try {
        const published = await prisma.tradeDocument.findFirst({ where: { id: document.id, filePath }, select: { id: true } });
        const audit = await prisma.auditLog.findFirst({ where: { targetType: 'TradeDocument', targetId: document.id,
          action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: filePath } }, select: { id: true } });
        if (!published && !audit) fs.unlinkSync(absolute);
      } catch { /* An uncertain committed publication must retain its bytes. */ }
    }
    throw error;
  }
}

export async function assertDevelopmentCiArchiveInTx(tx: any, actual: any, requested: any, actor: TokenPayload | null | undefined) {
  const requestedPath = typeof requested.filePath === 'string' ? path.posix.normalize(requested.filePath) : null;
  if (actual.filePath !== requested.filePath || !requestedPath?.startsWith('trade-documents/ci-development-'))
    throw businessError('CONFLICT', '归档文件不属于当前开发 CI。');
  const audits = await tx.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: actual.id,
    detail: { path: ['filePath'], equals: requestedPath } } });
  const proof = audits.find((row: any) => typeof row.detail?.developmentCiVersionId === 'string')?.detail;
  if (!proof || !Number.isSafeInteger(proof.developmentCiVersion)) throw businessError('CONFLICT', '开发 CI 归档缺少准确签发版本凭据。');
  const history = await read(tx, actual.id, actor, proof.developmentCiVersion);
  if (history.document.status !== 'Issued' || history.version.id !== history.latestVersion.id || !history.snapshot.issuedAt
    || history.version.id !== proof.developmentCiVersionId || history.snapshot.snapshotFingerprint !== proof.developmentCiSnapshotFingerprint
    || history.snapshot.sourceFingerprint !== proof.developmentCiSourceFingerprint || actual.fileName !== proof.fileName
    || !/^[a-f0-9]{64}$/.test(proof.sha ?? '') || !Number.isSafeInteger(proof.fileSize) || proof.fileSize <= 0)
    throw businessError('CONFLICT', '开发 CI 归档原票或文件凭据已变化。');
}
