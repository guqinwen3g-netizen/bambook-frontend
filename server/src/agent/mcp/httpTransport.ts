import type { RequestHandler } from 'express';
import type { KnowledgeHit } from '../types';
import type { ToolManifest } from './types';

interface McpHttpDependencies {
  manifest: () => ToolManifest[];
  /** The authenticated route owns actor resolution, authorization, approvals and audit. */
  call: (name: string, input: Record<string, unknown>) => Promise<KnowledgeHit[]>;
}
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Stateless Streamable HTTP MCP; mount behind the existing strict Agent principal guard. */
export function createMcpHttpHandler(dependencies: (request: Parameters<RequestHandler>[0]) => McpHttpDependencies): RequestHandler {
  return async (req, res) => {
    // MCP Origin validation is additional to authentication; native clients may omit Origin.
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      res.status(403).json({ error: 'UNTRUSTED_MCP_ORIGIN' }); return;
    }
    const body: unknown = req.body;
    const id = isObject(body) && (typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id))) ? body.id : null;
    const error = (code: number, message: string) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
    if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      res.status(400); error(-32600, 'Invalid MCP request'); return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'id')) {
      // A notification never executes a business action.
      if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') res.status(202).end();
      else { res.status(400); error(-32600, 'Business requests require an id'); }
      return;
    }
    if (id === null) { res.status(400); error(-32600, 'Invalid request id'); return; }
    const params = body.params === undefined ? {} : body.params;
    if (!isObject(params)) { error(-32602, 'Invalid params'); return; }
    const reply = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
    const deps = dependencies(req);
    try {
      switch (body.method) {
        case 'initialize':
          reply({ protocolVersion: typeof params.protocolVersion === 'string' && versions.has(params.protocolVersion)
            ? params.protocolVersion : '2025-03-26', capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'Bambook', version: '0.8.0' } }); return;
        case 'ping': reply({}); return;
        case 'tools/list': {
          const tools = deps.manifest();
          const cursor = params.cursor;
          if (cursor !== undefined && (typeof cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor))) {
            error(-32602, 'Invalid tools cursor'); return;
          }
          const start = cursor === undefined ? 0 : Number(cursor);
          if (!Number.isSafeInteger(start) || start > tools.length) { error(-32602, 'Invalid tools cursor'); return; }
          reply({ tools: tools.slice(start, start + 64).map(tool => ({ name: tool.id, title: tool.name,
            description: [tool.description, tool.inputHint].filter(Boolean).join('\n'), inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: !tool.safety.sideEffects } })),
            ...(start + 64 < tools.length ? { nextCursor: String(start + 64) } : {}) }); return;
        }
        case 'tools/call': {
          if (typeof params.name !== 'string' || !deps.manifest().some(tool => tool.id === params.name)
            || (params.arguments !== undefined && !isObject(params.arguments))) {
            error(-32602, 'Unknown tool or invalid arguments'); return;
          }
          const input = (params.arguments ?? {}) as Record<string, unknown>;
          if (JSON.stringify(input).length > 65536) { error(-32602, 'Tool arguments exceed the request budget'); return; }
          const hits = await deps.call(params.name, input);
          const text = JSON.stringify({ hits });
          if (text.length > 1048576) {
            reply({ isError: true, content: [{ type: 'text', text: 'Result exceeds the response budget; narrow the query or paginate.' }] }); return;
          }
          // ApprovalPending remains an explicit pending result, never a fabricated completed write.
          reply({ isError: hits.length === 0, content: [{ type: 'text', text }], structuredContent: { hits } }); return;
        }
        default: error(-32601, 'MCP method not found'); return;
      }
    } catch {
      // Do not expose caught provider, SQL, credential or authorization diagnostics.
      if (body.method === 'tools/call') {
        reply({ isError: true, content: [{ type: 'text', text: 'Business tool failed or access was denied.' }] });
      } else error(-32603, 'MCP request failed');
    }
  };
}
