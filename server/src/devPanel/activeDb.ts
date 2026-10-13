import { ALLOWED_DBS } from './companies';

/**
 * 开发态「当前激活库」的内存态指针。
 *
 * 核心动机：避免切库时重启整个服务。后端在 DEV 双库模式下于启动期为两个演示库
 * 各建一个 PrismaClient 连接池，本模块仅保存一个指向「当前应该用哪个」的字符串；
 * 切库 = 翻转这个指针（<1ms），无需重写 .env、无需 process.exit、无需重启。
 *
 * 生产构建（NODE_ENV=production 或未开 BAMBOOK_DEV_PANEL）一律不进入双库模式，
 * 仍由 index.ts 走单例 PrismaClient 老路径。
 */

function dbNameFromUrl(url: string): string {
  const m = url.match(/\/([^/?]+)(?:\?|$)/);
  return m ? m[1] : '(unknown)';
}

/** 把给定连接串的库名段替换为 targetDb（保留 host / 凭据 / query 串）。 */
export function dbUrlFor(targetDb: string, baseUrl: string = process.env.DATABASE_URL || ''): string {
  return baseUrl.replace(/(postgresql:\/\/[^@]*@[^/]+?\/)[^/?]+/, (_m, pre: string) => `${pre}${targetDb}`);
}

let activeDbName = dbNameFromUrl(process.env.DATABASE_URL || '');

export function getActiveDb(): string {
  return activeDbName;
}

export function setActiveDb(dbName: string): boolean {
  if (!ALLOWED_DBS.has(dbName)) return false;
  activeDbName = dbName;
  return true;
}

export function isDualMode(): boolean {
  return process.env.BAMBOOK_DEV_PANEL === '1' && process.env.NODE_ENV !== 'production';
}
