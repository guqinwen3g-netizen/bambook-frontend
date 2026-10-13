export type AiLaneName = 'model' | 'search' | 'heavy';

export type AiEventType =
  | 'queued'
  | 'step'
  | 'agent_event'
  | 'delta'
  | 'tts_chunk'
  | 'final'
  | 'error'
  | 'heartbeat'
  | 'block_start'
  | 'block_delta'
  | 'block_patch'
  | 'block_end'
  | 'block_error';

export type AiEmit = (type: AiEventType, payload: Record<string, unknown>) => void;

export type AiChatRequest = {
  sessionId: string;
  userId: string;
  runtimeRunId?: string;
  actorUserId?: string;
  requestSource?: 'user-session' | 'api-key' | 'dev';
  displayName?: string;
  roles?: Array<string>;
  departmentIds?: Array<string>;
  roleIds?: string[];
  permissions?: string[];
  authorizationLoaded?: true;
  message: string;
  history?: Array<{ role: string; content?: string; text?: string }>;
  attachments?: Array<{ name: string; mimeType?: string; data?: string }>;
  model?: string;
  temperature?: number;
  tts?: {
    enabled?: boolean;
    voice?: string;
    speed?: number;
  };
  signal?: AbortSignal;
  emit?: AiEmit;
};

export type AiChatResult = {
  text: string;
  sources?: Array<Record<string, unknown>>;
  thoughtProcess?: string;
};

export type AiChatRunner = (request: AiChatRequest & { signal: AbortSignal; emit: AiEmit }) => Promise<AiChatResult>;

type QueueItem<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class Semaphore {
  private running = 0;
  private queued = 0;
  private completed = 0;
  private failed = 0;
  private queue: Array<QueueItem<unknown>> = [];

  constructor(public readonly name: AiLaneName | string, public readonly limit: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    this.queued++;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve: resolve as (value: unknown) => void, reject });
      this.drain();
    });
  }

  snapshot() {
    return {
      name: this.name,
      limit: this.limit,
      running: this.running,
      queued: this.queued,
      completed: this.completed,
      failed: this.failed,
    };
  }

  private drain() {
    while (this.running < this.limit && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
      this.queued--;
      this.running++;
      item.task()
        .then(value => {
          this.completed++;
          this.running--;
          item.resolve(value);
          this.drain();
        })
        .catch(error => {
          this.failed++;
          this.running--;
          item.reject(error);
          this.drain();
        });
    }
  }
}

type RuntimeOptions = {
  modelConcurrency?: number;
  searchConcurrency?: number;
  heavyConcurrency?: number;
  chatTimeoutMs?: number;
  chatRunner?: AiChatRunner;
};

type ActiveRun = {
  controller: AbortController;
  startedAt: number;
};

export function createAiRuntime(options: RuntimeOptions = {}) {
  const lanes = {
    model: new Semaphore('model', options.modelConcurrency ?? 3),
    search: new Semaphore('search', options.searchConcurrency ?? 6),
    heavy: new Semaphore('heavy', options.heavyConcurrency ?? 1),
  };
  const activeRuns = new Map<string, ActiveRun>();
  const chatTimeoutMs = options.chatTimeoutMs ?? 90_000;
  const chatRunner = options.chatRunner ?? defaultMissingRunner;
  const startedAt = Date.now();
  let totalRuns = 0;
  let cancelledRuns = 0;
  let totalLatencyMs = 0;
  let lastError: string | null = null;

  async function runChat(request: AiChatRequest): Promise<AiChatResult> {
    const previous = activeRuns.get(request.sessionId);
    if (previous) {
      cancelledRuns++;
      previous.controller.abort('superseded');
    }

    const controller = new AbortController();
    const removeExternalAbort = bindAbort(request.signal, controller);
    activeRuns.set(request.sessionId, { controller, startedAt: Date.now() });
    const started = Date.now();
    const emit = request.emit || (() => undefined);
    emit('queued', { lane: 'model', sessionId: request.sessionId });

    const timeout = setTimeout(() => controller.abort(), chatTimeoutMs);
    try {
      const result = await lanes.model.run(() => chatRunner({ ...request, signal: controller.signal, emit }));
      totalRuns++;
      totalLatencyMs += Date.now() - started;
      return result;
    } catch (error: any) {
      lastError = String(error?.message || error);
      throw error;
    } finally {
      clearTimeout(timeout);
      removeExternalAbort();
      if (activeRuns.get(request.sessionId)?.controller === controller) {
        activeRuns.delete(request.sessionId);
      }
    }
  }

  function runSearch<T>(task: () => Promise<T>) {
    return lanes.search.run(task);
  }

  function runHeavyTask<T>(task: () => Promise<T>) {
    return lanes.heavy.run(task);
  }

  function getMetrics() {
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      activeSessions: activeRuns.size,
      totalRuns,
      cancelledRuns,
      averageLatencyMs: totalRuns ? Math.round(totalLatencyMs / totalRuns) : 0,
      lastError,
      lanes: {
        model: lanes.model.snapshot(),
        search: lanes.search.snapshot(),
        heavy: lanes.heavy.snapshot(),
      },
    };
  }

  return { runChat, runSearch, runHeavyTask, getMetrics, lanes };
}

function bindAbort(external: AbortSignal | undefined, controller: AbortController) {
  if (!external) return () => undefined;
  const abort = () => controller.abort();
  if (external.aborted) abort();
  external.addEventListener('abort', abort);
  return () => external.removeEventListener('abort', abort);
}

async function defaultMissingRunner(): Promise<AiChatResult> {
  throw new Error('AI chat runner is not configured');
}
