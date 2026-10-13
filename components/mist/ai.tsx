import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight, Link2 } from 'lucide-react';
import { Drawer } from './overlays';
import { AIBadge, Icon } from './primitives';
import { AssistantEyes } from './AssistantEyes';

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; html?: string; content?: React.ReactNode; sources?: string[]; actions?: React.ReactNode }
  | { role: 'typing' };

/**
 * 小竹抽屉。只负责展示；消息状态与发送逻辑由调用方管理（接真实 Agent 接口）。
 * html 字段仅用于可信的内部模板；来自模型的文本请用 content（React 节点）渲染。
 */
export function AssistantDrawer({ open, onClose, messages, onSend, suggestions = [], title = '小竹', sub = '基于当前工作空间的业务数据回答', icon = AssistantEyes }: {
  open: boolean; onClose: () => void; messages: ChatMessage[]; onSend: (text: string) => void; suggestions?: string[]; title?: string; sub?: string; icon?: LucideIcon;
}) {
  const [draft, setDraft] = React.useState('');
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [messages, open]);
  const send = (t: string) => { const v = t.trim(); if (!v) return; onSend(v); setDraft(''); };
  return (
    <Drawer open={open} onClose={onClose} title={title} sub={sub} tone="ai" leading={<AIBadge icon={icon} size="lg" />} bodyless>
      <div className="mist-drawer-body" ref={list}>
        <div className="mist-msgs">
          {messages.map((m, i) => m.role === 'user' ? <div key={i} className="mist-msg" data-role="user">{m.text}</div>
            : m.role === 'typing' ? <div key={i} className="mist-msg" data-role="assistant"><div className="mist-msg-bubble mist-typing"><i /><i /><i /></div></div>
            : <div key={i} className="mist-msg" data-role="assistant">
                {m.html ? <div className="mist-msg-bubble" dangerouslySetInnerHTML={{ __html: m.html }} /> : <div className="mist-msg-bubble">{m.content}</div>}
                {m.sources && <div className="mist-msg-src">{m.sources.map(s => <span key={s}><Icon icon={Link2} size="xs" />{s}</span>)}</div>}
                {m.actions && <div className="mist-msg-acts">{m.actions}</div>}
              </div>)}
        </div>
      </div>
      {suggestions.length > 0 && <div className="mist-sugg">{suggestions.map(s => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}</div>}
      <div className="mist-composer">
        <textarea value={draft} placeholder="问小竹，或让它帮你做事…" aria-label="输入问题" onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }} />
        <button type="button" className="mist-send" aria-label="发送" onClick={() => send(draft)}><Icon icon={ArrowUpRight} size="sm" /></button>
      </div>
    </Drawer>
  );
}
