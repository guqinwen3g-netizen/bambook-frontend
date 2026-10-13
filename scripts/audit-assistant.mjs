// audit-assistant.mjs - 专门验证 Agent 对话页面 Phase 12 改动
import { chromium } from 'playwright';

const browser = await chromium.launch({ 
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const context = await browser.newContext();
const page = await context.newPage();

try {
  console.log('=== Bambook Agent 对话页面验证 ===\n');

  // 1. 导航到首页，等待登录表单
  console.log('[1/4] 加载首页...');
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // 等待会话检查完成或登录表单出现
  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    return !text.includes('CHECKING SESSION');
  }, { timeout: 30000 });
  
  await page.waitForTimeout(2000);

  // 2. 登录
  console.log('[2/4] 登录中...');
  const emailInput = await page.$('input[placeholder*="张三"]');
  const passInput = await page.$('input[type="password"]');
  const submitBtn = await page.$('button[type="submit"]');

  if (emailInput && passInput && submitBtn) {
    await emailInput.fill('admin@bambook.local');
    await passInput.fill('bambook2026');
    await submitBtn.click();
    await page.waitForTimeout(3000);
    console.log('      ✅ 登录成功');
  } else {
    console.log('      ⚠️ 未找到登录表单，可能已登录');
  }

  // 3. 导航到 Agent 对话页面
  console.log('[3/4] 导航到 Agent 对话页面...');
  await page.goto('http://localhost:3000/#/assistant', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
  
  console.log(`      当前 URL: ${page.url()}`);
  
  // 截图保存
  await page.screenshot({ path: '/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/scripts/snapshot-assistant.png', fullPage: true });
  console.log('      ✅ 已保存截图');

  // 4. 提取关键信息验证 Phase 12 改动
  console.log('\n[4/4] 验证 Phase 12 渲染效果...\n');
  
  const pageData = await page.evaluate(() => {
    // 提取对话区域所有可见文本（去掉空白和纯数字的市场数据）
    const allText = document.body.innerText || '';
    
    // 查找所有带 block 或 agent 样式的元素
    const blockElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const className = typeof el.className === 'string' ? el.className : '';
      const hasBlockClass = className.includes('block') || className.includes('agent') || className.includes('message') || className.includes('document');
      const text = el.innerText || '';
      return hasBlockClass && text.trim().length > 0 && text.trim().length < 300;
    }).slice(0, 20).map(el => ({
      class: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      text: (el.innerText || '').trim().slice(0, 150)
    }));
    
    // 查找导航栏项
    const navItems = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = el.innerText || '';
      return text && (text.includes('Dashboard') || text.includes('Assistant') || text.includes('Agent') || text.includes('知识库') || text.includes('订单') || text.includes('客户') || text.includes('研发') || text.includes('市场'));
    }).slice(0, 20).map(el => (el.innerText || '').trim().slice(0, 50));
    
    // 查找输入区域
    const inputAreas = Array.from(document.querySelectorAll('textarea, input[type="text"]')).filter(input => {
      const text = input.placeholder || input.innerText || '';
      return text.toLowerCase().includes('agent') || text.toLowerCase().includes('bambook') || text.length > 5;
    }).map(input => ({
      placeholder: input.placeholder || '(no placeholder)',
      className: (typeof input.className === 'string' ? input.className : '').slice(0, 80)
    }));
    
    // 查找所有按钮
    const buttons = Array.from(document.querySelectorAll('button')).map(btn => ({
      text: (btn.innerText || '').trim().slice(0, 50),
      className: (typeof btn.className === 'string' ? btn.className : '').slice(0, 80),
      disabled: btn.disabled
    })).filter(b => b.text);
    
    return {
      fullText: allText.slice(0, 5000),
      blockElements,
      navItems,
      inputAreas,
      buttons: buttons.slice(0, 30),
      headings: Array.from(document.querySelectorAll('h1, h2, h3, h4')).map(h => h.innerText).filter(t => t.trim())
    };
  });
  
  // 打印分析结果
  console.log('--- 页面标题 ---');
  console.log(`${await page.title()}\n`);
  
  console.log('--- 导航菜单 ---');
  const uniqueNav = [...new Set(pageData.navItems.filter(t => t.length < 30))];
  uniqueNav.slice(0, 15).forEach(item => console.log(`  • ${item}`));
  
  console.log('\n--- 按钮列表（前20）---');
  pageData.buttons.forEach((btn, i) => {
    const status = btn.disabled ? '[禁用]' : '';
    console.log(`  ${i+1}. ${btn.text} ${status}`);
  });
  
  console.log('\n--- 输入区域 ---');
  if (pageData.inputAreas.length === 0) {
    console.log('  未找到 Agent 对话输入框（可能需要等待消息框加载）');
  } else {
    pageData.inputAreas.forEach((input, i) => {
      console.log(`  ${i+1}. ${input.placeholder}`);
    });
  }
  
  console.log('\n--- 页面主要内容预览（前2000字符）---');
  console.log(pageData.fullText.slice(0, 2000));
  
  console.log('\n--- Block 元素验证（Phase 12 关键）---');
  if (pageData.blockElements.length === 0) {
    console.log('  未检测到 block / agent / message / document 元素');
  } else {
    pageData.blockElements.forEach((block, i) => {
      console.log(`  ${i+1}. [${block.class}] ${block.text}`);
    });
  }
  
  console.log('\n=== 验证完成 ===');

} catch (error) {
  console.error('❌ 错误:', error.message);
  console.error(error.stack);
} finally {
  await browser.close();
  console.log('\n📄 截图已保存到: scripts/snapshot-assistant.png');
}
