import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../emailSyncService', () => ({ syncEmailsFromImap: vi.fn(), resolveEmailAttachmentPath: vi.fn() }));
vi.mock('../emailLinkService', () => ({ autoLinkEmailById: vi.fn(), backfillEmailLinks: vi.fn() }));
vi.mock('../emailClassificationService', () => ({ applyEmailClassification: vi.fn(), backfillEmailClassification: vi.fn() }));
vi.mock('../emailFollowUpService', () => ({ autoFollowUpForClassifiedEmail: vi.fn(), createFollowUpFromEmail: vi.fn() }));
vi.mock('../emailOutboxMutationService', () => ({ createOutboxEmail: vi.fn(), createReplyOutboxEmail: vi.fn() }));
vi.mock('../outboxSend', () => ({ sendOutboxEmail: vi.fn() }));
vi.mock('../../audit/routeAudit', () => ({ actorIdFromRequest: (req: any) => req.actor?.userId || 'api', writeRouteAuditLog: vi.fn(async () => 'audit-sim') }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { createEmailRouter } from '../route';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const apiKeys = new Set<string>();
const token = (userId: string, roles: string[] = ['sales']) => jwt.sign({ userId, roles, permissions: ['emails:read', 'emails:write', 'emails:admin'] }, SECRET);

function makeApp(prisma: any) {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part: string) => {
      const [key, ...value] = part.trim().split('='); return [key, value.join('=')];
    })); next();
  });
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

function db() {
  return {
    email: {
      findMany: vi.fn(async () => []), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})), create: vi.fn(async ({ data }: any) => data),
    },
    emailAttachment: { findFirst: vi.fn(async () => null) },
    userAccount: {
      findUnique: vi.fn(async () => ({ id: 'gu-yan', email: 'sales.garment1.lead@bambook.local', displayName: '顾言' })),
      findFirst: vi.fn(async () => ({ id: 'gu-yan', email: 'sales.garment1.lead@bambook.local', displayName: '顾言' })),
    },
    relation: { findFirst: vi.fn(async () => ({ id: 'cedar', name: 'Cedar & Crown Tailoring' })), findUnique: vi.fn(async () => ({ id: 'cedar', name: 'Cedar & Crown Tailoring' })) },
  };
}

describe('per-user mailbox ownership', () => {
  it('lists only the authenticated user mailbox', async () => {
    const prisma = db();
    const res = await request(makeApp(prisma)).get('/api/v1/email?mailbox=INBOX').set('Cookie', `bambook_token=${token('gu-yan')}`);
    expect(res.status).toBe(200);
    expect(prisma.email.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, mailbox: 'INBOX', mailboxOwnerUserId: 'gu-yan' } }));
  });

  it('hides another employee email by id and does not mutate it', async () => {
    const prisma = db();
    const detail = await request(makeApp(prisma)).get('/api/v1/email/EML__other').set('Cookie', `bambook_token=${token('gu-yan')}`);
    expect(detail.status).toBe(404);
    const patch = await request(makeApp(prisma)).patch('/api/v1/email/EML__other').set('Cookie', `bambook_token=${token('gu-yan')}`).send({ isRead: true });
    expect(patch.status).toBe(404);
    expect(prisma.email.update).not.toHaveBeenCalled();
  });

  it('creates a development-only inbound simulation addressed to the selected employee', async () => {
    const prisma = db();
    const oldEnv = { nodeEnv: process.env.NODE_ENV, databaseUrl: process.env.DATABASE_URL, simulator: process.env.DEVSIM_EMAIL_ENABLED };
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://x:x@localhost:5432/panda_hub_dev';
    process.env.DEVSIM_EMAIL_ENABLED = 'true';
    try {
      const res = await request(makeApp(prisma)).post('/api/v1/email/simulate-inbound').set('Cookie', `bambook_token=${token('owner', ['owner'])}`).send({
        recipientUserId: 'gu-yan', fromAddress: 'morgan@cedarcrown.example', fromName: 'Morgan Ellis',
        relationId: 'cedar', subject: 'AW27 男士 Blazer 与配套面料开发咨询', bodyText: '请协助开发男士Blazer及配套羊毛面料。',
      });
      expect(res.status).toBe(201);
      expect(prisma.email.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        mailboxOwnerUserId: 'gu-yan', direction: 'inbound', mailbox: 'INBOX', status: 'new',
        fromAddress: 'morgan@cedarcrown.example', toAddresses: JSON.stringify(['sales.garment1.lead@bambook.local']),
        relationId: 'cedar',
      }) }));
    } finally {
      if (oldEnv.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv.nodeEnv;
      if (oldEnv.databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldEnv.databaseUrl;
      if (oldEnv.simulator === undefined) delete process.env.DEVSIM_EMAIL_ENABLED; else process.env.DEVSIM_EMAIL_ENABLED = oldEnv.simulator;
    }
  });
});
