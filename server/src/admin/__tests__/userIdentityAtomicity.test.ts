import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../route';
import { createAuthService } from '../../auth/service';
const token = createAuthService().signToken({ userId:'owner', roles:['owner'], permissions:['users:write'], departmentIds:[] });
function fixture() {
 const tx = { $queryRaw: vi.fn().mockResolvedValue([]), userAccount: { findUnique: vi.fn().mockResolvedValue({ id:'pending',status:'pending' }), create: vi.fn().mockResolvedValue({ id:'new' }), update: vi.fn().mockResolvedValue({id:'pending'}) }, userRole: { deleteMany: vi.fn(), create: vi.fn() } };
 const prisma:any = { userAccount: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue({ id:'pending',status:'pending',email:null }) }, role: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) }, department: { findUnique: vi.fn().mockResolvedValue({id:'dept',parentId:'company',status:'active'}) }, auditLog: { create:vi.fn() }, $transaction:vi.fn(async (fn:any)=>fn(tx)) };
 const app=express(); app.use(express.json());app.use('/admin',createAdminRouter({prisma}));return {app,prisma,tx};
}
describe('account creation and approval atomicity',()=>{
 it.each(['/users','/users/pending/approve'])('invalid role never activates or creates an account at %s',async path=>{
  const f=fixture();const response=await request(f.app).post(`/admin${path}`).set('Authorization',`Bearer ${token}`).send({ displayName:'New',email:'new@example.com',password:'safe-test-only',roles:['missing-role'],departmentId:'dept' });
  expect(response.status).toBe(400); expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.tx.userAccount.update).not.toHaveBeenCalled(); expect(f.tx.userAccount.create).not.toHaveBeenCalled();
 });
 it('valid creation persists identity and explicit role in the same transaction',async()=>{
  const f=fixture();f.prisma.role.findUnique.mockResolvedValue({id:'role-sales'});
  const response=await request(f.app).post('/admin/users').set('Authorization',`Bearer ${token}`).send({ displayName:'New',email:'new@example.com',password:'safe-test-only',roles:['role-sales'],departmentId:'dept' });
  expect(response.status).toBe(200);expect(f.prisma.$transaction).toHaveBeenCalledOnce();expect(f.tx.userAccount.create).toHaveBeenCalledOnce();expect(f.tx.userRole.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({ userId:'new',roleId:'role-sales' })}));
 });
 it('company root cannot be assigned as employment department',async()=>{
  const f=fixture();f.prisma.department.findUnique.mockResolvedValue({id:'company',parentId:null,status:'active'});
  expect((await request(f.app).post('/admin/users').set('Authorization',`Bearer ${token}`).send({displayName:'New',email:'new@example.com',password:'safe-test-only',departmentId:'company'})).status).toBe(400);
 });
});
