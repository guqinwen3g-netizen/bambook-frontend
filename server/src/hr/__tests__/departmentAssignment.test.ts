import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createHRRouter } from '../route';

describe('department assignment boundary', () => {
  for (const resource of ['teams', 'positions']) {
    for (const method of ['post', 'patch'] as const) {
      for (const department of [null, { id: 'company', parentId: null, status: 'active' }, { id: 'closed', parentId: 'company', status: 'inactive' }]) {
        it(`${method} ${resource} rejects invalid department ${department?.id}`, async () => {
          const write = vi.fn();
          const prisma = {
            department: { findUnique: vi.fn().mockResolvedValue(department) },
            team: { create: write, update: write }, jobPosition: { create: write, update: write },
          };
          const app = express(); app.use(express.json());
          app.use('/hr', createHRRouter({ prisma: prisma as any, requireAuth: false }));
          const response = await request(app)[method](`/hr/${resource}${method === 'patch' ? '/existing' : ''}`)
            .send({ name: 'Test', title: 'Test', departmentId: department?.id ?? '' });
          expect(response.status).toBe(400);
          expect(write).not.toHaveBeenCalled();
        });
      }
    }
  }
});
