import {beforeEach,expect,it,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../../auth/moduleGuard',()=>({createModuleAuthGuard:()=> (_req:any,_res:any,next:any)=>next()}));
vi.mock('../../orders/orderService',()=>({buildOrderListScopeWhere:vi.fn()}));
vi.mock('../dashboardService',()=>({getBusinessCockpit:vi.fn(async()=>({safe:true}))}));
vi.mock('../sensitiveMask',()=>({maskBusinessCockpit:vi.fn((value:any)=>value)}));
import {buildOrderListScopeWhere} from '../../orders/orderService';
import {getBusinessCockpit} from '../dashboardService';
import {createDashboardRouter} from '../route';
function app(){const a=express();a.use((req:any,_res,next)=>{req.actor={userId:'u',roles:[],permissions:['cockpit:read']};next();});a.use(createDashboardRouter({prisma:{} as any,requireAuth:true,apiKeys:new Set()}));return a;}
beforeEach(()=>vi.clearAllMocks());
it('scope解析失败不调用业务聚合，也不泄露底层错误',async()=>{
 vi.mocked(buildOrderListScopeWhere).mockRejectedValue(new Error('secret database error'));
 const response=await request(app()).get('/cockpit');
 expect(response.status).toBe(500);expect(response.body.error.code).toBe('COCKPIT_FAILED');expect(response.body.error.message).not.toContain('secret');expect(getBusinessCockpit).not.toHaveBeenCalled();
});
it('正常限制范围原样传递，正常全权空范围仍有效',async()=>{
 for(const scope of [{id:{in:['OWN']}},{}]) {
  vi.mocked(buildOrderListScopeWhere).mockResolvedValue(scope);
  const response=await request(app()).get('/cockpit?from=2026-09-01&marginRowLimit=5');
  expect(response.status).toBe(200);expect(getBusinessCockpit).toHaveBeenLastCalledWith({},expect.objectContaining({orderScopeWhere:scope,from:'2026-09-01',marginRowLimit:5}));
 }
});
