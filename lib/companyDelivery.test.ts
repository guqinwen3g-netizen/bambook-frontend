import { describe, expect, it } from 'vitest';
import { View } from '../types';
import { COMPANY_HOME_VIEW, isDevelopingCompanyView, normalizeCompanyView } from './companyDelivery';
import { isAuthenticatedPublicView, getViewPermission } from './modulePermissions';
import { BAMBOOK_MODULES, getPrimaryNavigationModules } from '../components/moduleRegistry';
import { buildCompanyRecordGroups } from '../components/CommandPalette';

describe('User-approved company V1 delivery entries', () => {
  it.each([undefined, null, '', 'unknown', View.Dashboard, View.UiLab, View.Emails])('migrates retired or invalid saved entry %s to the company personal home', view => {
    expect(normalizeCompanyView(view)).toBe(View.Cockpit);
  });
  it('retains every required business destination and the three explicit placeholders', () => {
    for (const view of Object.values(View).filter(view => view !== View.Dashboard && view !== View.UiLab && view !== View.Emails)) expect(normalizeCompanyView(view)).toBe(view);
    expect(COMPANY_HOME_VIEW).toBe(View.Cockpit);
    expect(BAMBOOK_MODULES).toHaveLength(35);
  });
  it('makes home accessible to every authenticated account without granting the financial cockpit permission', () => {
    expect(isAuthenticatedPublicView(COMPANY_HOME_VIEW)).toBe(true);
    expect(getViewPermission(COMPANY_HOME_VIEW)).toBeUndefined();
    expect(getViewPermission(View.Invoices)).toBe('invoices:read');
  });
  it('keeps current MVP personal overview entries and reports in platform', () => {
    const modules = getPrimaryNavigationModules({ isAdmin: true, canAccessView: () => true });
    expect(modules.some(module => module.view === View.Dashboard)).toBe(false);
    expect(modules.find(module => module.view === COMPANY_HOME_VIEW)?.productLabel).toBe('我的工作');
    expect(modules.filter(module => module.nav.group === 'overview').map(module => module.view)).toEqual([View.Cockpit, View.Calendar]);
    expect(modules.find(module => module.view === View.Reports)?.nav.group).toBe('platform');
  });
  it('marks precisely the two requested development entries, with an actual pure placeholder', () => {
    for (const view of Object.values(View)) expect(isDevelopingCompanyView(view)).toBe(view === View.Assistant || view === View.DataCenter);
    for (const view of [View.Assistant, View.DataCenter]) {
      const module = BAMBOOK_MODULES.find(module => module.view === view)!;
      expect(module.productLabel).toContain('开发中');
      expect(module.entry.current).toBe('components/PlaceholderModule.tsx');
    }
  });
  it('keeps DataCenter knowledge and current MVP mail record search sealed', () => {
    const knowledge = { id: 'old-knowledge', title: 'MATCH record', content: 'MATCH', category: 'Policy' } as any;
    const order = { id: 'original-order', poNumber: 'MATCH PO', customer: 'Customer', product: 'Cloth' } as any;
    const data = { relations: [], orders: [order], products: [], invoices: [], shipments: [], knowledge: [knowledge], emails: [{ id: 'deferred-mail', subject: 'MATCH mail', sender: 'MATCH sender' } as any] };
    const groups = buildCompanyRecordGroups('MATCH', data);
    expect(groups.map(group => group.domain)).toEqual(['订单']);
    expect(groups[0].items[0]).toMatchObject({ id: order.id, order });
    expect(buildCompanyRecordGroups('MATCH', data, () => false)).toEqual([]);
  });
});
