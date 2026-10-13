import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

/** Opt-in business acceptance may only write the runner's new local cluster.
 * Verify after dotenv setup and before the first fixture/business mutation. */
export async function assertIsolatedAcceptanceDatabase(prisma: PrismaClient): Promise<void> {
  const expected = process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL;
  const sandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX;
  const database = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
  const port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
  const directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
  if (!expected || process.env.DATABASE_URL !== expected || !sandbox || !database
    || !/^bambook_acceptance_[a-f0-9]+$/.test(database) || !port || !directory
    || process.env.NODE_ENV !== 'test' || process.env.BAMBOOK_NO_SCHEDULER !== '1') {
    throw new Error('Business acceptance requires the isolated acceptance runner.');
  }
  const url = new URL(expected);
  if (url.hostname !== '127.0.0.1' || url.port !== port || url.pathname !== '/' + database
    || fs.lstatSync(sandbox).isSymbolicLink() || fs.realpathSync(sandbox) !== sandbox
    || path.dirname(directory) !== sandbox) {
    throw new Error('Acceptance database identity is outside the private runner.');
  }
  const rows = await prisma.$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  if (rows.length !== 1 || rows[0].name !== database || rows[0].directory !== directory || rows[0].port !== Number(port)) {
    throw new Error('Acceptance cluster identity did not match the runner.');
  }
  for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'BAMBOOK_API_KEY', 'BAMBOOK_SDK_KEY']) {
    if (process.env[key]) throw new Error('Acceptance environment includes an external provider credential.');
  }
}
