/**
 * 本机会话存储：每个会话一个 JSONL 文件（首行 meta，其余为消息），逐步追加即检查点。
 * 目录按账号隔离：<userData>/assistant/accounts/<账号哈希>/sessions。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './types';

export type SessionMeta = { id: string; title: string; providerId: string | null; createdAt: string; updatedAt: string; messageCount: number };
type Line = { type: 'meta'; title: string; providerId: string | null; createdAt: string } | { type: 'message'; at: string; message: ChatMessage } | { type: 'title'; title: string };

const ID = /^[a-f0-9-]{36}$/;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class SessionStore {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  private file(id: string) {
    if (!ID.test(id)) throw new Error('invalid session id');
    return path.join(this.dir, `${id}.jsonl`);
  }

  private append(id: string, line: Line) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(id);
    // 断电可能留下没有换行的半行；先补换行，避免新记录与半行粘连而一起丢失。
    let prefix = '';
    try {
      const size = fs.statSync(file).size;
      if (size > 0) {
        const fd = fs.openSync(file, 'r');
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        fs.closeSync(fd);
        if (last[0] !== 0x0a) prefix = '\n';
      }
    } catch { /* 新文件 */ }
    fs.appendFileSync(file, prefix + JSON.stringify(line) + '\n', { mode: 0o600 });
  }

  create(title: string, providerId: string | null): SessionMeta {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.append(id, { type: 'meta', title: title.slice(0, 80) || '新对话', providerId, createdAt: at });
    return { id, title: title.slice(0, 80) || '新对话', providerId, createdAt: at, updatedAt: at, messageCount: 0 };
  }

  appendMessage(id: string, message: ChatMessage) {
    if (!fs.existsSync(this.file(id))) throw new Error('session not found');
    this.append(id, { type: 'message', at: this.now().toISOString(), message });
  }

  rename(id: string, title: string) { this.append(id, { type: 'title', title: title.slice(0, 80) }); }

  private read(id: string): { meta: SessionMeta; messages: ChatMessage[] } | null {
    const file = this.file(id);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return null; }
    if (stat.size > MAX_FILE_BYTES) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let meta: SessionMeta | null = null;
    const messages: ChatMessage[] = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let line: Line;
      try { line = JSON.parse(raw); } catch { continue; } // 断电造成的半行直接跳过
      if (line.type === 'meta') meta = { id, title: line.title, providerId: line.providerId, createdAt: line.createdAt, updatedAt: line.createdAt, messageCount: 0 };
      else if (line.type === 'title' && meta) meta.title = line.title;
      else if (line.type === 'message' && meta) { messages.push(line.message); meta.updatedAt = line.at; }
    }
    if (!meta) return null;
    meta.messageCount = messages.length;
    return { meta, messages };
  }

  get(id: string) { return this.read(id); }

  list(): SessionMeta[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter(n => n.endsWith('.jsonl') && ID.test(n.slice(0, -6)))
      .map(n => this.read(n.slice(0, -6))?.meta)
      .filter((m): m is SessionMeta => Boolean(m))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(id: string) { fs.rmSync(this.file(id), { force: true }); }
}
