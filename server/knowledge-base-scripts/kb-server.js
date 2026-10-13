/**
 * kb-server.js - 知识库 API 服务
 * 运行: node scripts/kb-server.js
 * 端口: 3099
 */

const http = require('http');
const url = require('url');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../database/panda_kb.db');
const FRONTEND_PATH = path.join(__dirname, '../frontend/index.html');
const db = new Database(DB_PATH);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
};

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data, null, 2));
}

function sendFile(res, filePath, status = 200) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  const data = fs.readFileSync(filePath);
  res.writeHead(status, { 'Content-Type': mime + '; charset=utf-8' });
  res.end(data);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function now() {
  return new Date().toISOString();
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str || '[]'); } catch { return fallback; }
}

// 数据库role_type → RelationCategory 映射
function mapRoleToCategory(role) {
  const map = { customer:'Customer', supplier:'Supplier', factory:'Supplier', agent:'Agent', logistics:'Partner', partner:'Partner', institution:'Government', other:'Other' };
  return map[role] || 'Other';
}

// 数据库role_type → Relation.type 映射
function mapRoleToType(role) {
  const map = { customer:'Customer', supplier:'Supplier', factory:'Supplier', agent:'Agent', logistics:'Partner', partner:'Partner', institution:'Government', other:'Other' };
  return map[role] || 'Other';
}

// RelationCategory → 数据库role_type 映射（反向）
function mapCategoryToRole(category) {
  const map = { Customer:'customer', Supplier:'supplier', Agent:'agent', Partner:'partner', Government:'institution', Other:'other' };
  return map[category] || 'other';
}

// 写实体Markdown详情
function writeEntityMd(eid, data) {
  const md = `---
id: ${eid}
name: ${data.name}
category: ${data.category || 'Other'}
updated: ${now()}
---

# ${data.name}

${data.contactInfo || ''}

## 基本信息
- **分类**: ${data.category || '—'}
- **Tier**: ${data.rating || 3}
${data.website ? '- **官网**: ' + data.website : ''}
${data.paymentTerms ? '- **付款条款**: ' + data.paymentTerms : ''}
${data.currency ? '- **币种**: ' + data.currency : ''}
${data.officialAddress ? '- **注册地址**: ' + data.officialAddress : ''}

${data.preferences ? '## 备注\n' + data.preferences : ''}
`;
  const entityDir = path.join(__dirname, '../entities', eid);
  fs.mkdirSync(entityDir, { recursive: true });
  fs.writeFileSync(path.join(entityDir, `${eid}_detail.md`), md);
}

// ========== 路由 ==========

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 静态文件 / → index.html
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, FRONTEND_PATH);
  }
  if (pathname.startsWith('/static/')) {
    return sendFile(res, path.join(__dirname, '../frontend', pathname));
  }

  // ---- API ----
  try {
    if (pathname === '/api/entities' && req.method === 'GET') {
      // 查询列表，支持 ?type=&search=
      let sql = `
        SELECT e.*, GROUP_CONCAT(er.role_type) as roles
        FROM entities e
        LEFT JOIN entity_roles er ON er.entity_id = e.id
      `;
      const params = [];
      const conditions = [];
      if (parsed.query.search) {
        conditions.push('(e.name LIKE ? OR e.description LIKE ?)');
        params.push('%' + parsed.query.search + '%', '%' + parsed.query.search + '%');
      }
      if (parsed.query.type) {
        conditions.push('e.id IN (SELECT entity_id FROM entity_roles WHERE role_type = ?)');
        params.push(parsed.query.type);
      }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' GROUP BY e.id ORDER BY e.updated_at DESC';
      const list = db.prepare(sql).all(...params);
      return send(res, 200, list.map(r => ({ ...r, roles: r.roles ? r.roles.split(',') : [] })));
    }

    if (pathname === '/api/entities' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const d = JSON.parse(body);
          const eid = genId();
          db.prepare(`INSERT INTO entities (id, name, country, city, description, tags, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?)`).run(
            eid, d.name||'', d.country||'', d.city||'', d.description||'',
            JSON.stringify(d.tags||[]), now(), now()
          );
          // 角色
          const roles = Array.isArray(d.roles) ? d.roles : (d.roles ? [d.roles] : []);
          roles.forEach((rt, i) => {
            db.prepare(`INSERT INTO entity_roles (id, entity_id, role_type, is_primary, created_at)
                        VALUES (?,?,?,?,?)`).run(genId(), eid, rt, i === 0 ? 1 : 0, now());
          });
          // 联系人
          if (Array.isArray(d.contacts)) {
            d.contacts.forEach(c => {
              db.prepare(`INSERT INTO contacts (id, entity_id, name, role, email, phone, wechat, notes, created_at)
                          VALUES (?,?,?,?,?,?,?,?,?)`).run(
                genId(), eid, c.name||'', c.role||'', c.email||'', c.phone||'', c.wechat||'', c.notes||'', now()
              );
            });
          }
          // 写 Markdown
          const md = `---
id: ${eid}
name: ${d.name}
country: ${d.country||''}
city: ${d.city||''}
roles: ${roles.join(', ')}
created: ${now()}
---

# ${d.name}

${d.description || ''}

## 基本信息
- **国家**: ${d.country||'—'}
- **城市**: ${d.city||'—'}
- **角色**: ${roles.join(' / ') || '—'}

${d.contacts?.length ? '## 联系人\n' + d.contacts.map(c => `- **${c.name}** [${c.role||'未知'}] - ${c.email||'无邮箱'}`).join('\n') : ''}
`;
          const entityDir = path.join(__dirname, '../entities', eid);
          fs.mkdirSync(entityDir, { recursive: true });
          fs.writeFileSync(path.join(entityDir, `${eid}_detail.md`), md);
          const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(eid);
          const entityRoles = db.prepare('SELECT * FROM entity_roles WHERE entity_id = ?').all(eid);
          const contacts = db.prepare('SELECT * FROM contacts WHERE entity_id = ?').all(eid);
          return send(res, 201, { ...entity, roles: entityRoles.map(r=>r.role_type), contacts });
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    if (pathname.startsWith('/api/entities/') && req.method === 'GET') {
      const eid = pathname.split('/')[3];
      const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(eid);
      if (!entity) return send(res, 404, { error: 'Not found' });
      const roles = db.prepare('SELECT * FROM entity_roles WHERE entity_id = ?').all(eid);
      const contacts = db.prepare('SELECT * FROM contacts WHERE entity_id = ?').all(eid);
      const pos = db.prepare('SELECT * FROM purchase_orders WHERE entity_id = ? ORDER BY created_at DESC LIMIT 20').all(eid);
      const logs = db.prepare('SELECT * FROM activity_logs WHERE entity_id = ? ORDER BY created_at DESC LIMIT 50').all(eid);
      const mdPath = path.join(__dirname, '../entities', eid, `${eid}_detail.md`);
      const markdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf-8') : '';
      return send(res, 200, { ...entity, roles: roles.map(r=>r.role_type), contacts, pos, logs, markdown });
    }

    if (pathname.startsWith('/api/entities/') && req.method === 'DELETE') {
      const eid = pathname.split('/')[3];
      // 删除 Markdown 目录
      const entityDir = path.join(__dirname, '../entities', eid);
      if (fs.existsSync(entityDir)) fs.rmSync(entityDir, { recursive: true });
      // SQLite 数据靠 CASCADE 自动删
      db.prepare('DELETE FROM entities WHERE id = ?').run(eid);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/relationships' && req.method === 'GET') {
      const list = db.prepare(`
        SELECT r.*,
          e1.name as from_name, e2.name as to_name
        FROM relationships r
        JOIN entities e1 ON e1.id = r.from_entity_id
        JOIN entities e2 ON e2.id = r.to_entity_id
        ORDER BY r.created_at DESC
      `).all();
      return send(res, 200, list.map(r => ({ ...r, related_pos: JSON.parse(r.related_pos || '[]') })));
    }

    if (pathname === '/api/relationships' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const d = JSON.parse(body);
          const rid = genId();
          db.prepare(`INSERT INTO relationships (id, from_entity_id, to_entity_id, type, description, context, related_pos, created_at)
                      VALUES (?,?,?,?,?,?,?,?)`).run(
            rid, d.from_entity_id, d.to_entity_id, d.type||'',
            d.description||'', d.context||'',
            JSON.stringify(d.related_pos||[]), now()
          );
          return send(res, 201, db.prepare('SELECT * FROM relationships WHERE id = ?').get(rid));
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    if (pathname === '/api/contacts' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const d = JSON.parse(body);
          const cid = genId();
          db.prepare(`INSERT INTO contacts (id, entity_id, name, role, email, phone, wechat, notes, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?)`).run(
            cid, d.entity_id, d.name||'', d.role||'', d.email||'', d.phone||'', d.wechat||'', d.notes||'', now()
          );
          return send(res, 201, db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid));
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    if (pathname === '/api/pos' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const d = JSON.parse(body);
          const pid = genId();
          db.prepare(`INSERT INTO purchase_orders (id, entity_id, po_number, season, order_type, amount, currency, status, notes, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            pid, d.entity_id, d.po_number||'', d.season||'', d.order_type||'',
            d.amount||null, d.currency||'USD', d.status||'pending', d.notes||'', now()
          );
          return send(res, 201, db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(pid));
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    if (pathname === '/api/activity' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const d = JSON.parse(body);
          const aid = genId();
          db.prepare(`INSERT INTO activity_logs (id, entity_id, type, description, source_email_id, created_at)
                      VALUES (?,?,?,?,?,?)`).run(
            aid, d.entity_id, d.type||'note', d.description||'', d.source_email_id||null, now()
          );
          return send(res, 201, db.prepare('SELECT * FROM activity_logs WHERE id = ?').get(aid));
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    // ========== Relations API (对齐Bambook前端 Relation 类型) ==========

    // GET /api/relations — 返回所有Relation格式数据（组织+联系人混合列表）
    if (pathname === '/api/relations' && req.method === 'GET') {
      const relations = [];

      // 1. 组织（isOrganization=true）
      const orgs = db.prepare('SELECT * FROM entities WHERE is_organization = 1 OR is_organization IS NULL').all();
      for (const e of orgs) {
        const roles = db.prepare('SELECT role_type, is_primary FROM entity_roles WHERE entity_id = ?').all(e.id);
        const primaryRole = roles.find(r => r.is_primary) || roles[0];
        const category = mapRoleToCategory(primaryRole?.role_type);
        const type = mapRoleToType(primaryRole?.role_type);
        const tags = safeParseJSON(e.tags, []);
        const factoryAddresses = safeParseJSON(e.factory_addresses, []);

        relations.push({
          id: e.id,
          name: e.name,
          category,
          type,
          isOrganization: true,
          tags,
          contactInfo: e.description || '',
          rating: e.rating || 3,
          lastInteraction: new Date(e.updated_at || e.created_at).getTime(),
          preferences: '',
          deletedAt: undefined,
          // 组织专属
          website: e.website || undefined,
          paymentTerms: e.payment_terms || undefined,
          paymentPreference: e.payment_preference || undefined,
          currency: e.currency || undefined,
          taxId: e.tax_id || undefined,
          creditLimit: e.credit_limit || undefined,
          officialAddress: e.official_address || undefined,
          factoryAddresses: factoryAddresses.length ? factoryAddresses : undefined,
          warehouseAddress: e.warehouse_address || undefined,
          coordinates: (e.coordinates_lat && e.coordinates_lng)
            ? { lat: e.coordinates_lat, lng: e.coordinates_lng }
            : undefined,
        });
      }

      // 2. 联系人（isOrganization=false）
      const contacts = db.prepare('SELECT * FROM contacts').all();
      for (const c of contacts) {
        const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(c.entity_id);
        const entityRoles = db.prepare('SELECT role_type FROM entity_roles WHERE entity_id = ?').all(c.entity_id);
        const primaryRole = entityRoles[0];
        const category = mapRoleToCategory(primaryRole?.role_type);

        relations.push({
          id: c.id,
          name: c.name,
          category,
          type: mapRoleToType(primaryRole?.role_type),
          isOrganization: false,
          parentId: c.entity_id,
          role: c.role || undefined,
          department: c.department || undefined,
          tags: [],
          contactInfo: c.email || c.phone || '',
          rating: c.rating || 3,
          lastInteraction: new Date(c.created_at).getTime(),
          preferences: '',
          deletedAt: undefined,
          // 联系人专属
          phone: c.phone || undefined,
          mobile: c.mobile || undefined,
          wechat: c.wechat || undefined,
          whatsapp: c.whatsapp || undefined,
          birthday: c.birthday || undefined,
          language: c.language || undefined,
          timezone: c.timezone || undefined,
          personalNote: c.personal_note || undefined,
          reportsToId: c.reports_to_id || undefined,
        });
      }

      return send(res, 200, relations);
    }

    // POST /api/relations — 保存Relation（前端写入时调用）
    if (pathname === '/api/relations' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const d = JSON.parse(body);
          if (d.isOrganization) {
            // 组织 → entities表
            const eid = d.id || genId();
            db.prepare(`INSERT OR REPLACE INTO entities
              (id, name, country, city, description, tags, website, payment_terms, payment_preference,
               currency, tax_id, credit_limit, official_address, factory_addresses, warehouse_address,
               coordinates_lat, coordinates_lng, rating, is_organization, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              eid, d.name||'', '', '', d.contactInfo||'',
              JSON.stringify(d.tags||[]), d.website||null, d.paymentTerms||null,
              d.paymentPreference||null, d.currency||null, d.taxId||null,
              d.creditLimit||null, d.officialAddress||null,
              JSON.stringify(d.factoryAddresses||[]), d.warehouseAddress||null,
              d.coordinates?.lat||null, d.coordinates?.lng||null,
              d.rating||3, 1,
              now(), now()
            );
            // 角色
            const category = d.category || 'Other';
            const roleType = mapCategoryToRole(category);
            db.prepare('DELETE FROM entity_roles WHERE entity_id = ?').run(eid);
            db.prepare(`INSERT INTO entity_roles (id, entity_id, role_type, is_primary, created_at)
                        VALUES (?,?,?,?,?)`).run(genId(), eid, roleType, 1, now());
            // 写 Markdown
            writeEntityMd(eid, d);
            return send(res, 201, { ...d, id: eid });
          } else {
            // 联系人 → contacts表
            const cid = d.id || genId();
            db.prepare(`INSERT OR REPLACE INTO contacts
              (id, entity_id, name, role, email, phone, wechat, notes,
               mobile, whatsapp, birthday, language, timezone, personal_note, reports_to_id, department, rating, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              cid, d.parentId||'', d.name||'', d.role||'',
              d.contactInfo||d.email||'', d.phone||null, d.wechat||null, d.personalNote||'',
              d.mobile||null, d.whatsapp||null, d.birthday||null,
              d.language||null, d.timezone||null, d.personalNote||null,
              d.reportsToId||null, d.department||null, d.rating||3, now()
            );
            return send(res, 201, { ...d, id: cid });
          }
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    // PUT /api/relations/:id — 更新Relation
    if (pathname.startsWith('/api/relations/') && req.method === 'PUT') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        try {
          const rid = pathname.split('/')[3];
          const d = JSON.parse(body);
          if (d.isOrganization) {
            db.prepare(`UPDATE entities SET
              name=?, description=?, tags=?, website=?, payment_terms=?, payment_preference=?,
              currency=?, tax_id=?, credit_limit=?, official_address=?, factory_addresses=?,
              warehouse_address=?, coordinates_lat=?, coordinates_lng=?, rating=?, updated_at=?
              WHERE id=?`).run(
              d.name||'', d.contactInfo||'', JSON.stringify(d.tags||[]),
              d.website||null, d.paymentTerms||null, d.paymentPreference||null,
              d.currency||null, d.taxId||null, d.creditLimit||null,
              d.officialAddress||null, JSON.stringify(d.factoryAddresses||[]),
              d.warehouseAddress||null, d.coordinates?.lat||null, d.coordinates?.lng||null,
              d.rating||3, now(), rid
            );
            // 更新角色
            if (d.category) {
              const roleType = mapCategoryToRole(d.category);
              db.prepare('DELETE FROM entity_roles WHERE entity_id = ?').run(rid);
              db.prepare(`INSERT INTO entity_roles (id, entity_id, role_type, is_primary, created_at)
                          VALUES (?,?,?,?,?)`).run(genId(), rid, roleType, 1, now());
            }
            writeEntityMd(rid, d);
          } else {
            db.prepare(`UPDATE contacts SET
              name=?, role=?, email=?, phone=?, wechat=?, notes=?,
              mobile=?, whatsapp=?, birthday=?, language=?, timezone=?,
              personal_note=?, reports_to_id=?, department=?, rating=?
              WHERE id=?`).run(
              d.name||'', d.role||'', d.contactInfo||d.email||'',
              d.phone||null, d.wechat||null, d.personalNote||'',
              d.mobile||null, d.whatsapp||null, d.birthday||null,
              d.language||null, d.timezone||null, d.personalNote||null,
              d.reportsToId||null, d.department||null, d.rating||3, rid
            );
          }
          return send(res, 200, { ok: true });
        } catch(e) {
          return send(res, 400, { error: e.message });
        }
      });
    }

    // DELETE /api/relations/:id — 软删除
    if (pathname.startsWith('/api/relations/') && req.method === 'DELETE') {
      const rid = pathname.split('/')[3];
      // 先检查是实体还是联系人
      const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(rid);
      if (entity) {
        db.prepare('DELETE FROM entities WHERE id = ?').run(rid);
        // CASCADE自动删角色、联系人
      } else {
        db.prepare('DELETE FROM contacts WHERE id = ?').run(rid);
      }
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/stats') {
      const entityCount = db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
      const contactCount = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
      const poCount = db.prepare('SELECT COUNT(*) as c FROM purchase_orders').get().c;
      const relationshipCount = db.prepare('SELECT COUNT(*) as c FROM relationships').get().c;
      const roleStats = db.prepare('SELECT role_type, COUNT(*) as c FROM entity_roles GROUP BY role_type').all();
      return send(res, 200, { entityCount, contactCount, poCount, relationshipCount, roleStats });
    }

    return send(res, 404, { error: 'Not found' });
  } catch(e) {
    return send(res, 500, { error: e.message });
  }
});

const PORT = 3099;
server.listen(PORT, () => {
  console.log(`✅ 知识库服务已启动: http://localhost:${PORT}`);
  console.log(`   前端界面:          http://localhost:${PORT}`);
  console.log(`   API文档:           http://localhost:${PORT}/api/stats`);
});
