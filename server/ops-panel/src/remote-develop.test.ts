import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');
const ui = readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

describe('ops panel remote develop console', () => {
  it('exposes asynchronous command jobs without routing through arbitrary action scripts', () => {
    expect(source).toContain('type DevJobStatus');
    expect(source).toContain('DEV_JOB_CWD_OPTIONS');
    expect(source).toContain('DEV_JOB_HISTORY_FILE');
    expect(source).toContain('appendDevJobHistory');
    expect(source).toContain('readDevJobHistory');
    expect(source).toContain("app.post('/api/dev/jobs'");
    expect(source).toContain("app.get('/api/dev/jobs/:id'");
    expect(source).toContain("app.post('/api/dev/jobs/:id/cancel'");
    expect(source).toContain("spawn('/bin/bash', ['-lc', command]");
    expect(source).toContain('maskSensitiveOutput');
  });

  it('runs whitelisted ops actions through the asynchronous job runner', () => {
    expect(source).toContain('startActionJob');
    expect(source).toContain('scriptCommandForAction');
    expect(source).toContain('return res.status(202).json({ ok: true, action: id, label: action.label, job: serializeDevJob(job) })');
    expect(source).not.toContain('const result = await runLocalScript(action.script, action.timeoutMs)');
  });

  it('keeps OPS on the canonical /ops shell and /api backend paths only', () => {
    expect(source).toContain("app.use('/ops'");
    expect(source).toContain("app.get('/ops/*'");
    expect(source).not.toContain("app.use('/bambook/ops'");
    expect(source).not.toContain("app.get('/bambook/ops/*'");
    expect(source).not.toContain("app.use('/bambook/ops/api'");
    expect(ui).toContain("const API_BASE = '/api'");
    expect(ui).not.toContain('/bambook/ops/api');
  });

  it('exposes scoped remote file read and write APIs with backups', () => {
    expect(source).toContain('resolveDevFilePath');
    expect(source).toContain('readDevFile');
    expect(source).toContain('writeDevFile');
    expect(source).toContain('diffDevFile');
    expect(source).toContain('listDevFileBackups');
    expect(source).toContain('rollbackDevFile');
    expect(source).toContain('uploadDevFile');
    expect(source).toContain('DEV_FILE_BACKUP_DIR');
    expect(source).toContain("app.get('/api/dev/files'");
    expect(source).toContain("app.post('/api/dev/files/diff'");
    expect(source).toContain("app.post('/api/dev/files/write'");
    expect(source).toContain("app.get('/api/dev/files/backups'");
    expect(source).toContain("app.post('/api/dev/files/rollback'");
    expect(source).toContain("app.post('/api/dev/files/upload'");
  });

  it('masks sensitive values when returning logs', () => {
    expect(source).toContain('readOpsLog');
    expect(source).toContain('maskSensitiveOutput(filterLogLines');
  });

  it('supports log search, stderr filtering, and full log download', () => {
    expect(source).toContain('readOpsLog');
    expect(source).toContain('filterLogLines');
    expect(source).toContain("req.query.download || '') === '1'");
    expect(source).toContain('stderrOnly');
    expect(source).toContain('Content-Disposition');
  });

  it('exposes action locks for mutually exclusive long operations', () => {
    expect(source).toContain('lockKey?: string');
    expect(source).toContain('DEV_JOB_LOCKS');
    expect(source).toContain('activeJobLocks');
    expect(source).toContain('ACTION_LOCKED');
    expect(source).toContain("lockKey: 'melo-tts'");
    expect(source).toContain('lockedBy: a.lockKey ? activeJobLock(a.lockKey) : null');
    expect(ui).toContain('锁占用');
    expect(ui).toContain('a.lockedBy ?');
    expect(ui).toContain('测试 Melo TTS');
    expect(ui).toContain('公网探测');
    expect(ui).toContain('currentDevLockKey');
  });

  it('supports warn-level health checks without marking the whole system failed', () => {
    expect(source).toContain("type ServiceStatus = 'ok' | 'warn' | 'error'");
    expect(source).toContain('const cloudflareStatus: ServiceStatus');
    expect(source).toContain('warnCount');
    expect(source).toContain("status: errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'ok'");
    expect(ui).toContain('.badge.warn');
    expect(ui).toContain('可用但需关注');
  });

  it('renders command input, quick actions, live output, cancel, and history controls', () => {
    expect(ui).toContain('Remote Develop');
    expect(ui).toContain('id="devCommand"');
    expect(ui).toContain('id="runDevCommand"');
    expect(ui).toContain('id="cancelDevJob"');
    expect(ui).toContain('id="devQuickActions"');
    expect(ui).toContain('id="devJobs"');
    expect(ui).toContain('loadDevJob');
    expect(ui).toContain('result.job');
    expect(ui).toContain('pollDevJob(result.job.id)');
  });

  it('renders log search and line count controls', () => {
    expect(ui).toContain('id="logSearch"');
    expect(ui).toContain('id="logLines"');
    expect(ui).toContain('id="logStderrOnly"');
    expect(ui).toContain('id="downloadLog"');
    expect(ui).toContain('currentLogName');
  });

  it('renders remote file viewing and editing controls', () => {
    expect(ui).toContain('远程文件维护');
    expect(ui).toContain('id="devFilePath"');
    expect(ui).toContain('id="loadDevFile"');
    expect(ui).toContain('id="diffDevFile"');
    expect(ui).toContain('id="saveDevFile"');
    expect(ui).toContain('id="rollbackDevFile"');
    expect(ui).toContain('id="devUploadFile"');
    expect(ui).toContain('id="uploadDevFile"');
    expect(ui).toContain('id="devFileContent"');
    expect(ui).toContain('id="devFileDiff"');
    expect(ui).toContain('loadDevFile');
    expect(ui).toContain('diffDevFile');
    expect(ui).toContain('saveDevFile');
    expect(ui).toContain('rollbackDevFile');
    expect(ui).toContain('uploadDevFile');
  });

  it('offers backend development shortcuts instead of SSH-like terminal framing', () => {
    expect(ui).toContain('Prisma 状态');
    expect(ui).toContain('Prisma migrate');
    expect(ui).toContain('主 API 进程');
    expect(ui).toContain('OPS 进程');
    expect(ui).toContain('Action log');
    expect(ui).toContain('环境摘要');
    expect(ui).not.toContain('Web Terminal');
    expect(ui).not.toContain('xterm');
  });
});
