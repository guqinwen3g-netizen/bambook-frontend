import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { createAgentRouter } from '../route';
import { createAuthService } from '../../auth/service';
import { durableFixture } from '../../email/__tests__/outboxDurableFixture';
import { buildEmailSendOutboxDraft } from '../emailSendOutboxFlow';
import { executeAgentTool, executeTool, runAgentToolCalls } from '../toolRuntime';
import { clearEmailCredentials, takeEmailSendCredential } from '../emailCredentialStore';
import * as dispatch from '../toolDispatchRegistry';

// Actual route, approval kernel and durable producer; only storage and SMTP are synthetic.
const actor: any = { userId: 'u1', roles: ['admin'], departmentIds: [],
  permissionScopes: ['emails:write'], permissionsAuthoritative: true,
  toolScopes: ['automation'], memoryScopes: [], knowledgeScopes: ['company'] };
const nativeActor: any = { userId: 'u1', roles: ['admin'], permissions: ['emails:write'], authorizationLoaded: true };
function fixture() {
  const f = durableFixture({ id: 'E-agent', direction: 'outbound', mailbox: 'Outbox',
    fromAddress: 'synthetic@bambook.local', toAddresses: '["recipient@bambook.local"]',
    ccAddresses: '[]', bccAddresses: '[]', subject: 'Approved subject', bodyText: 'Approved body',
    bodyHtml: null, hasAttachments: false, attachmentCount: 0, messageId: null, sentAt: null, deletedAt: null });
  const approvals: any[] = [], runs: any[] = [], receipts: any[] = [];
  let grant = true;
  const p: any = f.prisma;
  p.userAccount.findUnique.mockImplementation(async ({where}: any) => ({ id: where.id, status: 'active', deletedAt: null,
    roles: [{ role: { id: 'synthetic-grant', permissions: grant ? [{ permission: { scope: 'emails:write' } }, { permission: { scope: 'agent:approvals:approve' } }] : [] } }] }));
  p.userAccount.findFirst = vi.fn(async ({where}: any) => ({ id: where.id || 'u1', primaryDeptId: null }));
  p.userAccount.count = vi.fn(async () => 2);
  p.userRole = { findMany: vi.fn(async ({where}: any) => where.userId === 'reviewer'
    ? [{ userId: 'reviewer', roleId: 'role-super-admin' }] : [{ userId: 'reviewer', roleId: 'role-super-admin' }]) };
  p.department = { findUnique: vi.fn(async () => null) };
  p.approvalRequest = {
    create: vi.fn(async ({data}: any) => { const row = {...data, createdAt: new Date(), updatedAt: new Date()}; approvals.push(row); return row; }),
    findUnique: vi.fn(async ({where}: any) => approvals.find(r => r.id === where.id) || null),
    findUniqueOrThrow: vi.fn(async ({where}: any) => approvals.find(r => r.id === where.id)),
    updateMany: vi.fn(async ({where,data}: any) => { const row = approvals.find(r => r.id === where.id); if (!row || row.status !== where.status) return {count: 0}; Object.assign(row,data); return {count: 1}; }),
  };
  p.agentToolRun = { create: vi.fn(async ({data}: any) => { runs.push(data); return data; }) };
  p.agentCommitReceipt = {
    findUnique: vi.fn(async ({where}: any) => receipts.find(r => r.idempotencyKey === where.idempotencyKey) || null),
    create: vi.fn(async ({data}: any) => { if (receipts.some(r => r.idempotencyKey === data.idempotencyKey)) throw Object.assign(Error('duplicate'),{code:'P2002'}); receipts.push(data); return data; }),
    update: vi.fn(async ({where,data}: any) => Object.assign(receipts.find(r => r.idempotencyKey === where.idempotencyKey),data)),
    delete: vi.fn(async ({where}: any) => { receipts.splice(receipts.findIndex(r=>r.idempotencyKey===where.idempotencyKey),1); }),
  };
  p.auditLog.findFirst = vi.fn(async () => null);
  const tx = p.$transaction.getMockImplementation()!;
  p.$transaction.mockImplementation((fn: any) => tx((client: any) => fn(Object.assign(client, {
    approvalRequest: p.approvalRequest, userRole: p.userRole, userAccount: p.userAccount,
    agentToolRun: p.agentToolRun, agentCommitReceipt: p.agentCommitReceipt,
  }))));
  const sendMail = vi.fn(async () => ({ messageId: '<synthetic-agent@bambook.local>',
    accepted: ['recipient@bambook.local'], rejected: [], pending: [] }));
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({sendMail} as any);
  const app = express(); app.use(express.json());
  app.use('/api/agent', createAgentRouter({ prisma: p, requireAuth: true, apiKeys: new Set(),
    dataSource: {kind:'local-dev',runtimeEnv:'test',database:'postgresql',host:'localhost',name:'synthetic',isBusinessTruth:false,warning:'Synthetic only'},
    getRuntimeMetrics:()=>({}) }));
  const token = (userId: string) => createAuthService().signToken({ userId, roles:['admin'], departmentIds:[], permissions:['emails:write', 'agent:approvals:approve'], authorizationLoaded:true });
  async function draft() {
    const result: any = await executeAgentTool({prisma:p,actor,toolId:'email.send',
      toolInput:{emailId:'E-agent',credentials:{user:'synthetic@bambook.local',pass:'synthetic-password'}}});
    expect(result.status).toBe('approval_required');
    const approval = approvals[0]; approval.status = 'approved'; return approval;
  }
  const commit = (approval: any, current = actor) => executeTool(p,{toolId:'email.send',input:{},approvalId:approval.id} as any,{actor:current});
  return {...f,p,approvals,runs,receipts,sendMail,app,token,draft,commit,setGrant:(value:boolean)=>{grant=value}};
}
beforeEach(() => { vi.restoreAllMocks(); clearEmailCredentials(); });
describe('Agent durable email actual-route contract', () => {
  it('MCP plan → exact server snapshot approval → actual reviewer route → durable native send', async () => {
    const f = fixture();
    const response = await request(f.app).post('/api/agent/mcp/run').set('Authorization',`Bearer ${f.token('u1')}`).send({
      plan:{steps:[{toolId:'email.send',input:{emailId:'E-agent',password:'synthetic-password',email:'synthetic@bambook.local'},reason:'send approved draft'}]},
    });
    expect(response.status).toBe(200); expect(f.approvals).toHaveLength(1);
    const approval = f.approvals[0];
    expect(approval.payload.processDraft.subOperations[0].after.sendContextVersion).toBe(1);
    expect(approval.payload.processDraft.subOperations[0].after.content.bodyText).toBe('Approved body');
    expect(JSON.stringify([response.body,f.approvals,f.runs])).not.toContain('synthetic-password');
    expect(f.sendMail).not.toHaveBeenCalled();
    const decision = await request(f.app).post(`/api/agent/approvals/${approval.id}/resolve`)
      .set('Authorization',`Bearer ${f.token('reviewer')}`).send({decision:'approved'});
    expect(decision.status).toBe(200); expect(approval.status).toBe('approved');
    expect((await f.commit(approval) as any).ok).toBe(true);
    expect(f.sendMail).toHaveBeenCalledTimes(1); expect(f.state.attempt.status).toBe('sent');
    expect(f.state.attempt.actorId).toBe('u1'); expect(f.receipts).toHaveLength(0);
    expect(JSON.stringify([f.approvals,f.runs,f.audits,f.state.attempt])).not.toContain('synthetic-password');
  });
  it.each(['bodyText','bccAddresses'])('approved %s drift fails before SMTP', async field => {
    const f=fixture(), approval=await f.draft(); f.state.email[field]=field==='bodyText'?'Changed body':'["other@bambook.local"]';
    expect((await f.commit(approval) as any).ok).toBe(false); expect(f.sendMail).not.toHaveBeenCalled();
    expect(f.state.attempt).toBeNull();
  });
  it('accepted recovery with expired secret, generic legacy hint and actual execution actor retains requester provenance', async () => {
    const f=fixture(), approval=await f.draft(); approval.requesterId='original-requester';
    const nativeUpdate=f.p.email.update.getMockImplementation(); f.p.email.update.mockRejectedValueOnce(Error('transient update failure'));
    expect((await f.commit(approval) as any).ok).toBe(false); expect(f.state.attempt.status).toBe('accepted');
    f.p.email.update.mockImplementation(nativeUpdate); clearEmailCredentials();
    const old={idempotencyKey:`commit:email.send:${approval.id}`,status:'committing'}; f.receipts.push(old);
    expect((await f.commit(approval) as any).ok).toBe(true); expect(f.sendMail).toHaveBeenCalledTimes(1);
    expect(f.state.attempt.actorId).toBe('u1'); expect(approval.requesterId).toBe('original-requester');
    expect(f.receipts).toEqual([old]);
  });
  it.each(['committing','committed'])('legacy %s without native attempt cannot send or return cached success', async status => {
    const f=fixture(), approval=await f.draft(); const old={idempotencyKey:`commit:email.send:${approval.id}`,status,result:{ok:true,committed:true}}; f.receipts.push(old);
    expect((await f.commit(approval) as any).ok).toBe(false); expect(f.sendMail).not.toHaveBeenCalled();
    expect(f.state.attempt).toBeNull(); expect(f.receipts).toEqual([old]);
  });
  it('current DB revocation and signed ceiling reject even generic committed cache', async () => {
    const f=fixture(), approval=await f.draft(); expect((await f.commit(approval) as any).ok).toBe(true);
    const old={idempotencyKey:`commit:email.send:${approval.id}`,status:'committed',result:{ok:true}}; f.receipts.push(old);
    f.setGrant(false); expect((await f.commit(approval) as any).ok).toBe(false);
    f.setGrant(true); expect((await f.commit(approval,{...actor,permissionCeiling:[]}) as any).ok).toBe(false);
    expect(f.sendMail).toHaveBeenCalledTimes(1); expect(f.receipts).toEqual([old]);
  });
  it('approval resume does not reread a Sent draft and only restores native receipt', async () => {
    const f=fixture(), approval=await f.draft(); expect((await f.commit(approval) as any).ok).toBe(true);
    const result: any=await executeAgentTool({prisma:f.p,actor,toolId:'email.send',toolInput:{},approvalId:approval.id,skipApprovalCheck:true});
    expect(result.ok).toBe(true); expect(f.sendMail).toHaveBeenCalledTimes(1); expect(f.approvals).toHaveLength(1);
  });
  it('id-only legacy approval is not promoted into a new content approval', async () => {
    const f=fixture(), approval=await f.draft(); const draft:any=approval.payload.processDraft;
    delete draft.subOperations[0].after.contentHash; delete draft.subOperations[0].after.content; delete draft.subOperations[0].after.sendContextVersion;
    // Pure old builder generates a valid old hash, but cannot authorize the current body.
    approval.payload.processDraft=buildEmailSendOutboxDraft({emailId:'E-agent',credentials:{user:'synthetic@bambook.local',pass:''}} as any);
    expect((await f.commit(approval) as any).ok).toBe(false); expect(f.sendMail).not.toHaveBeenCalled();
  });
  it('denied runtime and MCP events never receive either password shape', async () => {
    const f=fixture(), emit=vi.fn(), denied={...actor,permissionsAuthoritative:true,permissionScopes:[]};
    await expect(executeAgentTool({prisma:f.p,actor:denied,toolId:'email.send',toolInput:{password:'top-secret',credentials:{user:'x',pass:'nested-secret'}}})).rejects.toThrow('TOOL_NOT_ALLOWED');
    await runAgentToolCalls({prisma:f.p,actor:denied,calls:[{toolId:'email.send',input:{password:'top-secret',credentials:{user:'x',pass:'nested-secret'}},reason:'denied'}],emit});
    expect(JSON.stringify([f.runs,emit.mock.calls])).not.toMatch(/top-secret|nested-secret/); expect(f.approvals).toHaveLength(0);
  });
  it('legacy generic receipt SQL read failure is not permission to claim a new native send', async () => {
    const f=fixture(), approval=await f.draft(); f.p.agentCommitReceipt.findUnique.mockRejectedValue(Error('SQL unavailable'));
    const result:any=await f.commit(approval).catch(()=>({ok:false})); expect(result.ok).toBe(false);
    expect(f.sendMail).not.toHaveBeenCalled(); expect(f.state.attempt).toBeNull();
  });
  it.each(['claimed','unknown'])('native %s attempt cannot automatically send again', async status => {
    const f=fixture(), approval=await f.draft();
    const after=approval.payload.processDraft.subOperations[0].after;
    f.state.attempt={id:'prior-native',emailId:'E-agent',status,contentHash:after.contentHash,
      contentSnapshot:after.content,smtpUser:after.credentialsUser};
    const result:any=await f.commit(approval); expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe(status==='claimed'?'SEND_IN_PROGRESS':'SEND_RESULT_UNCERTAIN');
    expect(f.sendMail).not.toHaveBeenCalled(); expect(f.state.attempt.status).toBe(status);
  });
  it('SMTP partial acceptance persists unknown and replay cannot resend', async () => {
    const f=fixture(); f.state.email.bccAddresses='["bcc@bambook.local"]'; const approval=await f.draft();
    expect((await f.commit(approval) as any).ok).toBe(false); expect(f.state.attempt.status).toBe('unknown');
    expect((await f.commit(approval) as any).ok).toBe(false); expect(f.sendMail).toHaveBeenCalledTimes(1);
    expect(f.state.email.mailbox).toBe('Outbox');
  });
  it('two concurrent commits share one native attempt and one SMTP call', async () => {
    const f=fixture(), approval=await f.draft();
    const results:any[]=await Promise.all([f.commit(approval),f.commit(approval)]);
    expect(results.some(result=>result.ok)).toBe(true); expect(f.sendMail).toHaveBeenCalledTimes(1);
    expect(f.p.emailSendAttempt.create).toHaveBeenCalledTimes(1); expect(f.receipts).toHaveLength(0);
  });
  it('native successful audit tamper cannot be replaced by generic success cache', async () => {
    const f=fixture(), approval=await f.draft(); expect((await f.commit(approval) as any).ok).toBe(true);
    const audit=f.audits.find(row=>row.id===f.state.attempt.auditId); audit.actorId='wrong-native-actor';
    const old={idempotencyKey:`commit:email.send:${approval.id}`,status:'committed',result:{ok:true}};f.receipts.push(old);
    const result:any=await f.commit(approval);expect(result.ok).toBe(false);expect(result.errorFeedback.code).toBe('SEND_RECEIPT_INVALID');
    expect(f.sendMail).toHaveBeenCalledTimes(1);expect(f.receipts).toEqual([old]);
  });
  it('retired ephemeral secret does not become a persisted approval password fallback', async () => {
    const f=fixture(), approval=await f.draft(); clearEmailCredentials(); approval.payload.credentialsPassword='obsolete-secret';
    const result:any=await f.commit(approval);expect(result.ok).toBe(false);expect(result.errorFeedback.code).toBe('MISSING_CREDENTIALS');
    expect(f.sendMail).not.toHaveBeenCalled();expect(f.state.attempt).toBeNull();
  });
  it('legacy executeTool fallback preserves the native contract and cross-action guard', async () => {
    const f=fixture(), approval=await f.draft(); vi.spyOn(dispatch,'dispatchFromRegistry').mockResolvedValue({hit:false});
    approval.actionType='tool:invoice.issue';expect((await f.commit(approval) as any).errorFeedback.code).toBe('CROSS_APPROVAL_BINDING');
    approval.actionType='tool:email.send';expect((await f.commit(approval) as any).ok).toBe(true);
    expect(f.state.attempt.actorId).toBe('u1');expect(f.sendMail).toHaveBeenCalledTimes(1);
    clearEmailCredentials();expect((await f.commit(approval) as any).ok).toBe(true);expect(f.sendMail).toHaveBeenCalledTimes(1);
  });
  it('missing requester identity or reviewer resolution cannot create a temporary success approval', async () => {
    const f=fixture(); f.p.userAccount.findFirst.mockResolvedValue(null);
    const result:any=await executeAgentTool({prisma:f.p,actor,toolId:'email.send',toolInput:{emailId:'E-agent',credentials:{user:'synthetic@bambook.local',pass:'secret'}}});
    expect(result.status).toBe('preconditions_failed');expect(f.approvals).toHaveLength(0);expect(f.sendMail).not.toHaveBeenCalled();
  });
  it('malformed initial input is sanitized before failure audit and an unexecuted MCP step is safely projected', async () => {
    const f=fixture();const bad:any=await executeAgentTool({prisma:f.p,actor,toolId:'email.send',toolInput:{password:'bad-input-secret'}});
    expect(bad.status).toBe('preconditions_failed');expect(JSON.stringify(f.runs)).not.toContain('bad-input-secret');
    const response=await request(f.app).post('/api/agent/mcp/run').set('Authorization',`Bearer ${f.token('u1')}`).send({
      plan:{steps:Array.from({length:7},(_,i)=>({toolId:'email.send',input:{emailId:`missing-${i}`,password:'never-return-secret',credentials:{user:'synthetic@bambook.local',pass:'nested-never-return-secret'}},reason:'safe projection'}))},
    });
    expect(response.status).toBe(200);expect(JSON.stringify([response.body,f.runs,f.approvals])).not.toContain('never-return-secret');
    expect(f.sendMail).not.toHaveBeenCalled();
  });
  it('first draft rejects a client reference; a different current actor cannot consume the original password', async () => {
    const f=fixture(),approval=await f.draft(),ref=approval.payload.input.credentials.credentialRef;
    const spoof:any=await executeAgentTool({prisma:f.p,actor,toolId:'email.send',toolInput:{emailId:'E-agent',credentials:{user:'synthetic@bambook.local',credentialRef:ref}}});
    expect(spoof.status).toBe('preconditions_failed');expect(f.approvals).toHaveLength(1);
    expect((await f.commit(approval,{...actor,userId:'another-granted-operator'}) as any).ok).toBe(false);
    expect(f.sendMail).not.toHaveBeenCalled();expect((await f.commit(approval) as any).ok).toBe(true);
    expect(f.sendMail).toHaveBeenCalledTimes(1);
  });
  it('accepted native recovery does not consume a still-valid bound password', async () => {
    const f=fixture(),approval=await f.draft(),ref=approval.payload.input.credentials.credentialRef;
    const after=approval.payload.processDraft.subOperations[0].after;
    // Keep the server credential available while the producer receives an external ephemeral secret.
    const {commitEmailSendOutbox}=await import('../emailSendOutboxFlow');
    const direct:any=await commitEmailSendOutbox({prisma:f.p,approvalId:approval.id,approvalPayload:approval.payload,
      actorId:'u1',trustedActor:nativeActor,credentialsPassword:'external-synthetic-secret'});
    expect(direct.ok).toBe(true);expect((await f.commit(approval) as any).ok).toBe(true);
    expect(takeEmailSendCredential(ref,{actorId:'u1',emailId:'E-agent',smtpUser:after.credentialsUser,contentHash:after.contentHash})).toBe('synthetic-password');
    expect(f.sendMail).toHaveBeenCalledTimes(1);
  });
});
