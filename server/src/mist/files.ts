import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors';
export const MIST_FILE_MAX_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MistFileInput = { bytes: Buffer; name: string; mimeType: string; multipartFilename?: boolean };
export type MistStoredFile = { id: string; name: string; mimeType: string; size: number; storageKey: string; createdAt: string; uploadedBy?: string };
export function validateFileInput(input: MistFileInput) {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > MIST_FILE_MAX_BYTES) fail('INVALID_FILE', '请上传一个不超过50MiB的实际文件', 400);
  const name = path.basename(input.name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..' || name.length > 180) fail('INVALID_FILE', '文件名无效或过长', 400);
  return { name, mimeType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.mimeType) ? input.mimeType : 'application/octet-stream', size: input.bytes.length, sha256: createHash('sha256').update(input.bytes).digest('hex') };
}
/** Decode only stored multipart display names; keep raw validation metadata stable for request replay. */
function multipartDisplayName(name: string): string {
  if ([...name].some(char => char.charCodeAt(0) > 255)) return name;
  const bytes = Buffer.from(name, 'latin1');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : name;
  } catch { return name; }
}
export class MistPrivateFiles {
  constructor(private readonly root: string) {}
  private checked(workspaceId: string, fileId: string) {
    if (!UUID.test(workspaceId) || !UUID.test(fileId)) fail('INVALID_FILE_PATH', '附件路径无效', 400);
    const root = path.resolve(this.root), file = path.resolve(root, workspaceId, fileId);
    if (!file.startsWith(root + path.sep)) fail('INVALID_FILE_PATH', '附件路径无效', 400);
    return { root, file, directory: path.dirname(file) };
  }
  async write(workspaceId: string, input: MistFileInput, now: string): Promise<MistStoredFile> { return this.writeWithId(workspaceId, randomUUID(), input, now); }
  /** 以既定附件 ID 写入（演示工作区创建时使用）；ID 必须是 UUID 且尚不存在。 */
  async writeWithId(workspaceId: string, id: string, input: MistFileInput, now: string): Promise<MistStoredFile> {
    const meta = validateFileInput(input), target = this.checked(workspaceId, id);
    await fs.mkdir(target.directory, { recursive: true, mode: 0o700 });
    const realRoot = await fs.realpath(target.root), realDirectory = await fs.realpath(target.directory);
    if (realDirectory !== path.join(realRoot, workspaceId)) fail('INVALID_FILE_PATH', '附件目录无效', 400);
    const handle = await fs.open(target.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(input.bytes); } catch (error) { await handle.close(); await fs.unlink(target.file).catch(() => undefined); throw error; }
    await handle.close();
    return { id, name: input.multipartFilename ? multipartDisplayName(meta.name) : meta.name, mimeType: meta.mimeType, size: meta.size, storageKey: `${workspaceId}/${id}`, createdAt: now };
  }
  async read(workspaceId: string, file: MistStoredFile): Promise<Buffer> {
    if (file.storageKey !== `${workspaceId}/${file.id}`) fail('INVALID_FILE_PATH', '附件不属于当前工作区', 404);
    const target = this.checked(workspaceId, file.id);
    let handle;
    try {
      const realRoot = await fs.realpath(target.root), realDirectory = await fs.realpath(target.directory);
      if (realDirectory !== path.join(realRoot, workspaceId)) fail('INVALID_FILE_PATH', '附件目录无效', 404);
      handle = await fs.open(target.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch { fail('FILE_NOT_FOUND', '附件原文件不存在', 404); }
    try {
      const stat = await handle!.stat();
      if (!stat.isFile() || stat.size !== file.size || stat.size > MIST_FILE_MAX_BYTES) fail('FILE_NOT_FOUND', '附件原文件无法核验', 404);
      return await handle!.readFile();
    } finally { await handle!.close(); }
  }
  async remove(workspaceId: string, file: MistStoredFile) {
    if (file.storageKey !== `${workspaceId}/${file.id}`) fail('INVALID_FILE_PATH', '附件不属于当前工作区', 404);
    await fs.unlink(this.checked(workspaceId, file.id).file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
