import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import { createMistRouter } from './route';
import {createMistLocalRuntime,mistLocalRequested,assertMistLocalMode,type MistLocalRuntime} from './local';
import {MistRepository,type MistContract} from './repository';
import {MistPrivateFiles} from './files';
import * as mistContract from '../shared/mistWorkspace';
export function createMistServer(prisma?: any,options:{local?:MistLocalRuntime;host?:string}={}) {
  const app = express(); app.disable('x-powered-by');
  const host=options.host??process.env.MIST_HOST??'127.0.0.1';
  const local=options.local??(mistLocalRequested()?createMistLocalRuntime({host}):undefined);
  if(local)assertMistLocalMode(host);
  const configured = new Set((local?'':process.env.MIST_CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
  app.use(cors({ credentials: true, origin(origin, callback) {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) || configured.has(origin)) callback(null, true);
    else callback(null, false);
  } }));
  app.use(express.json({ limit: '4mb' })); app.use(cookieParser());
  app.get('/api/health', async (_req, res) => {
    try { if(local){await local.ready;await local.database.health();res.json({status:'ok',service:'mist-workspace',mode:'local',storage:'local-file'});return;}await prisma.$queryRawUnsafe('SELECT 1'); res.json({ status: 'ok', service: 'mist-workspace', database: 'ok' }); }
    catch { res.status(503).json(local?{status:'error',service:'mist-workspace',mode:'local',storage:'unavailable'}:{ status: 'error', service: 'mist-workspace', database: 'unavailable' }); }
  });
  if(local){
    app.locals.mistLocal=local;
    app.get('/api/mist/session',local.sessionGet);app.post('/api/mist/session',local.sessionPost);
    const repository=new MistRepository(local.database,mistContract as MistContract,new MistPrivateFiles(path.join(local.database.directory,'files')),local.authorize);
    app.use('/api/mist',createMistRouter({repository,authenticate:local.authenticate}));
  }else{
    if(!prisma)throw new Error('Mist server requires an explicit database outside local mode');
    const {createAuthRouter}=require('../auth/route') as typeof import('../auth/route');
    const {createDbVerificationStore}=require('../auth/verificationDb') as typeof import('../auth/verificationDb');
    const {createEmailService}=require('../auth/email') as typeof import('../auth/email');
    const requireEmailVerification = process.env.AUTH_REQUIRE_EMAIL_VERIFY ? !/^(0|false|no)$/i.test(process.env.AUTH_REQUIRE_EMAIL_VERIFY.trim()) : true;
    app.use('/api/auth', createAuthRouter({ prisma, email: createEmailService(), verification: createDbVerificationStore({ prisma }), requireEmailVerification }));
    // The local-identity session exists only in local mode. Answer 404 before authentication so the web app
    // detects server-account mode and shows sign-in (a 401 here made it fall back to the local-workspace screen).
    app.all('/api/mist/session', (_req, res) => { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Local workspace session is not available on this server' } }); });
    app.use('/api/mist', createMistRouter({ prisma,contract:mistContract as MistContract, filesRoot: process.env.MIST_FILES_DIR || path.resolve(__dirname, '../../private/mist-files') }));
  }
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = error?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ ok: false, error: { code: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST', message: tooLarge ? '请求超过大小限制' : '请求格式无效' } });
  });
  return app;
}
