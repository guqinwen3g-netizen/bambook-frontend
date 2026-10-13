#!/usr/bin/env node
/**
 * extract-entities-from-email.js — 从邮件中自动提炼实体和关系
 * 用法: node extract-entities-from-email.js [选项]
 * 
 * 选项:
 *   --email <email>     邮箱地址
 *   --password <pwd>    邮箱密码/授权码
 *   --host <host>       IMAP 主机 (默认: imap.qiye.aliyun.com)
 *   --box <box>         邮箱文件夹 (默认: INBOX)
 *   --limit <n>         扫描邮件数量 (默认: 50)
 *   --dry-run           仅显示提取结果，不写入数据库
 *   --interactive       交互模式，逐封确认
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');

// 配置
const KB_ROOT = path.join(__dirname, '..');

// 尝试加载 Prisma
let prisma = null;
const PRISMA_PATH = path.join(KB_ROOT, 'bambook-frontend', 'server');
const loadPrisma = async () => {
  if (fs.existsSync(path.join(PRISMA_PATH, 'node_modules', '@prisma', 'client'))) {
    try {
      const originalCwd = process.cwd();
      process.chdir(PRISMA_PATH);
      const envPath = path.join(PRISMA_PATH, '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        envContent.split('\n').forEach(line => {
          const [key, ...rest] = line.split('=');
          if (key && rest.length > 0 && !process.env[key]) {
            process.env[key] = rest.join('=').trim();
          }
        });
      }
      const { PrismaClient } = require('@prisma/client');
      prisma = new PrismaClient();
      process.chdir(originalCwd);
      return true;
    } catch (err) {
      console.log('⚠️ Prisma 加载失败:', err.message);
      return false;
    }
  }
  return false;
};

// SQLite (better-sqlite3)
let sqliteDb = null;
const loadSqlite = () => {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(KB_ROOT, 'database/panda_kb.db');
    if (fs.existsSync(dbPath)) {
      sqliteDb = new Database(dbPath);
      return true;
    }
  } catch (err) {
    console.log('⚠️ SQLite 加载失败:', err.message);
  }
  return false;
};

// 命令行参数解析
const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : defaultVal;
};

const EMAIL = getArg('email', '');
const PASSWORD = getArg('password', '');
const HOST = getArg('host', 'imap.qiye.aliyun.com');
const PORT = parseInt(getArg('port', '993')) || 993;
const BOX = getArg('box', 'INBOX');
const LIMIT = parseInt(getArg('limit', '50')) || 50;
const DRY_RUN = args.includes('--dry-run');
const INTERACTIVE = args.includes('--interactive');

// 简单输入
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// 打印标题
function header(title) {
  console.log('\n' + '═'.repeat(60));
  console.log('  ' + title);
  console.log('═'.repeat(60));
}

// 生成短ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ============================================================
// 实体提取规则引擎 (简化版 LLM-free 方案)
// ============================================================

// 常见公司名称模式
const COMPANY_PATTERNS = [
  /(?:公司|Company|Co\.|Ltd\.|Inc\.|Corp\.|Limited|LLC)[\s,，]?/g,
  /(?:供应商|厂商|工厂|Factory|Supplier|Vendor)[\s:：]?\s*([^\s，,。\n]{2,20})/gi,
  /(?:客户| Customer|Buyer|Client)[\s:：]?\s*([^\s，,。\n]{2,20})/gi,
  /(?:来自|致|收件人|发件人|To:|From:|Sent To:|Sent By:)[\s]*([^\s<@]+@[^\s>]+)/gi,
];

// 邮箱地址提取
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// 联系方式提取
const PHONE_PATTERNS = [
  /电话[\s:：]*([+\d\s\-()]{8,20})/g,
  /Tel[\s:：]*([+\d\s\-()]{8,20})/gi,
  /Phone[\s:：]*([+\d\s\-()]{8,20})/gi,
  /\+?86[\s.-]?(\d{3,4})[\s.-]?(\d{3,4})[\s.-]?(\d{4})/g,
  /(\d{3,4})[-.]?(\d{3,4})[-.]?(\d{4})/g,
];

// 金额提取
const AMOUNT_PATTERNS = [
  /\$\s*([\d,]+(?:\.\d{2})?)/g,
  /USD\s*([\d,]+(?:\.\d{2})?)/gi,
  /CNY\s*([\d,]+(?:\.\d{2})?)/gi,
  /人民币[\s¥]*([\d,]+(?:\.\d{2})?)/gi,
  /([\d,]+(?:\.\d{2})?)\s*(?:美元|USD)/gi,
];

// 从文本中提取实体
function extractEntities(text) {
  const entities = [];
  const emails = text.match(EMAIL_PATTERN) || [];
  
  // 提取邮箱作为联系人
  emails.forEach(email => {
    const name = email.split('@')[0].replace(/[._-]/g, ' ');
    entities.push({
      type: 'contact',
      name: capitalizeFirst(name),
      value: email,
      source: 'email'
    });
  });

  // 提取电话号码
  PHONE_PATTERNS.forEach(pattern => {
    const matches = text.match(pattern) || [];
    matches.forEach(match => {
      const phone = match.replace(/电话|Tel|Phone[\s:：]*/gi, '').trim();
      if (phone.length >= 7) {
        entities.push({
          type: 'phone',
          name: phone,
          value: phone,
          source: 'text'
        });
      }
    });
  });

  // 提取金额
  const amounts = [];
  AMOUNT_PATTERNS.forEach(pattern => {
    const matches = text.match(pattern) || [];
    matches.forEach(match => {
      const amount = match.replace(/[$,CNY人民币USD]/g, '').trim();
      amounts.push(parseFloat(amount.replace(/,/g, '')));
    });
  });

  // 提取公司名称 (简单规则)
  const companyPatterns = [
    /([A-Z][a-zA-Z\s]+(?:Company|Co\.|Ltd\.|Inc\.|Corp\.))/g,
    /([\u4e00-\u9fa5]{3,20}(?:公司|集团|工厂|企业))/g,
  ];
  const seenCompanies = new Set();
  companyPatterns.forEach(pattern => {
    const matches = text.match(pattern) || [];
    matches.forEach(match => {
      const clean = match.trim();
      if (!seenCompanies.has(clean) && clean.length >= 2) {
        seenCompanies.add(clean);
        entities.push({
          type: 'company',
          name: clean,
          value: clean,
          source: 'text'
        });
      }
    });
  });

  return { entities, amounts };
}

// 关系提取
function extractRelations(text, entities) {
  const relations = [];
  
  // 供应关系
  if (/供应|ship|deliver|shipment|供货/i.test(text)) {
    const supplierEntity = entities.find(e => e.type === 'company');
    if (supplierEntity) {
      relations.push({
        type: 'supplies',
        from: supplierEntity.name,
        description: '供应关系'
      });
    }
  }

  // 采购关系
  if (/订单|order|采购|purchase|buy/i.test(text)) {
    relations.push({
      type: 'purchases',
      description: '采购/订单关系'
    });
  }

  // 询价/报价
  if (/询价|quote|报价|price|报价/i.test(text)) {
    relations.push({
      type: 'quotes',
      description: '询价/报价'
    });
  }

  return relations;
}

// 首字母大写
function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  header('邮件实体提炼');

  // 1. 检查凭证
  let email = EMAIL;
  let password = PASSWORD;
  
  if (!email) {
    email = await ask('📧 邮箱地址: ');
  }
  if (!password) {
    password = await ask('🔑 密码/授权码 (应用密码): ');
  }

  if (!email || !password) {
    console.log('❌ 邮箱和密码不能为空');
    return;
  }

  // 2. 加载数据库
  console.log('\n📦 加载数据库...');
  const prismaLoaded = await loadPrisma();
  const sqliteLoaded = loadSqlite();
  
  if (!prismaLoaded && !sqliteLoaded) {
    console.log('❌ 无法连接数据库 (SQLite/PostgreSQL)');
    return;
  }

  console.log(`   SQLite: ${sqliteLoaded ? '✅' : '❌'}`);
  console.log(`   PostgreSQL: ${prismaLoaded ? '✅' : '❌'}`);

  // 3. 连接 IMAP
  header('连接邮箱');
  console.log(`   主机: ${HOST}:${PORT}`);
  console.log(`   邮箱: ${email}`);
  console.log(`   文件夹: ${BOX}`);

  const config = {
    imap: {
      user: email,
      password: password,
      host: HOST,
      port: PORT,
      tls: true,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection;
  try {
    connection = await imaps.connect(config);
    console.log('✅ 邮箱连接成功');
  } catch (err) {
    console.log('❌ 连接失败:', err.message);
    return;
  }

  // 4. 获取邮件列表
  header(`扫描邮件 (${BOX})`);
  
  try {
    await connection.openBox(BOX);
    
    // 获取最新邮件
    const searchCriteria = ['ALL'];
    const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: false };
    
    const messages = await connection.search(searchCriteria, fetchOptions);
    console.log(`   总邮件数: ${messages.length}`);
    
    // 取最新的 N 封
    const recentMessages = messages.slice(-LIMIT);
    console.log(`   扫描数量: ${recentMessages.length}`);

    // 5. 逐封提取
    header('实体提炼结果');
    
    const allExtracted = [];
    
    for (let i = 0; i < recentMessages.length; i++) {
      const msg = recentMessages[i];
      
      // 获取邮件内容
      const header = msg.parts.find(p => p.which === 'HEADER');
      const body = msg.parts.find(p => p.which === 'TEXT');
      
      const subject = header?.body?.subject?.[0] || '(无主题)';
      const from = header?.body?.from?.[0] || '';
      const date = header?.body?.date?.[0] || '';
      const textContent = typeof body?.body === 'string' ? body.body : '';
      
      console.log(`\n📧 [${i + 1}/${recentMessages.length}] ${subject}`);
      console.log(`   发件人: ${from}`);
      console.log(`   时间: ${date}`);

      // 提取实体
      const { entities, amounts } = extractEntities(textContent);
      const relations = extractRelations(textContent, entities);

      if (entities.length === 0 && amounts.length === 0) {
        console.log('   ⚪ 无明显实体');
        continue;
      }

      // 显示提取结果
      console.log(`   ✅ 提取到:`);
      
      const uniqueEntities = [];
      const seenValues = new Set();
      entities.forEach(e => {
        if (!seenValues.has(e.value)) {
          seenValues.add(e.value);
          uniqueEntities.push(e);
        }
      });

      uniqueEntities.forEach(e => {
        console.log(`      - [${e.type}] ${e.name}`);
      });

      if (amounts.length > 0) {
        console.log(`      - [金额] $${Math.max(...amounts).toLocaleString()}`);
      }

      allExtracted.push({
        subject,
        from,
        date,
        entities: uniqueEntities,
        amounts,
        relations
      });

      // 交互模式
      if (INTERACTIVE) {
        const save = await ask('   保存到知识库? (y/n) [n]: ');
        if (save.toLowerCase() === 'y') {
          await saveToDatabase(uniqueEntities, amounts, relations, subject);
        }
      }
    }

    // 6. 批量保存 (非交互模式)
    if (!INTERACTIVE && allExtracted.length > 0 && !DRY_RUN) {
      const save = await ask(`\n💾 将 ${allExtracted.length} 封邮件的实体保存到知识库? (y/n) [y]: `);
      if (save.toLowerCase() !== 'n') {
        for (const extracted of allExtracted) {
          await saveToDatabase(extracted.entities, extracted.amounts, extracted.relations, extracted.subject);
        }
        console.log('✅ 批量保存完成');
      }
    }

    // Dry run 模式
    if (DRY_RUN) {
      console.log('\n🔍 [DRY RUN] 未写入数据库');
    }

  } catch (err) {
    console.log('❌ 扫描失败:', err.message);
  }

  // 清理
  connection.end();
  if (prisma) await prisma.$disconnect();
  if (sqliteDb) sqliteDb.close();

  header('完成');
  console.log(`   处理邮件: ${allExtracted?.length || 0} 封`);
  console.log(`   模式: ${DRY_RUN ? 'DRY RUN' : INTERACTIVE ? 'INTERACTIVE' : 'BATCH'}`);
}

// 保存到数据库
async function saveToDatabase(entities, amounts, relations, sourceEmail) {
  const timestamp = Date.now();
  const now = new Date().toISOString();
  const entityId = genId();

  // SQLite 写入
  if (sqliteDb) {
    try {
      // 保存为 Relation (使用 email 作为标识)
      const emailEntity = entities.find(e => e.type === 'email');
      const companyEntity = entities.find(e => e.type === 'company');
      const name = companyEntity?.name || emailEntity?.name || sourceEmail.substring(0, 30);
      
      sqliteDb.prepare(`
        INSERT OR IGNORE INTO entities (id, name, type, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entityId, name, 'extracted', `从邮件 "${sourceEmail}" 提取`, now, now);
      
      console.log(`   ✅ SQLite: ${name}`);
    } catch (err) {
      console.log(`   ⚠️ SQLite 写入失败: ${err.message}`);
    }
  }

  // PostgreSQL 写入
  if (prisma) {
    try {
      const emailEntity = entities.find(e => e.type === 'email');
      const companyEntity = entities.find(e => e.type === 'company');
      const phoneEntity = entities.find(e => e.type === 'phone');
      
      const name = companyEntity?.name || emailEntity?.name || sourceEmail.substring(0, 30);
      const contactInfo = phoneEntity?.value || emailEntity?.value || '';
      
      await prisma.relation.upsert({
        where: { id: entityId },
        update: {
          lastInteraction: timestamp,
          preferences: JSON.stringify({
            sourceEmail,
            extractedEntities: entities,
            amounts,
            relations,
            extractedAt: now
          })
        },
        create: {
          id: entityId,
          name,
          category: 'Other',
          type: 'Partner',
          isOrganization: !!(companyEntity),
          tags: ['extracted-from-email'],
          contactInfo,
          rating: 0,
          lastInteraction: timestamp,
          preferences: JSON.stringify({
            sourceEmail,
            extractedEntities: entities,
            amounts,
            relations,
            extractedAt: now
          })
        }
      });
      console.log(`   ✅ PostgreSQL: ${name}`);
    } catch (err) {
      console.log(`   ⚠️ PostgreSQL 写入失败: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
