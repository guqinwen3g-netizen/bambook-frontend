import { describe, expect, it } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import { hasWorkflowDecisionScope, assertWorkflowDecisionScope, workflowReviewerMatches, assertWorkflowReviewer } from '../workflowAccess';

const actor = (permissions: string[], extra: Partial<TokenPayload> = {}): TokenPayload => ({ userId: 'finance-reviewer', roles: ['finance'], roleIds: ['role-finance'],
  permissions, departmentIds: [], authorizationLoaded: true, ...extra });

describe('explicit configured workflow step duties', () => {
  it.each(['role-finance', 'finance'])('Order %s uses both Order read and Invoice write without Order write', approverRole => {
    expect(hasWorkflowDecisionScope(actor(['orders:read', 'invoices:write']), 'Order', { approverRole })).toBe(true);
    for (const permissions of [['orders:read'], ['invoices:write'], ['orders:write']]) expect(hasWorkflowDecisionScope(actor(permissions), 'Order', { approverRole })).toBe(false);
    expect(() => assertWorkflowDecisionScope(actor(['orders:read']), 'Order', { approverRole })).toThrow('权限不足');
  });
  it('a finance actor cannot substitute Invoice permission for an ordinary or user-only Order step', () => {
    const current = actor(['orders:read', 'invoices:write']);
    expect(hasWorkflowDecisionScope(current, 'Order', { approverRole: 'role-sales-manager' })).toBe(false);
    expect(hasWorkflowDecisionScope(current, 'Order', {})).toBe(false);
    expect(hasWorkflowDecisionScope(actor(['orders:write'], { roleIds: [] }), 'Order', { approverRole: 'role-sales-manager' })).toBe(true);
    expect(hasWorkflowDecisionScope(current, 'Order', { approverRole: 'custom-role-named-finance' })).toBe(false);
  });
  it('specified user priority and ordinary self-approval prohibition remain independent of financial duties', () => {
    const step = { approverRole: 'role-finance', approverUserId: 'specified-finance' }, current = actor(['orders:read', 'invoices:write']);
    expect(hasWorkflowDecisionScope(current, 'Order', step)).toBe(true);
    expect(workflowReviewerMatches(current, step)).toBe(false);
    const specified = actor(['orders:read', 'invoices:write'], { userId: 'specified-finance', roleIds: ['custom-explicit-reviewer'] });
    expect(workflowReviewerMatches(specified, step)).toBe(true);
    expect(() => assertWorkflowReviewer(specified, { initiatedById: specified.userId }, step)).toThrow('不能审批自己的');
  });
  it('signed permission ceiling can remove either financial capability even while current grants contain it', () => {
    expect(hasWorkflowDecisionScope(actor(['orders:read', 'invoices:write'], { permissionCeiling: ['orders:read'] }), 'Order', { approverRole: 'role-finance' })).toBe(false);
    expect(hasWorkflowDecisionScope(actor(['orders:read', 'invoices:write'], { permissionCeiling: ['invoices:write'] }), 'Order', { approverRole: 'role-finance' })).toBe(false);
    expect(hasWorkflowDecisionScope(actor(['orders:read', 'invoices:write'], { permissionCeiling: ['*'] }), 'Order', { approverRole: 'role-finance' })).toBe(true);
  });
  it('Invoice and DevelopmentCase retain their native module capabilities', () => {
    expect(hasWorkflowDecisionScope(actor(['orders:read', 'orders:write']), 'Invoice', { approverRole: 'role-finance' })).toBe(false);
    expect(hasWorkflowDecisionScope(actor(['invoices:write']), 'Invoice', { approverRole: 'role-finance' })).toBe(true);
    expect(hasWorkflowDecisionScope(actor(['products:write', 'invoices:write']), 'DevelopmentCase', { approverRole: 'role-finance' })).toBe(false);
    expect(hasWorkflowDecisionScope(actor(['qc:garment_chain:write']), 'DevelopmentCase', { approverRole: 'role-qc' })).toBe(true);
  });
});
