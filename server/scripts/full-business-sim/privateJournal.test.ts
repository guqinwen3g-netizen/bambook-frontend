import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrivateScenarioJournal } from './privateJournal';
import type { ScenarioCommandRecord } from './driverContract';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bambook-journal-unit-')); roots.push(root); return root; }
const record = (key: string): ScenarioCommandRecord => ({ key, actor: 'fabric1Sales', actorId: 'actual-account',
  runtimeId: 'fresh-private-instance', method: 'post', url: '/native-command', hash: 'content-hash', retryPolicy: 'reconcile-create', state: 'intent', body: { quantity: '10.5' } });
describe('durable private scenario command journal', () => {
  it('retains an unknown intent across recreation and atomically replaces it with its actual ACK', async () => {
    const root = await directory(), key = '../../must-not-become-path';
    const first = await createPrivateScenarioJournal(root);
    expect(await first.read(key)).toBeNull(); await first.write(record(key));
    const resumed = await createPrivateScenarioJournal(root);
    expect(await resumed.read(key)).toEqual(record(key));
    await resumed.write({ ...record(key), state: 'acknowledged', response: { status: 201, body: { id: 'native-object' } } });
    expect((await first.read(key))?.response?.body.id).toBe('native-object');
    const entries = await fs.readdir(root); expect(entries).toHaveLength(1); expect(entries[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await fs.stat(path.join(root, entries[0]))).mode & 0o077).toBe(0);
  });
  it('rejects a shared journal directory and a symbolic record before reading its contents', async () => {
    const root = await directory(); await fs.chmod(root, 0o755);
    await expect(createPrivateScenarioJournal(root)).rejects.toThrow('PRIVATE_JOURNAL');
    await fs.chmod(root, 0o700);
    const journal = await createPrivateScenarioJournal(root); await journal.write(record('key'));
    const [name] = await fs.readdir(root), file = path.join(root, name);
    await fs.rename(file, file + '.original'); await fs.symlink(file + '.original', file);
    await expect(journal.read('key')).rejects.toThrow('PRIVATE_RECORD');
  });
  it('does not silently treat corrupt private evidence as a missing command', async () => {
    const root = await directory(), journal = await createPrivateScenarioJournal(root); await journal.write(record('key'));
    const [name] = await fs.readdir(root); await fs.writeFile(path.join(root, name), '{invalid');
    await expect(journal.read('key')).rejects.toThrow();
  });
});
