/**
 * 当前开发调试面板唯一可用的数据源。
 * 新业务模拟数据按模块评审后逐步添加，不复用旧开发库中的历史业务数据。
 */
export const DEV_COMPANIES = [
  {
    id: 'dev',
    dbName: 'panda_hub_dev',
    label: '开发新库',
    description: '当前模块改造专用开发环境；业务模拟数据按模块逐步添加。',
    accent: 'var(--mask-blue)',
  },
] as const;

export type CompanyDef = (typeof DEV_COMPANIES)[number];
export const COMPANY_BY_DB = new Map<string, CompanyDef>(DEV_COMPANIES.map(c => [c.dbName, c]));
export const ALLOWED_DBS = new Set<string>(DEV_COMPANIES.map(c => c.dbName));
