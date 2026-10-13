import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executeTool, executeAgentTool } from '../toolRuntime';

const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['knowledge', 'email', 'finance'], knowledgeScopes: ['company'], departmentIds: [] } as any;

describe('task flow: knowledge.ingest real draft→approval→commit flow', () => {
  it('executeAgentTool creates approval (draft phase), no pseudo-success', async () => {
    const approvalCreate = vi.fn().mockImplementation(async ({ data }: any) => data);
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) }, approvalRequest: { create: approvalCreate }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) }, department: { findUnique: vi.fn().mockResolvedValue(null) }, userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'knowledge.ingest', toolInput: { title: 't', text: 'content here' }, sessionId: 's1' });
    expect(result?.status).toBe('approval_required');
    expect(approvalCreate).toHaveBeenCalledTimes(1);
    expect(result.processDraft).toBeTruthy();
    expect(result.processDraft.idempotencyKey).toContain(':pd:');
  });

  it('executeAgentTool missing text → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'knowledge.ingest', toolInput: { title: 't' }, sessionId: 's1' });
    expect(result?.status).toBe('preconditions_failed');
  });

  it('toolRegistry upgraded: approvalPolicy always + processSpec', () => {
    const reg = fs.readFileSync(path.resolve(__dirname, '../toolRegistry.ts'), 'utf-8');
    const entry = reg.slice(reg.indexOf("id: 'knowledge.ingest'"), reg.indexOf("id: 'email.sync'"));
    expect(entry).toContain("approvalPolicy: 'always'");
    expect(entry).toContain('processSpec');
    expect(entry).not.toContain('NOT_IMPLEMENTED');
  });

  it('manifest upgraded: real flow, no failClosed', () => {
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    expect(manifest).toContain("id: 'knowledge.ingest'");
    const entry = manifest.slice(manifest.indexOf("id: 'knowledge.ingest'"), manifest.indexOf("id: 'entities.search'"));
    expect(entry).not.toContain('failClosed: true');
    expect(entry).toContain("approval: 'always'");
    expect(entry).toContain('sideEffects: true');
  });
});

describe('task gap-closure: email.sync fail-closed (EMAIL_SYNC_NOT_CONFIGURED)', () => {
  it('executeTool email.sync now enters draft/approval flow (no longer fail-closed stub)', async () => {
    // email.sync upgraded from fail-closed to real draft→approval→commit flow
    // executeTool dispatch for skipApprovalCheck=false now handled by executeAgentTool draft phase
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    const entry = manifest.slice(manifest.indexOf("id: 'email.sync'"), manifest.indexOf("id: 'email.link_to_order'"));
    expect(entry).not.toContain('failClosed: true');
    expect(entry).not.toContain('EMAIL_SYNC_NOT_CONFIGURED');
  });

  it('executeAgentTool creates approval (draft phase), credentialRef replaces password', async () => {
    const approvalCreate = vi.fn().mockImplementation(async ({ data }: any) => data);
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) }, approvalRequest: { create: approvalCreate }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) }, department: { findUnique: vi.fn().mockResolvedValue(null) }, userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'email.sync', toolInput: { credentials: { user: 'a@b.com', pass: 'supersecret' } }, sessionId: 's1' });
    expect(result?.status).toBe('approval_required');
    expect(approvalCreate).toHaveBeenCalledTimes(1);
    // password not in payload
    const payload = approvalCreate.mock.calls[0][0].data.payload;
    expect(JSON.stringify(payload)).not.toContain('supersecret');
    expect(payload.input.credentials.pass).toBe('');
    expect(payload.input.credentials.credentialRef).toMatch(/^ecred_/);
  });

  it('email.sync registered in toolRegistry with approvalPolicy always (real flow)', () => {
    const reg = fs.readFileSync(path.resolve(__dirname, '../toolRegistry.ts'), 'utf-8');
    expect(reg).toContain("id: 'email.sync'");
    const entry = reg.slice(reg.indexOf("id: 'email.sync'"), reg.indexOf("id: 'orders.update_status'"));
    expect(entry).toContain("approvalPolicy: 'always'");
    expect(entry).toContain('processSpec');
  });

  it('manifest email.sync upgraded to real flow (no failClosed)', () => {
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    const entry = manifest.slice(manifest.indexOf("id: 'email.sync'"), manifest.indexOf("id: 'email.link_to_order'"));
    expect(entry).not.toContain('failClosed: true');
    expect(entry).toContain('approval: \'always\'');
  });
});

describe('task gap-closure: payment.receive_and_reconcile not polluted', () => {
  it('payment.receive_and_reconcile manifest does NOT have email.sync failClosedCode', () => {
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    const entry = manifest.slice(manifest.indexOf("id: 'payment.receive_and_reconcile'"), manifest.indexOf("id: 'order.ship'"));
    expect(entry).not.toContain('EMAIL_SYNC_NOT_CONFIGURED');
    expect(entry).not.toContain('failClosed');
  });
});
