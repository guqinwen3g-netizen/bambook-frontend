#!/usr/bin/env node
/**
 * sync-to-ima.js — 将知识库实体同步到 IMA 笔记
 * 单向同步：SQLite → IMA 笔记
 * 
 * 用法:
 *   node sync-to-ima.js --entity <entity_id>    # 同步单个实体
 *   node sync-to-ima.js --all                   # 同步所有实体
 *   node sync-to-ima.js --dry-run               # 预览模式
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const https = require('https');
const readline = require('readline');

// 导入安全执行工具
const { withTimeout, retry, safeDbOperation } = require('./safe-exec');

const KB_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(KB_ROOT, 'database/panda_kb.db');

// IMA API 配置
const IMA_BASE_URL = 'ima.qq.com';
const IMA_API_PATH = '/openapi/note/v1';

// 超时配置
const DB_TIMEOUT = 10000;       // 数据库操作超时 10秒
const API_TIMEOUT = 30000;      // API 调用超时 30秒
const API_RETRY_DELAY = 2000;   // API 重试间隔 2秒
const MAX_API_RETRIES = 3;      // 最大重试次数

// 加载凭证
function loadCredentials() {
  // 方式1: 环境变量
  if (process.env.IMA_OPENAPI_CLIENTID && process.env.IMA_OPENAPI_APIKEY) {
    return {
      clientId: process.env.IMA_OPENAPI_CLIENTID,
      apiKey: process.env.IMA_OPENAPI_APIKEY
    };
  }
  
  // 方式2: 配置文件
  const configPath = path.join(process.env.HOME, '.config', 'ima', 'credentials');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const lines = content.split('\n');
    return {
      clientId: lines[0]?.trim(),
      apiKey: lines[1]?.trim()
    };
  }
  
  return null;
}

// IMA API 调用（带超时和重试）
function imaApiCall(endpoint, body, timeout = API_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const credentials = loadCredentials();
    if (!credentials) {
      reject(new Error('IMA 凭证未配置'));
      return;
    }

    const postData = JSON.stringify(body);
    
    const options = {
      hostname: IMA_BASE_URL,
      port: 443,
      path: `${IMA_API_PATH}/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ima-openapi-clientid': credentials.clientId,
        'ima-openapi-apikey': credentials.apiKey,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeout  // 连接超时
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('解析响应失败: ' + e.message));
        }
      });
    });

    // 请求超时处理
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API 请求超时'));
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

// 带重试的 IMA API 调用
async function imaApiCallWithRetry(endpoint, body, maxRetries = MAX_API_RETRIES) {
  return retry(
    async () => {
      const result = await imaApiCall(endpoint, body);
      // IMA API 返回错误码也算失败，需要重试
      if (result.retcode !== 0 && result.retcode !== undefined) {
        throw new Error(`API error: ${result.errmsg || 'unknown'}`);
      }
      return result;
    },
    maxRetries,
    API_RETRY_DELAY
  );
}

// 生成短ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// 打印标题
function header(title) {
  console.log('\n' + '═'.repeat(60));
  console.log('  ' + title);
  console.log('═'.repeat(60));
}

// 角色标签映射
const ROLE_LABELS = {
  customer: '客户',
  supplier: '供应商',
  factory: '工厂',
  agent: '代理商',
  logistics: '物流',
  partner: '合作伙伴',
  institution: '机构',
  other: '其他'
};

// 构建实体 Markdown 内容
function buildEntityMarkdown(entity, roles, contacts, pos, relationships, db) {
  const primaryRole = roles.find(r => r.is_primary) || roles[0];
  const roleLabel = ROLE_LABELS[primaryRole?.role_type] || '其他';
  
  let md = `---
id: ${entity.id}
name: ${entity.name}
category: ${roleLabel}
updated: ${entity.updated_at || entity.created_at}
---

# ${entity.name}

## 基本信息
- **主角色**: ${roleLabel}
- **国家/地区**: ${entity.country || '—'} ${entity.city ? `/ ${entity.city}` : ''}
- **描述**: ${entity.description || '无'}

`;

  // 联系人
  if (contacts.length > 0) {
    md += `## 联系人\n`;
    contacts.forEach(c => {
      md += `### ${c.name}${c.role ? ` — ${c.role}` : ''}\n`;
      if (c.email) md += `- 邮箱: ${c.email}\n`;
      if (c.phone) md += `- 电话: ${c.phone}\n`;
      if (c.wechat) md += `- 微信: ${c.wechat}\n`;
      if (c.notes) md += `- 备注: ${c.notes}\n`;
      md += '\n';
    });
  }

  // 采购订单
  if (pos.length > 0) {
    md += `## 采购订单\n`;
    pos.forEach(p => {
      md += `- **${p.po_number}** (${p.status})`;
      if (p.amount) md += ` — ${p.currency} ${p.amount}`;
      if (p.season) md += ` — ${p.season}`;
      md += '\n';
    });
    md += '\n';
  }

  // 关系链路
  if (relationships.length > 0) {
    md += `## 业务关系\n`;
    relationships.forEach(r => {
      const fromEntity = db.prepare('SELECT name FROM entities WHERE id = ?').get(r.from_entity_id);
      const toEntity = db.prepare('SELECT name FROM entities WHERE id = ?').get(r.to_entity_id);
      md += `- ${fromEntity?.name} → ${toEntity?.name} (${r.type})\n`;
      if (r.description) md += `  - ${r.description}\n`;
    });
    md += '\n';
  }

  // 标签
  if (entity.tags) {
    try {
      const tags = JSON.parse(entity.tags);
      if (tags.length > 0) {
        md += `## 标签\n${tags.map(t => `\`${t}\``).join(' ')}\n\n`;
      }
    } catch (e) {}
  }

  md += `---
*同步时间: ${new Date().toISOString()}*
*来源: Panda 关系智库*
`;

  return md;
}

// 同步单个实体到 IMA（带超时和错误恢复）
async function syncEntityToIMA(entityId, db, dryRun = false) {
  // 查询实体（带超时）
  const entityResult = await safeDbOperation(() => {
    return db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
  }, DB_TIMEOUT);
  
  if (!entityResult.success || !entityResult.data) {
    console.log(`⚠️  实体不存在或查询超时: ${entityId}`);
    return null;
  }
  const entity = entityResult.data;

  // 并行查询关联数据（带超时）
  const [rolesResult, contactsResult, posResult, relationshipsResult] = await Promise.all([
    safeDbOperation(() => db.prepare('SELECT * FROM entity_roles WHERE entity_id = ?').all(entityId), DB_TIMEOUT),
    safeDbOperation(() => db.prepare('SELECT * FROM contacts WHERE entity_id = ?').all(entityId), DB_TIMEOUT),
    safeDbOperation(() => db.prepare('SELECT * FROM purchase_orders WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10').all(entityId), DB_TIMEOUT),
    safeDbOperation(() => db.prepare('SELECT * FROM relationships WHERE from_entity_id = ? OR to_entity_id = ?').all(entityId, entityId), DB_TIMEOUT)
  ]);

  const roles = rolesResult.success ? rolesResult.data : [];
  const contacts = contactsResult.success ? contactsResult.data : [];
  const pos = posResult.success ? posResult.data : [];
  const relationships = relationshipsResult.success ? relationshipsResult.data : [];

  const content = buildEntityMarkdown(entity, roles, contacts, pos, relationships, db);
  const title = `${entity.name} [${ROLE_LABELS[roles[0]?.role_type] || '其他'}]`;

  if (dryRun) {
    console.log(`\n🔍 [DRY RUN] 将同步实体: ${entity.name}`);
    console.log(`   标题: ${title}`);
    console.log(`   内容长度: ${content.length} 字符`);
    return { title, content, dryRun: true };
  }

  try {
    // 调用 IMA API（带重试）
    const result = await imaApiCallWithRetry('import_doc', {
      title: title,
      content: content,
      content_format: 1  // Markdown
    });

    if (result.success && result.data?.retcode === 0) {
      console.log(`✅ 已同步: ${entity.name} → IMA笔记 (doc_id: ${result.data.doc_id})`);
      
      // 记录同步日志（带超时）
      await safeDbOperation(() => {
        db.prepare(`
          INSERT INTO activity_logs (id, entity_id, type, description, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(genId(), entityId, 'sync', `同步到 IMA: ${result.data.doc_id}`, new Date().toISOString());
        return true;
      }, DB_TIMEOUT);
      
      return result.data;
    } else if (result.attempts && result.attempts > 1) {
      console.log(`❌ 同步失败（重试${result.attempts}次）: ${entity.name} - ${result.message || 'unknown'}`);
      return null;
    } else {
      console.log(`❌ 同步失败: ${entity.name} - ${result.message || 'unknown'}`);
      return null;
    }
  } catch (err) {
    console.log(`❌ 同步错误: ${entity.name} - ${err.message}`);
    return null;
  }
}

// 主流程
async function main() {
  header('知识库 → IMA 同步');

  // 检查凭证
  const credentials = loadCredentials();
  if (!credentials) {
    console.log('\n❌ IMA 凭证未配置');
    console.log('\n配置方式1 - 环境变量:');
    console.log('   export IMA_OPENAPI_CLIENTID="your_client_id"');
    console.log('   export IMA_OPENAPI_APIKEY="your_api_key"');
    console.log('\n配置方式2 - 配置文件:');
    console.log('   mkdir -p ~/.config/ima');
    console.log('   echo "your_client_id" > ~/.config/ima/credentials');
    console.log('   echo "your_api_key" >> ~/.config/ima/credentials');
    return;
  }

  console.log('\n✅ IMA 凭证已加载');

  let db;
  try {
    // 连接数据库（带超时保护）
    const dbResult = await safeDbOperation(() => {
      return new Database(DB_PATH);
    }, DB_TIMEOUT);
    
    if (!dbResult.success) {
      console.log('❌ 数据库连接失败:', dbResult.error?.message || 'timeout');
      return;
    }
    db = dbResult.data;
    
    // 解析参数
    const args = process.argv.slice(2);
    const entityId = args[args.indexOf('--entity') + 1];
    const syncAll = args.includes('--all');
    const dryRun = args.includes('--dry-run');

    if (dryRun) {
      console.log('🔍 [DRY RUN] 预览模式，不实际写入 IMA');
    }

    if (entityId) {
      // 同步单个实体
      console.log(`\n📌 同步单个实体: ${entityId}`);
      await syncEntityToIMA(entityId, db, dryRun);
    } else if (syncAll) {
      // 同步所有实体（带超时保护）
      const entitiesResult = await safeDbOperation(() => {
        return db.prepare('SELECT id, name FROM entities').all();
      }, DB_TIMEOUT);
      
      if (!entitiesResult.success) {
        console.log('❌ 获取实体列表失败:', entitiesResult.error?.message || 'timeout');
        db.close();
        return;
      }
      
      const entities = entitiesResult.data;
      console.log(`\n📌 同步所有实体 (${entities.length} 个)`);
      
      let success = 0;
      let failed = 0;
      let skipped = 0;
      
      for (const entity of entities) {
        try {
          const result = await syncEntityToIMA(entity.id, db, dryRun);
          if (result) success++;
          else failed++;
        } catch (err) {
          console.log(`⚠️  同步异常: ${entity.name} - ${err.message}`);
          failed++;
        }
        
        // 限流，避免 API 限制
        if (!dryRun) await new Promise(r => setTimeout(r, 500));
      }
      
      console.log(`\n📊 同步完成: ${success} 成功, ${failed} 失败`);
    } else {
      // 显示帮助
      console.log('\n💡 使用方式:');
      console.log('   node sync-to-ima.js --entity <entity_id>');
      console.log('   node sync-to-ima.js --all');
      console.log('   node sync-to-ima.js --entity <entity_id> --dry-run');
      console.log('\n可用实体:');
      
      const entitiesResult = await safeDbOperation(() => {
        return db.prepare('SELECT id, name FROM entities LIMIT 10').all();
      }, DB_TIMEOUT);
      
      if (entitiesResult.success) {
        entitiesResult.data.forEach(e => {
          console.log(`   ${e.id.slice(0, 8)}... - ${e.name}`);
        });
      } else {
        console.log('   (无法获取实体列表)');
      }
    }

    db.close();
    
  } catch (err) {
    console.error('❌ 错误:', err.message);
    if (db) {
      try { db.close(); } catch (e) { /* ignore */ }
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
