#!/usr/bin/env node
/**
 * add-entity.js — 交互式录入实体到知识库
 * 支持双写：SQLite (原有) + PostgreSQL (Prisma via bambook-frontend/server)
 * 用法: node add-entity.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { PrismaClient } = require('@prisma/client');

const KB_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(KB_ROOT, 'database/panda_kb.db');

// 尝试加载 Prisma (位于 bambook-frontend/server)
// 注意：需要先运行 `cd server && npx prisma generate` 生成客户端
let prisma = null;
const PRISMA_PATH = path.join(KB_ROOT, 'bambook-frontend', 'server');
const nodeModulesPath = path.join(PRISMA_PATH, 'node_modules', '@prisma', 'client');

if (fs.existsSync(nodeModulesPath) || fs.existsSync(path.join(PRISMA_PATH, 'node_modules', '.prisma'))) {
  try {
    // 动态加载 PrismaClient
    const originalCwd = process.cwd();
    process.chdir(PRISMA_PATH);
    
    // 加载 .env
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
    console.log('✅ PostgreSQL (Prisma) 连接就绪');
  } catch (err) {
    console.log('⚠️ PostgreSQL 不可用，仅使用 SQLite:', err.message);
  }
} else {
  console.log('⚠️ Prisma 客户端未生成 (cd server && npx prisma generate)，跳过 PostgreSQL');
  console.log('   当前仅写入 SQLite');
}

// 实体角色枚举
const ROLE_TYPES = ['customer', 'supplier', 'factory', 'agent', 'logistics', 'partner', 'institution', 'other'];
// 关系类型枚举
const REL_TYPES = ['supplies', 'purchases', 'agents', 'ships', 'collaborates', 'pays', 'processes'];
// 国家列表（常用）
const COMMON_COUNTRIES = ['中国', '美国', '加拿大', '英国', '德国', '法国', '意大利', '日本', '韩国', '越南', '孟加拉国', '印度', '印度尼西亚', '波兰', '荷兰', '西班牙', '澳大利亚', '中国香港', '中国台湾'];

// 简单输入函数
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// 生成短ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// 打印标题
function header(title) {
  console.log('\n' + '═'.repeat(50));
  console.log('  ' + title);
  console.log('═'.repeat(50));
}

// 打印选项
function printOptions(items, def) {
  items.forEach((item, i) => {
    const sel = item === def ? ' ◀' : '  ';
    console.log(`${sel} ${i + 1}. ${item}`);
  });
}

async function main() {
  const db = new Database(DB_PATH);

  header('新增实体');

  // 1. 基本信息
  const name = await ask('\n公司/实体名称: ');
  if (!name) { console.log('❌ 名称不能为空'); db.close(); return; }

  console.log('\n[所在地区]');
  printOptions(COMMON_COUNTRIES, '中国');
  const countryIdx = await ask(`选择或输入 [1]: `);
  const country = countryIdx
    ? (parseInt(countryIdx) > 0 ? COMMON_COUNTRIES[parseInt(countryIdx) - 1] : countryIdx)
    : '中国';

  const city = await ask('城市: ');

  const description = await ask('简要描述: ');
  const tagsRaw = await ask('标签（逗号分隔，可留空）: ');

  // 2. 多角色选择
  header('角色（可多选，用逗号分隔，如 1,3,5）');
  printOptions(ROLE_TYPES, '');
  const roleSel = await ask('\n选择角色: ');
  const selectedRoles = roleSel
    ? roleSel.split(',').map(s => ROLE_TYPES[parseInt(s.trim()) - 1]).filter(Boolean)
    : [];
  if (selectedRoles.length === 0) {
    console.log('⚠️ 未选择角色，设为 other');
    selectedRoles.push('other');
  }

  // 3. 主角色
  console.log('\n[主角色]');
  printOptions(selectedRoles, selectedRoles[0]);
  const primaryIdx = await ask(`选择主角色 [1]: `);
  const primaryRole = selectedRoles[parseInt(primaryIdx || '1') - 1] || selectedRoles[0];

  // 4. 关系
  header('关系（可选，跳过直接回车）');
  console.log('\n查找已存在的实体建立关系:');
  const existing = db.prepare('SELECT id, name, type FROM entities').all();
  if (existing.length > 0) {
    existing.forEach(e => console.log(`  - ${e.name} (${e.type || '未分类'})`));
  } else {
    console.log('  (暂无已存实体)');
  }
  console.log('\n[关系方向]');
  console.log('  1. 本实体 → 另一实体（本实体是供应方/服务方）');
  console.log('  2. 另一实体 → 本实体（另一实体是供应方/服务方）');
  const direction = await ask('选择 [1]: ');
  const isFrom = direction !== '2';

  console.log('\n[关系类型]');
  printOptions(REL_TYPES, 'supplies');
  const relIdx = await ask('选择类型 [1]: ');
  const relType = REL_TYPES[parseInt(relIdx || '1') - 1] || 'supplies';

  const targetName = await ask('\n关联目标实体名称: ');
  let targetEntity = existing.find(e => e.name.toLowerCase() === targetName.toLowerCase());
  if (!targetEntity && targetName) {
    // 自动创建目标实体
    const newId = genId();
    db.prepare('INSERT INTO entities (id, name, country, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      newId, targetName, '', '', new Date().toISOString(), new Date().toISOString()
    );
    targetEntity = { id: newId, name: targetName };
    console.log(`✅ 自动创建目标实体: ${targetName}`);
  }

  const relDesc = await ask('关系说明（如"供应面料"）: ');

  // 5. 联系人
  header('联系人（可选，跳过直接回车）');
  const contacts = [];
  let addMore = true;
  while (addMore) {
    const cName = await ask('\n姓名（留空结束）: ');
    if (!cName) { addMore = false; continue; }
    const cRole = await ask('职位: ');
    const cEmail = await ask('邮箱: ');
    const cPhone = await ask('电话: ');
    const cWechat = await ask('微信: ');
    const cNotes = await ask('备注: ');
    contacts.push({ name: cName, role: cRole, email: cEmail, phone: cPhone, wechat: cWechat, notes: cNotes });
    addMore = (await ask('继续添加联系人？(y/n) [n]: ')).toLowerCase() === 'y';
  }

  // 6. 备注
  header('附加信息（可选）');
  const extraNotes = await ask('\n附加备注: ');

  // === 写入数据库 ===
  const entityId = genId();
  const now = new Date().toISOString();
  const tags = tagsRaw ? JSON.stringify(tagsRaw.split(',').map(t => t.trim()).filter(Boolean)) : null;

  // 插入实体
  db.prepare(`
    INSERT INTO entities (id, name, country, city, description, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entityId, name, country, city, description, tags, now, now);

  // 插入角色
  selectedRoles.forEach((role, i) => {
    db.prepare(`
      INSERT INTO entity_roles (id, entity_id, role_type, is_primary, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(genId(), entityId, role, role === primaryRole ? 1 : 0, '', now);
  });

  // 插入关系
  if (targetEntity && relType) {
    const fromId = isFrom ? entityId : targetEntity.id;
    const toId = isFrom ? targetEntity.id : entityId;
    db.prepare(`
      INSERT INTO relationships (id, from_entity_id, to_entity_id, type, description, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(genId(), fromId, toId, relType, relDesc, '', now);
  }

  // 插入联系人
  contacts.forEach(c => {
    db.prepare(`
      INSERT INTO contacts (id, entity_id, name, role, email, phone, wechat, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genId(), entityId, c.name, c.role, c.email, c.phone, c.wechat, c.notes, now);
  });

  // 记录活动日志
  db.prepare(`
    INSERT INTO activity_logs (id, entity_id, type, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(genId(), entityId, 'record', `实体录入: ${name}`, now);

  // === 双写 PostgreSQL (Prisma) ===
  if (prisma) {
    try {
      const timestamp = Date.now();
      
      // 角色映射
      const roleMap = {
        'supplier': 'Supplier',
        'customer': 'Customer',
        'agent': 'Agent',
        'partner': 'Partner',
        'factory': 'Supplier',
        'logistics': 'Partner',
        'institution': 'Government',
        'other': 'Other'
      };
      const mappedCategory = roleMap[selectedRoles[0]] || 'Other';
      
      // 主联系方式
      const primaryContact = contacts.length > 0 
        ? contacts.map(c => `${c.name}${c.role ? ` (${c.role})` : ''}: ${c.email || c.phone || c.wechat || ''}`).join('; ')
        : '';
      
      const relationData = {
        id: entityId,
        name: name,
        category: mappedCategory,
        type: mappedCategory === 'Supplier' ? 'Supplier' : mappedCategory === 'Customer' ? 'Customer' : 'Partner',
        isOrganization: true,
        tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
        contactInfo: primaryContact || country,
        rating: 0,
        lastInteraction: timestamp,
        // 组织专属字段
        officialAddress: city ? `${country} ${city}` : country,
        preferences: JSON.stringify({
          country,
          city,
          description,
          roles: selectedRoles,
          primaryRole,
          extraNotes,
          allContacts: contacts,
          relationWith: targetEntity ? {
            name: targetEntity.name,
            type: relType,
            direction: isFrom ? 'outgoing' : 'incoming',
            description: relDesc
          } : null
        })
      };
      
      await prisma.relation.upsert({
        where: { id: entityId },
        update: relationData,
        create: relationData
      });
      console.log('✅ PostgreSQL 写入成功');
    } catch (err) {
      console.log('⚠️ PostgreSQL 写入失败:', err.message);
    }
  }

  // 7. 同步写入 Markdown 详情文件
  const mdDir = path.join(KB_ROOT, 'entities');
  if (!fs.existsSync(mdDir)) fs.mkdirSync(mdDir, { recursive: true });
  
  const contactDetails = contacts.length > 0 
    ? contacts.map(c => `
### ${c.name}${c.role ? ` — ${c.role}` : ''}
- 邮箱: ${c.email || '无'}
- 电话: ${c.phone || '无'}
- 微信: ${c.wechat || '无'}
- 备注: ${c.notes || '无'}`).join('\n')
    : '- 暂无联系人';
  
  const relationDetails = targetEntity
    ? `- **${isFrom ? '→' : '←'} ${targetEntity.name}** (${relType})`
    : '- 暂无关联关系';

  const tagList = tagsRaw
    ? tagsRaw.split(',').map(t => `\`${t.trim()}\``).join(' ')
    : '无';

  const mdContent = `# ${name}

## 基本信息
- **ID**: \`${entityId}\`
- **主角色**: ${primaryRole} ${primaryRole !== selectedRoles[0] ? `(兼: ${selectedRoles.join(', ')})` : ''}
- **国家/地区**: ${country}${city ? ` / ${city}` : ''}
- **描述**: ${description || '无'}

## 联系人
${contactDetails}

## 业务关系
${relationDetails}
${relDesc ? `  - 说明: ${relDesc}` : ''}

## 标签
${tagList}

## 附加备注
${extraNotes || '无'}

---

*录入时间: ${now}*  
*数据源: SQLite${prisma ? ' + PostgreSQL' : ''}*
`;
  fs.writeFileSync(path.join(mdDir, `${entityId}_detail.md`), mdContent, 'utf-8');

  db.close();
  if (prisma) await prisma.$disconnect();

  console.log('\n' + '═'.repeat(50));
  console.log('  ✅ 实体录入成功！');
  console.log('═'.repeat(50));
  console.log(`  实体ID:   ${entityId}`);
  console.log(`  名称:     ${name}`);
  console.log(`  角色:     ${selectedRoles.join(', ')} [主: ${primaryRole}]`);
  console.log(`  联系人:   ${contacts.length} 人`);
  console.log(`  Markdown: entities/${entityId}_detail.md`);
  console.log(`  数据源:   SQLite${prisma ? ' + PostgreSQL' : ''}`);
  console.log('═'.repeat(50));
}

main().catch(err => { console.error('❌ 错误:', err.message); process.exit(1); });
