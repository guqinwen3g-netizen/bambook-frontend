/**
 * privateFiles.ts — 私有文件存储根（敏感文件安全收口）
 *
 * 邮件附件、QC 测试报告等敏感业务文件不允许落在 /api/uploads 静态服务根
 * （index.ts 的 UPLOAD_DIR，express.static 无鉴权直读）之下——必须存入本私有根，
 * 只能经带权限门的下载路由读取（如 emails:read / qc:read）。
 *
 * 根目录：BAMBOOK_PRIVATE_FILES_DIR 或 <server>/private-files。
 * 与 UPLOAD_DIR 的默认布局（dev apps/Bambook/uploads、生产 ~/uploads）天然不同树；
 * index.ts 启动时另有防呆校验，二者重叠即拒绝启动。
 */
import path from 'path';
import fs from 'fs';

export const PRIVATE_FILES_DIR =
  process.env.BAMBOOK_PRIVATE_FILES_DIR || path.resolve(__dirname, '../..', 'private-files');

/** 确保私有根（或其子目录）存在，返回其绝对路径 */
export function ensurePrivateDir(sub?: string): string {
  const dir = sub ? path.join(PRIVATE_FILES_DIR, sub) : PRIVATE_FILES_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** target 是否位于 ancestor 目录之内（含相等） */
export function isInsideDir(ancestor: string, target: string): boolean {
  const rel = path.relative(path.resolve(ancestor), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
