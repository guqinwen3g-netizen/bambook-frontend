#!/usr/bin/env node
/**
 * 产物密钥泄露检查（构建后门禁）
 *
 * ## 为什么需要
 *
 * Vite 会把 `VITE_` 前缀变量内联进客户端产物；而服务端密钥若与这些值相同，
 * 就等于把钥匙塞进任何人都可下载的 JS 里。
 *
 * 关键难点：**服务端无法在运行时自查这件事**。
 * 服务端进程只加载 server/.env.local（里面没有 VITE_ 变量），
 * 而产物是在构建机上、用根 .env.local 的 VITE_ 变量打出来的——
 * 二者不在同一个进程、同一个环境里，运行时交叉比对永远命中不了。
 * （2026-09-15 实测：进程内自检零命中，而泄露 key 依然能读出 208KB 订单。）
 *
 * 因此唯一可靠的拦截点在**构建之后**：拿服务端真实密钥去扫产物。
 *
 * ## 用法
 *   node scripts/check-bundle-secret-leak.mjs          # 扫 dist/ 与 out/
 *   node scripts/check-bundle-secret-leak.mjs --quiet   # 只输出结论
 * 退出码：0 = 干净；1 = 发现泄露（应当阻断发布）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 默认扫描目录：网页版产物 + Electron 渲染产物 */
export const DEFAULT_BUNDLE_DIRS = ['dist', 'out'];

/** 需要确认「绝不出现在产物里」的服务端密钥键名 */
export const SERVER_SECRET_KEYS = [
  'BAMBOOK_SDK_KEY',
  'BAMBOOK_API_KEY',
  'BAMBOOK_AGENT_API_KEY_MAP',
  'JWT_SECRET',
];

/** 需要确认「绝不出现在产物里」的客户端变量（它们本就该是公开值，出现即说明被误用） */
export const CLIENT_EXPOSED_KEYS = ['VITE_BAMBOOK_API_KEY'];

/** 极简 .env 解析：KEY=value，去引号，忽略注释与空行 */
export function parseEnvFile(filePath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

const redact = (v) => (v && v.length > 8 ? `${v.slice(0, 4)}…（长度 ${v.length}）` : '****');

/**
 * 收集待检查的密钥值：服务端 env 文件优先，环境变量兜底。
 *
 * @param {Object} [options]
 * @param {string} [options.root]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {SecretEntry[]}
 */
export function collectSecrets({ root = ROOT, env = process.env } = {}) {
  const files = [
    { file: path.join(root, 'server', '.env.local'), label: 'server/.env.local' },
    { file: path.join(root, '.env.local'), label: '.env.local' },
  ];
  const parsed = files.map(({ file, label }) => ({ values: parseEnvFile(file), label }));

  const secrets = [];
  const push = (key, value, source) => {
    if (!value) return;
    // 过短的值（如占位符 "changeme"）噪声太大，跳过
    if (value.length < 16) return;
    if (secrets.some((s) => s.value === value)) return;
    secrets.push({ key, value, source });
  };

  for (const { values, label } of parsed) {
    for (const key of [...SERVER_SECRET_KEYS, ...CLIENT_EXPOSED_KEYS]) {
      push(key, values[key], label);
    }
  }
  for (const key of [...SERVER_SECRET_KEYS, ...CLIENT_EXPOSED_KEYS]) {
    push(key, env[key], 'process.env');
  }
  return secrets;
}

/** 递归列出目录下的 .js/.mjs/.css/.html 文件 */
function listBundleFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listBundleFiles(full, acc);
    } else if (/\.(js|mjs|cjs|css|html|map)$/i.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * @typedef {{ key: string, value: string, source: string }} SecretEntry
 * @typedef {{ secretKey: string, source: string, file: string, masked: string }} LeakEntry
 */

/**
 * 扫描产物：返回泄露清单 [{ secretKey, source, file, masked }]
 * 不回显完整密钥值，避免日志二次泄露。
 *
 * @param {Object} [options]
 * @param {string} [options.root] 仓库根
 * @param {string[]} [options.dirs] 相对 root 的产物目录
 * @param {SecretEntry[]} [options.secrets] 待校验密钥；缺省时自动收集
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {LeakEntry[]}
 */
export function collectBundleSecretLeaks({
  root = ROOT,
  dirs = DEFAULT_BUNDLE_DIRS,
  secrets,
  env = process.env,
} = {}) {
  const list = secrets || collectSecrets({ root, env });
  if (list.length === 0) return [];

  const leaks = [];
  for (const rel of dirs) {
    const dir = path.resolve(root, rel);
    if (!fs.existsSync(dir)) continue;
    for (const file of listBundleFiles(dir)) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const secret of list) {
        if (content.includes(secret.value)) {
          leaks.push({
            secretKey: secret.key,
            source: secret.source,
            file: path.relative(root, file),
            masked: redact(secret.value),
          });
        }
      }
    }
  }
  return leaks;
}

/** CLI：仅在直接执行本文件时运行 */
const isCli = isCliEntry(import.meta.url);

if (isCli) {
  const quiet = process.argv.includes('--quiet');
  const secrets = collectSecrets();
  const leaks = collectBundleSecretLeaks({ secrets });
  const scanned = [];
  for (const rel of DEFAULT_BUNDLE_DIRS) {
    if (fs.existsSync(path.resolve(ROOT, rel))) scanned.push(`${rel}/ (${listBundleFiles(path.resolve(ROOT, rel)).length} 个文件)`);
  }

  if (!quiet) {
    console.log(`已扫描：${scanned.join('、') || '（无产物目录）'}`);
    console.log(`待校验密钥：${secrets.map((s) => `${s.key}@${s.source}`).join('、') || '（无）'}`);
  }

  if (leaks.length === 0) {
    console.log('✓ 产物中未发现服务端密钥');
    process.exit(0);
  }

  console.error(`✗ 发现 ${leaks.length} 处密钥泄露（阻断发布）：`);
  for (const leak of leaks) {
    console.error(`  · [${leak.secretKey}]（来源 ${leak.source}）出现在 ${leak.file}  → ${leak.masked}`);
  }
  console.error(
    '\n处置：轮换对应密钥，使服务端密钥与任何 VITE_ 变量都不相同；' +
      '并确认前端不再读取 VITE_BAMBOOK_API_KEY。',
  );
  process.exit(1);
}
