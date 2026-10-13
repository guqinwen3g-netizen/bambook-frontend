import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertScenarioRehearsalDatabase } from '../../acceptance-tests/scenarioRehearsalDatabase';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function context() {
  const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bambook-acceptance-')));
  directories.push(sandbox); const directory = path.join(sandbox, 'postgres'); await fs.mkdir(directory, { mode: 0o700 });
  const url = 'postgresql://acceptance@127.0.0.1:49123/panda_hub_dev?schema=public', nonce = 'a'.repeat(64);
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', DATABASE_URL: url, BAMBOOK_ACCEPTANCE_DATABASE_URL: url,
    BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: '49123',
    BAMBOOK_ACCEPTANCE_DB_NAME: 'panda_hub_dev', BAMBOOK_SCENARIO_REHEARSAL_NONCE: nonce, BAMBOOK_NO_SCHEDULER: '1',
    BAMBOOK_DEV_PANEL: '1', BAMBOOK_DEV_BUSINESS_TIME: '2026-10-08T00:18:00.000Z' })) vi.stubEnv(key, value);
  for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'BAMBOOK_API_KEY', 'BAMBOOK_SDK_KEY']) vi.stubEnv(key, undefined);
  const file = path.join(sandbox, 'scenario-rehearsal-target.json');
  await fs.writeFile(file, JSON.stringify({ nonce, databaseUrl: url, directory, port: 49123, database: 'panda_hub_dev',
    sourceSha256: 'b'.repeat(64), clock: '2026-10-08T00:18:00.000Z' }), { mode: 0o600 });
  const query = vi.fn().mockResolvedValue([{ name: 'panda_hub_dev', directory, port: 49123 }]);
  return { file, query, prisma: { $queryRaw: query } as any };
}
describe('dedicated fixed-time scenario rehearsal boundary', () => {
  it('checks SQL data-directory identity even when the database has the dev name', async () => {
    const c = await context(); await expect(assertScenarioRehearsalDatabase(c.prisma)).resolves.toBeUndefined(); expect(c.query).toHaveBeenCalledOnce();
    c.query.mockResolvedValue([{ name: 'panda_hub_dev', directory: '/actual/dev/data', port: 49123 }]);
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow('SQL identity');
  });
  it('rejects the ordinary dev port and redirected database URLs before SQL', async () => {
    const c = await context(); vi.stubEnv('BAMBOOK_ACCEPTANCE_DB_PORT', '5432');
    vi.stubEnv('DATABASE_URL', 'postgresql://acceptance@127.0.0.1:5432/panda_hub_dev?schema=public');
    vi.stubEnv('BAMBOOK_ACCEPTANCE_DATABASE_URL', process.env.DATABASE_URL);
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow(); expect(c.query).not.toHaveBeenCalled();
    vi.stubEnv('BAMBOOK_ACCEPTANCE_DB_PORT', '49123');
    vi.stubEnv('DATABASE_URL', 'postgresql://acceptance@127.0.0.1:49123/panda_hub_dev?schema=public&host=elsewhere');
    vi.stubEnv('BAMBOOK_ACCEPTANCE_DATABASE_URL', process.env.DATABASE_URL);
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow(); expect(c.query).not.toHaveBeenCalled();
  });
  it('refuses a missing runner nonce, altered receipt, public receipt or provider credential', async () => {
    const c = await context(); vi.stubEnv('BAMBOOK_SCENARIO_REHEARSAL_NONCE', undefined);
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow('runner required');
    vi.stubEnv('BAMBOOK_SCENARIO_REHEARSAL_NONCE', 'c'.repeat(64));
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow('receipt mismatch');
    vi.stubEnv('BAMBOOK_SCENARIO_REHEARSAL_NONCE', 'a'.repeat(64)); await fs.chmod(c.file, 0o644);
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow('private cluster');
    await fs.chmod(c.file, 0o600); vi.stubEnv('SMTP_PASSWORD', 'prohibited-provider-value');
    await expect(assertScenarioRehearsalDatabase(c.prisma)).rejects.toThrow('external provider');
  });
});
