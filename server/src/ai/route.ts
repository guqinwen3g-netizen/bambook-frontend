import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AiChatRequest, AiEmit, AiEventType, createAiRuntime } from './runtime';
import { normalizeTtsRequest, streamTtsSpeech, synthesizeTtsSpeech, TtsSpeechRequest, validateTtsRequest, MELO_CIRCUIT_OPEN_ERROR } from './tts';
import { extractActorFromRequest } from '../auth/middleware';
import { createModuleAuthGuard, ModuleAuthGuardOptions } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { TokenPayload } from '../auth/service';
import { createAgentRuntimeService } from '../agent/runtime';
import { normalizeTextForTts } from './ttsTextNormalizer';
import { logger } from '../lib/logger';
import { logAgentFailure, publicAgentFailure } from '../agent/publicFailure';

type AuthOptions = ModuleAuthGuardOptions;

type AiRouterOptions = AuthOptions & {
  runtime: ReturnType<typeof createAiRuntime>;
  prisma?: PrismaClient;
  ttsSynthesizer?: TtsSynthesizer;
};

type TtsSynthesizer = (input: TtsSpeechRequest, signal?: AbortSignal) => Promise<{
  audio: Buffer;
  contentType: string;
  engine: string;
  serviceElapsedMs?: string;
  language?: string;
}>;

export function createAiRouter(options: AiRouterOptions) {
  const router = Router();
  const agentRuntime = options.prisma ? createAgentRuntimeService({ prisma: options.prisma }) : null;
  const ttsSynthesizer = options.ttsSynthesizer || synthesizeTtsSpeech;

  // /metrics 是 OPS Panel 状态探测消费的只读运行指标：与 Agent 执行面（chat 等严格
  // 主身份模式）不同，对齐 agent 路由 /status 的口径——普通 moduleAuthGuard，
  // 裸 SDK API key（X-Bambook-API-Key）即可读取，无需 Agent 服务主体映射。
  const metricsGuard = createModuleAuthGuard({
    requireAuth: options.requireAuth,
    apiKeys: options.apiKeys,
  });

  router.get('/metrics', metricsGuard, (_req, res) => {
    res.json({ ok: true, metrics: options.runtime.getMetrics() });
  });

  // W-C 权限收口：对话/查询面挂 ai:chat scope（ai:chat 为读类 scope，API-key 映射主体
  // 若 JWT permissions / legacy 角色解析出 ai:chat 亦可通行；无 scope 身份 → 403）。
  router.post('/chat', auth(options), requirePermission('ai:chat'), async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: 'message is required' });
    }

    // 诊断日志：记录前端请求的认证来源和关键参数，便于排查前后端路径差异
    const _diagActor = (req as any).actor || extractActorFromRequest(req);
    const _diagAuthSource = ((req as any).authSource || (_diagActor ? 'user-session' : 'api-key'));
    const _diagUserId = String(req.body?.userId || req.headers['x-bambook-user-id'] || 'default-user');
    const _diagUseAgentLoop = process.env.BAMBOOK_AGENT_LOOP !== '0' && (req.body as any)?.useAgentLoop !== false;
    logger.debug(`[AI Chat] authSource=${_diagAuthSource} userId=${_diagUserId} agentLoop=${_diagUseAgentLoop} msg="${message.slice(0, 80)}"`);

    setupSse(res);

    const controller = new AbortController();
    let completed = false;
    const heartbeat = setInterval(() => sendSse(res, 'heartbeat', { at: new Date().toISOString() }), 10_000);
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      if (!completed) controller.abort();
    });

    const actor = (req as any).actor || extractActorFromRequest(req);
    const authSource = ((req as any).authSource || (actor ? 'user-session' : 'api-key')) as AiChatRequest['requestSource'];
    const sessionId = String(req.body?.sessionId || req.headers['x-bambook-session-id'] || 'default-session');
    const tts = normalizeChatTtsOptions(req.body?.tts);
    const ttsStream = createBackendTtsEventStream({
      enabled: Boolean(tts?.enabled),
      tts,
      signal: controller.signal,
      emit: (type, payload) => sendSse(res, type, payload),
      synthesize: ttsSynthesizer,
    });
    const emit: AiChatRequest['emit'] = (type, payload) => {
      sendSse(res, type, clientVisiblePayload(type, payload));
      ttsStream.accept(type, payload);
    };
    const request = agentRuntime
      ? await agentRuntime.prepareChatRun({
        sessionId,
        actor,
        body: {
          userId: String(req.body?.userId || req.headers['x-bambook-user-id'] || 'default-user'),
          displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : undefined,
          roles: Array.isArray(req.body?.roles) ? req.body.roles.map(String) : undefined,
          departmentIds: Array.isArray(req.body?.departmentIds) ? req.body.departmentIds.map(String) : undefined,
          message,
          history: Array.isArray(req.body?.history) ? req.body.history : [],
          attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
          model: typeof req.body?.model === 'string' ? req.body.model : undefined,
          temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : undefined,
          tts,
        },
        signal: controller.signal,
        emit,
        requestSource: authSource,
      })
      : {
        sessionId,
        userId: actor?.userId || String(req.body?.userId || req.headers['x-bambook-user-id'] || 'default-user'),
        runtimeRunId: undefined,
        actorUserId: actor?.userId || String(req.body?.userId || req.headers['x-bambook-user-id'] || 'default-user'),
        requestSource: authSource,
        displayName: actor?.displayName || (typeof req.body?.displayName === 'string' ? req.body.displayName : undefined),
        roles: actor?.roles || (Array.isArray(req.body?.roles) ? req.body.roles.map(String) : undefined),
        departmentIds: actor?.departmentIds || (Array.isArray(req.body?.departmentIds) ? req.body.departmentIds.map(String) : undefined),
        roleIds: actor?.roleIds,
        permissions: actor?.permissions,
        authorizationLoaded: actor?.authorizationLoaded,
        message,
        history: Array.isArray(req.body?.history) ? req.body.history : [],
        attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
        temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : undefined,
        tts,
        signal: controller.signal,
        emit,
      };

    try {
      const result = await options.runtime.runChat(request);
      await ttsStream.finish();
      await agentRuntime?.saveAssistantMessage({
        sessionId: request.sessionId,
        userId: request.userId,
        runtimeRunId: request.runtimeRunId,
        result,
      });
      sendSse(res, 'final', { ok: true, ...result });
    } catch (error: any) {
      const failure = publicAgentFailure(error);
      logAgentFailure('[ai-chat] execution failed', error);
      await ttsStream.cancel();
      await agentRuntime?.markRunFailed({
        sessionId: request.sessionId,
        userId: request.userId,
        runtimeRunId: request.runtimeRunId,
        error: failure,
      });
      sendSse(res, 'error', { ok: false, error: failure });
    } finally {
      completed = true;
      clearInterval(heartbeat);
      res.end();
    }
  });

  // TTS 合成是 AI 助手（View.Assistant → ai:chat）的消费面，与 /chat 同 scope 门。
  router.post('/tts/speech', auth(options), requirePermission('ai:chat'), async (req, res) => {
    const input = normalizeTtsRequest(req.body);
    const error = validateTtsRequest(input);
    if (error) {
      return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', message: error });
    }

    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => controller.abort());

    try {
      await streamTtsSpeech(input, res, controller.signal);
    } catch (error: any) {
      const failure = publicAgentFailure(error);
      logAgentFailure('[ai-tts] synthesis failed', error);
      if (!res.headersSent) {
        const message = String(error?.message || error);
        // 批次 2c：TTS 降级语义化——区分"未配置 / 熔断中（服务不可用）/ 其他失败"
        if (message.includes('BAMBOOK_MELO_URL environment variable')) {
          return res.status(503).json({ ok: false, error: 'TTS_NOT_CONFIGURED', message: 'TTS 服务未配置（BAMBOOK_MELO_URL 缺失）' });
        }
        if (message.startsWith(MELO_CIRCUIT_OPEN_ERROR)) {
          return res.status(503).json({ ok: false, error: 'TTS_UNAVAILABLE', message: 'TTS 服务暂不可用（熔断冷却中），请稍后重试' });
        }
        return res.status(502).json({ ok: false, error: 'TTS_FAILED', message: failure });
      }
      res.destroy(error);
      return;
    } finally {
      if (!res.destroyed) res.end();
    }
  });

  return router;
}

function normalizeChatTtsOptions(value: unknown): AiChatRequest['tts'] {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!raw || raw.enabled !== true) return { enabled: false };
  const speed = typeof raw.speed === 'number' && Number.isFinite(raw.speed)
    ? Math.min(1.35, Math.max(0.7, raw.speed))
    : 1;
  return {
    enabled: true,
    voice: typeof raw.voice === 'string' && raw.voice.trim() ? raw.voice.trim() : 'melo',
    speed,
  };
}

function createBackendTtsEventStream(options: {
  enabled: boolean;
  tts?: AiChatRequest['tts'];
  signal: AbortSignal;
  emit: AiEmit;
  synthesize: TtsSynthesizer;
}) {
  let buffer = '';
  let nextSegmentId = 0;
  let queue = Promise.resolve();
  let firstDeltaServerAt = 0;
  let firstTtsSegmentQueued = false;
  let firstSegmentTimer: ReturnType<typeof setTimeout> | null = null;
  // 批次 2c：TTS 分片失败提示只发一次——melo 不可用时熔断会快速失败，
  // 若每段都 emit step 提示会刷屏；首次失败告知"已降级为纯文本"，后续静默。
  let ttsFailureNotified = false;
  const pending: Array<Promise<void>> = [];

  const clearFirstSegmentTimer = () => {
    if (firstSegmentTimer) {
      clearTimeout(firstSegmentTimer);
      firstSegmentTimer = null;
    }
  };

  const enqueue = (text: string, strategy = 'steady') => {
    const input = cleanTtsText(text);
    if (!options.enabled || !input || options.signal.aborted) return;
    const segmentId = nextSegmentId++;
    if (segmentId === 0) {
      firstTtsSegmentQueued = true;
      clearFirstSegmentTimer();
    }
    const queuedAt = Date.now();
    const task = queue.then(async () => {
      const synthesisStartAt = Date.now();
      const result = await options.synthesize({
        input,
        voice: options.tts?.voice || 'default',
        rate: speedToRate(options.tts?.speed),
      }, options.signal);
      if (options.signal.aborted) return;
      const chunkServerAt = Date.now();
      const synthMs = Number(result.serviceElapsedMs || 0) || chunkServerAt - synthesisStartAt;
      options.emit('tts_chunk', {
        segmentId,
        text: input,
        audioBase64: result.audio.toString('base64'),
        contentType: result.contentType,
        engine: result.engine,
        language: result.language || '',
        elapsedMs: synthMs,
        ttsDebug: {
          segmentId,
          strategy,
          chars: input.length,
          firstDeltaServerAt,
          queuedAt,
          synthesisStartAt,
          chunkServerAt,
          queuedToSynthesisStartMs: synthesisStartAt - queuedAt,
          synthesisMs: synthMs,
          firstDeltaToSynthesisStartMs: firstDeltaServerAt ? synthesisStartAt - firstDeltaServerAt : null,
          firstDeltaToChunkServerMs: firstDeltaServerAt ? chunkServerAt - firstDeltaServerAt : null,
        },
      });
    }).catch(error => {
      if (options.signal.aborted) return;
      if (ttsFailureNotified) return; // 一次性提示，后续分片静默降级
      ttsFailureNotified = true;
      const failure = publicAgentFailure(error);
      logAgentFailure('[ai-chat] TTS synthesis failed', error);
      options.emit('step', { message: `TTS 分片生成失败，本次回复已降级为纯文本：${failure}` });
    });
    queue = task.then(() => undefined, () => undefined);
    pending.push(task);
  };

  const scheduleFirstSegmentTimer = () => {
    if (firstSegmentTimer || firstTtsSegmentQueued) return;
    firstSegmentTimer = setTimeout(() => {
      firstSegmentTimer = null;
      if (firstTtsSegmentQueued || options.signal.aborted) return;
      const safeText = getCompleteTtsAnnotationPrefix(buffer);
      const clean = cleanTtsText(safeText);
      if (clean.length < FIRST_TTS_TIMER_MIN_CHARS) {
        scheduleFirstSegmentTimer();
        return;
      }
      if (hasTtsAnnotationSyntax(safeText)) {
        enqueue(safeText, 'short-first-timeout');
        buffer = buffer.slice(safeText.length).trim();
        return;
      }
      const cut = Math.min(clean.length, FIRST_TTS_FORCE_CHARS);
      enqueue(clean.slice(0, cut), 'short-first-timeout');
      buffer = clean.slice(cut).trim();
    }, FIRST_TTS_TIMEOUT_MS);
  };

  return {
    accept(type: AiEventType, payload: Record<string, unknown>) {
      if (!options.enabled || type !== 'delta') return;
      const displayText = typeof payload.text === 'string' ? payload.text : '';
      const text = typeof payload.ttsText === 'string' ? payload.ttsText : displayText;
      if (!text) return;
      if (!firstDeltaServerAt) {
        firstDeltaServerAt = Date.now();
        scheduleFirstSegmentTimer();
      }
      buffer += text;
      const segments = takeReadyTtsSegments(buffer, false, !firstTtsSegmentQueued);
      buffer = segments.remaining;
      segments.ready.forEach(segment => enqueue(segment.text, segment.strategy));
    },
    async finish() {
      if (!options.enabled) return;
      clearFirstSegmentTimer();
      const text = buffer;
      buffer = '';
      if (cleanTtsText(text)) enqueue(text, firstTtsSegmentQueued ? 'steady-final' : 'short-first-final');
      await Promise.allSettled(pending);
      await queue;
    },
    async cancel() {
      clearFirstSegmentTimer();
      buffer = '';
      await Promise.allSettled(pending);
    },
  };
}

const FIRST_TTS_MIN_CHARS = 36;
const FIRST_TTS_FORCE_CHARS = 64;
const FIRST_TTS_SENTENCE_MIN_CHARS = 18;
const FIRST_TTS_TIMER_MIN_CHARS = 18;
const FIRST_TTS_TIMEOUT_MS = 1000;
// 稳态阶段的切分上下限：下限 88 让短句被合并而不是逐句切片，
// 上限 240 给古诗（七言律诗 64 字、含标点 80 字）、长句、列表项留空间。
const STEADY_TTS_MIN_CHARS = 88;
const STEADY_TTS_FORCE_CHARS = 240;

function takeReadyTtsSegments(text: string, flush: boolean, isFirstSegment = false) {
  const scanText = flush ? text : getCompleteTtsAnnotationPrefix(text);
  const protectedRemainder = text.slice(scanText.length);
  const clean = cleanTtsText(scanText);
  if (!clean) return { ready: [], remaining: text };
  const ready: Array<{ text: string; strategy: string }> = [];
  let cursor = 0;
  const boundary = /[。！？.!?]/g;
  const minChunkChars = isFirstSegment ? FIRST_TTS_MIN_CHARS : STEADY_TTS_MIN_CHARS;
  const forceChunkChars = isFirstSegment ? FIRST_TTS_FORCE_CHARS : STEADY_TTS_FORCE_CHARS;
  const sentenceMinChars = isFirstSegment ? FIRST_TTS_SENTENCE_MIN_CHARS : minChunkChars;
  const strategy = isFirstSegment ? 'short-first' : 'steady';
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(scanText)) !== null) {
    const end = match.index + match[0].length;
    const candidate = scanText.slice(cursor, end).trim();
    if (cleanTtsText(candidate).length >= sentenceMinChars) {
      ready.push({ text: candidate, strategy });
      cursor = end;
      if (isFirstSegment) break;
    }
  }
  const remaining = scanText.slice(cursor).trim();
  if (!flush && !hasTtsAnnotationSyntax(remaining) && cleanTtsText(remaining).length >= forceChunkChars) {
    const cut = findTtsChunkCut(remaining, minChunkChars, forceChunkChars);
    ready.push({ text: remaining.slice(0, cut).trim(), strategy: isFirstSegment ? 'short-first-force' : 'steady-force' });
    return { ready, remaining: joinTtsRemainder(remaining.slice(cut).trim(), protectedRemainder) };
  }
  if (flush && remaining) ready.push({ text: remaining, strategy: isFirstSegment ? 'short-first-final' : 'steady-final' });
  return { ready, remaining: flush ? '' : joinTtsRemainder(remaining, protectedRemainder) };
}

function findTtsChunkCut(text: string, minChars: number, maxChars: number) {
  const window = text.slice(minChars, maxChars);
  const punctuationIndex = Math.max(
    window.lastIndexOf('，'),
    window.lastIndexOf('、'),
    window.lastIndexOf('；'),
    window.lastIndexOf('：'),
    window.lastIndexOf(','),
    window.lastIndexOf(';'),
    window.lastIndexOf(':'),
    window.lastIndexOf(' '),
  );
  return punctuationIndex >= 0 ? minChars + punctuationIndex + 1 : maxChars;
}

function cleanTtsText(text: string) {
  return normalizeTextForTts(text);
}

function getCompleteTtsAnnotationPrefix(text: string) {
  const partialTagStart = findPartialTtsTagStart(text);
  const scanEnd = partialTagStart >= 0 ? partialTagStart : text.length;
  const scan = text.slice(0, scanEnd);
  const tagPattern = /<\/?tts\b[^>]*>/gi;
  const openStack: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(scan)) !== null) {
    if (/^<\//.test(match[0])) {
      openStack.pop();
    } else {
      openStack.push(match.index);
    }
  }
  if (openStack.length) {
    return text.slice(0, openStack[0]);
  }
  return scan;
}

function findPartialTtsTagStart(text: string) {
  const open = text.lastIndexOf('<');
  if (open < 0 || text.indexOf('>', open) >= 0) return -1;
  const rest = text.slice(open);
  return /^<\/?t?t?s?/i.test(rest) ? open : -1;
}

function hasTtsAnnotationSyntax(text: string) {
  return /<\/?tts\b/i.test(text);
}

function joinTtsRemainder(remaining: string, protectedRemainder: string) {
  if (!remaining) return protectedRemainder.trimStart();
  if (!protectedRemainder) return remaining.trim();
  return `${remaining}${protectedRemainder}`;
}

function clientVisiblePayload(type: AiEventType, payload: Record<string, unknown>) {
  if (type !== 'delta' || !('ttsText' in payload)) return payload;
  const { ttsText: _ttsText, ...visiblePayload } = payload;
  return visiblePayload;
}

function speedToRate(speed?: number) {
  const safeSpeed = typeof speed === 'number' && Number.isFinite(speed) ? speed : 1;
  const pct = Math.round((safeSpeed - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function auth(options: AuthOptions) {
  // Delegate to the shared module guard (enhanced to support Agent strict-principal
  // mapping via apiKeyActors and explicit dev-actor construction via devActorFactory).
  // This unifies ai module auth with the other 12 modules without weakening the
  // "API key is a transport credential, not an identity" model.
  //
  // Strict mode is always enforced for ai: an absent apiKeyActors map is treated as
  // an empty map (no key is ever mapped to a principal), preserving the original
  // behavior where an unmapped key is rejected with AGENT_PRINCIPAL_REQUIRED.
  return createModuleAuthGuard({
    ...options,
    apiKeyActors: options.apiKeyActors ?? new Map<string, TokenPayload>(),
    devActorFactory: buildDevelopmentActor,
  });
}

function buildDevelopmentActor(req: Request): TokenPayload {
  const requestedRoles = Array.isArray(req.body?.roles) ? req.body.roles.map(String) : [];
  const roles = requestedRoles.length ? requestedRoles : ['owner'];
  const departmentIds = Array.isArray(req.body?.departmentIds) && req.body.departmentIds.length
    ? req.body.departmentIds.map(String)
    : ['company'];
  return {
    userId: String(req.body?.userId || req.headers['x-bambook-user-id'] || 'local-dev-agent'),
    displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : 'Local Development Agent',
    roles: roles as TokenPayload['roles'],
    permissions: [],
    departmentIds,
  };
}

function setupSse(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function sendSse(res: Response, event: AiEventType, payload: Record<string, unknown>) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
