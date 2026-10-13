import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Pool } from 'pg';
import { redactSecrets } from './redact';

const execFileAsync = promisify(execFile);

const PANEL_ROOT = path.resolve(__dirname, '..');
const SERVER_ROOT = path.resolve(PANEL_ROOT, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
dotenv.config({ path: path.join(PANEL_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(PANEL_ROOT, '.env') });

const PORT = Number(process.env.BAMBOOK_OPS_PORT || 8088);
const ADMIN_TOKEN = String(process.env.BAMBOOK_OPS_ADMIN_TOKEN || '').trim();
const ACTION_LOG = process.env.BAMBOOK_OPS_ACTION_LOG || '/tmp/bambook-ops-actions.log';
const MAIN_API_URL = process.env.BAMBOOK_OPS_MAIN_API_URL || 'http://127.0.0.1:8081/api/health';
const KNOWLEDGE_API_URL = process.env.BAMBOOK_OPS_KNOWLEDGE_API_URL || 'http://127.0.0.1:8091/bambook/kb/health';
const LOCAL_PUBLIC_API_URL = process.env.BAMBOOK_OPS_LOCAL_PUBLIC_API_URL || 'http://127.0.0.1:8091/bambook/kb/health';
const PUBLIC_API_URL = process.env.BAMBOOK_OPS_PUBLIC_API_URL || 'https://jiangsupanda.com/bambook/api/health';
const AI_RUNTIME_METRICS_URL = process.env.BAMBOOK_OPS_AI_RUNTIME_METRICS_URL || 'http://127.0.0.1:8081/api/ai/metrics';
const AGENT_STATUS_URL = process.env.BAMBOOK_OPS_AGENT_STATUS_URL || 'http://127.0.0.1:8081/api/agent/status';
const MELO_TTS_URL = process.env.BAMBOOK_MELO_URL || 'http://127.0.0.1:8765';
const MAIN_API_KEY = process.env.BAMBOOK_SDK_KEY || process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const MELO_TTS_LABEL = process.env.BAMBOOK_MELO_TTS_LABEL || 'com.bambook.melo-tts';
const CLOUDFLARE_LABEL = process.env.BAMBOOK_CLOUDFLARE_LABEL || 'com.cloudflare.bambook.api';
const CLOUDFLARE_WATCHDOG_LABEL = process.env.BAMBOOK_CLOUDFLARE_WATCHDOG_LABEL || 'com.cloudflare.bambook.watchdog';

if (!ADMIN_TOKEN && process.env.NODE_ENV === 'production') {
  throw new Error('BAMBOOK_OPS_ADMIN_TOKEN is required in production');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
const dbPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
// 部署包体量上限：webapp 含 mermaid/maplibre/three.js/cytoscape 等大依赖，90MB+ 为正常体量。
// 80mb 过保守（曾致 webapp 部署 413）；200mb 覆盖增长空间，Mac Mini 16GB+ 内存无压力。
const DEPLOY_PACKAGE_LIMIT = process.env.BAMBOOK_OPS_DEPLOY_PACKAGE_LIMIT || '200mb';

type ServiceStatus = 'ok' | 'warn' | 'error';
type OpsAction = {
  label: string;
  script: string;
  confirm?: string;
  timeoutMs: number;
  group: 'routine' | 'deploy' | 'danger';
  description: string;
  lockKey?: string;
  lockLabel?: string;
};
type DevJobStatus = 'running' | 'ok' | 'error' | 'cancelled';
type DevJob = {
  id: string;
  command: string;
  cwd: string;
  status: DevJobStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  output: string;
  pid?: number;
  child?: ReturnType<typeof spawn>;
  lockKey?: string;
  lockLabel?: string;
  actionId?: string;
  label?: string;
};

const DEV_JOB_CWD_OPTIONS = [
  { id: 'server', label: '后端 server', cwd: SERVER_ROOT },
  { id: 'repo', label: '完整 Bambook repo', cwd: REPO_ROOT },
  { id: 'opsPanel', label: 'OPS 面板', cwd: PANEL_ROOT },
];
const DEV_JOB_MAX_OUTPUT = Number(process.env.BAMBOOK_OPS_DEV_JOB_MAX_OUTPUT || 320_000);
const DEV_JOB_DEFAULT_TIMEOUT_MS = Number(process.env.BAMBOOK_OPS_DEV_JOB_TIMEOUT_MS || 30 * 60_000);
const DEV_JOB_MAX_TIMEOUT_MS = Number(process.env.BAMBOOK_OPS_DEV_JOB_MAX_TIMEOUT_MS || 2 * 60 * 60_000);
const DEV_JOB_MAX_COMMAND_LENGTH = Number(process.env.BAMBOOK_OPS_DEV_JOB_MAX_COMMAND_LENGTH || 8_000);
const DEV_JOB_MAX_ACTIVE = Number(process.env.BAMBOOK_OPS_DEV_JOB_MAX_ACTIVE || 4);
const DEV_JOB_HISTORY_FILE = process.env.BAMBOOK_OPS_DEV_JOB_HISTORY_FILE || '/tmp/bambook-ops-dev-jobs.jsonl';
const DEV_JOB_HISTORY_OUTPUT_TAIL = Number(process.env.BAMBOOK_OPS_DEV_JOB_HISTORY_OUTPUT_TAIL || 80_000);
const DEV_FILE_BACKUP_DIR = process.env.BAMBOOK_OPS_DEV_FILE_BACKUP_DIR || '/tmp/bambook-ops-file-backups';
const DEV_FILE_MAX_BYTES = Number(process.env.BAMBOOK_OPS_DEV_FILE_MAX_BYTES || 512_000);
const DEV_UPLOAD_MAX_BYTES = process.env.BAMBOOK_OPS_DEV_UPLOAD_MAX_BYTES || '50mb';
const devJobs = new Map<string, DevJob>();

const DEV_JOB_LOCKS: Record<string, string> = {
  'melo-tts': 'Melo TTS',
  'main-api': '主数据 API',
  cloudflare: 'Cloudflare Tunnel',
  'postgres-backup': 'PostgreSQL 备份',
  'ops-panel': 'OPS 面板',
  'demo-data': 'DEMO 数据',
};

const ACTIONS: Record<string, OpsAction> = {
  healthcheck: {
    label: '运行完整健康检查',
    script: 'ops-healthcheck.sh',
    confirm: 'RUN_HEALTHCHECK',
    timeoutMs: 30_000,
    group: 'routine',
    description: '检查公网、主 API、知识库、Cloudflare 和磁盘状态',
  },
  publicProbe: {
    label: '运行公网探测',
    script: 'ops-public-probe.sh',
    confirm: 'RUN_PUBLIC_PROBE',
    timeoutMs: 45_000,
    group: 'routine',
    description: '检查公网 API、知识库、OPS 和已废弃路径的状态码',
  },
  restartCloudflare: {
    label: '重启 Cloudflare Tunnel',
    script: 'ops-restart-cloudflare.sh',
    confirm: 'RESTART_CLOUDFLARE',
    timeoutMs: 45_000,
    group: 'danger',
    description: '公网访问异常时使用，会短暂中断远程入口',
    lockKey: 'cloudflare',
    lockLabel: 'Cloudflare Tunnel',
  },
  restartMainApi: {
    label: '重启主数据 API',
    script: 'ops-restart-main-api.sh',
    confirm: 'RESTART_MAIN_API',
    timeoutMs: 90_000,
    group: 'danger',
    description: '订单、档案等业务 API 异常时使用',
    lockKey: 'main-api',
    lockLabel: '主数据 API',
  },
  backupPostgres: {
    label: '执行 PostgreSQL 备份',
    script: 'ops-backup-postgres.sh',
    confirm: 'BACKUP_POSTGRES',
    timeoutMs: 120_000,
    group: 'routine',
    description: '立即创建一次数据库备份',
    lockKey: 'postgres-backup',
    lockLabel: 'PostgreSQL 备份',
  },
  deployMainApi: {
    label: '拉取 GitHub 并部署主数据 API',
    script: 'ops-deploy-main-api.sh',
    confirm: 'DEPLOY_MAIN_API',
    timeoutMs: 300_000,
    group: 'deploy',
    description: '更新主数据 API、执行迁移并健康检查',
    lockKey: 'main-api',
    lockLabel: '主数据 API',
  },
  deployPanel: {
    label: '更新运维面板自身',
    script: 'ops-deploy-panel.sh',
    timeoutMs: 240_000,
    group: 'deploy',
    description: '更新这个运维面板，不影响业务数据',
    lockKey: 'ops-panel',
    lockLabel: 'OPS 面板',
  },
  demoSeedDryRun: {
    label: 'DEMO 数据 dry-run',
    script: 'ops-demo-seed-dry-run.sh',
    confirm: 'DEMO_SEED_DRY_RUN',
    timeoutMs: 60_000,
    group: 'routine',
    description: '预检查 DEMO 数据脚本，不写入数据库',
    lockKey: 'demo-data',
    lockLabel: 'DEMO 数据',
  },
  demoSeedRollback: {
    label: '回滚 DEMO 数据',
    script: 'ops-demo-seed-rollback.sh',
    confirm: 'DEMO_SEED_ROLLBACK',
    timeoutMs: 120_000,
    group: 'danger',
    description: '删除 DEMO 标记数据，演示后谨慎使用',
    lockKey: 'demo-data',
    lockLabel: 'DEMO 数据',
  },
  seedRbac: {
    label: '初始化 RBAC 权限数据',
    script: 'ops-seed-rbac.sh',
    confirm: 'SEED_RBAC',
    timeoutMs: 60_000,
    group: 'deploy',
    description: '向数据库写入角色、权限、角色-权限关联和默认 owner 账号（幂等，可重复执行）',
    lockKey: 'main-api',
    lockLabel: '主数据 API',
  },
  setupMeloTts: {
    label: '安装/修复 Melo TTS',
    script: 'ops-setup-melo-tts.sh',
    confirm: 'SETUP_MELO_TTS',
    timeoutMs: 900_000,
    group: 'deploy',
    description: '在数据中心固定路径安装 Melo TTS、预热模型、写入主 API 环境变量并重启主 API',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  installMeloTtsService: {
    label: '安装/启动 Melo TTS 常驻服务',
    script: 'ops-install-melo-tts-service.sh',
    confirm: 'INSTALL_MELO_TTS_SERVICE',
    timeoutMs: 240_000,
    group: 'deploy',
    description: '在 Mac Mini 上安装 com.bambook.melo-tts LaunchAgent，并保持 Melo 服务常驻',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  ensureMeloNltk: {
    label: '补齐 Melo NLTK 资源',
    script: 'ops-ensure-melo-nltk.sh',
    confirm: 'ENSURE_MELO_NLTK',
    timeoutMs: 240_000,
    group: 'deploy',
    description: '下载 Melo 可选 NLTK 资源，避免依赖缺失导致服务异常',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  restartMeloTtsService: {
    label: '重启 Melo TTS 常驻服务',
    script: 'ops-restart-melo-tts-service.sh',
    confirm: 'RESTART_MELO_TTS_SERVICE',
    timeoutMs: 240_000,
    group: 'danger',
    description: '重启 Mac Mini 上的 Melo TTS 常驻服务',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  testMeloTts: {
    label: '测试 Melo TTS',
    script: 'ops-test-melo-tts.sh',
    confirm: 'TEST_MELO_TTS',
    timeoutMs: 240_000,
    group: 'routine',
    description: '在 Mac Mini 上用真实主 API key 请求本机主 API TTS，输出耗时和 WAV 状态',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  stopMeloTtsService: {
    label: '停止 Melo TTS 常驻服务',
    script: 'ops-stop-melo-tts-service.sh',
    confirm: 'STOP_MELO_TTS_SERVICE',
    timeoutMs: 20_000,
    group: 'danger',
    description: '停止 Mac Mini 上的 Melo TTS 常驻服务',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  startMeloTtsSetup: {
    label: '后台安装/修复 Melo TTS',
    script: 'ops-start-melo-tts-setup.sh',
    confirm: 'START_MELO_TTS_SETUP',
    timeoutMs: 15_000,
    group: 'deploy',
    description: '后台运行 Melo TTS 安装，避免首次安装被公网长连接超时中断',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  restartMeloTtsSetup: {
    label: '重启后台 Melo TTS 安装',
    script: 'ops-restart-melo-tts-setup.sh',
    confirm: 'RESTART_MELO_TTS_SETUP',
    timeoutMs: 20_000,
    group: 'deploy',
    description: '停止当前 Melo 安装进程并重新后台安装',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
  stopMeloTtsSetup: {
    label: '停止后台 Melo TTS 安装',
    script: 'ops-stop-melo-tts-setup.sh',
    confirm: 'STOP_MELO_TTS_SETUP',
    timeoutMs: 10_000,
    group: 'deploy',
    description: '停止当前 Melo 安装进程',
    lockKey: 'melo-tts',
    lockLabel: 'Melo TTS',
  },
};

async function seedRbacDirect() {
  if (!dbPool) throw new Error('DATABASE_URL is not configured');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Department
    await client.query(`
      INSERT INTO "Department" (id, name, status, "createdAt", "updatedAt")
      VALUES ('company', 'Company', 'active', NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `);

    // 2. Roles
    const roles = [
      ['role_owner', 'owner', '超级管理员，拥有全部权限', true],
      ['role_admin', 'admin', '系统管理员，管理用户和配置', true],
      ['role_manager', 'manager', '业务经理，审批和查看全部业务数据', true],
      ['role_merchandiser', 'merchandiser', '跟单员，管理订单和生产', true],
      ['role_sales', 'sales', '销售，查看客户和报价', true],
      ['role_finance', 'finance', '财务，查看账款和发票', true],
      ['role_agent_operator', 'agent_operator', 'AI Agent 操作员，使用工具和知识库', true],
      ['role_viewer', 'viewer', '只读查看者', true],
    ] as const;
    for (const [id, name, desc, isSystem] of roles) {
      await client.query(`
        INSERT INTO "Role" (id, name, description, "isSystem", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, "isSystem" = EXCLUDED."isSystem"
      `, [id, name, desc, isSystem]);
    }

    // 3. Permissions
    const perms: [string, string, string][] = [
      ['perm_users_read', 'users:read', '查看用户列表'],
      ['perm_users_write', 'users:write', '创建/编辑用户'],
      ['perm_users_delete', 'users:delete', '删除/停用用户'],
      ['perm_roles_read', 'roles:read', '查看角色和权限'],
      ['perm_roles_write', 'roles:write', '编辑角色权限'],
      ['perm_orders_read', 'orders:read', '查看订单'],
      ['perm_orders_write', 'orders:write', '创建/编辑订单'],
      ['perm_orders_delete', 'orders:delete', '删除订单'],
      ['perm_products_read', 'products:read', '查看产品'],
      ['perm_products_write', 'products:write', '创建/编辑产品'],
      ['perm_relations_read', 'relations:read', '查看关系人脉'],
      ['perm_relations_write', 'relations:write', '创建/编辑关系人脉'],
      ['perm_knowledge_read', 'knowledge:read', '查看数据中心'],
      ['perm_knowledge_write', 'knowledge:write', '编辑数据中心'],
      ['perm_knowledge_admin', 'knowledge:admin', '管理数据中心权限'],
      ['perm_tools_execute', 'tools:execute', '使用Agent工具'],
      ['perm_tools_admin', 'tools:admin', '管理工具权限'],
      ['perm_finance_read', 'finance:read', '查看财务数据'],
      ['perm_finance_write', 'finance:write', '编辑财务数据'],
      ['perm_ai_chat', 'ai:chat', '使用AI对话'],
      ['perm_ai_agent', 'ai:agent', '使用AI Agent'],
      ['perm_emails_read', 'emails:read', '查看邮件'],
      ['perm_emails_write', 'emails:write', '发送邮件'],
      ['perm_settings_read', 'settings:read', '查看系统设置'],
      ['perm_settings_write', 'settings:write', '修改系统设置'],
      ['perm_audit_read', 'audit:read', '查看审计日志'],
      ['perm_approvals_read', 'approvals:read', '查看审批请求'],
      ['perm_approvals_write', 'approvals:write', '审批决策'],
    ];
    for (const [id, scope, desc] of perms) {
      await client.query(`
        INSERT INTO "Permission" (id, scope, description, "createdAt")
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (scope) DO UPDATE SET description = EXCLUDED.description
      `, [id, scope, desc]);
    }

    // 4. Role-Permission links
    const rolePermMap: Record<string, string[]> = {
      role_owner: perms.map(p => p[1]), // all
      role_admin: ['users:read','users:write','users:delete','roles:read','roles:write','orders:read','orders:write','products:read','products:write','relations:read','relations:write','knowledge:read','knowledge:write','knowledge:admin','tools:execute','tools:admin','finance:read','ai:chat','ai:agent','emails:read','emails:write','settings:read','settings:write','audit:read','approvals:read','approvals:write'],
      role_manager: ['users:read','orders:read','orders:write','products:read','products:write','relations:read','relations:write','knowledge:read','knowledge:write','tools:execute','finance:read','finance:write','ai:chat','ai:agent','emails:read','emails:write','settings:read','audit:read','approvals:read','approvals:write'],
      role_merchandiser: ['orders:read','orders:write','products:read','relations:read','knowledge:read','tools:execute','ai:chat','ai:agent','emails:read'],
      role_sales: ['orders:read','products:read','relations:read','relations:write','knowledge:read','tools:execute','ai:chat','emails:read','emails:write'],
      role_finance: ['orders:read','finance:read','finance:write','knowledge:read','tools:execute','ai:chat','emails:read'],
      role_agent_operator: ['orders:read','products:read','knowledge:read','tools:execute','ai:chat','ai:agent'],
      role_viewer: ['orders:read','products:read','relations:read','knowledge:read','ai:chat'],
    };
    // Get perm IDs
    const permRows = (await client.query('SELECT id, scope FROM "Permission"')).rows;
    const permScopeToId = new Map(permRows.map((r: any) => [r.scope, r.id]));
    for (const [roleId, scopes] of Object.entries(rolePermMap)) {
      for (const scope of scopes) {
        const permissionId = permScopeToId.get(scope);
        if (!permissionId) continue;
        await client.query(`
          INSERT INTO "RolePermission" (id, "roleId", "permissionId")
          VALUES ($1, $2, $3)
          ON CONFLICT ("roleId", "permissionId") DO NOTHING
        `, [`rp_${roleId}_${permissionId}`, roleId, permissionId]);
      }
    }

    // 5. Migrate legacy role IDs to new role_ prefixed IDs
    const legacyRoleMap: Record<string, string> = {
      'owner': 'role_owner',
      'admin': 'role_admin',
      'manager': 'role_manager',
      'merchandiser': 'role_merchandiser',
      'sales': 'role_sales',
      'finance': 'role_finance',
      'agent_operator': 'role_agent_operator',
      'viewer': 'role_viewer',
    };
    for (const [legacyId, newId] of Object.entries(legacyRoleMap)) {
      if (legacyId === newId) continue;
      const exists = (await client.query('SELECT 1 FROM "Role" WHERE id = $1', [legacyId])).rows.length > 0;
      if (exists) {
        await client.query(`UPDATE "UserRole" SET "roleId" = $1 WHERE "roleId" = $2`, [newId, legacyId]);
        await client.query(`UPDATE "RolePermission" SET "roleId" = $1 WHERE "roleId" = $2`, [newId, legacyId]);
        await client.query(`UPDATE "AgentToolPermission" SET "roleId" = $1 WHERE "roleId" = $2`, [newId, legacyId]);
        await client.query(`UPDATE "KnowledgeAcl" SET "roleId" = $1 WHERE "roleId" = $2`, [newId, legacyId]);
        await client.query(`UPDATE "AgentPolicy" SET "roleId" = $1 WHERE "roleId" = $2`, [newId, legacyId]);
        await client.query(`DELETE FROM "RolePermission" WHERE "roleId" = $1`, [legacyId]);
        await client.query(`DELETE FROM "Role" WHERE id = $1`, [legacyId]);
      }
    }

    // 6. Assign viewer role to any active users who have NO role at all
    const usersWithoutRole = (await client.query(`
      SELECT ua.id FROM "UserAccount" ua
      LEFT JOIN "UserRole" ur ON ur."userId" = ua.id
      WHERE ur.id IS NULL AND ua."deletedAt" IS NULL AND ua.status = 'active'
    `)).rows;
    for (const u of usersWithoutRole) {
      await client.query(`
        INSERT INTO "UserRole" (id, "userId", "roleId", "createdAt")
        VALUES ($1, $2, 'role_viewer', NOW())
        ON CONFLICT DO NOTHING
      `, [`ur_${u.id}_viewer`, u.id]);
    }

    // 7. Account data belongs to the data center. The synthetic owner is only
    // available for an explicit one-off bootstrap, never as default seed data.
    const existingOwner = (await client.query(`
      SELECT ua.id FROM "UserAccount" ua
      JOIN "UserRole" ur ON ur."userId" = ua.id
      JOIN "Role" r ON r.id = ur."roleId"
      WHERE r.name = 'owner' AND ua."deletedAt" IS NULL
      LIMIT 1
    `)).rows;

    let ownerCreated = false;
    if (process.env.BAMBOOK_SEED_DEFAULT_OWNER === '1' && existingOwner.length === 0) {
      const bcrypt = require('bcryptjs') as typeof import('bcryptjs');
      // 弱口令治理：初始口令不再硬编码。优先取 BAMBOOK_INITIAL_ADMIN_PASSWORD；
      // 未设置时随机生成并打印到 ops-panel 日志（仅此一次；不回传 HTTP 响应、不写行动日志）。
      const envPassword = String(process.env.BAMBOOK_INITIAL_ADMIN_PASSWORD || '').trim();
      const initialPassword = envPassword || require('crypto').randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(initialPassword, 12);
      await client.query(`
        INSERT INTO "UserAccount" (id, "displayName", email, "passwordHash", status, "primaryDeptId", "createdAt", "updatedAt")
        VALUES ('usr_owner_default', 'Admin', 'admin@bambook.local', $1, 'active', 'company', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash"
      `, [passwordHash]);
      await client.query(`
        INSERT INTO "UserRole" (id, "userId", "roleId", "departmentId", "createdAt")
        VALUES ('ur_owner_default_role_owner', 'usr_owner_default', 'role_owner', 'company', NOW())
        ON CONFLICT DO NOTHING
      `);
      ownerCreated = true;
      if (envPassword) {
        console.log('[seedRbac] owner bootstrap 完成：admin@bambook.local（口令取自 BAMBOOK_INITIAL_ADMIN_PASSWORD，首次登录后请立即修改）');
      } else {
        console.log(
          `[seedRbac] owner bootstrap 完成：admin@bambook.local\n` +
          `  ══════════════════════════════════════════════════════════\n` +
          `  初始随机口令（仅显示一次，请立即保存）：${initialPassword}\n` +
          `  ⚠ 首次登录后请立即修改密码！\n` +
          `  ══════════════════════════════════════════════════════════`,
        );
      }
    }

    await client.query('COMMIT');
    return { ownerCreated, roles: roles.length, permissions: perms.length, usersFixed: usersWithoutRole.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function auth(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_TOKEN && process.env.NODE_ENV !== 'production') return next();
  // token 只走 header：URL query 会进代理/网关访问日志，明文 token 不能出现在 URL 里
  const token = String(req.headers['x-bambook-ops-token'] || '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Missing X-Bambook-Ops-Token' });
  if (token !== ADMIN_TOKEN) return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Invalid ops token' });
  return next();
}

function appendActionLog(event: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  fs.appendFileSync(ACTION_LOG, line);
}

function updateEnvToken(newToken: string) {
  const envPath = path.join(SERVER_ROOT, '.env.local');
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const retained = current
    .split('\n')
    .filter(line => !line.startsWith('BAMBOOK_OPS_ADMIN_TOKEN='))
    .join('\n')
    .trimEnd();
  const next = `${retained}${retained ? '\n' : ''}BAMBOOK_OPS_ADMIN_TOKEN=${newToken}\n`;
  fs.writeFileSync(envPath, next, { mode: 0o600 });
}

// .env.local 在 run-main-data-api.sh 里是用 `source` 加载的（按 bash 语法），
// 因此值里出现 `<` `>` `(` `)` `&` `;` `|` `空格` 等会被 bash 误解，必须加引号。
// 同时 dotenv 也兼容这种引号包裹的格式，所以 Node.js 直接读 .env 也没问题。
function shellQuoteEnvValue(value: string): string {
  // 简单值（仅字母数字 + 安全符号）不加引号，保持可读性
  if (/^[A-Za-z0-9_./:@,=+-]*$/.test(value)) return value;
  // 否则用单引号包裹；单引号本身用 '\'' 序列转义
  const escaped = value.replace(/'/g, `'\\''`);
  return `'${escaped}'`;
}

function updateMainApiEnv(values: Record<string, string>) {
  const envPath = path.join(SERVER_ROOT, '.env.local');
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const keys = new Set(Object.keys(values));
  const retained = current
    .split('\n')
    .filter(line => {
      const key = line.split('=', 1)[0];
      return key && !keys.has(key);
    })
    .join('\n')
    .trimEnd();
  const additions = Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuoteEnvValue(value)}`)
    .join('\n');
  const next = `${retained}${retained ? '\n' : ''}${additions}\n`;
  fs.writeFileSync(envPath, next, { mode: 0o600 });
}

function schedulePanelRestart() {
  const label = process.env.BAMBOOK_OPS_PANEL_LABEL || 'com.bambook.ops-panel';
  const child = spawn('/bin/bash', ['-lc', `sleep 2; launchctl kickstart -k "gui/$(id -u)/${label}"`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function changeOpsToken(req: Request, res: Response) {
  const newToken = String(req.body?.newToken || '').trim();
  if (newToken.length < 6) {
    return res.status(400).json({ ok: false, error: 'WEAK_TOKEN', message: 'New password must be at least 6 characters' });
  }
  if (/[\r\n]/.test(newToken)) {
    return res.status(400).json({ ok: false, error: 'BAD_TOKEN', message: 'New password cannot contain line breaks' });
  }

  updateEnvToken(newToken);
  appendActionLog({ action: 'changeToken', label: '修改运维面板管理员密码', status: 'ok', ip: req.ip });
  schedulePanelRestart();
  return res.json({ ok: true, message: 'Password updated. Ops panel will restart in a few seconds.' });
}

function updateModelKey(req: Request, res: Response) {
  const modelKey = String(req.body?.modelKey || req.headers['x-bambook-model-key'] || '').trim();
  if (modelKey.length < 12) {
    return res.status(400).json({ ok: false, error: 'BAD_MODEL_KEY', message: 'Model API key is missing or too short' });
  }
  if (/[\r\n]/.test(modelKey)) {
    return res.status(400).json({ ok: false, error: 'BAD_MODEL_KEY', message: 'Model API key cannot contain line breaks' });
  }

  updateMainApiEnv({
    ARK_API_KEY: modelKey,
    BAMBOOK_MODEL_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    BAMBOOK_MODEL_NAME: 'ark-code-latest',
  });
  appendActionLog({ action: 'updateModelKey', label: '更新 AI Runtime 模型 API Key', status: 'ok', ip: req.ip });

  const label = process.env.BAMBOOK_OPS_MAIN_API_LABEL || 'com.bambook.main-data-api';
  spawn('/bin/bash', ['-lc', `sleep 1; launchctl kickstart -k "gui/$(id -u)/${label}"`], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  return res.json({ ok: true, message: 'Model API key updated. Main API restart has been scheduled.' });
}

// ── 主 API 鉴权开关（BAMBOOK_REQUIRE_AUTH）─────────────────────────────
// 开启后业务路由要求 JWT 或 SDK API key（health/login 按设计保持开放）。
// 开启前置校验：服务端必须持有 SDK key（网页端 SSE ?apiKey=、Electron import、
// OPS 探针 X-Bambook-API-Key 都依赖它）——sdkKey 未提供且 env 无既有 key 时拒绝开启，
// 防止「一键开鉴权 → 实时通知/探针全断」的事故路径。
function setMainApiRequireAuth(req: Request, res: Response) {
  const enabled = req.body?.enabled !== false; // 缺省 true；显式 false 为回滚通道
  const sdkKey = String(req.body?.sdkKey || req.headers['x-bambook-sdk-key'] || '').trim();

  if (/[\r\n]/.test(sdkKey)) {
    return res.status(400).json({ ok: false, error: 'BAD_SDK_KEY', message: 'SDK key cannot contain line breaks' });
  }
  if (sdkKey && sdkKey.length < 16) {
    return res.status(400).json({ ok: false, error: 'BAD_SDK_KEY', message: 'SDK key is too short (min 16 chars)' });
  }

  const envHasSdkKey = [path.join(SERVER_ROOT, '.env.local'), path.join(SERVER_ROOT, '.env')]
    .filter(p => fs.existsSync(p))
    .some(p => fs.readFileSync(p, 'utf8').split('\n').some(l => /^(BAMBOOK_SDK_KEY|BAMBOOK_API_KEY|VITE_BAMBOOK_API_KEY)=/.test(l.trim())));
  if (enabled && !sdkKey && !envHasSdkKey) {
    return res.status(400).json({
      ok: false,
      error: 'SDK_KEY_REQUIRED',
      message: '开启鉴权前需提供 sdkKey（或服务端 env 已配置 BAMBOOK_SDK_KEY）——网页端 SSE 实时通知与 OPS 探针依赖该 key',
    });
  }

  const values: Record<string, string> = { BAMBOOK_REQUIRE_AUTH: enabled ? 'true' : 'false' };
  if (sdkKey) values.BAMBOOK_SDK_KEY = sdkKey;
  updateMainApiEnv(values);
  appendActionLog({
    action: 'setMainApiRequireAuth',
    label: enabled ? '开启主 API 鉴权（BAMBOOK_REQUIRE_AUTH=true）' : '关闭主 API 鉴权（回滚）',
    status: 'ok',
    sdkKeyProvided: Boolean(sdkKey),
    ip: req.ip,
  });

  // 主 API 与面板自身都重启：面板需重读 env 拿 MAIN_API_KEY（探针带 key）
  const mainApiLabel = process.env.BAMBOOK_OPS_MAIN_API_LABEL || 'com.bambook.main-data-api';
  spawn('/bin/bash', ['-lc', `sleep 1; launchctl kickstart -k "gui/$(id -u)/${mainApiLabel}"`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  schedulePanelRestart();

  return res.json({
    ok: true,
    enabled,
    message: enabled
      ? '主 API 鉴权已开启，主 API 与运维面板将自动重启（约 10 秒）。回滚：POST { "enabled": false }'
      : '主 API 鉴权已关闭（回滚完成），服务重启中',
  });
}

function updateEmailKey(req: Request, res: Response) {
  const apiKey = String(req.body?.apiKey || req.headers['x-bambook-resend-key'] || '').trim();
  const from = String(req.body?.from || '').trim();

  if (!apiKey || apiKey.length < 12) {
    return res.status(400).json({ ok: false, error: 'BAD_RESEND_KEY', message: 'Resend API key is missing or too short' });
  }
  if (!/^re_[A-Za-z0-9_\-]+$/.test(apiKey)) {
    return res.status(400).json({ ok: false, error: 'BAD_RESEND_KEY', message: 'Resend API key must look like "re_xxxx..."' });
  }
  if (/[\r\n]/.test(apiKey) || /[\r\n]/.test(from)) {
    return res.status(400).json({ ok: false, error: 'BAD_INPUT', message: 'Values cannot contain line breaks' });
  }
  if (!from) {
    return res.status(400).json({ ok: false, error: 'BAD_FROM', message: 'Sender (RESEND_FROM) is required' });
  }
  const fromEmail = from.match(/<([^>]+)>/)?.[1] || from;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
    return res.status(400).json({ ok: false, error: 'BAD_FROM', message: `Sender email is invalid: ${fromEmail}` });
  }

  updateMainApiEnv({
    RESEND_API_KEY: apiKey,
    RESEND_FROM: from,
  });
  appendActionLog({ action: 'updateEmailKey', label: '更新邮件发送 (Resend)', status: 'ok', from, ip: req.ip });

  const label = process.env.BAMBOOK_OPS_MAIN_API_LABEL || 'com.bambook.main-data-api';
  spawn('/bin/bash', ['-lc', `sleep 1; launchctl kickstart -k "gui/$(id -u)/${label}"`], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  return res.json({ ok: true, message: 'Resend 配置已更新，主 API 重启已排程（约 5~10 秒后生效）。', from });
}

async function deployUploadedPackage(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'EMPTY_PACKAGE', message: 'Missing tar.gz request body' });
  }

  const tmpRoot = fs.mkdtempSync('/tmp/bambook-ops-upload-');
  const archivePath = path.join(tmpRoot, 'payload.tar.gz');
  fs.writeFileSync(archivePath, req.body);

  appendActionLog({ action: 'deployUploadedPackage', label: '上传更新包并部署运维面板', status: 'started', bytes: req.body.length, ip: req.ip });

  try {
    const extractDir = path.join(tmpRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', extractDir], { timeout: 60_000, maxBuffer: 1024 * 1024 });

    const entries = fs.readdirSync(extractDir).map(name => path.join(extractDir, name));
    const rootDir = entries.find(entry => fs.existsSync(path.join(entry, 'server', 'ops-panel'))) || extractDir;
    const serverSrc = fs.existsSync(path.join(rootDir, 'server', 'ops-panel')) ? path.join(rootDir, 'server') : rootDir;

    const panelSrc = path.join(serverSrc, 'ops-panel');
    const scriptsSrc = path.join(serverSrc, 'scripts');
    const docsSrc = path.join(serverSrc, 'docs', 'ops-panel-runbook.md');
    const mainSrc = path.join(serverSrc, 'src');
    const prismaSrc = path.join(serverSrc, 'prisma');

    if (!fs.existsSync(panelSrc) || !fs.existsSync(path.join(scriptsSrc, 'ops'))) {
      throw new Error('Package must contain server/ops-panel and server/scripts/ops');
    }
    const hasMainApi = fs.existsSync(mainSrc) && fs.existsSync(path.join(serverSrc, 'package.json'));

    await execFileAsync('/bin/rm', ['-rf', PANEL_ROOT, path.join(SERVER_ROOT, 'scripts', 'ops')], { timeout: 60_000 });
    fs.mkdirSync(path.join(SERVER_ROOT, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(SERVER_ROOT, 'docs'), { recursive: true });

    await execFileAsync('/bin/cp', ['-R', panelSrc, PANEL_ROOT], { timeout: 60_000 });
    await execFileAsync('/bin/cp', [path.join(scriptsSrc, 'run-ops-panel.sh'), path.join(SERVER_ROOT, 'scripts')], { timeout: 60_000 });
    for (const plistFile of fs.readdirSync(scriptsSrc).filter(name => name.endsWith('.plist'))) {
      await execFileAsync('/bin/cp', [path.join(scriptsSrc, plistFile), path.join(SERVER_ROOT, 'scripts')], { timeout: 60_000 });
    }
    await execFileAsync('/bin/cp', ['-R', path.join(scriptsSrc, 'ops'), path.join(SERVER_ROOT, 'scripts', 'ops')], { timeout: 60_000 });
    // Copy seed / utility scripts (non-ops scripts used by ops actions and runtime services)
    // 2026-08-28 运维冲刺：.sh 一并拷贝（backup-postgres.sh 曾因只拷 .ts/.js/.py 而长期滞留旧版）
    for (const seedFile of fs.readdirSync(scriptsSrc).filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.sh'))) {
      await execFileAsync('/bin/cp', [path.join(scriptsSrc, seedFile), path.join(SERVER_ROOT, 'scripts', seedFile)], { timeout: 60_000 });
    }
    if (fs.existsSync(docsSrc)) {
      await execFileAsync('/bin/cp', [docsSrc, path.join(SERVER_ROOT, 'docs')], { timeout: 60_000 });
    }
    await execFileAsync('/bin/chmod', ['+x', path.join(SERVER_ROOT, 'scripts', 'run-ops-panel.sh'), ...fs.readdirSync(path.join(SERVER_ROOT, 'scripts', 'ops')).filter(name => name.endsWith('.sh')).map(name => path.join(SERVER_ROOT, 'scripts', 'ops', name)), ...fs.readdirSync(path.join(SERVER_ROOT, 'scripts')).filter(name => name.endsWith('.sh')).map(name => path.join(SERVER_ROOT, 'scripts', name))], { timeout: 60_000 });

    const mainLogs: Array<{ stdout: string; stderr: string }> = [];
    if (hasMainApi) {
      await execFileAsync('/bin/rm', ['-rf', path.join(SERVER_ROOT, 'src')], { timeout: 60_000 });
      await execFileAsync('/bin/cp', ['-R', mainSrc, path.join(SERVER_ROOT, 'src')], { timeout: 60_000 });
      if (fs.existsSync(prismaSrc)) {
        await execFileAsync('/bin/rm', ['-rf', path.join(SERVER_ROOT, 'prisma')], { timeout: 60_000 });
        await execFileAsync('/bin/cp', ['-R', prismaSrc, path.join(SERVER_ROOT, 'prisma')], { timeout: 60_000 });
      }
      for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']) {
        const source = path.join(serverSrc, file);
        if (fs.existsSync(source)) {
          await execFileAsync('/bin/cp', [source, path.join(SERVER_ROOT, file)], { timeout: 60_000 });
        }
      }
      mainLogs.push(await execFileAsync('/usr/bin/env', ['npm', 'install', '--include=dev'], {
        cwd: SERVER_ROOT,
        timeout: 180_000,
        maxBuffer: 1024 * 1024 * 2,
        env: process.env,
      }));
      if (fs.existsSync(path.join(SERVER_ROOT, 'prisma'))) {
        // 部署通道已收敛到 migrate deploy 单一真源（运维冲刺任务 2）——禁止 db push
        // --accept-data-loss（绕过账本、可能静默丢列）；迁移账本断链时用
        // scripts/fix-migration-ledger.ts 补账后再 deploy。
        mainLogs.push(await execFileAsync('/usr/bin/env', ['npx', 'prisma', 'migrate', 'deploy'], {
          cwd: SERVER_ROOT,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 2,
          env: process.env,
        }));
        mainLogs.push(await execFileAsync('/usr/bin/env', ['npx', 'prisma', 'generate'], {
          cwd: SERVER_ROOT,
          timeout: 120_000,
          maxBuffer: 1024 * 1024 * 2,
          env: process.env,
        }));
      }
      mainLogs.push(await execFileAsync('/usr/bin/env', ['npm', 'run', 'build'], {
        cwd: SERVER_ROOT,
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 2,
        env: process.env,
      }));
    }

    const install = await execFileAsync('/usr/bin/env', ['npm', 'install', '--include=dev'], {
      cwd: PANEL_ROOT,
      timeout: 180_000,
      maxBuffer: 1024 * 1024 * 2,
      env: process.env,
    });
    const build = await execFileAsync('/usr/bin/env', ['npm', 'run', 'build'], {
      cwd: PANEL_ROOT,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 2,
      env: process.env,
    });

    appendActionLog({ action: 'deployUploadedPackage', status: 'ok', bytes: req.body.length });
    if (hasMainApi) {
      const label = process.env.BAMBOOK_OPS_MAIN_API_LABEL || 'com.bambook.main-data-api';
      spawn('/bin/bash', ['-lc', `sleep 2; launchctl kickstart -k "gui/$(id -u)/${label}"`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
    schedulePanelRestart();
    return res.json({
      ok: true,
      action: 'deployUploadedPackage',
      message: hasMainApi
        ? 'Package deployed. Main API and ops panel restarts have been scheduled.'
        : 'Package deployed. Ops panel restart has been scheduled.',
      stdout: [...mainLogs.map(log => log.stdout), install.stdout, build.stdout].filter(Boolean).join('\n'),
      stderr: [...mainLogs.map(log => log.stderr), install.stderr, build.stderr].filter(Boolean).join('\n'),
    });
  } catch (error: any) {
    appendActionLog({ action: 'deployUploadedPackage', status: 'error', error: String(error?.message || error) });
    return res.status(500).json({
      ok: false,
      error: String(error?.message || error),
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    });
  }
}

async function deployUploadedWebapp(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'EMPTY_PACKAGE', message: 'Missing tar.gz request body' });
  }

  // 部署目标：webapp（默认，老路径入口 base=/bambook/api/app/）| webapp-root（子域名入口 base=/）
  const rawTarget = String(req.headers['x-deploy-target'] || 'webapp');
  const target = rawTarget === 'webapp-root' ? 'webapp-root' : 'webapp';

  const tmpRoot = fs.mkdtempSync('/tmp/bambook-webapp-upload-');
  const archivePath = path.join(tmpRoot, 'payload.tar.gz');
  fs.writeFileSync(archivePath, req.body);

  appendActionLog({ action: 'deployUploadedWebapp', label: `上传网页端打包并部署（${target}）`, status: 'started', bytes: req.body.length, ip: req.ip });

  // Webapp lives next to the main API source so the express.static at
  // /api/app picks it up automatically. Keep one previous version on disk
  // for emergency manual rollback (mv webapp.prev webapp).
  // webapp-root 同构双目录：主 API 根路径直挂（子域名 bambook.jiangsupanda.com）。
  const webappDir = path.join(SERVER_ROOT, target);
  const prevDir = path.join(SERVER_ROOT, `${target}.prev`);

  try {
    const extractDir = path.join(tmpRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', extractDir], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024 * 4,
    });

    const indexFile = path.join(extractDir, 'index.html');
    if (!fs.existsSync(indexFile)) {
      throw new Error('Package must contain an index.html at the archive root (tar -czf X.tgz -C dist .)');
    }

    if (fs.existsSync(prevDir)) {
      await execFileAsync('/bin/rm', ['-rf', prevDir], { timeout: 60_000 });
    }
    if (fs.existsSync(webappDir)) {
      await execFileAsync('/bin/mv', [webappDir, prevDir], { timeout: 60_000 });
    }
    fs.mkdirSync(webappDir, { recursive: true });
    await execFileAsync('/bin/cp', ['-R', `${extractDir}/.`, webappDir], { timeout: 60_000 });

    // 大体量静态资源目录内容稳定、极少变更，轻量部署包可省略以降低上传体积。
    // 此处从上一版本自动沿用，避免被全量替换语义误删。
    // 扩展沿用目录：data/glyphs（字体字形）、geo（地理数据）、fonts（字体文件）。
    // wallpapers/dev-assets 为已清理死重（壁纸功能下线/零引用设计物料），不再沿用。
    // webapp-root 首次部署无 prev 时：重资产从老入口 webapp/ 交叉沿用——
    // 地图数据/字体与构建 base 路径无关，两份产物完全相同，免 88MB 全量种子上传。
    const carryDirs = target === 'webapp-root'
      ? ['data', 'glyphs', 'geo', 'fonts']
      : ['data', 'wallpapers', 'glyphs', 'geo', 'fonts', 'dev-assets'];
    const crossEntrySource = (target === 'webapp-root' && !fs.existsSync(prevDir)
      && fs.existsSync(path.join(SERVER_ROOT, 'webapp')))
      ? path.join(SERVER_ROOT, 'webapp')
      : null;
    if (crossEntrySource) {
      appendActionLog({ action: 'deployUploadedWebapp', status: 'carryover', from: 'webapp', note: '首次部署 webapp-root，重资产交叉沿用老入口' });
    }
    // ★★ 逐文件合并，不是「整目录二选一」（2026-09-19 修）
    //
    // 旧实现：`if (!fs.existsSync(inPackage)) 整目录 cp -R prev` —— 但 **tar 一定会写入目录条目**
    // （`tar -C dist .` 会带上 `./fonts/`），所以 `inPackage` **恒为真** ⇒ 沿用**从不触发**。
    // 而服务端是「整目录替换」语义（mv 到 .prev 后 cp 新包）⇒ 客户端因为「增量跳过」
    // 没有打包进包里的文件，**在部署时被静默删除**，站点 404 且无人报警。
    //
    // 实测后果（修复前）：webapp-root/fonts 只剩 Inter-*.woff2（AcherusGrotesque-*.otf 被删）、
    // webapp/fonts 只剩 AcherusGrotesque-*.otf（Inter-*.woff2 被删）—— 两个入口互相丢文件。
    //
    // 现在：prev 里有、而**包里没有的同路径文件**逐个补齐（包里的新版永远优先）。
    for (const heavyDir of carryDirs) {
      const inPackage = path.join(extractDir, heavyDir);
      const deployed = path.join(webappDir, heavyDir);
      const inPrev = path.join(prevDir, heavyDir);
      const inCross = crossEntrySource ? path.join(crossEntrySource, heavyDir) : null;
      const source = fs.existsSync(inPrev) ? inPrev : (inCross && fs.existsSync(inCross) ? inCross : null);
      if (!source || !fs.existsSync(source)) continue;
      let carried = 0;
      const merge = (rel: string) => {
        const srcAbs = rel ? path.join(source, rel) : source;
        if (!fs.existsSync(srcAbs)) return;
        if (fs.statSync(srcAbs).isDirectory()) {
          for (const name of fs.readdirSync(srcAbs)) merge(rel ? path.join(rel, name) : name);
          return;
        }
        if (fs.existsSync(rel ? path.join(inPackage, rel) : inPackage)) return; // 包里有新版 ⇒ 不覆盖
        const dstAbs = rel ? path.join(deployed, rel) : deployed;
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.copyFileSync(srcAbs, dstAbs);
        carried += 1;
      };
      merge('');
      if (carried > 0) {
        appendActionLog({ action: 'deployUploadedWebapp', status: 'carryover', dir: heavyDir, files: carried, from: source === inPrev ? 'prev' : 'webapp' });
      }
    }

    // ★★ 根级文件沿用 —— 从「硬编码 2 个」改为「**遍历 prev 根级、包里没有的才补**」（2026-09-19 二次修）
    //
    // 旧实现只列了 2 个（`ne_50m_admin_0_countries.geojson` / `earth_specular_2048.jpg`）。
    // 于是**其它根级文件**一旦被增量包省略（客户端「同名且同 size 跳过」），
    // 就会被服务端的**整目录替换**静默删除 —— **与上面 fonts 那个缺陷是同一类**：
    // **硬编码枚举 ⇒ 覆盖面小于实际文件面**（本仓 REFERENCE.md 的判据又踩一次）。
    //
    // 实测（2026-09-19 生产核对）：`webapp` 入口的 `pwa-icon.svg` / `ui-lab-icon.svg` /
    // `logo_dual.svg` **已经 404**，而 `webapp-root` 尚在 —— 即「两个入口又互相丢文件」，
    // 与 2026-09-19 上午修的 fonts 症状一模一样，只是发生在**根级**。
    //
    // 修法：判据翻转 —— **枚举「不沿用的」而不是「要沿用的」**：
    //   · 跳过目录（由 carryDirs 处理）
    //   · 跳过包里已有的（新版优先）
    //   · ⚠️ 跨入口沿用（webapp-root 首次部署、无 prev）时**跳过 `index.html`** ——
    //     两个入口的 base 不同（`/` vs `/bambook/api/app/`），拿对方的 index.html 会**指错资源路径**。
    // 取舍：与 carryDirs 同口径 —— **从仓库删掉的文件会在生产残留**（不自动清）。
    //   这是本仓既有决策（上午修 fonts 时已接受），此处保持一致，避免引入两种语义。
    {
      const rootSource = fs.existsSync(prevDir) ? prevDir : crossEntrySource;
      const fromCross = rootSource !== null && rootSource === crossEntrySource;
      if (rootSource && fs.existsSync(rootSource)) {
        let carriedRoot = 0;
        for (const name of fs.readdirSync(rootSource)) {
          const srcAbs = path.join(rootSource, name);
          let isDir = false;
          try { isDir = fs.statSync(srcAbs).isDirectory(); } catch { continue; }
          if (isDir) continue;                                     // 目录 → carryDirs
          if (fromCross && name === 'index.html') continue;         // base 不同，不可跨入口沿用
          if (fs.existsSync(path.join(extractDir, name))) continue;  // 包里有新版 ⇒ 不覆盖
          fs.copyFileSync(srcAbs, path.join(webappDir, name));
          carriedRoot += 1;
        }
        if (carriedRoot > 0) {
          appendActionLog({ action: 'deployUploadedWebapp', status: 'carryover', scope: 'root', files: carriedRoot, from: fromCross ? 'webapp' : 'prev' });
        }
      }
    }

    // assets/ 目录全量文件级沿用：JS/CSS bundles 和字体文件均为 content-hash 命名，
    // 轻量包省略后按文件名从上一版本补齐；新文件会以新 hash 出现在新包中。
    // 这允许超轻量包只包含变更的 JS/CSS 文件，未变更的自动从上一版本沿用。
    // webapp-root 首次部署时 assets 字体同样从老入口交叉沿用（JS/CSS 因 base 不同必然全量在包内）。
    const assetsSourceDir = fs.existsSync(path.join(prevDir, 'assets'))
      ? path.join(prevDir, 'assets')
      : (crossEntrySource ? path.join(crossEntrySource, 'assets') : null);
    const newAssets = path.join(webappDir, 'assets');
    if (assetsSourceDir && fs.existsSync(assetsSourceDir) && fs.existsSync(newAssets)) {
      let carriedAssets = 0;
      for (const f of fs.readdirSync(assetsSourceDir)) {
        const target = path.join(newAssets, f);
        if (!fs.existsSync(target)) {
          fs.copyFileSync(path.join(assetsSourceDir, f), target);
          carriedAssets += 1;
        }
      }
      if (carriedAssets > 0) {
        appendActionLog({ action: 'deployUploadedWebapp', status: 'carryover', dir: 'assets', files: carriedAssets });
      }
    }

    appendActionLog({ action: 'deployUploadedWebapp', status: 'ok', bytes: req.body.length });

    // Bounce the main API so the static-mount probe (fs.existsSync at startup)
    // catches a fresh first-time deploy. Subsequent updates would technically
    // work without a restart since express.static reads files on each request,
    // but bouncing keeps behavior deterministic.
    const label = process.env.BAMBOOK_OPS_MAIN_API_LABEL || 'com.bambook.main-data-api';
    spawn('/bin/bash', ['-lc', `sleep 1; launchctl kickstart -k "gui/$(id -u)/${label}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    return res.json({
      ok: true,
      action: 'deployUploadedWebapp',
      target,
      message: target === 'webapp-root'
        ? '网页端已部署到 ~/bambook-main-api/webapp-root/，主 API 重启已排程，约 5~10 秒后访问 https://bambook.jiangsupanda.com/'
        : '网页端已部署到 ~/bambook-main-api/webapp/，主 API 重启已排程，约 5~10 秒后访问 https://jiangsupanda.com/bambook/api/app/',
      bytes: req.body.length,
    });
  } catch (error: any) {
    appendActionLog({ action: 'deployUploadedWebapp', status: 'error', error: String(error?.message || error) });
    return res.status(500).json({
      ok: false,
      error: String(error?.message || error),
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    });
  } finally {
    try {
      await execFileAsync('/bin/rm', ['-rf', tmpRoot], { timeout: 30_000 });
    } catch {
      // best effort
    }
  }
}

async function runLocalScript(scriptName: string, timeoutMs: number) {
  const script = path.join(SERVER_ROOT, 'scripts', 'ops', scriptName);
  if (!script.startsWith(path.join(SERVER_ROOT, 'scripts', 'ops'))) {
    throw new Error('Invalid script path');
  }
  if (!fs.existsSync(script)) throw new Error(`Missing script: ${script}`);
  const { stdout, stderr } = await execFileAsync('/bin/bash', [script], {
    cwd: SERVER_ROOT,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      SERVER_ROOT,
      REPO_ROOT,
      PANEL_ROOT,
    },
  });
  return { stdout, stderr };
}

function resolveDevJobCwd(value: unknown) {
  const raw = String(value || 'server').trim();
  const option = DEV_JOB_CWD_OPTIONS.find(item => item.id === raw) || DEV_JOB_CWD_OPTIONS.find(item => item.cwd === raw);
  if (!option) throw new Error(`Unsupported cwd: ${raw}`);
  return option.cwd;
}

function resolveDevFilePath(cwdValue: unknown, filePathValue: unknown) {
  const cwd = resolveDevJobCwd(cwdValue);
  const rawPath = String(filePathValue || '').trim();
  if (!rawPath) throw new Error('File path is required');
  if (rawPath.includes('\0')) throw new Error('File path contains invalid characters');
  const fullPath = path.resolve(cwd, rawPath);
  const relative = path.relative(cwd, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('File path must stay inside the selected workspace');
  }
  return { cwd, fullPath, relative };
}

function readDevFile(req: Request, res: Response) {
  let resolved: ReturnType<typeof resolveDevFilePath>;
  try {
    resolved = resolveDevFilePath(req.query.cwd || req.body?.cwd, req.query.path || req.body?.path);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_PATH', message: String(error?.message || error) });
  }

  try {
    const stat = fs.statSync(resolved.fullPath);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: 'NOT_A_FILE', message: 'Path is not a file' });
    if (stat.size > DEV_FILE_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: `File is larger than ${DEV_FILE_MAX_BYTES} bytes` });
    }
    const content = fs.readFileSync(resolved.fullPath, 'utf8');
    return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, bytes: stat.size, mtime: stat.mtime.toISOString(), content });
  } catch (error: any) {
    return res.status(404).json({ ok: false, error: 'READ_FAILED', message: String(error?.message || error) });
  }
}

function backupExistingDevFile(fullPath: string, relativePath: string) {
  if (!fs.existsSync(fullPath)) return null;
  fs.mkdirSync(DEV_FILE_BACKUP_DIR, { recursive: true, mode: 0o700 });
  const backupName = `${Date.now()}-${relativePath.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
  const backupPath = path.join(DEV_FILE_BACKUP_DIR, backupName);
  fs.copyFileSync(fullPath, backupPath);
  return backupPath;
}

function writeDevFile(req: Request, res: Response) {
  let resolved: ReturnType<typeof resolveDevFilePath>;
  try {
    resolved = resolveDevFilePath(req.body?.cwd, req.body?.path);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_PATH', message: String(error?.message || error) });
  }

  const content = String(req.body?.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > DEV_FILE_MAX_BYTES) {
    return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: `Content is larger than ${DEV_FILE_MAX_BYTES} bytes` });
  }
  if (req.body?.confirm !== 'SAVE_REMOTE_FILE') {
    return res.status(400).json({ ok: false, error: 'BAD_CONFIRM', message: 'confirm must be SAVE_REMOTE_FILE' });
  }

  try {
    fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true });
    const backupPath = backupExistingDevFile(resolved.fullPath, resolved.relative);
    fs.writeFileSync(resolved.fullPath, content, { mode: 0o644 });
    appendActionLog({ action: 'devFileWrite', status: 'ok', cwd: resolved.cwd, path: resolved.relative, backupPath, bytes: Buffer.byteLength(content, 'utf8'), ip: req.ip });
    return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, backupPath, bytes: Buffer.byteLength(content, 'utf8') });
  } catch (error: any) {
    appendActionLog({ action: 'devFileWrite', status: 'error', cwd: resolved.cwd, path: resolved.relative, error: String(error?.message || error), ip: req.ip });
    return res.status(500).json({ ok: false, error: 'WRITE_FAILED', message: String(error?.message || error) });
  }
}

async function buildUnifiedDiff(filePath: string, content: string) {
  const tmpDir = fs.mkdtempSync('/tmp/bambook-ops-diff-');
  const nextPath = path.join(tmpDir, 'next');
  try {
    fs.writeFileSync(nextPath, content, { mode: 0o600 });
    try {
      const { stdout, stderr } = await execFileAsync('/usr/bin/diff', ['-u', filePath, nextPath], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      return maskSensitiveOutput(stdout || stderr || 'No changes.');
    } catch (error: any) {
      const stdout = String(error?.stdout || '');
      const stderr = String(error?.stderr || '');
      if (typeof error?.code === 'number' && error.code === 1 && stdout) return maskSensitiveOutput(stdout);
      return maskSensitiveOutput(stdout || stderr || String(error?.message || error));
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function diffDevFile(req: Request, res: Response) {
  let resolved: ReturnType<typeof resolveDevFilePath>;
  try {
    resolved = resolveDevFilePath(req.body?.cwd, req.body?.path);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_PATH', message: String(error?.message || error) });
  }
  const content = String(req.body?.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > DEV_FILE_MAX_BYTES) {
    return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE', message: `Content is larger than ${DEV_FILE_MAX_BYTES} bytes` });
  }
  if (!fs.existsSync(resolved.fullPath)) {
    return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, exists: false, diff: `--- /dev/null\n+++ ${resolved.relative}\n@@ new file @@\n${content.split('\n').map(line => `+${line}`).join('\n')}` });
  }
  const diff = await buildUnifiedDiff(resolved.fullPath, content);
  return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, exists: true, diff });
}

function backupFileMatchesPath(fileName: string, relativePath: string) {
  const encoded = relativePath.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return fileName.endsWith(`-${encoded}`);
}

function listDevFileBackups(req: Request, res: Response) {
  let resolved: ReturnType<typeof resolveDevFilePath>;
  try {
    resolved = resolveDevFilePath(req.query.cwd || req.body?.cwd, req.query.path || req.body?.path);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_PATH', message: String(error?.message || error) });
  }
  if (!fs.existsSync(DEV_FILE_BACKUP_DIR)) return res.json({ ok: true, backups: [] });
  const backups = fs.readdirSync(DEV_FILE_BACKUP_DIR)
    .filter(name => backupFileMatchesPath(name, resolved.relative))
    .map(name => {
      const fullPath = path.join(DEV_FILE_BACKUP_DIR, name);
      const stat = fs.statSync(fullPath);
      return { id: name, path: fullPath, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);
  return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, backups });
}

function rollbackDevFile(req: Request, res: Response) {
  let resolved: ReturnType<typeof resolveDevFilePath>;
  try {
    resolved = resolveDevFilePath(req.body?.cwd, req.body?.path);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_PATH', message: String(error?.message || error) });
  }
  if (req.body?.confirm !== 'ROLLBACK_REMOTE_FILE') {
    return res.status(400).json({ ok: false, error: 'BAD_CONFIRM', message: 'confirm must be ROLLBACK_REMOTE_FILE' });
  }
  const backupId = String(req.body?.backupId || '').trim();
  if (!backupId || backupId.includes('/') || backupId.includes('\\')) {
    return res.status(400).json({ ok: false, error: 'BAD_BACKUP', message: 'Invalid backup id' });
  }
  if (!backupFileMatchesPath(backupId, resolved.relative)) {
    return res.status(400).json({ ok: false, error: 'BAD_BACKUP', message: 'Backup does not match file path' });
  }
  const backupPath = path.join(DEV_FILE_BACKUP_DIR, backupId);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ ok: false, error: 'BACKUP_NOT_FOUND' });
  try {
    fs.copyFileSync(backupPath, resolved.fullPath);
    const stat = fs.statSync(resolved.fullPath);
    appendActionLog({ action: 'devFileRollback', status: 'ok', cwd: resolved.cwd, path: resolved.relative, backupId, bytes: stat.size, ip: req.ip });
    return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, backupId, bytes: stat.size });
  } catch (error: any) {
    appendActionLog({ action: 'devFileRollback', status: 'error', cwd: resolved.cwd, path: resolved.relative, backupId, error: String(error?.message || error), ip: req.ip });
    return res.status(500).json({ ok: false, error: 'ROLLBACK_FAILED', message: String(error?.message || error) });
  }
}

function uploadDevFile(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'EMPTY_UPLOAD', message: 'Upload body is empty' });
  }
  let resolved: ReturnType<typeof resolveDevFilePath>;
  try {
    resolved = resolveDevFilePath(req.query.cwd || req.headers['x-bambook-dev-cwd'], req.query.path || req.headers['x-bambook-dev-path']);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_PATH', message: String(error?.message || error) });
  }
  if (String(req.headers['x-bambook-dev-confirm'] || '') !== 'UPLOAD_REMOTE_FILE') {
    return res.status(400).json({ ok: false, error: 'BAD_CONFIRM', message: 'X-Bambook-Dev-Confirm must be UPLOAD_REMOTE_FILE' });
  }

  try {
    fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true });
    const backupPath = backupExistingDevFile(resolved.fullPath, resolved.relative);
    fs.writeFileSync(resolved.fullPath, req.body, { mode: 0o644 });
    appendActionLog({ action: 'devFileUpload', status: 'ok', cwd: resolved.cwd, path: resolved.relative, backupPath, bytes: req.body.length, ip: req.ip });
    return res.json({ ok: true, cwd: resolved.cwd, path: resolved.relative, backupPath, bytes: req.body.length });
  } catch (error: any) {
    appendActionLog({ action: 'devFileUpload', status: 'error', cwd: resolved.cwd, path: resolved.relative, error: String(error?.message || error), ip: req.ip });
    return res.status(500).json({ ok: false, error: 'UPLOAD_FAILED', message: String(error?.message || error) });
  }
}

function maskSensitiveOutput(value: string) {
  return String(value)
    .replace(/(BAMBOOK_OPS_ADMIN_TOKEN|DATABASE_URL|BAMBOOK_API_KEY|BAMBOOK_SDK_KEY|VITE_BAMBOOK_API_KEY|ARK_API_KEY|RESEND_API_KEY|CLOUDFLARE_TUNNEL_TOKEN)=([^\s'"]+)/g, '$1=[redacted]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s'"]+/gi, '$1[redacted]')
    .replace(/\b(re_[A-Za-z0-9_-]{12,})\b/g, 're_[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, 'sk-[redacted]');
}

function appendDevJobOutput(job: DevJob, chunk: Buffer | string) {
  const next = maskSensitiveOutput(String(chunk));
  job.output = `${job.output}${next}`;
  if (job.output.length > DEV_JOB_MAX_OUTPUT) {
    job.output = `... output truncated to last ${DEV_JOB_MAX_OUTPUT} chars ...\n${job.output.slice(-DEV_JOB_MAX_OUTPUT)}`;
  }
  job.updatedAt = new Date().toISOString();
}

function serializeDevJob(job: DevJob, includeOutput = true) {
  const { child: _child, ...rest } = job;
  return includeOutput ? rest : { ...rest, output: undefined };
}

function serializeDevJobForHistory(job: DevJob) {
  const output = maskSensitiveOutput(job.output || '');
  return {
    ...serializeDevJob(job),
    command: maskSensitiveOutput(job.command),
    output: output.length > DEV_JOB_HISTORY_OUTPUT_TAIL
      ? `... persisted output truncated to last ${DEV_JOB_HISTORY_OUTPUT_TAIL} chars ...\n${output.slice(-DEV_JOB_HISTORY_OUTPUT_TAIL)}`
      : output,
  };
}

function appendDevJobHistory(job: DevJob) {
  try {
    fs.appendFileSync(DEV_JOB_HISTORY_FILE, JSON.stringify(serializeDevJobForHistory(job)) + '\n', { mode: 0o600 });
  } catch (error) {
    appendActionLog({ action: 'devJobHistory', status: 'error', id: job.id, error: String((error as Error)?.message || error) });
  }
}

function readDevJobHistory(limit = 30) {
  if (!fs.existsSync(DEV_JOB_HISTORY_FILE)) return [];
  try {
    const lines = readTail(DEV_JOB_HISTORY_FILE, Math.max(limit * 3, 90)).split('\n').filter(Boolean);
    return lines
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function activeJobLocks() {
  return Array.from(devJobs.values())
    .filter(job => job.status === 'running' && job.lockKey)
    .map(job => ({
      key: job.lockKey,
      label: job.lockLabel || job.lockKey,
      jobId: job.id,
      actionId: job.actionId || null,
      startedAt: job.startedAt,
      command: maskSensitiveOutput(job.command),
    }));
}

function activeJobLock(key: string) {
  return activeJobLocks().find(lock => lock.key === key) || null;
}

function listDevJobs(_req: Request, res: Response) {
  const memoryJobs = Array.from(devJobs.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 30)
    .map(job => serializeDevJob(job, false));
  const seen = new Set(memoryJobs.map(job => job.id));
  const persistedJobs = readDevJobHistory(30)
    .filter(job => !seen.has(job.id))
    .map(job => ({ ...job, output: undefined }));
  const jobs = [...memoryJobs, ...persistedJobs]
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
    .slice(0, 30);
  res.json({ ok: true, cwdOptions: DEV_JOB_CWD_OPTIONS, jobs, activeLocks: activeJobLocks() });
}

function getDevJob(req: Request, res: Response) {
  const job = devJobs.get(req.params.id);
  if (job) return res.json({ ok: true, job: serializeDevJob(job) });
  const persisted = readDevJobHistory(200).find(item => item.id === req.params.id);
  if (!persisted) return res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND' });
  return res.json({ ok: true, job: persisted });
}

function createDevJob(command: string, cwd: string, timeoutMs: number, meta: { action?: string; label?: string; ip?: string; lockKey?: string; lockLabel?: string } = {}) {
  const id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const displayCommand = maskSensitiveOutput(command);
  const job: DevJob = {
    id,
    command,
    cwd,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    output: `$ ${displayCommand}\n# cwd: ${cwd}\n\n`,
    lockKey: meta.lockKey,
    lockLabel: meta.lockLabel,
    actionId: meta.action,
    label: meta.label,
  };
  devJobs.set(id, job);
  appendActionLog({ action: meta.action || 'devJob', label: meta.label || 'Remote Develop command', status: 'started', id, cwd, command: displayCommand, lockKey: meta.lockKey, ip: meta.ip });

  const child = spawn('/bin/bash', ['-lc', command], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      SERVER_ROOT,
      REPO_ROOT,
      PANEL_ROOT,
      TERM: process.env.TERM || 'xterm-256color',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  job.pid = child.pid;

  const timeout = setTimeout(() => {
    if (job.status !== 'running') return;
    appendDevJobOutput(job, `\n[ops] timeout after ${timeoutMs}ms; terminating job\n`);
    cancelDevJobProcess(job, 'timeout');
  }, timeoutMs);

  child.stdout?.on('data', chunk => appendDevJobOutput(job, chunk));
  child.stderr?.on('data', chunk => appendDevJobOutput(job, chunk));
  child.on('error', error => {
    clearTimeout(timeout);
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    appendDevJobOutput(job, `\n[ops] failed to start: ${String(error?.message || error)}\n`);
    appendActionLog({ action: meta.action || 'devJob', status: 'error', id, error: String(error?.message || error) });
  });
  child.on('close', (code, signal) => {
    clearTimeout(timeout);
    if (job.status === 'cancelled') {
      job.exitCode = code;
      job.signal = signal;
    } else {
      job.status = code === 0 ? 'ok' : 'error';
      job.exitCode = code;
      job.signal = signal;
    }
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    appendDevJobOutput(job, `\n[ops] finished with status=${job.status} code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    appendDevJobHistory(job);
    appendActionLog({ action: meta.action || 'devJob', status: job.status, id, code, signal });
  });

  return job;
}

function scriptCommandForAction(action: OpsAction) {
  const script = path.join(SERVER_ROOT, 'scripts', 'ops', action.script);
  if (!script.startsWith(path.join(SERVER_ROOT, 'scripts', 'ops'))) {
    throw new Error('Invalid script path');
  }
  if (!fs.existsSync(script)) throw new Error(`Missing script: ${script}`);
  return `/bin/bash ${JSON.stringify(script)}`;
}

function startDevJob(req: Request, res: Response) {
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ ok: false, error: 'BAD_COMMAND', message: 'Command is required' });
  if (command.length > DEV_JOB_MAX_COMMAND_LENGTH) {
    return res.status(400).json({ ok: false, error: 'COMMAND_TOO_LONG', message: `Command must be <= ${DEV_JOB_MAX_COMMAND_LENGTH} characters` });
  }

  const active = Array.from(devJobs.values()).filter(job => job.status === 'running').length;
  if (active >= DEV_JOB_MAX_ACTIVE) {
    return res.status(429).json({ ok: false, error: 'TOO_MANY_ACTIVE_JOBS', message: `Only ${DEV_JOB_MAX_ACTIVE} development jobs can run at once` });
  }

  let cwd: string;
  try {
    cwd = resolveDevJobCwd(req.body?.cwd);
  } catch (error: any) {
    return res.status(400).json({ ok: false, error: 'BAD_CWD', message: String(error?.message || error) });
  }

  const requestedLockKey = String(req.body?.lockKey || '').trim();
  let lockKey: string | undefined;
  let lockLabel: string | undefined;
  if (requestedLockKey) {
    lockLabel = DEV_JOB_LOCKS[requestedLockKey];
    if (!lockLabel) {
      return res.status(400).json({ ok: false, error: 'BAD_LOCK', message: `Unsupported lockKey: ${requestedLockKey}` });
    }
    const lock = activeJobLock(requestedLockKey);
    if (lock) {
      return res.status(409).json({
        ok: false,
        error: 'ACTION_LOCKED',
        message: `${lockLabel} 正被任务 ${lock.jobId} 占用`,
        lock,
      });
    }
    lockKey = requestedLockKey;
  }

  const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs || DEV_JOB_DEFAULT_TIMEOUT_MS), 5_000), DEV_JOB_MAX_TIMEOUT_MS);
  const job = createDevJob(command, cwd, timeoutMs, { ip: req.ip, lockKey, lockLabel });
  return res.status(202).json({ ok: true, job: serializeDevJob(job) });
}

function startActionJob(req: Request, res: Response, id: string, action: OpsAction) {
  const active = Array.from(devJobs.values()).filter(job => job.status === 'running').length;
  if (active >= DEV_JOB_MAX_ACTIVE) {
    return res.status(429).json({ ok: false, error: 'TOO_MANY_ACTIVE_JOBS', message: `Only ${DEV_JOB_MAX_ACTIVE} jobs can run at once` });
  }

  if (action.lockKey) {
    const lock = activeJobLock(action.lockKey);
    if (lock) {
      return res.status(409).json({
        ok: false,
        error: 'ACTION_LOCKED',
        message: `${action.lockLabel || action.lockKey} 正被任务 ${lock.jobId} 占用`,
        lock,
      });
    }
  }

  let command: string;
  try {
    command = scriptCommandForAction(action);
  } catch (error: any) {
    appendActionLog({ action: id, label: action.label, status: 'error', error: String(error?.message || error), ip: req.ip });
    return res.status(500).json({ ok: false, action: id, label: action.label, error: String(error?.message || error) });
  }

  const job = createDevJob(command, SERVER_ROOT, action.timeoutMs, { action: id, label: action.label, ip: req.ip, lockKey: action.lockKey, lockLabel: action.lockLabel });
  return res.status(202).json({ ok: true, action: id, label: action.label, job: serializeDevJob(job) });
}

function cancelDevJobProcess(job: DevJob, reason = 'cancelled') {
  if (job.status !== 'running') return false;
  job.status = 'cancelled';
  job.updatedAt = new Date().toISOString();
  appendDevJobOutput(job, `\n[ops] ${reason}; terminating process group\n`);
  if (job.pid) {
    try {
      process.kill(-job.pid, 'SIGTERM');
      setTimeout(() => {
        if (job.status === 'cancelled' && !job.finishedAt && job.pid) {
          try { process.kill(-job.pid, 'SIGKILL'); } catch {}
        }
      }, 3000).unref();
    } catch {
      try { job.child?.kill('SIGTERM'); } catch {}
    }
  } else {
    try { job.child?.kill('SIGTERM'); } catch {}
  }
  return true;
}

function cancelDevJob(req: Request, res: Response) {
  const job = devJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND' });
  const changed = cancelDevJobProcess(job);
  appendActionLog({ action: 'devJobCancel', status: changed ? 'ok' : 'noop', id: job.id, ip: req.ip });
  return res.json({ ok: true, job: serializeDevJob(job) });
}

async function fetchHealth(url: string) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      body: body.slice(0, 500),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      body: String(error?.message || error),
    };
  }
}

async function fetchJsonHealth(url: string, headers: Record<string, string> = {}) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok && data?.ok !== false,
      status: res.status,
      ms: Date.now() - started,
      data,
      body: JSON.stringify(data).slice(0, 700),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      data: null,
      body: String(error?.message || error),
    };
  }
}

async function shellText(command: string, args: string[] = [], timeout = 5000) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 512 * 1024,
    });
    return { ok: true, text: (stdout || stderr).trim() };
  } catch (error: any) {
    return { ok: false, text: String(error?.stdout || error?.stderr || error?.message || error).trim() };
  }
}

function countCloudflareOriginErrors(logFile = '/tmp/cloudflared-bambook.log', origin = '127.0.0.1:8091') {
  if (!fs.existsSync(logFile)) return { count: 0, latest: '', origin };
  const lines = readTail(logFile, 400).split('\n').filter(Boolean);
  const matches = lines.filter(line => line.includes('ERR') && line.includes(origin));
  return {
    count: matches.length,
    latest: matches.at(-1) || '',
    origin,
  };
}

async function getStatus() {
  const meloHealthUrl = `${MELO_TTS_URL.replace(/\/$/, '')}/health`;
  const [mainApi, knowledgeApi, localPublicApi, publicApi, meloTts, aiRuntime, agentStatus, database, cloudflared, launchUser, disk, backups] = await Promise.all([
    fetchHealth(MAIN_API_URL),
    fetchHealth(KNOWLEDGE_API_URL),
    fetchHealth(LOCAL_PUBLIC_API_URL),
    fetchHealth(PUBLIC_API_URL),
    fetchHealth(meloHealthUrl),
    fetchJsonHealth(AI_RUNTIME_METRICS_URL, MAIN_API_KEY ? { 'X-Bambook-API-Key': MAIN_API_KEY } : {}),
    fetchJsonHealth(AGENT_STATUS_URL, MAIN_API_KEY ? { 'X-Bambook-API-Key': MAIN_API_KEY } : {}),
    checkDatabaseHealth(),
    shellText('/usr/bin/pgrep', ['-lf', 'cloudflared']),
    shellText('/bin/launchctl', ['list']),
    shellText('/bin/df', ['-h', '/']),
    shellText('/bin/bash', ['-lc', 'ls -lt "${BAMBOOK_BACKUP_DIR:-/Users/Shared/BambookBackups}" 2>/dev/null | head -6']),
  ]);

  // 进程参数脱敏：cloudflared 的 --token 是隧道凭据（拿到即等于控制整条隧道），
  // 而 `pgrep -lf` 会把完整命令行带出来——此前直接进 /api/status 响应，
  // 导致凭据出现在面板页面、浏览器缓存与任何被转发的日志里。一律脱敏后再出网。
  const cloudflaredText = redactSecrets(cloudflared.text || '');
  const cloudflaredLines = cloudflaredText ? cloudflaredText.split('\n').filter(Boolean) : [];
  const cloudflareStatus: ServiceStatus =
    !cloudflared.ok || cloudflaredLines.length === 0
      ? 'error'
      : cloudflaredLines.length === 1 && cloudflaredText.includes('--protocol http2')
        ? 'ok'
        : 'warn';
  const cloudflareDetail = cloudflareStatus === 'warn'
    ? `Tunnel 可运行但状态需关注：${cloudflaredLines.length} 个 cloudflared 进程`
    : cloudflaredText;
  const cloudflareOriginErrors = countCloudflareOriginErrors();
  const originStatus: ServiceStatus = !localPublicApi.ok
    ? 'error'
    : cloudflareOriginErrors.count > 0
      ? 'warn'
      : 'ok';
  const originDetail = [
    `local ${LOCAL_PUBLIC_API_URL} => ${localPublicApi.status} in ${localPublicApi.ms}ms`,
    cloudflareOriginErrors.count
      ? `最近 cloudflared 日志中有 ${cloudflareOriginErrors.count} 条 8091 origin 错误；最新：${cloudflareOriginErrors.latest}`
      : '最近 cloudflared 日志未发现 8091 origin 错误',
  ].join('\n');

  const services = [
    service('公网 API', publicApi.ok, publicApi.body, publicApi.ms),
    serviceWithStatus('Cloudflare Origin 8091', originStatus, originDetail, localPublicApi.ms),
    service('主数据 API', mainApi.ok, mainApi.body, mainApi.ms),
    service('知识库 API', knowledgeApi.ok, knowledgeApi.body, knowledgeApi.ms),
    service('Melo TTS', meloTts.ok, meloTts.body, meloTts.ms),
    service('AI Runtime', aiRuntime.ok, aiRuntime.body, aiRuntime.ms),
    service('Agent OS', agentStatus.ok, agentStatus.body, agentStatus.ms),
    service('PostgreSQL', database.ok, database.body, database.ms),
    serviceWithStatus('Cloudflare Tunnel', cloudflareStatus, cloudflareDetail, null),
    service('LaunchAgent: cloudflare', launchUser.text.includes(CLOUDFLARE_LABEL), CLOUDFLARE_LABEL, null),
    service('Cloudflare Watchdog', launchUser.text.includes(CLOUDFLARE_WATCHDOG_LABEL), CLOUDFLARE_WATCHDOG_LABEL, null),
    service('LaunchAgent: main api', launchUser.text.includes('com.bambook.main-data-api'), 'com.bambook.main-data-api', null),
    service('LaunchAgent: melo tts', launchUser.text.includes(MELO_TTS_LABEL), MELO_TTS_LABEL, null),
  ];
  const errorCount = services.filter(s => s.status === 'error').length;
  const warnCount = services.filter(s => s.status === 'warn').length;

  return {
    ok: errorCount === 0,
    status: errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'ok',
    errorCount,
    warnCount,
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    uptimeSeconds: Math.round(os.uptime()),
    loadavg: os.loadavg(),
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
    },
    services,
    cloudflared: {
      ok: cloudflareStatus !== 'error',
      status: cloudflareStatus,
      lines: cloudflaredLines,
      origin: {
        ok: localPublicApi.ok,
        url: LOCAL_PUBLIC_API_URL,
        status: localPublicApi.status,
        ms: localPublicApi.ms,
        recentErrors: cloudflareOriginErrors,
      },
    },
    launchd: {
      userHasCloudflare: launchUser.text.includes(CLOUDFLARE_LABEL),
      userHasCloudflareWatchdog: launchUser.text.includes(CLOUDFLARE_WATCHDOG_LABEL),
      userHasMainApi: launchUser.text.includes('com.bambook.main-data-api'),
      userHasMeloTts: launchUser.text.includes(MELO_TTS_LABEL),
    },
    disk: disk.text,
    backups: backups.text,
    aiRuntime: aiRuntime.data?.metrics || null,
    agentOs: agentStatus.data?.agent || null,
  };
}

async function checkDatabaseHealth() {
  const started = Date.now();
  if (!dbPool) return { ok: false, ms: 0, body: 'DATABASE_URL is not configured' };
  try {
    await dbPool.query('SELECT 1');
    return { ok: true, ms: Date.now() - started, body: 'database connection ok' };
  } catch (error: any) {
    return { ok: false, ms: Date.now() - started, body: String(error?.message || error) };
  }
}

function service(name: string, ok: boolean, detail: string, ms: number | null) {
  return serviceWithStatus(name, ok ? 'ok' : 'error', detail, ms);
}

function serviceWithStatus(name: string, status: ServiceStatus, detail: string, ms: number | null) {
  return {
    name,
    status,
    detail,
    ms,
  };
}

function readTail(file: string, lines = 120) {
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8');
  return content.split('\n').slice(-lines).join('\n');
}

const OPS_LOG_FILES: Record<string, string> = {
  ops: ACTION_LOG,
  cloudflare: '/tmp/cloudflared-bambook.log',
  main: '/tmp/bambook-main-data-api.log',
  health: '/tmp/bambook-cloudflare-health.log',
  melo: '/tmp/bambook-melo-setup.log',
  meloService: '/tmp/bambook-melo-tts-service.log',
  meloServiceError: '/tmp/bambook-melo-tts-service.err.log',
};

function filterLogLines(log: string, query: string, stderrOnly: boolean) {
  const q = query.trim().toLowerCase();
  return log.split('\n').filter(line => {
    if (stderrOnly && !/(stderr|error|fail|exception|traceback|warn)/i.test(line)) return false;
    if (q && !line.toLowerCase().includes(q)) return false;
    return true;
  }).join('\n');
}

function readOpsLog(req: Request, res: Response) {
  const name = String(req.query.name || 'ops');
  const file = OPS_LOG_FILES[name] || ACTION_LOG;
  const lines = Math.min(Math.max(Number(req.query.lines || 160), 1), 10_000);
  const download = String(req.query.download || '') === '1';
  const stderrOnly = String(req.query.stderrOnly || '') === '1';
  const query = String(req.query.q || '');
  const raw = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : '';
  const selected = download ? raw : raw.split('\n').slice(-lines).join('\n');
  const filtered = maskSensitiveOutput(filterLogLines(selected, query, stderrOnly));
  if (download) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bambook-${name}.log"`);
    return res.send(filtered);
  }
  return res.json({ ok: true, name, lines, q: query, stderrOnly, log: filtered });
}

async function countWhere(table: string, where = '"deletedAt" IS NULL') {
  if (!dbPool) return 0;
  try {
    const result = await dbPool.query(`SELECT COUNT(*)::int AS count FROM "${table}" WHERE ${where}`);
    return Number(result.rows[0]?.count || 0);
  } catch (error: any) {
    if (error?.code === '42P01') return 0;
    throw error;
  }
}

async function groupCounts(table: string, column: string, where = '"deletedAt" IS NULL', limit = 8) {
  if (!dbPool) return [];
  try {
    const result = await dbPool.query(
      `SELECT COALESCE("${column}"::text, '未填写') AS label, COUNT(*)::int AS count
       FROM "${table}"
       WHERE ${where}
       GROUP BY 1
       ORDER BY count DESC, label ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') return [];
    throw error;
  }
}

async function sumWhere(table: string, column: string, where = '"deletedAt" IS NULL') {
  if (!dbPool) return 0;
  try {
    const result = await dbPool.query(`SELECT COALESCE(SUM("${column}"), 0)::bigint AS total FROM "${table}" WHERE ${where}`);
    return Number(result.rows[0]?.total || 0);
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') return 0;
    throw error;
  }
}

async function getDataMap() {
  if (!dbPool) {
    return { ok: false, generatedAt: new Date().toISOString(), error: 'DATABASE_URL is not configured', categories: [] };
  }

  const [
    orders,
    orderLines,
    orderArchived,
    ordersByStatus,
    ordersBySource,
    products,
    productProfiles,
    productImages,
    productImageSize,
    productsByStatus,
    productsByMain,
    relations,
    orgRelations,
    contactRelations,
    relationsByCategory,
    memories,
    knowledgeItems,
    insights,
    sopTemplates,
    classifications,
    customerCodes,
    priceRows,
    certRows,
  ] = await Promise.all([
    countWhere('Order'),
    countWhere('OrderLine', '1=1'),
    countWhere('Order', '"deletedAt" IS NOT NULL'),
    groupCounts('Order', 'status'),
    groupCounts('Order', 'source'),
    countWhere('ProductAsset'),
    countWhere('FabricProfile'),
    countWhere('ProductImage'),
    sumWhere('ProductImage', 'fileSize'),
    groupCounts('ProductAsset', 'status'),
    groupCounts('ProductAsset', 'mainCategory'),
    countWhere('Relation'),
    countWhere('Relation', '"deletedAt" IS NULL AND "isOrganization" = true'),
    countWhere('Relation', '"deletedAt" IS NULL AND "isOrganization" = false'),
    groupCounts('Relation', 'category'),
    countWhere('ProjectMemory'),
    countWhere('KnowledgeItem'),
    countWhere('Insight'),
    countWhere('SopTemplate', '"deletedAt" IS NULL AND status = \'active\''),
    countWhere('ProductClassification'),
    countWhere('FabricCustomerCode'),
    countWhere('FabricPriceHistory'),
    countWhere('FabricCertification'),
  ]);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    categories: [
      {
        id: 'orders',
        title: '订单中枢',
        subtitle: 'PO、订单行、履约状态',
        count: orders,
        meta: `${orderLines} 行明细 · ${orderArchived} 归档`,
        accent: 'blue',
        items: [
          { label: '活跃订单', value: orders },
          { label: '订单明细', value: orderLines },
          { label: '归档订单', value: orderArchived },
        ],
        distribution: ordersByStatus,
        secondary: ordersBySource,
      },
      {
        id: 'products',
        title: '面料 / 产品档案',
        subtitle: '产品资产、面料规格、图片资料',
        count: products,
        meta: `${productProfiles} 份规格 · ${productImages} 张图片 · ${formatBytes(productImageSize)}`,
        accent: 'cyan',
        items: [
          { label: '产品资产', value: products },
          { label: '面料规格', value: productProfiles },
          { label: '图片资料', value: productImages },
          { label: '客户编码', value: customerCodes },
        ],
        distribution: productsByStatus,
        secondary: productsByMain,
      },
      {
        id: 'relations',
        title: '客户 / 供应商 / 联系人',
        subtitle: '组织档案、联系人、角色关系',
        count: relations,
        meta: `${orgRelations} 组织 · ${contactRelations} 联系人`,
        accent: 'purple',
        items: [
          { label: '关系档案', value: relations },
          { label: '组织', value: orgRelations },
          { label: '联系人', value: contactRelations },
        ],
        distribution: relationsByCategory,
        secondary: [],
      },
      {
        id: 'knowledge',
        title: '知识 / 记忆 / 洞察',
        subtitle: '项目记忆、知识条目、业务洞察',
        count: memories + knowledgeItems + insights,
        meta: `${memories} 记忆 · ${knowledgeItems} 知识 · ${insights} 洞察`,
        accent: 'green',
        items: [
          { label: '项目记忆', value: memories },
          { label: '知识条目', value: knowledgeItems },
          { label: '洞察', value: insights },
          { label: 'SOP 模板', value: sopTemplates },
        ],
        distribution: [],
        secondary: [],
      },
      {
        id: 'fabricMeta',
        title: '面料业务元数据',
        subtitle: '分类、价格、认证与成分支撑',
        count: classifications + priceRows + certRows,
        meta: `${classifications} 分类 · ${priceRows} 价格 · ${certRows} 认证`,
        accent: 'orange',
        items: [
          { label: '分类标签', value: classifications },
          { label: '价格历史', value: priceRows },
          { label: '认证记录', value: certRows },
        ],
        distribution: [],
        secondary: [],
      },
    ],
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

app.get('/api/status', auth, async (_req, res) => {
  try {
    res.json({ ok: true, status: await getStatus(), actions: publicActions() });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/datamap', auth, async (_req, res) => {
  try {
    res.json(await getDataMap());
  } catch (error: any) {
    res.status(500).json({ ok: false, error: String(error?.message || error), generatedAt: new Date().toISOString(), categories: [] });
  }
});

app.get('/api/logs', auth, readOpsLog);

app.post('/api/admin/seed-rbac', auth, async (req, res) => {
  if (req.body?.confirm !== 'SEED_RBAC') {
    return res.status(400).json({ ok: false, error: 'BAD_CONFIRM', message: 'confirm must be SEED_RBAC' });
  }
  appendActionLog({ action: 'seedRbac', label: '初始化 RBAC 权限数据', status: 'started', ip: req.ip });
  try {
    const result = await seedRbacDirect();
    appendActionLog({ action: 'seedRbac', status: 'ok', result });
    const label = process.env.BAMBOOK_OPS_MAIN_API_LABEL || 'com.bambook.main-data-api';
    spawn('/bin/bash', ['-lc', `sleep 1; launchctl kickstart -k "gui/$(id -u)/${label}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return res.json({ ok: true, message: 'RBAC seed complete. Main API restart scheduled.', result });
  } catch (error: any) {
    appendActionLog({ action: 'seedRbac', status: 'error', error: String(error?.message || error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/admin/token', auth, changeOpsToken);
app.post('/api/admin/model-key', auth, updateModelKey);
app.post('/api/admin/require-auth', auth, setMainApiRequireAuth);
app.post('/api/admin/email-key', auth, updateEmailKey);
app.post('/api/admin/deploy-package', auth, express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: DEPLOY_PACKAGE_LIMIT }), deployUploadedPackage);
app.post('/api/admin/deploy-webapp', auth, express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: DEPLOY_PACKAGE_LIMIT }), deployUploadedWebapp);

// ── webapp 文件清单（增量部署 diff 基线）────────────────────────────────────
// 客户端构建后拉取远端清单，跳过「同名且同 size」的未变文件（assets/ 全部为
// contenthash 命名——同名即同内容，size 双保险），只上传变化文件。
// 服务器端 deploy-webapp 的沿用机制（assets 文件级 + data/glyphs/geo/fonts
// 目录级 + 根级大文件）自动从上一版本补齐被省略的文件，无需额外改动。
app.get('/api/admin/webapp-manifest', auth, async (req: Request, res: Response) => {
  const rawTarget = String(req.query.target || 'webapp');
  const target = rawTarget === 'webapp-root' ? 'webapp-root' : 'webapp';
  const webappDir = path.join(SERVER_ROOT, target);
  try {
    if (!fs.existsSync(webappDir)) {
      return res.json({ ok: true, target, files: {} });
    }
    const files: Record<string, number> = {};
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          try { files[rel] = fs.statSync(path.join(dir, entry.name)).size; } catch { /* skip */ }
        }
      }
    };
    walk(webappDir, '');
    res.json({ ok: true, target, files });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// ── 分块上传 webapp（隧道 body 转发受限时的回退方案）──────────────────────────
// Cloudflare Tunnel 对 POST body 大小有限制（~500KB），完整 webapp 包（5MB+）
// 无法一次性通过。分块上传端点允许客户端将包拆分为多个 < 400KB 的块，
// 逐块上传后在服务端重组，再走标准 deployUploadedWebapp 流程。
interface ChunkedUpload {
  chunks: (Buffer | null)[];
  totalChunks: number;
  receivedChunks: number;
  createdAt: number;
  /** 最后一次收到块的时刻——GC 按此滑动过期（上传总时长可超 TTL，只要不空闲超时即保留） */
  lastActivityAt: number;
  /** 部署目标（webapp | webapp-root），首块记录、finalize 时透传 */
  target?: string;
}
const webappChunkedUploads = new Map<string, ChunkedUpload>();
// 每 5 分钟清理「空闲」超过 10 分钟的上传（滑动过期：按 lastActivityAt 起算，
// 而非 createdAt——慢隧道下大包分块上传总时长可达 15 分钟+，固定 TTL 会在
// 中途清掉整条记录导致 finalize INCOMPLETE_UPLOAD）
setInterval(() => {
  const now = Date.now();
  for (const [id, upload] of webappChunkedUploads) {
    if (now - upload.lastActivityAt > 10 * 60 * 1000) {
      webappChunkedUploads.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

app.post('/api/admin/deploy-webapp-chunk', auth, express.raw({ type: ['application/octet-stream'], limit: '500kb' }), (req, res) => {
  const uploadId = req.headers['x-upload-id'] as string;
  const chunkIndex = parseInt(req.headers['x-chunk-index'] as string, 10);
  const totalChunks = parseInt(req.headers['x-total-chunks'] as string, 10);

  if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    return res.status(400).json({ ok: false, error: 'INVALID_HEADERS', message: 'Requires X-Upload-Id, X-Chunk-Index (0-based), X-Total-Chunks headers' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'EMPTY_CHUNK' });
  }

  if (!webappChunkedUploads.has(uploadId)) {
    webappChunkedUploads.set(uploadId, {
      chunks: new Array(totalChunks).fill(null),
      totalChunks,
      receivedChunks: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      target: String(req.headers['x-deploy-target'] || 'webapp'),
    });
  }

  const upload = webappChunkedUploads.get(uploadId)!;
  if (upload.totalChunks !== totalChunks) {
    return res.status(400).json({ ok: false, error: 'TOTAL_MISMATCH' });
  }
  if (upload.chunks[chunkIndex] === null) {
    upload.chunks[chunkIndex] = req.body;
    upload.receivedChunks++;
  }
  // 滑动过期：任何块到达（含重复块）都刷新活跃时刻，防止慢上传中途被 GC
  upload.lastActivityAt = Date.now();

  return res.json({ ok: true, uploadId, chunkIndex, receivedChunks: upload.receivedChunks, totalChunks: upload.totalChunks });
});

app.post('/api/admin/deploy-webapp-finalize', auth, express.json(), async (req, res) => {
  const { uploadId } = req.body as { uploadId?: string };
  if (!uploadId) {
    return res.status(400).json({ ok: false, error: 'MISSING_UPLOAD_ID' });
  }

  const upload = webappChunkedUploads.get(uploadId);
  if (!upload) {
    return res.status(404).json({ ok: false, error: 'UPLOAD_NOT_FOUND' });
  }
  if (upload.receivedChunks !== upload.totalChunks) {
    return res.status(400).json({ ok: false, error: 'INCOMPLETE_UPLOAD', receivedChunks: upload.receivedChunks, totalChunks: upload.totalChunks });
  }

  // 重组完整归档
  const fullArchive = Buffer.concat(upload.chunks as Buffer[]);
  webappChunkedUploads.delete(uploadId);

  appendActionLog({ action: 'deployUploadedWebapp', label: '分块上传网页端打包并部署', status: 'reassembled', bytes: fullArchive.length, chunks: upload.totalChunks });

  // 构造模拟的 Express Request 复用 deployUploadedWebapp（透传部署目标 target）
  const mockReq = { body: fullArchive, headers: { 'x-deploy-target': upload.target || 'webapp' } } as any;
  return deployUploadedWebapp(mockReq, res);
});

app.get('/api/dev/jobs', auth, listDevJobs);
app.post('/api/dev/jobs', auth, startDevJob);
app.get('/api/dev/jobs/:id', auth, getDevJob);
app.post('/api/dev/jobs/:id/cancel', auth, cancelDevJob);
app.get('/api/dev/files', auth, readDevFile);
app.post('/api/dev/files/diff', auth, diffDevFile);
app.post('/api/dev/files/write', auth, writeDevFile);
app.get('/api/dev/files/backups', auth, listDevFileBackups);
app.post('/api/dev/files/rollback', auth, rollbackDevFile);
app.post('/api/dev/files/upload', auth, express.raw({ type: ['application/octet-stream', 'application/zip', 'application/gzip', 'audio/wav', 'audio/mpeg'], limit: DEV_UPLOAD_MAX_BYTES }), uploadDevFile);

app.post('/api/actions/:id', auth, async (req, res) => {
  const id = req.params.id;
  const action = ACTIONS[id];
  if (!action) return res.status(404).json({ ok: false, error: 'UNKNOWN_ACTION' });
  if (action.confirm && req.body?.confirm !== action.confirm) {
    return res.status(400).json({ ok: false, error: 'BAD_CONFIRM', message: `confirm must be ${action.confirm}` });
  }

  return startActionJob(req, res, id, action);
});

function publicActions() {
  return Object.entries(ACTIONS).map(([id, a]) => ({
    id,
    label: a.label,
    confirm: a.confirm || null,
    group: a.group,
    description: a.description,
    lockKey: a.lockKey || null,
    lockLabel: a.lockLabel || null,
    lockedBy: a.lockKey ? activeJobLock(a.lockKey) : null,
  }));
}

app.use('/ops', express.static(path.join(PANEL_ROOT, 'public')));
app.get('/ops/*', (_req, res) => res.sendFile(path.join(PANEL_ROOT, 'public', 'index.html')));
app.get('/', (_req, res) => res.redirect('/ops'));

app.listen(PORT, () => {
  console.log(`[bambook-ops-panel] listening on ${PORT}`);
});
