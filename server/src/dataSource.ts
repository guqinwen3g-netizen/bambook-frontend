export type RuntimeDataSource = {
  kind: 'production' | 'local-dev' | 'unknown';
  runtimeEnv: string;
  database: string;
  host: string;
  name: string;
  isBusinessTruth: boolean;
  warning?: string;
};

export function describeRuntimeDataSource(databaseUrl = process.env.DATABASE_URL || ''): RuntimeDataSource {
  const runtimeEnv = process.env.BAMBOOK_DATA_SOURCE_KIND || process.env.NODE_ENV || 'development';
  const forcedProduction = runtimeEnv === 'production';
  const forcedLocalDev = runtimeEnv === 'local-dev' || runtimeEnv === 'development' || runtimeEnv === 'test';

  if (!databaseUrl.trim()) {
    return {
      kind: 'unknown',
      runtimeEnv,
      database: 'postgres',
      host: 'unknown',
      name: 'unknown',
      isBusinessTruth: false,
      warning: 'DATABASE_URL is not configured; this runtime cannot be treated as Bambook business truth.',
    };
  }

  try {
    const url = new URL(databaseUrl);
    const host = url.hostname || 'unknown';
    const name = decodeURIComponent(url.pathname.replace(/^\//, '') || 'unknown');
    const localHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host.toLowerCase());
    const localName = /local|dev|test/i.test(name);
    const isLocalDev = !forcedProduction && (forcedLocalDev || localHost || localName);

    return {
      kind: isLocalDev ? 'local-dev' : 'production',
      runtimeEnv,
      database: url.protocol.replace(':', '') || 'postgres',
      host,
      name,
      isBusinessTruth: !isLocalDev,
      warning: isLocalDev
        ? 'Local development database only. Do not use this runtime as Bambook business/account truth.'
        : undefined,
    };
  } catch {
    return {
      kind: 'unknown',
      runtimeEnv,
      database: 'postgres',
      host: 'unparseable',
      name: 'unparseable',
      isBusinessTruth: false,
      warning: 'DATABASE_URL is not parseable; this runtime cannot be treated as Bambook business truth.',
    };
  }
}
