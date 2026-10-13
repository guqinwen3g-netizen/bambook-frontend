// Prerequisite, run separately before the isolated business batch.
import { describe, expect, it, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertScenarioRehearsalDatabase } from './scenarioRehearsalDatabase';
const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
describe('acceptance environment identity after the standard dotenv setup', () => {
  it('uses the new cluster and database, with no external provider credentials', async () => {
    if (process.env.BAMBOOK_SCENARIO_REHEARSAL_NONCE) {
      await assertScenarioRehearsalDatabase(prisma);
      return;
    }
    const url = new URL(process.env.DATABASE_URL || '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_PORT);
    expect(url.pathname).toBe('/' + process.env.BAMBOOK_ACCEPTANCE_DB_NAME);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    const identity: any[] = await prisma.$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
    expect(identity[0]).toEqual({ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) });
    for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'BAMBOOK_API_KEY', 'BAMBOOK_SDK_KEY']) expect(process.env[key]).toBeUndefined();
    expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  });
});
