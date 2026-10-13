import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../../auth/permissionGuard',()=>({requirePermission:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../developmentFactoryNoticeService',()=>({factoryNoticeContext:vi.fn(),saveFactoryNotice:vi.fn(),uploadFactoryFile:vi.fn(),readFactoryNotice:vi.fn(async(_ctx,_case,_id,zip)=>({bytes:Buffer.from(zip?'zip-originals':'notice-only'),name:zip?'附件包.zip':'通知单.html',mimeType:zip?'application/zip':'text/html'})),readFactoryOriginal:vi.fn(async()=>({file:{originalName:'尺寸.xlsx',previewSupported:false},bytes:Buffer.from('excel')}))}));
import { createDevelopmentFactoryNoticeRouter } from '../developmentFactoryNoticeRoute';
import { readFactoryNotice } from '../developmentFactoryNoticeService';
function app(session=true){const app=express();app.use(express.json());app.use((req:any,_res,next)=>{if(session){req.actor={userId:'actor'};req.authSource='user-session';}next();});app.use(createDevelopmentFactoryNoticeRouter({prisma:{}}));return app;}
describe('factory notice download routes',()=>{
 it('rejects missing session before historical file download',async()=>{expect((await request(app(false)).get('/case/factory-notices/notice/notice')).status).toBe(401);});
 it('keeps notice and ZIP separate and private',async()=>{const notice=await request(app()).get('/case/factory-notices/saved/notice');expect(notice.status).toBe(200);expect(notice.text).toBe('notice-only');expect(notice.headers['cache-control']).toBe('private, no-store');const zip=await request(app()).get('/case/factory-notices/saved/attachments.zip');expect(zip.status).toBe(200);expect(zip.headers['content-type']).toContain('application/zip');expect(readFactoryNotice).toHaveBeenLastCalledWith(expect.anything(),'case','saved',true);});
 it('never renders Office files inline',async()=>{const unsupported=await request(app()).get('/case/factory-notice-files/file?kind=version&targetId=version&preview=1');expect(unsupported.status).toBe(400);expect(unsupported.body.error.code).toBe('PREVIEW_UNSUPPORTED');const download=await request(app()).get('/case/factory-notice-files/file?kind=version&targetId=version');expect(download.status).toBe(200);expect(download.headers['content-disposition']).toContain('attachment');expect(download.headers['x-content-type-options']).toBe('nosniff');});
});
