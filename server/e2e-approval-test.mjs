import { chromium } from 'playwright';

const APP_URL = 'http://localhost:5173';
const TEST_MESSAGE = '帮我新建一个客户档案 叫 E2E Auto Test Customer';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // 捕获 console 里审批相关的日志
  const approvalLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Approval') || text.includes('Block') || text.includes('approval')) {
      approvalLogs.push(text);
    }
  });

  console.log('=== Step 1: 登录 ===');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);

  // 检查是否已在主界面（cookie 残留）
  let bodyText = await page.textContent('body').catch(() => '');
  let needsLogin = bodyText.includes('Sign in') || bodyText.includes('Password');

  if (needsLogin) {
    const userInput = page.locator('input[placeholder*="张三"], input[placeholder*="you@company"], input[placeholder*="姓名"]').first();
    await userInput.waitFor({ state: 'visible', timeout: 10000 });
    const passInput = page.locator('input[type="password"]').first();
    await userInput.fill('admin@bambook.local');
    await passInput.fill('bambook2026');
    await page.locator('button:has-text("Sign in")').click();
    console.log('  已提交登录，等待跳转...');
    await page.waitForTimeout(5000);
  } else {
    console.log('  已登录（cookie 残留），直接进入主界面');
  }

  await page.screenshot({ path: '/tmp/e2e-after-login.png' });
  bodyText = await page.textContent('body').catch(() => '');
  const stillOnLogin = bodyText.includes('Sign in');
  console.log(`  当前在主界面: ${stillOnLogin ? '否（登录失败）' : '是'}`);
  if (stillOnLogin) {
    console.log('  ⚠️ 登录失败，终止');
    await browser.close();
    return;
  }

  // Step 2: 导航到 AI 助手，找聊天输入框并发消息
  console.log('\n=== Step 2: 进入 AI 助手并发送消息 ===');

  // 点击侧边栏的"AI 助手"
  const aiAssistantNav = page.locator('text=AI 助手').first();
  if (await aiAssistantNav.isVisible().catch(() => false)) {
    await aiAssistantNav.click();
    console.log('  已点击"AI 助手"导航');
    await page.waitForTimeout(2000);
  }

  const textarea = page.locator('textarea').first();
  const textareaVisible = await textarea.isVisible().catch(() => false);
  console.log(`  聊天输入框可见: ${textareaVisible}`);

  if (!textareaVisible) {
    // 可能 textarea 有特殊选择器，列出所有可见输入
    const allInputs = await page.$$eval('textarea, input[type="text"], input[contenteditable]', els => els.map(e => ({
      tag: e.tagName, placeholder: e.placeholder, visible: e.offsetParent !== null,
    }))).catch(() => []);
    console.log('  所有输入框:', JSON.stringify(allInputs.filter(i => i.visible)));
    console.log('  ⚠️ 未找到聊天框');
    await page.screenshot({ path: '/tmp/e2e-no-chat.png' });
    await browser.close();
    return;
  }

  await textarea.fill(TEST_MESSAGE);
  await page.waitForTimeout(500);

  // 找发送按钮或按 Enter
  const sendBtn = page.locator('button[type="submit"], button:has-text("发送")').first();
  if (await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click();
  } else {
    await textarea.press('Enter');
  }
  console.log('  已发送消息，等待 Agent 响应...');

  // Step 3: 等待审批卡片出现，然后点批准
  console.log('\n=== Step 3: 等待审批卡片 ===');
  let approvalClicked = false;
  let toolExecuted = false;

  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);

    // 检查是否有审批卡片和"批准"按钮
    if (!approvalClicked) {
      const approveBtn = page.locator('button:has-text("批准")').first();
      if (await approveBtn.isVisible().catch(() => false)) {
        console.log(`  [${i}s] 📋 发现批准按钮，点击...`);
        await approveBtn.click();
        approvalClicked = true;
        console.log('  ✅ 已点击批准');
        await page.screenshot({ path: '/tmp/e2e-approved.png' });
      }
    }

    // 检查 console 里是否有工具执行完成的日志
    if (approvalLogs.some(l => l.includes('tool_call_end') && l.includes('complete'))) {
      toolExecuted = true;
    }

    // 检查页面是否出现最终回答
    const currentText = await page.textContent('body').catch(() => '');
    if (approvalClicked && (currentText.includes('已创建') || currentText.includes('创建成功') || currentText.includes('已完成'))) {
      console.log(`  [${i}s] 检测到完成文本`);
      break;
    }

    // 如果已批准且过了一段时间，检查是否有新的 tool 执行
    if (approvalClicked && i > 20) {
      break;
    }
  }

  await page.screenshot({ path: '/tmp/e2e-final.png' });

  console.log('\n=== 结果 ===');
  console.log(`批准按钮已点击: ${approvalClicked ? '✅' : '❌'}`);
  console.log(`工具执行完成: ${toolExecuted ? '✅' : '未从 console 确认'}`);
  console.log(`审批相关日志 (${approvalLogs.length} 条):`);
  approvalLogs.slice(-10).forEach(l => console.log(`  ${l.slice(0, 120)}`));

  const finalText = await page.textContent('body').catch(() => '');
  // 找最终回答区域
  const assistantText = await page.locator('[class*="model"], [class*="assistant"], [class*="message"]').last().textContent().catch(() => '');
  console.log(`\n最终界面文本片段: ${finalText.slice(-400).replace(/\s+/g, ' ')}`);

  await browser.close();
  console.log('\n=== 测试结束 ===');
}
main().catch(e => console.error(e));
