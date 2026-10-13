/**
 * migrate-private-files.ts — 敏感文件迁入私有目录（安全收口 2026-09-01）
 *
 * 背景：邮件附件与 QC 测试报告曾落盘在 /api/uploads 静态服务根（无鉴权直读）
 * 或 server/uploads 旧位置。新代码统一写私有根 private-files/（只经带权限门的
 * 下载路由读取）；本脚本把存量文件搬入私有根，保证旧记录继续可读。
 *
 * 迁移内容：
 *   1. QC 测试报告：<UPLOAD_DIR>/test-reports/** → <PRIVATE_FILES_DIR>/test-reports/**
 *      （TestReportFile.filePath 相对根形状不变，无需改库）
 *   2. 邮件附件：<SERVER_ROOT>/uploads/email-attachments/** →
 *      <PRIVATE_FILES_DIR>/email-attachments/**（同步把 EmailAttachment.filePath
 *      从 uploads/email-attachments/x 改写为 email-attachments/x）
 *
 * 幂等：源不存在视为已迁移/无数据，跳过；目的已存在时跳过并报告冲突（不覆盖）。
 *
 * 用法：
 *   npx tsx scripts/migrate-private-files.ts            # dry-run 报告
 *   npx tsx scripts/migrate-private-files.ts --apply    # 实际迁移
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PRIVATE_FILES_DIR, isInsideDir } from '../src/lib/privateFiles';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

// 与 src/index.ts 的 UPLOAD_DIR 同口径（BAMBOOK_UPLOAD_DIR 或 apps/Bambook/uploads）
const UPLOAD_DIR = process.env.BAMBOOK_UPLOAD_DIR || path.join(SERVER_ROOT, '..', 'uploads');

interface MovePlan {
  src: string;
  dest: string;
  /** 邮件附件迁移后需回写的 DB 记录（QC 无需改库） */
  emailAttachmentId?: string;
  emailAttachmentNewPath?: string;
}

/** 递归列出目录下全部文件（相对 rel 前缀） */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), path.join(prefix, entry.name)));
    } else if (entry.isFile()) {
      out.push(path.join(prefix, entry.name));
    }
  }
  return out;
}

function planTreeMove(srcDir: string, destDir: string, plan: MovePlan[]): number {
  if (!fs.existsSync(srcDir)) return 0;
  const files = listFiles(srcDir);
  for (const rel of files) {
    plan.push({ src: path.join(srcDir, rel), dest: path.join(destDir, rel) });
  }
  return files.length;
}

function moveFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      // 跨设备 rename 不可用：复制 + 删源（保持原子性语义：先复制成功再删源）
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
}

/** 自底向上清理空目录（迁空后的源侧残留树；非空即停，误调不伤数据） */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  try { fs.rmdirSync(dir); } catch { /* 非空/不存在 → 保留 */ }
}

async function main() {
  console.log(`[migrate-private-files] UPLOAD_DIR       = ${UPLOAD_DIR}`);
  console.log(`[migrate-private-files] PRIVATE_FILES_DIR = ${PRIVATE_FILES_DIR}`);
  if (isInsideDir(UPLOAD_DIR, PRIVATE_FILES_DIR)) {
    throw new Error('[migrate-private-files] 私有根不可位于 /api/uploads 静态服务根之内（配置冲突，拒绝执行）');
  }

  const plan: MovePlan[] = [];

  // 1) QC 测试报告：<UPLOAD_DIR>/test-reports → 私有根（DB 不动）
  const qcSrc = path.join(UPLOAD_DIR, 'test-reports');
  const qcCount = planTreeMove(qcSrc, path.join(PRIVATE_FILES_DIR, 'test-reports'), plan);
  console.log(`[migrate-private-files] QC 测试报告源目录 ${qcSrc}：${qcCount} 个文件`);

  // 2) 邮件附件（旧记录 uploads/email-attachments/... → 私有根 + 改写 DB filePath）
  const legacyEmailDir = path.join(SERVER_ROOT, 'uploads', 'email-attachments');
  const legacyRows = await prisma.emailAttachment.findMany({
    where: { filePath: { startsWith: 'uploads/email-attachments/' } },
    select: { id: true, filePath: true },
  });
  let emailMoved = 0;
  let emailMissing = 0;
  for (const row of legacyRows) {
    const src = path.join(SERVER_ROOT, row.filePath!);
    const newPath = row.filePath!.replace(/^uploads\//, '');
    const dest = path.join(PRIVATE_FILES_DIR, newPath);
    if (fs.existsSync(src)) {
      plan.push({ src, dest, emailAttachmentId: row.id, emailAttachmentNewPath: newPath });
      emailMoved += 1;
    } else if (fs.existsSync(dest)) {
      // 文件已在私有根（上次迁移中断在 DB 回写之前）：只补 DB 回写
      plan.push({ src, dest, emailAttachmentId: row.id, emailAttachmentNewPath: newPath });
      emailMoved += 1;
    } else {
      emailMissing += 1;
      console.warn(`[migrate-private-files] 邮件附件两处均无文件，跳过（DB 保留原值）：${row.id} → ${row.filePath}`);
    }
  }
  console.log(`[migrate-private-files] 邮件附件旧记录 ${legacyRows.length} 条（可迁 ${emailMoved}，源文件缺失 ${emailMissing}；旧目录 ${legacyEmailDir}）`);

  if (plan.length === 0) {
    console.log('[migrate-private-files] 无需迁移（幂等：可能已迁移过）');
    if (apply) {
      // 上次迁移可能残留空目录树（文件已搬走）：顺手清掉
      pruneEmptyDirs(qcSrc);
      pruneEmptyDirs(legacyEmailDir);
    }
    return;
  }
  if (!apply) {
    for (const p of plan) console.log(`  [dry-run] ${p.src} → ${p.dest}`);
    console.log(`[migrate-private-files] dry-run 模式（--apply 实际迁移），共 ${plan.length} 项`);
    return;
  }

  let moved = 0;
  let conflicts = 0;
  const dbUpdates: Array<{ id: string; newPath: string }> = [];
  for (const p of plan) {
    if (fs.existsSync(p.dest) && !fs.existsSync(p.src)) {
      // 目的已存在且源已清（重复执行）：仅补 DB 回写
      if (p.emailAttachmentId) dbUpdates.push({ id: p.emailAttachmentId, newPath: p.emailAttachmentNewPath! });
      continue;
    }
    if (fs.existsSync(p.dest)) {
      conflicts += 1;
      console.warn(`[migrate-private-files] 目的已存在，跳过不覆盖：${p.dest}`);
      continue;
    }
    if (!fs.existsSync(p.src)) {
      console.warn(`[migrate-private-files] 源不存在，跳过：${p.src}`);
      continue;
    }
    moveFile(p.src, p.dest);
    moved += 1;
    if (p.emailAttachmentId) dbUpdates.push({ id: p.emailAttachmentId, newPath: p.emailAttachmentNewPath! });
  }
  for (const u of dbUpdates) {
    await prisma.emailAttachment.update({ where: { id: u.id }, data: { filePath: u.newPath } });
  }
  // 清理迁空后的源侧目录树（test-reports / 旧 email-attachments）
  pruneEmptyDirs(qcSrc);
  pruneEmptyDirs(legacyEmailDir);
  console.log(`[migrate-private-files] 完成：迁移文件 ${moved} 个，DB filePath 回写 ${dbUpdates.length} 条，冲突跳过 ${conflicts} 个`);
}

main()
  .catch((e) => {
    console.error('[migrate-private-files] 失败：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
