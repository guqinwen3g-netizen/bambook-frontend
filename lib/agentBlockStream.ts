import type {
  AgentArtifactBlock,
  AgentBlockPatch,
  AgentBlockStreamEvent,
  AgentChartBlock,
  AgentMarkdownBlock,
  AgentMermaidBlock,
  AgentResponseBlock,
  AgentResponseBlockStatus,
  AgentTableBlock,
} from '../types';

const withStatus = <T extends AgentResponseBlock>(block: T, status: AgentResponseBlockStatus): T => ({
  ...block,
  status,
});

const appendMarkdown = (block: AgentMarkdownBlock, value: string): AgentMarkdownBlock => ({
  ...block,
  content: `${block.content ?? ''}${value}`,
  status: 'streaming',
});

const patchBlock = (block: AgentResponseBlock, patch: AgentBlockPatch): AgentResponseBlock => {
  if (patch.op === 'append_text' && block.type === 'markdown') {
    return appendMarkdown(block, patch.value);
  }

  if (patch.op === 'set_columns' && block.type === 'table') {
    return { ...block, columns: patch.columns, status: 'streaming' } satisfies AgentTableBlock;
  }

  if (patch.op === 'append_row' && block.type === 'table') {
    return { ...block, rows: [...block.rows, patch.row], status: 'streaming' } satisfies AgentTableBlock;
  }

  if (patch.op === 'replace_row' && block.type === 'table') {
    return {
      ...block,
      rows: block.rows.map(row => row.id === patch.rowId ? patch.row : row),
      status: 'streaming',
    } satisfies AgentTableBlock;
  }

  if (patch.op === 'append_data' && block.type === 'chart') {
    return { ...block, data: [...block.data, ...patch.data], status: 'streaming' } satisfies AgentChartBlock;
  }

  if (patch.op === 'set_spec' && block.type === 'chart') {
    return { ...block, ...patch.spec, status: 'streaming' } as AgentChartBlock;
  }

  if (patch.op === 'set_version' && block.type === 'artifact') {
    return { ...block, version: patch.version, status: 'streaming' } satisfies AgentArtifactBlock;
  }

  if (patch.op === 'replace_content' && block.type === 'artifact') {
    return { ...block, contentRef: patch.contentRef, status: 'streaming' } satisfies AgentArtifactBlock;
  }

  if (patch.op === 'set_code' && block.type === 'mermaid') {
    return { ...block, code: patch.code, status: 'streaming' } satisfies AgentMermaidBlock;
  }

  if (patch.op === 'set_approval_status' && block.type === 'approval') {
    // 终态后把 block.status 切到 complete，pending 时保持 streaming（等用户决策）
    const isTerminal = patch.approvalStatus !== 'pending';
    return {
      ...block,
      approvalStatus: patch.approvalStatus,
      status: isTerminal ? 'complete' : 'streaming',
    };
  }

  return block;
};

export const reduceAgentBlocks = (
  blocks: AgentResponseBlock[],
  streamEvent: AgentBlockStreamEvent,
): AgentResponseBlock[] => {
  if (streamEvent.event === 'block_start') {
    const startedBlock = withStatus(streamEvent.block, streamEvent.block.status ?? 'streaming');
    const existingIndex = blocks.findIndex(block => block.id === startedBlock.id);
    if (existingIndex === -1) return [...blocks, startedBlock];
    return blocks.map(block => block.id === startedBlock.id ? startedBlock : block);
  }

  if (streamEvent.event === 'block_delta') {
    return blocks.map(block => {
      if (block.id !== streamEvent.blockId || block.type !== 'markdown') return block;
      return appendMarkdown(block, streamEvent.delta);
    });
  }

  if (streamEvent.event === 'block_patch') {
    return blocks.map(block => block.id === streamEvent.blockId ? patchBlock(block, streamEvent.patch) : block);
  }

  if (streamEvent.event === 'block_end') {
    return blocks.map(block => block.id === streamEvent.blockId ? withStatus(block, 'complete') : block);
  }

  if (streamEvent.event === 'block_error') {
    return blocks.map(block => {
      if (block.id !== streamEvent.blockId) return block;
      return {
        ...block,
        status: 'error',
        title: block.title ?? streamEvent.error.message,
      };
    });
  }

  return blocks;
};

export const normalizeAgentBlockStreamEvent = (data: unknown): AgentBlockStreamEvent | null => {
  if (!data || typeof data !== 'object') return null;
  const value = data as Partial<AgentBlockStreamEvent> & Record<string, unknown>;
  if (typeof value.event !== 'string') return null;

  if (value.event === 'block_start' && value.block && typeof value.block === 'object') {
    const block = value.block as Partial<AgentResponseBlock>;
    if (typeof block.id !== 'string' || typeof block.type !== 'string') return null;
    return { event: 'block_start', messageId: String(value.messageId ?? ''), block: block as AgentResponseBlock };
  }

  if ((value.event === 'block_delta' || value.event === 'block_end') && typeof value.blockId === 'string') {
    if (value.event === 'block_delta') {
      return { event: 'block_delta', messageId: String(value.messageId ?? ''), blockId: value.blockId, delta: String(value.delta ?? '') };
    }
    return { event: 'block_end', messageId: String(value.messageId ?? ''), blockId: value.blockId };
  }

  if (value.event === 'block_patch' && typeof value.blockId === 'string' && value.patch && typeof value.patch === 'object') {
    return { event: 'block_patch', messageId: String(value.messageId ?? ''), blockId: value.blockId, patch: value.patch as AgentBlockPatch };
  }

  if (value.event === 'block_error' && typeof value.blockId === 'string') {
    const errorValue = value.error && typeof value.error === 'object' ? value.error as { message?: unknown; code?: unknown } : {};
    return {
      event: 'block_error',
      messageId: String(value.messageId ?? ''),
      blockId: value.blockId,
      error: {
        message: String(errorValue.message ?? 'Block rendering failed'),
        code: typeof errorValue.code === 'string' ? errorValue.code : undefined,
      },
    };
  }

  return null;
};
