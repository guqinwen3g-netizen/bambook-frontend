import { describe, expect, it, vi } from 'vitest';
import { createAiRuntime, Semaphore } from './runtime';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('AI runtime concurrency', () => {
  it('limits concurrent model runs', async () => {
    const runtime = createAiRuntime({
      modelConcurrency: 1,
      chatRunner: async () => {
        await wait(20);
        return { text: 'ok' };
      },
    });

    const first = runtime.runChat({ sessionId: 's1', userId: 'u1', message: 'one' });
    const second = runtime.runChat({ sessionId: 's2', userId: 'u2', message: 'two' });

    await wait(5);
    expect(runtime.getMetrics().lanes.model.running).toBe(1);
    expect(runtime.getMetrics().lanes.model.queued).toBe(1);

    await Promise.all([first, second]);
    expect(runtime.getMetrics().lanes.model.completed).toBe(2);
  });

  it('aborts the previous active run for the same session', async () => {
    const runtime = createAiRuntime({
      modelConcurrency: 2,
      chatRunner: async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted by test'));
          });
        });
        return { text: 'late' };
      },
    });

    const first = runtime.runChat({ sessionId: 'same', userId: 'u1', message: 'one' });
    await wait(5);
    const second = runtime.runChat({ sessionId: 'same', userId: 'u1', message: 'two' });

    await expect(first).rejects.toThrow('aborted');
    await expect(second).resolves.toMatchObject({ text: 'late' });
  });

  it('keeps heavy lane separate from chat model lane', async () => {
    const runtime = createAiRuntime({
      modelConcurrency: 1,
      heavyConcurrency: 1,
      chatRunner: async () => ({ text: 'chat' }),
    });

    const heavy = runtime.runHeavyTask(async () => {
      await wait(25);
      return 'indexed';
    });
    const chat = runtime.runChat({ sessionId: 's1', userId: 'u1', message: 'hello' });

    await expect(chat).resolves.toMatchObject({ text: 'chat' });
    await expect(heavy).resolves.toBe('indexed');
    expect(runtime.getMetrics().lanes.heavy.completed).toBe(1);
    expect(runtime.getMetrics().lanes.model.completed).toBe(1);
  });

  it('tracks semaphore queue and completion metrics', async () => {
    const semaphore = new Semaphore('search', 1);
    const work = vi.fn(async () => {
      await wait(10);
      return 'done';
    });

    const first = semaphore.run(work);
    const second = semaphore.run(work);
    expect(semaphore.snapshot()).toMatchObject({ running: 1, queued: 1 });

    await Promise.all([first, second]);
    expect(semaphore.snapshot()).toMatchObject({ running: 0, queued: 0, completed: 2, failed: 0 });
  });
});
