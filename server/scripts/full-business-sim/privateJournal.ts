import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ScenarioCommandJournal, ScenarioCommandRecord } from './driverContract';

/** One private directory per verified database instance. Atomic replacement
 * preserves unknown intents after interruption; keys never become file paths. */
export async function createPrivateScenarioJournal(directory: string): Promise<ScenarioCommandJournal> {
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077)) throw Error('SCENARIO_PRIVATE_JOURNAL_REQUIRED');
  const file = (key: string) => path.join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  return {
    async read(key) {
      const target = file(key);
      try {
        const info = await fs.lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw Error('SCENARIO_PRIVATE_RECORD_REQUIRED');
        const record = JSON.parse(await fs.readFile(target, 'utf8')) as ScenarioCommandRecord;
        if (record.key !== key) throw Error('SCENARIO_JOURNAL_KEY_MISMATCH');
        return record;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async write(record) {
      const target = file(record.key), temp = target + '.' + randomUUID() + '.tmp';
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, target);
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    },
  };
}
