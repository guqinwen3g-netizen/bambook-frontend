/**
 * 工作助手（本机 Agent）共享类型。
 * 运行在 assistant-host（Electron utilityProcess）中；渲染进程只拿到事件与脱敏视图。
 */
export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type Usage = { input: number; output: number };

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage };

export type ModelRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onEvent?: (event: ModelEvent) => void;
};

export type ModelResult = { text: string; toolCalls: ToolCall[]; usage?: Usage };

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResult>;
}

export type FetchLike = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

/** 本机加密凭据存储（主进程用系统钥匙串 safeStorage 实现；测试用内存实现）。 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class AssistantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AssistantError';
  }
}

export const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR');
