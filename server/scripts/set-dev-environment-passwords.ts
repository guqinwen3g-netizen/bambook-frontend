/**
 * Development environment only: give the seeded role-play test accounts individual random passwords.
 * Guarded to the dedicated localhost/panda_hub_dev database and BAMBOOK_DEV_ENVIRONMENT=1.
 * Passwords are written once to a new 0600 file given as the first argument and never printed.
 *
 * Run (as the delivery account, after seed:base, seed-empty-owner and seed:dev-roles):
 *   BAMBOOK_DEV_ENVIRONMENT=1 npx tsx scripts/set-dev-environment-passwords.ts /srv/bambook-dev/shared/test-accounts.txt
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

import { assertDevelopmentDatabase, DEV_TEST_ACCOUNTS } from '../src/devEnvironment/testAccounts';

async function main() {
  assertDevelopmentDatabase(process.env);
  const output = process.argv[2];
  if (!output) throw new Error('Output file path is required.');
  const prisma = new PrismaClient();
  try {
    const lines: string[] = ['# Bambook 开发环境测试账号（仅开发环境；不要提交或转发）', ''];
    let updated = 0;
    for (const account of DEV_TEST_ACCOUNTS) {
      const user = await prisma.userAccount.findFirst({ where: { email: account.email, status: 'active', deletedAt: null }, select: { id: true } });
      if (!user) { lines.push(`${account.label}\t${account.email}\t（账号不存在，跳过）`); continue; }
      const password = randomBytes(12).toString('base64url');
      await prisma.userAccount.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 12) } });
      lines.push(`${account.label}\t${account.email}\t${password}`);
      updated++;
    }
    fs.writeFileSync(output, lines.join('\n') + '\n', { mode: 0o600, flag: 'w' });
    fs.chmodSync(output, 0o600);
    console.log(`Updated ${updated} development test accounts; credentials written to ${output}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`[dev-passwords] ${error.message}`); process.exitCode = 1; });
}
