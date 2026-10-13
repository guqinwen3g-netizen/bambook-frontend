/**
 * Bambook 前端 SSE 完整模拟测试
 * 
 * 用 Node.js fetch 完全模拟 Electron renderer 的 SSE 请求，
 * 逐事件解析并记录，对比 curl 测试结果。
 * 
 * 用法：node scripts/e2e-sse-sim.mjs [bearer-token]
 * 
 * 不带 token 时使用 API Key 模式。
 */

import { enforceNonProdTarget } from './lib/prodTargetGuard.mjs';

const API_BASE = process.env.BAMBOOK_API_BASE || 'https://jiangsupanda.com/bambook/api';
// 默认值就指向生产，而这一句会真 POST /ai/chat（花模型配额）⇒ 打之前必须过闸（见 §9 B281/B282）
enforceNonProdTarget(API_BASE, { what: 'e2e-sse-sim 的 ai/chat' });
const API_KEY = process.env.BAMBOOK_API_KEY || process.env.BAMBOOK_TEST_API_KEY || '';
if (!API_KEY) {
  console.error('Missing BAMBOOK_API_KEY env var');
  process.exit(1);
}
const TEST_MESSAGE = '帮我创建一个新的客户档案 这个客户的名字你就写ABC';

async function main() {
  const bearerToken = process.argv[2];
  
  console.log('═══════════════════════════════════════════════════');
  console.log('Bambook SSE 端到端模拟测试');
  console.log('═══════════════════════════════════════════════════');
  console.log(`API Base: ${API_BASE}`);
  console.log(`Auth: ${bearerToken ? `Bearer token (${bearerToken.slice(0, 10)}...)` : 'API Key'}`);
  console.log(`Message: ${TEST_MESSAGE}`);
  console.log('');

  const headers = {
    'Content-Type': 'application/json',
  };

  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  } else {
    headers['X-Bambook-API-Key'] = API_KEY;
  }

  const body = JSON.stringify({
    message: TEST_MESSAGE,
    userId: 'test-user',
    sessionId: `e2e-sim-${Date.now()}`,
    history: [],
  });

  console.log(`📡 Sending POST ${API_BASE}/ai/chat ...`);

  const startTime = Date.now();
  const response = await fetch(`${API_BASE}/ai/chat`, {
    method: 'POST',
    headers,
    body,
  });

  console.log(`   Status: ${response.status}`);
  console.log(`   Content-Type: ${response.headers.get('content-type')}`);
  console.log('');

  if (response.status !== 200) {
    const text = await response.text();
    console.log(`❌ Error response: ${text.slice(0, 500)}`);
    return;
  }

  // 解析 SSE 流
  const events = [];
  let buffer = '';
  let llmText = '';
  let receivedFinal = false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const eventMatch = block.match(/^event:\s*(.+)$/m);
      const dataMatch = block.match(/^data:\s*(.+)$/m);
      if (!eventMatch || !dataMatch) continue;

      const event = eventMatch[1].trim();
      let data;
      try { data = JSON.parse(dataMatch[1]); } catch { continue; }

      const blockType = data?.block?.type || '';
      const toolId = data?.block?.toolId || data?.toolId || '';
      const lifecycle = data?.block?.lifecycleStatus || data?.status || '';
      const approvalId = data?.block?.approvalId || data?.metadata?.approvalId || '';
      const title = data?.block?.title || '';
      const risk = data?.block?.risk || data?.metadata?.risk || '';
      const resolution = data?.block?.resolution || data?.resolution || '';

      const entry = { 
        idx: events.length + 1, 
        event, 
        blockType, 
        toolId, 
        lifecycle, 
        approvalId,
        title,
        risk,
        resolution,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(1) + 's'
      };
      events.push(entry);

      // 实时输出
      const icon = event === 'final' ? '🏁' : 
                   blockType === 'approval' ? '🛡️ ' :
                   blockType === 'tool' ? '🔧' :
                   blockType === 'evidence' ? '📋' :
                   blockType === 'markdown' ? '📝' :
                   '  ';
      console.log(`${icon} #${entry.idx} [${entry.elapsed}] ${event}/${blockType || '-'} toolId=${toolId} lifecycle=${lifecycle} ${approvalId ? 'approvalId=' + approvalId : ''} ${title ? 'title=' + title : ''} ${risk ? 'risk=' + risk : ''}`);

      if (event === 'delta' && data.text) {
        llmText += data.text;
      }

      if (event === 'final') {
        receivedFinal = true;
        // 注意：前端代码在这里会 break！
        // 如果 final 事件在 approval block 之前到达，就会截断！
        console.log(`\n⚠️  FINAL 事件到达！前端代码会在这里 break 并取消 reader`);
        console.log(`   此时已收到 ${events.length} 个事件`);
      }
    }
  }

  // 总结
  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 测试结果总结');
  console.log('═══════════════════════════════════════════════════');
  console.log(`总事件数: ${events.length}`);
  console.log(`总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`收到 final: ${receivedFinal}`);

  // 事件类型统计
  const typeCounts = {};
  for (const e of events) {
    const key = `${e.event}/${e.blockType || '-'}`;
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  }
  console.log('\n事件类型分布:');
  for (const [k, v] of Object.entries(typeCounts)) {
    console.log(`  ${k}: ${v}`);
  }

  // 关键检查
  console.log('\n🔍 关键检查:');

  const blockStartEvents = events.filter(e => e.event === 'block_start');
  console.log(`  block_start 事件数: ${blockStartEvents.length}`);
  
  const toolBlocks = blockStartEvents.filter(e => e.blockType === 'tool');
  console.log(`  tool block 数: ${toolBlocks.length}`);
  for (const t of toolBlocks) {
    console.log(`    ${t.toolId} ${t.lifecycle} ${t.title}`);
  }

  const approvalBlocks = blockStartEvents.filter(e => e.blockType === 'approval');
  console.log(`  approval block 数: ${approvalBlocks.length}`);
  for (const a of approvalBlocks) {
    console.log(`    toolId=${a.toolId} approvalId=${a.approvalId} risk=${a.risk}`);
  }

  const relationsCreate = events.filter(e => e.toolId === 'relations.create');
  console.log(`  relations.create 相关事件: ${relationsCreate.length}`);
  for (const rc of relationsCreate) {
    console.log(`    ${rc.event}/${rc.blockType} lifecycle=${rc.lifecycle} approvalId=${rc.approvalId}`);
  }

  // LLM 回答
  console.log(`\n📝 LLM 回答:\n${llmText || '(无)'}`);

  // 事件时序图
  console.log('\n📈 完整事件时序:');
  for (const e of events) {
    const bar = e.blockType === 'approval' ? '🛡️ ' :
                e.blockType === 'tool' && e.lifecycle === 'running' ? '▶️ ' :
                e.blockType === 'tool' && e.lifecycle === 'succeeded' ? '✅' :
                e.blockType === 'tool' && e.lifecycle === 'blocked' ? '🔒' :
                e.blockType === 'evidence' ? '📋' :
                e.blockType === 'markdown' ? '📝' :
                e.event === 'delta' ? '·' :
                e.event === 'final' ? '🏁' : '  ';
    console.log(`  [${e.elapsed}] ${bar} ${e.event}/${e.blockType || '-'} ${e.toolId} ${e.lifecycle} ${e.approvalId ? 'approval=' + e.approvalId : ''}`);
  }

  // 关键判断
  const hasApprovalBlock = approvalBlocks.length > 0;
  const hasRelationsCreate = relationsCreate.length > 0;
  
  console.log('\n═══════════════════════════════════════════════════');
  if (hasApprovalBlock && hasRelationsCreate) {
    console.log('✅ 测试通过：relations.create 执行 + approval block 发射');
  } else {
    console.log('❌ 测试失败：');
    if (!hasRelationsCreate) console.log('   - relations.create 工具未执行');
    if (!hasApprovalBlock) console.log('   - approval block 未发射');
  }
  console.log('═══════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
