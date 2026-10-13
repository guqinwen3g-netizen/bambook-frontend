import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAiRouter } from './route';
import { createAiRuntime } from './runtime';
import { createAuthService } from '../auth/service';
import { TokenPayload } from '../auth/service';

function makeApp(opts: {
  prisma?: any;
  requireAuth?: boolean;
  apiKeys?: string[];
  apiKeyActors?: Map<string, TokenPayload>;
  ttsSynthesizer?: any;
  deltas?: Array<Record<string, unknown>>;
} = {}) {
  const app = express();
  app.use(express.json());
  const seenRequests: any[] = [];
  const runtime = createAiRuntime({
    chatRunner: async (runRequest) => {
      const { message, emit } = runRequest;
      seenRequests.push(runRequest);
      emit('agent_event', {
        id: 'evt_test_planning',
        phase: 'planning',
        status: 'running',
        title: '整理任务',
        message: '正在整理任务',
      });
      emit('step', { message: '检索中' });
      if (opts.deltas?.length) {
        opts.deltas.forEach(delta => emit('delta', delta));
      } else {
        emit('delta', { text: '回答：' });
        emit('delta', { text: message });
      }
      return {
        text: `回答：${message}`,
        sources: [{ title: 'Knowledge', excerpt: 'local' }],
        thoughtProcess: 'searched locally',
      };
    },
  });
  app.use('/api/ai', createAiRouter({
    runtime,
    prisma: opts.prisma,
    requireAuth: opts.requireAuth ?? false,
    apiKeys: new Set<string>(opts.apiKeys || []),
    apiKeyActors: opts.apiKeyActors,
    ttsSynthesizer: opts.ttsSynthesizer,
  } as any));
  return { app, seenRequests };
}

function makeRuntimePrisma(messages: Array<{ role: string; content: string }> = []) {
  let session: any = { id: 'as_1', title: '新对话', metadata: {} };
  return {
    userAccount: {
      findFirst: async () => ({ id: 'kevin' }),
      findMany: async () => [],
    },
    agentSession: {
      findFirst: async () => session,
      create: async (args: any) => {
        session = { ...args.data, metadata: args.data.metadata || {} };
        return session;
      },
      update: async (args: any) => {
        session = { ...session, ...args.data };
        return session;
      },
    },
    agentMessage: {
      findMany: async () => messages,
      findFirst: async () => null,
      create: async () => ({}),
    },
  };
}

describe('AI route', () => {
  it('streams chat events over SSE', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/ai/chat')
      .send({ sessionId: 's1', message: '订单状态', history: [] });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: queued');
    expect(res.text).toContain('event: agent_event');
    expect(res.text).toContain('evt_test_planning');
    expect(res.text).toContain('event: step');
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('event: final');
    expect(res.text).toContain('回答：订单状态');
  });

  it('streams backend-generated TTS chunks when requested by the client', async () => {
    const synthesize = vi.fn(async (input: any) => ({
      audio: Buffer.from(`wav:${input.input}`),
      contentType: 'audio/wav',
      engine: 'melo',
      serviceElapsedMs: '12',
      language: 'ZH',
    }));
    const { app, seenRequests } = makeApp({ ttsSynthesizer: synthesize });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({
        sessionId: 's1',
        message: '订单状态',
        history: [],
        tts: { enabled: true, voice: 'melo', speed: 1.05 },
      });

    expect(res.status).toBe(200);
    expect(seenRequests[0].tts).toMatchObject({ enabled: true, voice: 'melo', speed: 1.05 });
    expect(synthesize).toHaveBeenCalledWith(expect.any(Object), expect.any(AbortSignal));
    expect(synthesize.mock.calls[0][0]).not.toHaveProperty('mode');
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('event: tts_chunk');
    expect(res.text).toContain('"engine":"melo"');
    expect(res.text).toContain('"language":"ZH"');
    expect(res.text).not.toContain('"speaker"');
    expect(res.text).toContain(Buffer.from('wav:回答：订单状态').toString('base64'));
    expect(res.text.indexOf('event: tts_chunk')).toBeLessThan(res.text.indexOf('event: final'));
  });

  it('keeps internal TTS annotations out of client deltas while using them for speech', async () => {
    const synthesize = vi.fn(async (input: any) => ({
      audio: Buffer.from(`wav:${input.input}`),
      contentType: 'audio/wav',
      engine: 'melo',
    }));
    const { app } = makeApp({
      ttsSynthesizer: synthesize,
      deltas: [
        {
          text: 'PO 208401 的交期是 2026-06-11。',
          ttsText: 'PO <tts type="po">208401</tts> 的交期是 <tts type="date">2026-06-11</tts>。',
        },
      ],
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({
        sessionId: 's1',
        message: '订单状态',
        history: [],
        tts: { enabled: true },
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"text":"PO 208401 的交期是 2026-06-11。"');
    expect(res.text).not.toContain('ttsText');
    expect(res.text).not.toContain('<tts');
    expect(synthesize.mock.calls[0][0].input).toContain('P O 二 零 八 四 零 一');
    expect(synthesize.mock.calls[0][0].input).toContain('二零二六年六月十一日');
  });

  it('waits for split internal TTS annotations before synthesizing speech', async () => {
    const synthesize = vi.fn(async (input: any) => ({
      audio: Buffer.from(`wav:${input.input}`),
      contentType: 'audio/wav',
      engine: 'melo',
    }));
    const { app } = makeApp({
      ttsSynthesizer: synthesize,
      deltas: [
        { text: 'PO 208', ttsText: 'PO <tts type="po">208' },
        { text: '401 的交期是 ', ttsText: '401</tts> 的交期是 <tts type="date">2026-' },
        { text: '06-11。', ttsText: '06-11</tts>。' },
      ],
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({
        sessionId: 's1',
        message: '订单状态',
        history: [],
        tts: { enabled: true },
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"text":"PO 208"');
    expect(res.text).not.toContain('ttsText');
    expect(res.text).not.toContain('<tts');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0][0].input).toContain('P O 二 零 八 四 零 一');
    expect(synthesize.mock.calls[0][0].input).toContain('二零二六年六月十一日');
    expect(synthesize.mock.calls[0][0].input).not.toContain('<tts');
  });

  it('passes actor role and department context to the runtime', async () => {
    const { app, seenRequests } = makeApp();
    const res = await request(app)
      .post('/api/ai/chat')
      .send({
        sessionId: 's1',
        userId: 'finance-1',
        displayName: 'Finance User',
        roles: ['finance'],
        departmentIds: ['finance'],
        message: '开票',
      });

    expect(res.status).toBe(200);
    expect(seenRequests[0]).toMatchObject({
      userId: 'finance-1',
      displayName: 'Finance User',
      roles: ['finance'],
      departmentIds: ['finance'],
    });
  });

  it('prefers JWT actor over spoofed body roles when auth is required', async () => {
    const token = createAuthService().signToken({
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['*'],
      departmentIds: ['company'],
    });
    const { app, seenRequests } = makeApp({
      requireAuth: true,
      apiKeys: ['sdk-key'],
      prisma: makeRuntimePrisma([]),
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId: 's1',
        userId: 'viewer-user',
        displayName: 'Viewer User',
        roles: ['viewer'],
        departmentIds: ['sales'],
        message: '订单状态',
      });

    expect(res.status).toBe(200);
    expect(seenRequests[0]).toMatchObject({
      userId: 'kevin',
      actorUserId: 'kevin',
      requestSource: 'user-session',
      displayName: 'Kevin',
      roles: ['owner'],
      departmentIds: ['company'],
    });
  });

  it('allows API-key chat as a controlled SDK source', async () => {
    const { app, seenRequests } = makeApp({
      requireAuth: true,
      apiKeys: ['sdk-key'],
      apiKeyActors: new Map([['sdk-key', {
        userId: 'service-sdk',
        displayName: 'SDK Service',
        roles: ['agent_operator'],
        // W-C 权限收口：/chat 挂 ai:chat scope 门——受控 SDK 主体显式授予 ai:chat
        permissions: ['automation:run', 'ai:chat'],
        departmentIds: ['company'],
      }]]),
      prisma: makeRuntimePrisma([]),
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .set('x-bambook-api-key', 'sdk-key')
      .send({
        sessionId: 's1',
        userId: 'kevin',
        displayName: 'Kevin',
        roles: ['owner'],
        departmentIds: ['company'],
        message: '订单状态',
      });

    expect(res.status).toBe(200);
    expect(seenRequests[0]).toMatchObject({
      actorUserId: 'service-sdk',
      requestSource: 'api-key',
      roles: ['agent_operator'],
    });
  });

  it('rejects an API-key chat that has no mapped Agent principal', async () => {
    const { app } = makeApp({
      requireAuth: true,
      apiKeys: ['sdk-key'],
      prisma: makeRuntimePrisma([]),
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .set('x-bambook-api-key', 'sdk-key')
      .send({
        sessionId: 's1',
        userId: 'kevin',
        roles: ['owner'],
        message: '订单状态',
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'AGENT_PRINCIPAL_REQUIRED' });
  });

  it('hydrates chat history from the persisted agent session when frontend history is missing', async () => {
    const token = createAuthService().signToken({
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['*'],
      departmentIds: ['company'],
    });
    const prisma = makeRuntimePrisma([
      { role: 'user', content: '系统里一共有多少条面料信息？' },
      { role: 'model', content: '上下文不足。' },
      { role: 'user', content: '现在也一样' },
    ]);
    const { app, seenRequests } = makeApp({ prisma });

    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId: 'as_1',
        message: '现在也一样',
        history: [],
      });

    expect(res.status).toBe(200);
    expect(seenRequests[0]).toMatchObject({
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      departmentIds: ['company'],
    });
    expect(seenRequests[0].history).toEqual([
      { role: 'user', content: '系统里一共有多少条面料信息？' },
      { role: 'model', content: '上下文不足。' },
    ]);
  });

  it('persists user and assistant messages through the backend Agent runtime', async () => {
    const token = createAuthService().signToken({
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['*'],
      departmentIds: ['company'],
    });
    const createdMessages: any[] = [];
    const prisma = {
      ...makeRuntimePrisma([]),
      agentMessage: {
        findMany: async () => [],
        findFirst: async () => null,
        create: async (args: any) => {
          createdMessages.push(args.data);
          return args.data;
        },
      },
    };
    const { app } = makeApp({ prisma });

    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId: 'as_1',
        message: '系统里一共有多少条面料信息？',
        history: [],
      });

    expect(res.status).toBe(200);
    expect(createdMessages).toEqual([
      expect.objectContaining({ sessionId: 'as_1', userId: 'kevin', role: 'user', content: '系统里一共有多少条面料信息？' }),
      expect.objectContaining({ sessionId: 'as_1', userId: 'kevin', role: 'model', content: '回答：系统里一共有多少条面料信息？' }),
    ]);
  });

  it('persists runtime run state and agent events on the backend session', async () => {
    const token = createAuthService().signToken({
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      permissions: ['*'],
      departmentIds: ['company'],
    });
    const sessionUpdates: any[] = [];
    let session: any = { id: 'as_1', title: '新对话', metadata: {} };
    const prisma = {
      ...makeRuntimePrisma([]),
      agentSession: {
        findFirst: async () => session,
        create: async (args: any) => {
          session = { ...args.data, metadata: args.data.metadata || {} };
          return session;
        },
        update: async (args: any) => {
          session = { ...session, ...args.data };
          sessionUpdates.push(args.data);
          return session;
        },
      },
    };
    const { app, seenRequests } = makeApp({ prisma });

    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId: 'as_1',
        message: '检查运行状态',
        history: [],
      });

    expect(res.status).toBe(200);
    expect(seenRequests[0].runtimeRunId).toMatch(/^arun_/);
    expect(sessionUpdates.some(update => update.metadata?.agentRuntime?.currentRun?.events?.some((event: any) => event.id === 'evt_test_planning'))).toBe(true);
    expect(session.metadata.agentRuntime.currentRun).toMatchObject({
      id: seenRequests[0].runtimeRunId,
      status: 'complete',
      finalTextPreview: '回答：检查运行状态',
      sourceCount: 1,
    });
  });

  it('returns runtime metrics', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/ai/metrics');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.metrics.lanes.model.limit).toBeGreaterThan(0);
  });
});
