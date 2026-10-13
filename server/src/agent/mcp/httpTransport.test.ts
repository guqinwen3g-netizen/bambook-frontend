import express from 'express';
import request from 'supertest';
import {describe, expect, it, vi} from 'vitest';
import {createMcpHttpHandler} from './httpTransport';
import type {ToolManifest} from './types';
import type {KnowledgeHit} from '../types';

function fixture(count=1) {
  const call=vi.fn(async():Promise<KnowledgeHit[]>=>[{title:'Scoped result',category:'ToolResult',content:'Synthetic data',source:'agent-tool/orders.query'}]);
  const tools:ToolManifest[]=Array.from({length:count},(_,index)=>({id:`orders.query${index}`,name:'Query orders',description:'Scoped orders',
    domain:'orders',risk:'low',inputSchema:{type:'object'},outputSchema:{type:'object'},
    permissions:{scope:'orders:read',allowedRoles:['sales']},safety:{approval:'never',sideEffects:false},examples:[]}));
  const app=express();app.use(express.json());
  app.post('/mcp',createMcpHttpHandler(()=>({manifest:()=>tools,call})));
  const post=(method:string,params:unknown={},id:unknown=1)=>request(app).post('/mcp').send({jsonrpc:'2.0',id,method,params});
  return {app,call,post};
}
describe('stateless MCP HTTP protocol',()=>{
  it('negotiates initialization and advertises only implemented tool capabilities',async()=>{
    const {post}=fixture();const res=await post('initialize',{protocolVersion:'2025-03-26'});
    expect(res.body).toMatchObject({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'Bambook'}}});
    expect((await post('ping')).body.result).toEqual({});
  });
  it('pages tools in bounded batches without dropping the remainder',async()=>{
    const {post}=fixture(70);const first=(await post('tools/list')).body.result;
    expect(first.tools).toHaveLength(64);expect(first.nextCursor).toBe('64');
    const tail=(await post('tools/list',{cursor:first.nextCursor})).body.result;
    expect(tail.tools).toHaveLength(6);expect(tail.nextCursor).toBeUndefined();
    expect((await post('tools/list',{cursor:'-1'})).body.error.code).toBe(-32602);
  });
  it('calls only a manifest tool and preserves the original scoped results',async()=>{
    const {post,call}=fixture();const res=await post('tools/call',{name:'orders.query0',arguments:{limit:10}});
    expect(call).toHaveBeenCalledWith('orders.query0',{limit:10});
    expect(res.body.result).toMatchObject({isError:false,structuredContent:{hits:[{content:'Synthetic data'}]}});
    for(const params of [{name:'unknown'},{name:'orders.query0',arguments:[]},{name:'orders.query0',arguments:{data:'x'.repeat(65537)}}])
      expect((await post('tools/call',params)).body.error.code).toBe(-32602);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('never executes a business mutation in an id-less notification',async()=>{
    const {app,call}=fixture();const res=await request(app).post('/mcp').send({jsonrpc:'2.0',method:'tools/call',params:{name:'orders.query0'}});
    expect(res.status).toBe(400);expect(call).not.toHaveBeenCalled();
    expect((await request(app).post('/mcp').send({jsonrpc:'2.0',method:'notifications/initialized'})).status).toBe(202);
  });
  it('rejects untrusted browser origins and malformed requests',async()=>{
    const {app,post,call}=fixture();
    expect((await request(app).post('/mcp').set('Origin','https://untrusted.example').send({jsonrpc:'2.0',id:1,method:'ping'})).status).toBe(403);
    expect((await request(app).post('/mcp').send([])).status).toBe(400);
    expect((await post('ping',{},false)).status).toBe(400);
    expect((await post('unknown')).body.error.code).toBe(-32601);expect(call).not.toHaveBeenCalled();
  });
  it('keeps pending approvals distinct from completed writes and bounds large responses',async()=>{
    const {post,call}=fixture();
    const pending={title:'Approval required',category:'ApprovalPending',content:'approval_id = synthetic-approval',source:'agent-approval/orders.update'};
    call.mockResolvedValueOnce([pending]);
    const res=await post('tools/call',{name:'orders.query0'});
    expect(res.body.result.structuredContent.hits).toEqual([pending]);
    expect(res.body.result.content[0].text).toContain('ApprovalPending');
    call.mockResolvedValueOnce([{...pending,content:'x'.repeat(1048577)}]);
    const large=await post('tools/call',{name:'orders.query0'});
    expect(large.body.result.isError).toBe(true);expect(large.body.result.structuredContent).toBeUndefined();
    expect(large.body.result.content[0].text).toContain('paginate');
  });
  it('does not expose caught errors or invent success for a denied/empty result',async()=>{
    const {post,call}=fixture();call.mockRejectedValueOnce(new Error('private provider diagnostic'));
    const failure=await post('tools/call',{name:'orders.query0'});
    expect(failure.body.result.isError).toBe(true);expect(JSON.stringify(failure.body)).not.toContain('private provider');
    call.mockResolvedValueOnce([]);expect((await post('tools/call',{name:'orders.query0'})).body.result.isError).toBe(true);
  });
});
