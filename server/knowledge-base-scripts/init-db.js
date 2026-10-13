/**
 * init-db.js - 初始化Panda Clothing知识库SQLite数据库
 * 运行: node scripts/init-db.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../database/panda_kb.db');

// 确保目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 连接/创建数据库
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('📦 初始化数据库:', DB_PATH);

// ========== 建表 ==========

// 1. entities - 实体表
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    country     TEXT,
    city        TEXT,
    description TEXT,
    tags        TEXT DEFAULT '[]',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )
`);

// 2. entity_roles - 实体角色表（支持多角色，统一TEXT主键）
db.exec(`
  CREATE TABLE IF NOT EXISTS entity_roles (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL,
    role_type   TEXT NOT NULL,
    is_primary  INTEGER DEFAULT 0,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    UNIQUE(entity_id, role_type)
  )
`);

// 3. relationships - 关系表
db.exec(`
  CREATE TABLE IF NOT EXISTS relationships (
    id              TEXT PRIMARY KEY,
    from_entity_id  TEXT NOT NULL,
    to_entity_id    TEXT NOT NULL,
    type            TEXT NOT NULL,
    description     TEXT,
    context         TEXT,
    related_pos     TEXT DEFAULT '[]',
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (to_entity_id)   REFERENCES entities(id) ON DELETE CASCADE
  )
`);

// 4. contacts - 联系人表
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT,
    email       TEXT,
    phone       TEXT,
    wechat      TEXT,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  )
`);

// 5. documents - 文档表
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id              TEXT PRIMARY KEY,
    entity_id       TEXT NOT NULL,
    filename        TEXT NOT NULL,
    file_type       TEXT,
    file_path       TEXT NOT NULL,
    file_size       INTEGER,
    extracted_summary TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  )
`);

// 6. purchase_orders - PO订单表
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL,
    po_number   TEXT NOT NULL UNIQUE,
    season      TEXT,
    order_type  TEXT,
    amount      REAL,
    currency    TEXT DEFAULT 'USD',
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    notes       TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  )
`);

// 7. activity_logs - 活动日志表
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_logs (
    id              TEXT PRIMARY KEY,
    entity_id       TEXT NOT NULL,
    type            TEXT NOT NULL,
    description     TEXT,
    source_email_id TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  )
`);

// ========== 索引 ==========
const indexes = [
  'CREATE INDEX IF NOT EXISTS idx_entities_name    ON entities(name)',
  'CREATE INDEX IF NOT EXISTS idx_entity_roles_entity ON entity_roles(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_entity_roles_role   ON entity_roles(role_type)',
  'CREATE INDEX IF NOT EXISTS idx_relationships_from  ON relationships(from_entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_relationships_to    ON relationships(to_entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_relationships_type  ON relationships(type)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_entity  ON contacts(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_email  ON contacts(email)',
  'CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_po_entity        ON purchase_orders(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_po_number        ON purchase_orders(po_number)',
  'CREATE INDEX IF NOT EXISTS idx_po_status        ON purchase_orders(status)',
  'CREATE INDEX IF NOT EXISTS idx_activity_entity  ON activity_logs(entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_activity_type    ON activity_logs(type)',
];

indexes.forEach(sql => db.exec(sql));

// ========== 枚举CHECK约束 ==========
// PO状态
db.exec(`
  CREATE TABLE IF NOT EXISTS po_status_lookup (
    status TEXT PRIMARY KEY
  )
`);
const poStatuses = ['pending', 'confirmed', 'in_production', 'shipped', 'delivered', 'cancelled'];
const insertStatus = db.prepare('INSERT OR IGNORE INTO po_status_lookup(status) VALUES (?)');
poStatuses.forEach(s => insertStatus.run(s));

db.close();
console.log('✅ 数据库初始化完成！');
console.log('   表: entities, entity_roles, relationships, contacts, documents, purchase_orders, activity_logs');
console.log('   索引: 14个');
