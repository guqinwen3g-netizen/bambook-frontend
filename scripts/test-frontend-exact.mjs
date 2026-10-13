// 用前端精确消息（带空格版"写 ABC"）测试
const msg = '帮我创建一个新的客户档案 这个客户的名字你就写 ABC';
console.log('Testing message:', JSON.stringify(msg));

import { assertNonProdTarget } from './lib/prodTargetGuard.mjs';

// ★ 两处收口（v3.237 补 25）：① 原来这里**写死了一枚 API Key**（已挪进密钥轮换清单，指纹见台账 §9 B282）；
//   ② 原来这个探针**默认就打生产** ⇒ 现在目标必须是本机，否则拒绝（真要打外部得显式 BAMBOOK_ALLOW_PROD=yes）。
const TARGET = process.env.BAMBOOK_CHAT_URL || 'http://127.0.0.1:8090/api/v1/ai/chat';
const KEY = process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '';
if (!KEY) { console.error('缺 BAMBOOK_API_KEY（不再把密钥写进源码）'); process.exit(1); }
assertNonProdTarget(TARGET, { what: 'test-frontend-exact 的 ai/chat 探针' });

fetch(TARGET, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Bambook-API-Key': KEY,
  },
  body: JSON.stringify({
    message: msg,
    userId: 'test-user',
    sessionId: 'e2e-space-' + Date.now(),
    history: [],
  }),
}).then(async r => {
  const text = await r.text();
  const blocks = text.split('\n\n').filter(b => b.trim());
  const blockStarts = blocks.filter(b => b.startsWith('event: block_start'));
  console.log('Total blocks:', blocks.length);
  console.log('block_start count:', blockStarts.length);
  for (const b of blockStarts) {
    const dm = b.match(/^data:\s*(.+)$/m);
    if (!dm) continue;
    try {
      const d = JSON.parse(dm[1]);
      console.log('  type=' + (d.block?.type || '?') + ' toolId=' + (d.block?.toolId || '?') + ' lifecycle=' + (d.block?.lifecycleStatus || '?') + ' approvalId=' + (d.block?.approvalId || ''));
    } catch {}
  }
  const finalBlock = blocks.find(b => b.startsWith('event: final'));
  if (finalBlock) {
    const dm = finalBlock.match(/^data:\s*(.+)$/m);
    if (dm) {
      const d = JSON.parse(dm[1]);
      console.log('\nLLM final text:', (d.text || '').slice(0, 500));
    }
  }
}).catch(e => console.error('Error:', e));
