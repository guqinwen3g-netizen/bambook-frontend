// audit-page.mjs - 使用 Playwright 提取页面内容用于产品审查
import { chromium } from 'playwright';

const url = 'http://localhost:3000';

const browser = await chromium.launch({ 
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const context = await browser.newContext();
const page = await context.newPage();

// 启用请求日志
page.on('request', req => console.log(`[REQ] ${req.method()} ${req.url()}`));
page.on('response', res => console.log(`[RES] ${res.status()} ${res.url()}`));

try {
  console.log(`导航到: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 等待会话检查完成
  console.log('\n等待会话检查完成...');
  await page.waitForFunction(() => {
    const bodyText = document.body.innerText || '';
    return !bodyText.includes('CHECKING SESSION');
  }, { timeout: 30000 });
  
  console.log('会话检查完成');
  
  // 获取页面 HTML 片段来分析登录表单结构
  const html = await page.evaluate(() => document.body.innerHTML.slice(0, 5000));
  console.log('\n=== 页面 HTML 分析 ===');
  
  // 查找 input 元素
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(input => ({
      type: input.type,
      placeholder: input.placeholder,
      name: input.name,
      className: input.className
    }));
  });
  
  console.log('找到的 input 元素:');
  inputs.forEach((input, i) => {
    console.log(`${i+1}. type="${input.type}" placeholder="${input.placeholder}" name="${input.name}" class="${input.className}"`);
  });

  // 查找 button 元素
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(btn => ({
      type: btn.type,
      text: btn.innerText?.slice(0, 30),
      className: btn.className
    }));
  });
  
  console.log('\n找到的 button 元素:');
  buttons.forEach((btn, i) => {
    console.log(`${i+1}. type="${btn.type}" text="${btn.text}" class="${btn.className}"`);
  });

  // 尝试登录
  console.log('\n=== 尝试登录 ===');
  
  // 使用正确的选择器 - 邮箱输入框是 type="text" 不是 type="email"
  const emailInputs = await page.$$('input[type="text"], input[placeholder*="张三"], input[placeholder*="email"], input[placeholder*="Email"]');
  const passInputs = await page.$$('input[type="password"], input[placeholder*="password"], input[placeholder*="Password"]');
  const submitButtons = await page.$$('button[type="submit"], button:has-text("Sign in")');

  console.log(`找到 ${emailInputs.length} 个邮箱输入框`);
  console.log(`找到 ${passInputs.length} 个密码输入框`);
  console.log(`找到 ${submitButtons.length} 个提交按钮`);

  if (emailInputs.length > 0 && passInputs.length > 0 && submitButtons.length > 0) {
    console.log('尝试填写登录表单...');
    await emailInputs[0].fill('admin@bambook.local');
    await passInputs[0].fill('bambook2026');
    
    // 等待按钮变为可用
    await page.waitForFunction(() => {
      const btn = document.querySelector('button[type="submit"]');
      return btn && !btn.disabled;
    }, { timeout: 5000 });
    
    await submitButtons[0].click();
    await page.waitForTimeout(3000);
    
    // 检查是否跳转到其他页面
    const currentUrl = page.url();
    console.log(`登录后 URL: ${currentUrl}`);
    
    if (currentUrl.includes('assistant')) {
      console.log('✅ 已成功跳转到 Agent 页面');
    } else if (currentUrl !== url) {
      console.log('✅ 页面已跳转，可能需要进一步导航');
      // 导航到 Agent 页面
      await page.goto('http://localhost:3000/#/assistant', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
    } else {
      console.log('⚠️ 页面未跳转，登录可能失败');
    }
  } else {
    console.log('❌ 未找到登录表单元素');
  }

  // 提取页面标题和关键内容
  const title = await page.title();
  console.log(`\n=== 当前页面 ===`);
  console.log(`标题: ${title}`);
  console.log(`URL: ${page.url()}`);

  // 导航到 Agent 页面
  console.log('\n=== 导航到 Agent 对话页面 ===');
  await page.goto('http://localhost:3000/#/assistant', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
  
  console.log(`\n=== Agent 页面内容 ===`);
  console.log(`标题: ${await page.title()}`);
  console.log(`URL: ${page.url()}`);
  
  // 提取 Agent 对话相关的关键元素
  const agentElements = await page.evaluate(() => {
    const agentKeywords = ['思考', '工作', '执行', 'process', 'timeline', 'tool', 'Agent', 'Bambook'];
    const relevantElements = [];

    document.querySelectorAll('*').forEach(el => {
      const text = el.innerText || '';
      const className = typeof el.className === 'string' ? el.className : '';
      const hasKeyword = agentKeywords.some(kw => text.includes(kw));
      const hasRelevantClass = className && (
        className.includes('agent') ||
        className.includes('message') ||
        className.includes('timeline') ||
        className.includes('process')
      );

      if ((hasKeyword || hasRelevantClass) && text.trim().length > 0 && text.trim().length < 200) {
        relevantElements.push({
          tag: el.tagName,
          class: className.slice(0, 80),
          text: text.trim().slice(0, 150)
        });
      }
    });

    return relevantElements.slice(0, 40);
  });
  
  console.log('\n--- Agent 相关元素 ---');
  agentElements.forEach((el, i) => {
    console.log(`${i+1}. [${el.tag}] ${el.class}: ${el.text}`);
  });
  
  // 提取按钮和输入框
  const agentButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(btn => ({
      text: btn.innerText?.slice(0, 40),
      className: (typeof btn.className === 'string' ? btn.className : '').slice(0, 50)
    })).filter(b => b.text);
  });
  
  console.log('\n--- 按钮列表 ---');
  agentButtons.slice(0, 15).forEach((btn, i) => {
    console.log(`${i+1}. "${btn.text}" - ${btn.className}`);
  });

  // 提取页面文本内容
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  console.log(`\n--- 页面内容预览 ---`);
  console.log(bodyText);

} catch (error) {
  console.error('❌ 发生错误:', error.message);
} finally {
  await browser.close();
}