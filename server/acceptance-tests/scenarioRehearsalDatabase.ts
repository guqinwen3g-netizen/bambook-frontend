import type { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

/** Only the dedicated fresh-cluster rehearsal may use the dev database name
 * required by the real clock guard. Never use this for ordinary acceptance. */
export async function assertScenarioRehearsalDatabase(prisma: PrismaClient): Promise<void> {
  const env = process.env, sandbox = env.BAMBOOK_ACCEPTANCE_SANDBOX;
  const directory = env.BAMBOOK_ACCEPTANCE_DB_DIR, port = env.BAMBOOK_ACCEPTANCE_DB_PORT;
  const expected = env.BAMBOOK_ACCEPTANCE_DATABASE_URL, nonce = env.BAMBOOK_SCENARIO_REHEARSAL_NONCE;
  if (!sandbox || !directory || !port || !expected || env.DATABASE_URL !== expected
    || !nonce || !/^[a-f0-9]{64}$/.test(nonce) || env.NODE_ENV !== 'test'
    || env.BAMBOOK_NO_SCHEDULER !== '1' || env.BAMBOOK_DEV_PANEL !== '1'
    || env.BAMBOOK_DEV_BUSINESS_TIME !== '2026-10-08T00:18:00.000Z'
    || env.BAMBOOK_ACCEPTANCE_DB_NAME !== 'panda_hub_dev') throw Error('Dedicated scenario runner required');
  const url = new URL(expected), manifestFile = path.join(sandbox, 'scenario-rehearsal-target.json');
  if (url.hostname !== '127.0.0.1' || url.port !== port || url.port === '5432'
    || url.pathname !== '/panda_hub_dev' || url.username !== 'acceptance'
    || url.search !== '?schema=public' || path.dirname(directory) !== sandbox
    || !path.basename(sandbox).startsWith('bambook-acceptance-')
    || fs.lstatSync(sandbox).isSymbolicLink() || fs.realpathSync(sandbox) !== sandbox
    || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory
    || fs.lstatSync(manifestFile).isSymbolicLink()
    || (fs.statSync(sandbox).mode & 0o077) !== 0 || (fs.statSync(manifestFile).mode & 0o077) !== 0) {
    throw Error('Scenario target is outside its fresh private cluster');
  }
  const target = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (target.nonce !== nonce || target.databaseUrl !== expected || target.directory !== directory
    || target.port !== Number(port) || target.database !== 'panda_hub_dev'
    || target.clock !== env.BAMBOOK_DEV_BUSINESS_TIME || !/^[a-f0-9]{64}$/.test(target.sourceSha256)) {
    throw Error('Scenario target receipt mismatch');
  }
  const rows = await prisma.$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  if (rows.length !== 1 || rows[0].name !== target.database || rows[0].directory !== directory
    || rows[0].port !== Number(port)) throw Error('Scenario SQL identity mismatch');
  for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'BAMBOOK_API_KEY', 'BAMBOOK_SDK_KEY']) {
    if (env[key]) throw Error('Scenario rehearsal includes external provider credentials');
  }
}
