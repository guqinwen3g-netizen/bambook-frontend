// Real PG failure injection. The audited fallback is documented as best effort:
// a failed audit must not silently invalidate the caller's business transaction.
// These tests do not approve fallback MOQ values or a whole shipping workflow.
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createMoqConfigService } from '../src/moq/moqConfigService';
const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
describe('acceptance: optional MOQ audit and transaction integrity', () => {
  it('positive control: valid audit anchor permits fallback and a committed caller write', async () => {
    const id = 'acceptance-moq-positive';
    expect(await prisma.moqThresholdConfig.count()).toBe(0);
    expect((await prisma.userAccount.findUnique({ where: { id: 'system' } }))?.status).toBe('disabled');
    await prisma.userAccount.create({ data: { id, displayName: 'before', status: 'disabled' } });
    await prisma.$transaction(async tx => {
      const snapshot = await createMoqConfigService({ prisma: tx as any }).buildSnapshot();
      expect(snapshot.source).toBe('fallback_constant');
      await tx.userAccount.update({ where: { id }, data: { displayName: 'committed' } });
    });
    expect((await prisma.userAccount.findUnique({ where: { id } }))?.displayName).toBe('committed');
  });
  it('real audit FK failure must not poison the caller transaction after a caught optional audit error', async () => {
    const id = 'acceptance-moq-negative';
    const missingActor = 'acceptance-absent-audit-actor';
    expect(await prisma.userAccount.count({ where: { id: missingActor } })).toBe(0);
    await prisma.userAccount.create({ data: { id, displayName: 'before', status: 'disabled' } });
    let caughtAuditCode: string | undefined;
    let callerError: any;
    try {
      await prisma.$transaction(async tx => {
        // Preserve the real transaction control capability while injecting only the audit FK failure.
        const injected = { $executeRawUnsafe: tx.$executeRawUnsafe.bind(tx), moqThresholdConfig: tx.moqThresholdConfig, auditLog: { create: async ({ data }: any) => {
          try { return await tx.auditLog.create({ data: { ...data, actorId: missingActor } }); }
          catch (error: any) { caughtAuditCode = error.code; throw error; }
        } } };
        const snapshot = await createMoqConfigService({ prisma: injected as any }).buildSnapshot();
        expect(snapshot.source).toBe('fallback_constant');
        await tx.userAccount.update({ where: { id }, data: { displayName: 'committed' } });
      });
    } catch (error: any) { callerError = error; }
    const actual = (await prisma.userAccount.findUnique({ where: { id } }))?.displayName;
    console.log(JSON.stringify({ probe: 'optional-moq-audit', injectedSqlFailure: caughtAuditCode, callerError: callerError?.code, callerMessage: callerError?.message, actual }));
    expect(caughtAuditCode).toBe('P2003');
    expect({ callerError: callerError?.code, actual }).toEqual({ callerError: undefined, actual: 'committed' });
  });
  it('a real optional SQL read failure rolls back to its savepoint and permits the caller write', async () => {
    const id = 'acceptance-moq-read-failure';
    await prisma.userAccount.create({ data: { id, displayName: 'before', status: 'disabled' } });
    let sqlCode: string | undefined;
    await prisma.$transaction(async tx => {
      const injected = {
        $executeRawUnsafe: tx.$executeRawUnsafe.bind(tx),
        moqThresholdConfig: { findFirst: async () => {
          try { return await tx.$queryRawUnsafe('SELECT * FROM acceptance_moq_deliberately_absent_relation'); }
          catch (error: any) { sqlCode = error.code; throw error; }
        } }, auditLog: tx.auditLog,
      };
      const snapshot = await createMoqConfigService({ prisma: injected as any }).buildSnapshot();
      expect(snapshot.source).toBe('fallback_constant');
      await tx.userAccount.update({ where: { id }, data: { displayName: 'committed' } });
    });
    expect(sqlCode).toBe('P2010');
    expect((await prisma.userAccount.findUnique({ where: { id } }))?.displayName).toBe('committed');
  });
  it('concurrent optional SQL faults using the same transaction do not invalidate each other savepoints', async () => {
    const id = 'acceptance-moq-concurrent-failure';
    const missingActor = 'acceptance-absent-concurrent-moq-actor';
    expect(await prisma.userAccount.count({ where: { id: missingActor } })).toBe(0);
    await prisma.userAccount.create({ data: { id, displayName: 'before', status: 'disabled' } });
    const sqlCodes: string[] = [];
    await prisma.$transaction(async tx => {
      const injected = { $executeRawUnsafe: tx.$executeRawUnsafe.bind(tx),
        moqThresholdConfig: tx.moqThresholdConfig,
        auditLog: { create: async ({ data }: any) => {
          try { return await tx.auditLog.create({ data: { ...data, actorId: missingActor } }); }
          catch (error: any) { sqlCodes.push(error.code); throw error; }
        } },
      };
      const snapshots = await Promise.all([
        createMoqConfigService({ prisma: injected as any }).buildSnapshot(),
        createMoqConfigService({ prisma: injected as any }).buildSnapshot(),
      ]);
      expect(snapshots.map(s => s.source)).toEqual(['fallback_constant', 'fallback_constant']);
      await tx.userAccount.update({ where: { id }, data: { displayName: 'committed' } });
    });
    expect(sqlCodes).toEqual(['P2003', 'P2003']);
    expect((await prisma.userAccount.findUnique({ where: { id } }))?.displayName).toBe('committed');
  });

});
