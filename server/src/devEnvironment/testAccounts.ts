/** Development environment test-account list and database guard (used by scripts/set-dev-environment-passwords.ts). */
export const DEV_TEST_ACCOUNTS = [
  { email: 'owner@bambook.local', label: '公司管理员（全部权限，配置平台 AI）' },
  { email: 'sales.fabric.manager@bambook.local', label: '面料业务主管（审批人）' },
  { email: 'sales.fabric1.lead@bambook.local', label: '面料一组组长（业务员）' },
  { email: 'sales.fabric1.member@bambook.local', label: '面料一组业务员' },
  { email: 'finance@bambook.local', label: '财务专员' },
  { email: 'qc.fabric@bambook.local', label: '面料 QC' },
  { email: 'logistics@bambook.local', label: '物流与单证专员' },
] as const;

export function assertDevelopmentDatabase(env: NodeJS.ProcessEnv) {
  if (env.BAMBOOK_DEV_ENVIRONMENT !== '1') throw new Error('Refusing: BAMBOOK_DEV_ENVIRONMENT=1 is required.');
  const parsed = new URL(env.DATABASE_URL || '');
  const database = parsed.pathname.replace(/^\//, '');
  if (parsed.hostname !== 'localhost' || database !== 'panda_hub_dev') throw new Error('Refusing: expected localhost/panda_hub_dev.');
}
