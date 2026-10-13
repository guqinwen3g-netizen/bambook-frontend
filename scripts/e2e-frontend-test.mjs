/**
 * Bambook 前端端到端 SSE 测试
 * 
 * 用 Playwright Chromium 模拟前端请求，捕获完整 SSE 事件流。
 * 这样可以排除 curl 和前端请求的差异。
 * 
 * 用法：node scripts/e2e-frontend-test.mjs
 */

import { chromium } from 'playwright';

const API_BASE = 'https://jiangsupanda.com/bambook/api';
const TEST_MESSAGE = '帮我创建一个新的客户档案 这个客户的名字你就写ABC';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 收集所有 SSE 事件
  const sseEvents = [];
  let sseComplete = false;

  // 拦截网络请求 - 捕获 SSE 响应
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/ai/chat')) return;

    console.log(`\n📡 SSE Response from: ${url}`);
    console.log(`   Status: ${response.status()}`);
    console.log(`   Content-Type: ${response.headers()['content-type']}`);

    if (response.status() !== 200) {
      const body = await response.text().catch(() => '');
      console.log(`   Error body: ${body.slice(0, 500)}`);
      return;
    }

    // 读取 SSE 流
    try {
      const body = await response.text();
      const blocks = body.split('\n\n').filter(b => b.trim());
      
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

        const summary = { event, blockType, toolId, lifecycle, approvalId };
        sseEvents.push(summary);
        console.log(`   ${sseEvents.length}. ${JSON.stringify(summary)}`);

        if (event === 'final') {
          console.log(`\n📝 LLM Response: ${(data.text || '').slice(0, 300)}`);
          sseComplete = true;
        }
      }
    } catch (e) {
      console.error('   Error reading SSE:', e.message);
    }
  });

  // 导航到 Bambook 的 Vite dev server
  console.log('🌐 Loading Bambook app from Vite dev server...');
  
  try {
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 15000 });
  } catch (e) {
    console.log('⚠️  Vite dev server not available, trying Cloudflare...');
    await page.goto('https://jiangsupanda.com/bambook/', { waitUntil: 'networkidle', timeout: 30000 });
  }

  // 等待页面加载
  await page.waitForTimeout(3000);
  console.log('✅ Page loaded');

  // 截图看页面状态
  await page.screenshot({ path: '/tmp/bambook-e2e-page.png' });
  console.log('📸 Screenshot saved to /tmp/bambook-e2e-page.png');

  // 找聊天输入框并发送消息
  console.log(`\n💬 Sending message: "${TEST_MESSAGE}"`);
  
  // 尝试多种选择器找到输入框
  const inputSelectors = [
    'textarea',
    'input[type="text"]',
    '[contenteditable="true"]',
    '.chat-input textarea',
    '[data-testid="chat-input"]',
    '.ant-input',
  ];

  let inputEl = null;
  for (const sel of inputSelectors) {
    inputEl = await page.$(sel);
    if (inputEl) {
      console.log(`   Found input with selector: ${sel}`);
      break;
    }
  }

  if (!inputEl) {
    console.log('❌ Could not find chat input element');
    console.log('   Dumping page content...');
    const html = await page.content();
    console.log(html.slice(0, 2000));
    await browser.close();
    return;
  }

  // 输入消息
  await inputEl.click();
  await inputEl.fill(TEST_MESSAGE);
  await page.waitForTimeout(500);

  // 找发送按钮
  const sendSelectors = [
    'button[type="submit"]',
    'button:has-text("发送")',
    'button:has-text("Send")',
    '.chat-input button',
    '[data-testid="send-button"]',
    'button.send-btn',
  ];

  let sent = false;
  for (const sel of sendSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      console.log(`   Found send button with selector: ${sel}`);
      await btn.click();
      sent = true;
      break;
    }
  }

  if (!sent) {
    // 尝试 Enter 键发送
    console.log('   Trying Enter key to send...');
    await inputEl.press('Enter');
    sent = true;
  }

  if (!sent) {
    console.log('❌ Could not send message');
    await browser.close();
    return;
  }

  console.log('   Message sent! Waiting for SSE response...');

  // 等待 SSE 完成（最多 60 秒）
  const startTime = Date.now();
  while (!sseComplete && (Date.now() - startTime) < 60000) {
    await page.waitForTimeout(2000);
    if (sseEvents.length > 0) {
      console.log(`   ... received ${sseEvents.length} events so far`);
    }
  }

  // 输出结果
  console.log('\n══════════════════════════════════════════');
  console.log('📊 SSE Event Summary:');
  console.log('══════════════════════════════════════════');
  
  const eventTypes = {};
  for (const e of sseEvents) {
    const key = `${e.event}/${e.blockType || '-'}`;
    eventTypes[key] = (eventTypes[key] || 0) + 1;
  }
  console.log('Event type counts:', JSON.stringify(eventTypes, null, 2));

  const approvalEvents = sseEvents.filter(e => e.blockType === 'approval' || e.approvalId);
  console.log(`\n🛡️  Approval events: ${approvalEvents.length}`);
  for (const e of approvalEvents) {
    console.log(`   ${JSON.stringify(e)}`);
  }

  const toolEvents = sseEvents.filter(e => e.blockType === 'tool');
  console.log(`\n🔧 Tool events: ${toolEvents.length}`);
  for (const e of toolEvents) {
    console.log(`   ${JSON.stringify(e)}`);
  }

  if (!sseComplete) {
    console.log('\n⚠️  SSE stream did not complete within 60 seconds');
  }

  // 截图最终状态
  await page.screenshot({ path: '/tmp/bambook-e2e-result.png' });
  console.log('\n📸 Final screenshot saved to /tmp/bambook-e2e-result.png');

  await browser.close();
  console.log('\n✅ Test complete');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
