import path from 'node:path';
import dotenv from 'dotenv';
// Load the existing server configuration before importing auth or Prisma.
const root = path.resolve(__dirname, '../..');
const explicitRuntime=Object.fromEntries(['NODE_ENV','MIST_LOCAL_WORKSPACE','MIST_HOST','MIST_PORT'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));
dotenv.config({ path: path.join(root, '.env.local'), override: true });
dotenv.config({ path: path.join(root, '.env') });
Object.assign(process.env,explicitRuntime);
async function main() {
  const {mistLocalRequested,assertMistLocalMode}=await import('./local');
  const { createMistServer } = await import('./server');
  const port = Number(process.env.MIST_PORT || 8082);
  const host=process.env.MIST_HOST||'127.0.0.1';
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MIST_PORT');
  let disconnect:()=>Promise<unknown>,app:ReturnType<typeof createMistServer>;
  if(mistLocalRequested()){
    assertMistLocalMode(host);app=createMistServer(undefined,{host});await app.locals.mistLocal.ready;
    disconnect=()=>app.locals.mistLocal.database.$disconnect();
  }else{
    const {PrismaClient}=await import('@prisma/client');const prisma=new PrismaClient();
    app=createMistServer(prisma,{host});disconnect=()=>prisma.$disconnect();
  }
  const server = app.listen(port, host, () => { console.log(`[mist] ${mistLocalRequested()?'local-file workspace':'workspace server'} listening on ${host}:${port}`); });
  const stop = () => server.close(() => { void disconnect().finally(() => process.exit(0)); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch(() => { console.error('[mist] startup failed; check the local server configuration'); process.exitCode = 1; });
