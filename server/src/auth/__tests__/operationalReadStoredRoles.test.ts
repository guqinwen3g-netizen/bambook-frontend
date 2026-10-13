/** Actual JWT/module/routes and current stored L2; storage comes from the
 * original operational fixture factory without importing its test callbacks.
 * A legacy credential role is never a current stored-role assignment. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../service';
import { createInventoryRouter } from '../../inventory/inventoryRoute';
import { SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';

function originalStoredFixture() {
  const source = fs.readFileSync(path.join(__dirname, 'operationalReadBoundaries.test.ts'), 'utf8');
  const ast = ts.createSourceFile('operationalReadBoundaries.test.ts', source, ts.ScriptTarget.Latest, true);
  const factories = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'storage');
  if (factories.length !== 1) throw new Error('Actual independent stored fixture factory missing');
  const declaration = (name: string) => {
    const declarations = ast.statements.filter(node => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(item => item.name.getText(ast) === name));
    if (declarations.length !== 1) throw new Error(`Actual fixture declaration missing: ${name}`);
    return declarations[0].getText(ast);
  };
  const input = ['USER', 'readScopes', 'actor'].map(declaration).join('\n') + '\n' + factories[0].getText(ast)
    + '\n({ make: storage, subject: actor, userId: USER, scopes: readScopes });';
  const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const factory = vm.runInNewContext(compiled, { Prisma, vi }, { timeout: 1000 });
  return { ...factory, db: factory.make() };
}

const auth = createAuthService();
describe('current stored Sales remains bounded under legacy credential role claims', () => {
  it.each(['owner', 'finance'] as const)('%s JWT cannot assign a stored business-wide role', async legacy => {
    const fixture = originalStoredFixture(), { db } = fixture;
    expect(db.state.userAccount[0].roles[0].roleId).toBe(SYSTEM_ROLE_IDS.SALES);
    expect(db.state.userAccount[0].roles[0].role.id).toBe(SYSTEM_ROLE_IDS.SALES);
    const stored = JSON.stringify(db.state.userAccount);
    const subject = legacy === 'owner'
      ? fixture.subject([], { roles: ['owner'], permissionCeiling: ['orders:read', 'inventory:read'] })
      : fixture.subject(fixture.scopes, { roles: ['finance'] });
    if (legacy === 'finance') db.state.sampleColorBatch = [{ id: 'general-lab', stage: 'lab_dip', developmentCaseId: 'case-general',
      orderId: null, dyeLotNo: 'LOT-LAB', colorRating: 4, deletedAt: null, createdAt: BigInt(1) }];
    const app = express(); app.use(express.json());
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
    app.use('/inventory', createInventoryRouter({ prisma: db.prisma, requireAuth: true, apiKeys: new Set() }));
    const response = await request(app).get(legacy === 'owner' ? '/inventory/items' : '/inventory/dye-lot-stock')
      .set('Authorization', `Bearer ${auth.signToken(subject)}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    if (legacy === 'owner') {
      expect(response.body.items.map((row: any) => row.id).sort()).toEqual(['item-general', 'item-own']);
    } else {
      expect(response.body.lots.find((row: any) => row.lot === 'LOT-LAB')).toMatchObject({ registered: false, colorRating: null });
    }
    expect(JSON.stringify(db.state.userAccount)).toBe(stored);
    expect(db.prisma.userAccount.findUnique.mock.calls.length).toBeGreaterThan(0);
    expect(db.prisma.userAccount.findUnique.mock.calls.every((args: any[]) => args[0].where.id === fixture.userId)).toBe(true);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    for (const model of Object.keys(db.state)) for (const method of ['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'])
      expect(db.prisma[model][method], `${model}.${method}`).not.toHaveBeenCalled();
  });
});
