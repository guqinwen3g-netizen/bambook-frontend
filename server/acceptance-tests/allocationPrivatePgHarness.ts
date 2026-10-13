import { realpathSync } from 'node:fs';
import path from 'node:path';

const denied = () => new Error('Reviewed private allocation PG inputs are required');
const isPrivatePath = (value: string) => value.startsWith('/private/tmp/')
  || /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\//.test(value);

/** Test-only construction boundary; it never reads dotenv or guesses a URL. */
export function createPrivateAllocationClients<T>(
  Client: new (options: { datasources: { db: { url: string } } }) => T,
  env: NodeJS.ProcessEnv = process.env,
): readonly [T, T] {
  const { DATABASE_URL: url, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = env;
  let accepted: string;
  try {
    if (env.NODE_ENV !== 'test' || env.BAMBOOK_NO_SCHEDULER !== '1' || env.BAMBOOK_ACCEPTANCE_NO_DATABASE !== '0'
        || !url || !sandbox || !name || !directory || !port || !/^bambook_acceptance_[a-f0-9]+$/.test(name)
        || !/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535
        || !isPrivatePath(sandbox) || !isPrivatePath(directory)) throw denied();
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' || parsed.port !== port
        || parsed.username !== 'acceptance' || parsed.password !== '' || parsed.pathname !== `/${name}`
        || parsed.search !== '?schema=public') throw denied();
    const realSandbox = realpathSync(sandbox), realDirectory = realpathSync(directory);
    if (!isPrivatePath(realSandbox) || !isPrivatePath(realDirectory) || !/^bambook-/.test(path.basename(realSandbox))) throw denied();
    const privateNativeParent = path.dirname(realDirectory);
    const ownDatabase = realDirectory === path.join(realSandbox, 'postgres');
    const independentNativeDatabase = path.dirname(privateNativeParent) === '/private/tmp'
      && /^bambook-allocation-conflict-native-[a-f0-9]+$/.test(path.basename(privateNativeParent))
      && path.basename(realDirectory) === 'postgres';
    if (!ownDatabase && !independentNativeDatabase) throw denied();
    const guard = path.join(realSandbox, 'workspace', 'scripts', 'acceptance-network-guard.cjs');
    if (!env.NODE_OPTIONS?.split(/\s+/).includes(`--require=${guard}`)) throw denied();
    realpathSync(guard);
    accepted = parsed.href;
  } catch { throw denied(); }
  // Both actual native clients receive only the already-validated URL.
  return [new Client({ datasources: { db: { url: accepted } } }), new Client({ datasources: { db: { url: accepted } } })];
}
