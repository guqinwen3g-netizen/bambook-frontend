import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

/** 邮箱登录凭据：只写入服务端私有目录（目录 0700、文件 0600），不进入工作空间状态、接口响应、仓库或日志。 */
export type MistMailSecret = { username: string; password: string };
const ID = /^[A-Za-z0-9-]{1,120}$/;

export class MistMailCredentials {
  readonly root: string;
  /** key 可选：配置 MIST_MAIL_CREDENTIAL_KEY 时以 AES-256-GCM 加密落盘。 */
  constructor(root: string, private readonly key = process.env.MIST_MAIL_CREDENTIAL_KEY) { this.root = path.resolve(root); }
  private file(workspaceId: string, accountId: string) {
    if (!ID.test(workspaceId) || !ID.test(accountId)) throw new Error('邮箱凭据编号无效');
    return { dir: path.join(this.root, workspaceId), file: path.join(this.root, workspaceId, `${accountId}.json`) };
  }
  private seal(value: MistMailSecret) {
    const plain = Buffer.from(JSON.stringify({ v: 1, ...value }));
    if (!this.key) return JSON.stringify({ v: 1, plain: plain.toString('base64') });
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(this.key).digest(), iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  private open(raw: string): MistMailSecret | null {
    const value = JSON.parse(raw);
    let plain: Buffer;
    if (typeof value.plain === 'string') plain = Buffer.from(value.plain, 'base64');
    else {
      if (!this.key) return null;
      const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(this.key).digest(), Buffer.from(value.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      plain = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]);
    }
    const parsed = JSON.parse(plain.toString('utf8'));
    return typeof parsed.username === 'string' && typeof parsed.password === 'string' ? { username: parsed.username, password: parsed.password } : null;
  }
  async save(workspaceId: string, accountId: string, secret: MistMailSecret) {
    const { dir, file } = this.file(workspaceId, accountId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(this.seal(secret)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  }
  async load(workspaceId: string, accountId: string): Promise<MistMailSecret | null> {
    const { file } = this.file(workspaceId, accountId);
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
    try { return this.open(await handle.readFile('utf8')); } catch { return null; } finally { await handle.close(); }
  }
  async remove(workspaceId: string, accountId: string) {
    const { file } = this.file(workspaceId, accountId);
    await fs.rm(file, { force: true });
  }
}
