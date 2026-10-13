#!/usr/bin/env node
/**
 * link-document.js — 原文档归档与关联
 * 将 PDF/Word/Excel/PPT 等原文档归档到知识库，并关联到实体
 * 
 * 用法: 
 *   node link-document.js --file /path/to/doc.pdf --entity <entity_id>
 *   node link-document.js --scan /path/to/folder --entity <entity_id>
 *   node link-document.js --list <entity_id>
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// 导入安全执行工具
const { withTimeout, safeDbOperation, safeFileOperation } = require('./safe-exec');

const KB_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(KB_ROOT, 'database/panda_kb.db');
const DOCS_ROOT = path.join(KB_ROOT, 'docs');

// 超时配置
const DB_TIMEOUT = 10000;      // 数据库操作超时 10秒
const FILE_TIMEOUT = 5000;     // 文件操作超时 5秒
const COPY_TIMEOUT = 30000;    // 大文件复制超时 30秒

// 支持的文件类型
const SUPPORTED_TYPES = {
  '.pdf': { type: 'pdf', mime: 'application/pdf' },
  '.doc': { type: 'word', mime: 'application/msword' },
  '.docx': { type: 'word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xls': { type: 'excel', mime: 'application/vnd.ms-excel' },
  '.xlsx': { type: 'excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.ppt': { type: 'ppt', mime: 'application/vnd.ms-powerpoint' },
  '.pptx': { type: 'ppt', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.txt': { type: 'text', mime: 'text/plain' },
  '.md': { type: 'markdown', mime: 'text/markdown' },
  '.jpg': { type: 'image', mime: 'image/jpeg' },
  '.jpeg': { type: 'image', mime: 'image/jpeg' },
  '.png': { type: 'image', mime: 'image/png' },
};

// 命令行参数解析
const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : defaultVal;
};

const FILE_PATH = getArg('file', '');
const SCAN_DIR = getArg('scan', '');
const ENTITY_ID = getArg('entity', '');
const LIST_ENTITY = getArg('list', '');
const DRY_RUN = args.includes('--dry-run');

// 简单输入
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
  console.log('\n' + '═'.repeat(60));
  console.log('  ' + title);
  console.log('═'.repeat(60));
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// 获取文件类型信息
function getFileTypeInfo(filename) {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_TYPES[ext] || { type: 'unknown', mime: 'application/octet-stream' };
}

// 创建归档目录结构（带超时保护）
async function ensureArchiveDir(entityId, docType) {
  const typeDir = {
    'pdf': 'purchase_orders',
    'word': 'contracts',
    'excel': 'invoices',
    'ppt': 'presentations',
    'image': 'samples',
    'text': 'notes',
    'markdown': 'notes',
  }[docType] || 'misc';
  
  const archiveDir = path.join(DOCS_ROOT, typeDir, entityId);
  
  const result = await safeFileOperation(async () => {
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }
    return archiveDir;
  }, FILE_TIMEOUT);
  
  if (!result.success) {
    throw new Error(`创建目录失败: ${result.error?.message || 'timeout'}`);
  }
  
  return result.data;
}

// 归档单个文件（带超时和错误恢复）
async function archiveFile(filePath, entityId, db) {
  const filename = path.basename(filePath);
  const fileInfo = getFileTypeInfo(filename);
  
  if (fileInfo.type === 'unknown') {
    console.log(`⚠️  不支持的文件类型: ${filename}`);
    return null;
  }

  // 获取文件信息（带超时）
  const statsResult = await safeFileOperation(() => fs.statSync(filePath), FILE_TIMEOUT);
  if (!statsResult.success) {
    console.log(`❌ 无法读取文件: ${filename} (${statsResult.error?.message || 'timeout'})`);
    return null;
  }
  const stats = statsResult.data;

  // 创建归档目录
  let archiveDir;
  try {
    archiveDir = await ensureArchiveDir(entityId, fileInfo.type);
  } catch (err) {
    console.log(`❌ 创建目录失败: ${err.message}`);
    return null;
  }
  
  // 生成唯一文件名（避免冲突）
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const uniqueName = `${timestamp}_${filename}`;
  const destPath = path.join(archiveDir, uniqueName);
  
  // 相对路径（存储在数据库中）
  const relativePath = path.relative(KB_ROOT, destPath);

  if (!DRY_RUN) {
    // 复制文件到归档目录（带超时，大文件用更长超时）
    const copyTimeout = stats.size > 10 * 1024 * 1024 ? COPY_TIMEOUT * 2 : COPY_TIMEOUT;
    const copyResult = await safeFileOperation(() => {
      fs.copyFileSync(filePath, destPath);
      return destPath;
    }, copyTimeout);
    
    if (!copyResult.success) {
      console.log(`❌ 复制文件失败: ${filename} (${copyResult.error?.message || 'timeout'})`);
      // 清理可能的部分文件
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch (e) { /* ignore */ }
      return null;
    }
    
    // 写入数据库（带超时）
    const dbResult = await safeDbOperation(() => {
      const docId = genId();
      db.prepare(`
        INSERT INTO documents (id, entity_id, filename, file_type, file_path, file_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(docId, entityId, filename, fileInfo.type, relativePath, stats.size, new Date().toISOString());
      
      // 记录活动日志
      db.prepare(`
        INSERT INTO activity_logs (id, entity_id, type, description, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(genId(), entityId, 'document', `归档文档: ${filename}`, new Date().toISOString());
      
      return docId;
    }, DB_TIMEOUT);
    
    if (!dbResult.success) {
      console.log(`❌ 数据库写入失败: ${dbResult.error?.message || 'timeout'}`);
      // 回滚：删除已复制的文件
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch (e) { /* ignore */ }
      return null;
    }
  }

  return {
    filename,
    type: fileInfo.type,
    size: formatSize(stats.size),
    path: relativePath
  };
}

// 扫描目录并归档（带超时保护）
async function scanAndArchive(dirPath, entityId, db) {
  // 读取目录（带超时）
  const readResult = await safeFileOperation(() => fs.readdirSync(dirPath), FILE_TIMEOUT);
  if (!readResult.success) {
    throw new Error(`读取目录失败: ${readResult.error?.message || 'timeout'}`);
  }
  
  const files = readResult.data;
  const archived = [];
  const failed = [];
  
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    
    // 检查文件类型（带超时）
    const statResult = await safeFileOperation(() => fs.statSync(fullPath), FILE_TIMEOUT);
    if (!statResult.success) {
      console.log(`⚠️  无法读取: ${file}，跳过`);
      failed.push({ file, reason: 'stat failed' });
      continue;
    }
    
    if (statResult.data.isFile()) {
      try {
        const result = await archiveFile(fullPath, entityId, db);
        if (result) {
          archived.push(result);
        } else {
          failed.push({ file, reason: 'archive failed' });
        }
      } catch (err) {
        console.log(`⚠️  归档失败: ${file} - ${err.message}`);
        failed.push({ file, reason: err.message });
      }
    }
  }
  
  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} 个文件处理失败`);
  }
  
  return archived;
}

// 列出实体的文档（带超时保护）
async function listDocuments(entityId, db) {
  const result = await safeDbOperation(() => {
    return db.prepare(`
      SELECT * FROM documents WHERE entity_id = ? ORDER BY created_at DESC
    `).all(entityId);
  }, DB_TIMEOUT);
  
  if (!result.success) {
    throw new Error(`查询失败: ${result.error?.message || 'timeout'}`);
  }
  
  return result.data;
}

// 主流程
async function main() {
  header('原文档归档');

  let db;
  try {
    // 连接数据库（带超时保护）
    const dbResult = await safeDbOperation(() => {
      return new Database(DB_PATH);
    }, DB_TIMEOUT);
    
    if (!dbResult.success) {
      console.log('❌ 数据库连接失败:', dbResult.error?.message || 'timeout');
      console.log('   路径:', DB_PATH);
      return;
    }
    db = dbResult.data;
    
    // 模式1: 列出文档
    if (LIST_ENTITY) {
      const entityResult = await safeDbOperation(() => {
        return db.prepare('SELECT name FROM entities WHERE id = ?').get(LIST_ENTITY);
      }, DB_TIMEOUT);
      
      if (!entityResult.success || !entityResult.data) {
        console.log('❌ 实体不存在或查询超时');
        db.close();
        return;
      }
      
      const entity = entityResult.data;
      console.log(`\n📁 实体 "${entity.name}" 的归档文档:`);
      
      try {
        const docs = await listDocuments(LIST_ENTITY, db);
        
        if (docs.length === 0) {
          console.log('   (暂无文档)');
        } else {
          docs.forEach((d, i) => {
            console.log(`   ${i + 1}. ${d.filename} (${d.file_type}, ${formatSize(d.file_size)})`);
            console.log(`      路径: ${d.file_path}`);
          });
        }
      } catch (err) {
        console.log('❌ 查询文档失败:', err.message);
      }
      
      db.close();
      return;
    }

    // 检查实体ID
    if (!ENTITY_ID) {
      console.log('❌ 请指定 --entity <entity_id>');
      console.log('   可用实体:');
      try {
        const entitiesResult = await safeDbOperation(() => {
          return db.prepare('SELECT id, name FROM entities LIMIT 10').all();
        }, DB_TIMEOUT);
        
        if (entitiesResult.success) {
          entitiesResult.data.forEach(e => console.log(`      ${e.id.slice(0, 8)}... - ${e.name}`));
        }
      } catch (e) {
        console.log('   (无法获取实体列表)');
      }
      db.close();
      return;
    }

    const entityResult = await safeDbOperation(() => {
      return db.prepare('SELECT name FROM entities WHERE id = ?').get(ENTITY_ID);
    }, DB_TIMEOUT);
    
    if (!entityResult.success || !entityResult.data) {
      console.log('❌ 实体不存在或查询超时');
      db.close();
      return;
    }

    const entity = entityResult.data;
    console.log(`\n📌 目标实体: ${entity.name} (${ENTITY_ID})`);

    // 模式2: 归档单个文件
    if (FILE_PATH) {
      const existsResult = await safeFileOperation(() => fs.existsSync(FILE_PATH), FILE_TIMEOUT);
      if (!existsResult.success || !existsResult.data) {
        console.log('❌ 文件不存在或无法访问:', FILE_PATH);
        db.close();
        return;
      }

      console.log(`\n📄 归档文件: ${FILE_PATH}`);
      
      if (DRY_RUN) {
        console.log('🔍 [DRY RUN] 模拟执行，不实际写入');
      }

      const result = await archiveFile(FILE_PATH, ENTITY_ID, db);
      
      if (result) {
        console.log(`\n✅ 归档成功:`);
        console.log(`   文件名: ${result.filename}`);
        console.log(`   类型: ${result.type}`);
        console.log(`   大小: ${result.size}`);
        console.log(`   路径: ${result.path}`);
      } else {
        console.log('\n❌ 归档失败');
      }
      
      db.close();
      return;
    }

    // 模式3: 扫描目录
    if (SCAN_DIR) {
      const existsResult = await safeFileOperation(() => fs.existsSync(SCAN_DIR), FILE_TIMEOUT);
      const statResult = await safeFileOperation(() => fs.statSync(SCAN_DIR), FILE_TIMEOUT);
      
      if (!existsResult.success || !existsResult.data || !statResult.success || !statResult.data.isDirectory()) {
        console.log('❌ 目录不存在或无法访问:', SCAN_DIR);
        db.close();
        return;
      }

      console.log(`\n📂 扫描目录: ${SCAN_DIR}`);
      
      if (DRY_RUN) {
        console.log('🔍 [DRY RUN] 模拟执行，不实际写入');
      }

      try {
        const results = await scanAndArchive(SCAN_DIR, ENTITY_ID, db);
        
        console.log(`\n✅ 归档完成，共 ${results.length} 个文件:`);
        results.forEach((r, i) => {
          console.log(`   ${i + 1}. ${r.filename} (${r.type}, ${r.size})`);
        });
      } catch (err) {
        console.log('\n❌ 扫描目录失败:', err.message);
      }
      
      db.close();
      return;
    }

    // 交互模式
    console.log('\n💡 使用方式:');
    console.log('   node link-document.js --file <path> --entity <id>');
    console.log('   node link-document.js --scan <dir> --entity <id>');
    console.log('   node link-document.js --list <entity_id>');
    console.log('   node link-document.js --file <path> --entity <id> --dry-run');
    
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
