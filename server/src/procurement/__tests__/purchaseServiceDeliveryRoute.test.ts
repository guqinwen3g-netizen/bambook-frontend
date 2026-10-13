import {beforeEach,describe,it,expect,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks=vi.hoisted(()=>({create:vi.fn(),list:vi.fn(),createPayableDraft:vi.fn(),scope:vi.fn()}));
vi.mock('../purchaseServiceDeliveryService',async(original)=>({...await original<any>(),createPurchaseServiceDeliveryService:()=>mocks}));
vi.mock('../../auth/orderVisibility',async(original)=>({...await original<any>(),resolveVisibleOrderIds:mocks.scope}));
import {createProcurementRouter} from '../procurementRoute';
import {authHeader} from '../../__tests__/authTestHelper';
import {PurchaseServiceDeliveryError} from '../purchaseServiceDeliveryService';
function app(){const a=express();a.use(express.json());a.use('/',createProcurementRouter({prisma:{} as any,requireAuth:false,apiKeys:new Set()}));return a;}
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue(['O']);});
describe('采购服务交付接口边界',()=>{
 it('新建与重放状态、BigInt序列化并传入真实可见范围',async()=>{
  mocks.create.mockResolvedValueOnce({delivery:{id:'D',createdAt:1n},replayed:false}).mockResolvedValueOnce({delivery:{id:'D',createdAt:1n},replayed:true});
  const a=app();const first=await request(a).post('/P/service-deliveries').set(authHeader()).send({requestKey:'K'});
  expect(first.status).toBe(201);expect(first.body.delivery.createdAt).toBe('1');expect(mocks.create).toHaveBeenCalledWith('P',{requestKey:'K'},'u_owner',['O']);
  expect((await request(a).post('/P/service-deliveries').set(authHeader()).send({requestKey:'K'})).status).toBe(200);
 });
 it('销售不能创建应付草稿，匿名不能登记交付',async()=>{
  const token=jwt.sign({userId:'sales',roles:['sales']},process.env.JWT_SECRET||'change-me-in-production-at-least-32-chars');
  expect((await request(app()).post('/service-deliveries/D/payable-draft').set(authHeader(token)).send({})).status).toBe(403);
  expect(mocks.createPayableDraft).not.toHaveBeenCalled();
  expect((await request(app()).post('/P/service-deliveries').send({})).status).toBe(401);expect(mocks.create).not.toHaveBeenCalled();
 });
 it('领域拒绝保持404且不泄露额外内容',async()=>{
  mocks.list.mockRejectedValue(new PurchaseServiceDeliveryError('NOT_FOUND','采购单不存在或不可见',404));
  const response=await request(app()).get('/P/service-deliveries').set(authHeader());expect(response.status).toBe(404);expect(response.body.code).toBe('NOT_FOUND');
 });
 it('应付草稿路由正确分派并传递范围',async()=>{
  mocks.createPayableDraft.mockResolvedValue({invoice:{id:'I',createdAt:2n},replayed:false});
  const response=await request(app()).post('/service-deliveries/D/payable-draft').set(authHeader()).send({});
  expect(response.status).toBe(201);expect(response.body.invoice.createdAt).toBe('2');expect(mocks.createPayableDraft).toHaveBeenCalledWith('D','u_owner',['O']);
 });
});
