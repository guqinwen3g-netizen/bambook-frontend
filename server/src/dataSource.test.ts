import { describe, expect, it, vi } from 'vitest';
import { describeRuntimeDataSource } from './dataSource';

describe('describeRuntimeDataSource', () => {
  it('marks localhost databases as local-dev in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    const source = describeRuntimeDataSource('postgresql://bambook:bambook@localhost:5432/panda_hub_local?schema=public');

    expect(source).toMatchObject({
      kind: 'local-dev',
      runtimeEnv: 'development',
      host: 'localhost',
      name: 'panda_hub_local',
      isBusinessTruth: false,
    });
  });

  it('does not misclassify production runtimes whose database is local to the server', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const source = describeRuntimeDataSource('postgresql://bambook:bambook@localhost:5432/panda_hub_local?schema=public');

    expect(source).toMatchObject({
      kind: 'production',
      runtimeEnv: 'production',
      host: 'localhost',
      name: 'panda_hub_local',
      isBusinessTruth: true,
    });
    expect(source.warning).toBeUndefined();
  });
});
