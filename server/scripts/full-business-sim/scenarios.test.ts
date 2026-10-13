import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios, SCENARIO_BUSINESS_TIME } from './scenarios';
const master = planScenarioMasterData({ namespace: 'business-script', nowMs: Date.parse(SCENARIO_BUSINESS_TIME) });
describe('whole business simulation script invariants', () => {
  it('limits supplier-paid commission to confirmed fabric business and gives garment an independent AP approval case', () => {
    const plan = buildBusinessScenarios(master);
    expect(plan.orders.filter(row => row.stopAfter === 'commission_pending').map(row => row.family)).toEqual(['fabric']);
    expect(plan.orders.filter(row => row.stopAfter === 'supplier_payment_pending').map(row => row.family)).toEqual(['garment']);
  });
  it('carries the payment instrument as an explicit business field without inferring it from prose', () => {
    const plan = buildBusinessScenarios(master);
    expect(plan.orders.filter(row => row.paymentInstrument === 'L/C')).toHaveLength(2);
    for (const row of plan.orders) expect(row.paymentInstrument).toBe(row.stopAfter === 'document_return' ? 'L/C' : 'T/T');
  });
  it('exceeds the per-family minimums and spreads cases across distinct business stops', () => {
    const plan = buildBusinessScenarios(master);
    for (const family of ['fabric', 'garment']) {
      const orders = plan.orders.filter(row => row.family === family), dev = plan.developments.filter(row => row.family === family);
      expect(orders.length).toBeGreaterThanOrEqual(15); expect(dev.length).toBeGreaterThanOrEqual(10);
      expect(new Set(orders.map(row => row.stopAfter)).size).toBe(orders.length);
      expect(new Set(dev.map(row => row.stopAfter)).size).toBe(dev.length);
    }
  });
  it('only selects customer/factory pairs visible to the actual business group', () => {
    const plan = buildBusinessScenarios(master);
    for (const row of [...plan.orders, ...plan.developments]) {
      const team = master.businessTeams.find(team => team.key === row.teamKey)!;
      expect(team.memberIds).toContain(master.cast[row.owner].id);
      if (row.customerId) expect(team.customerIds).toContain(row.customerId);
      for (const supplierId of 'supplierIds' in row ? row.supplierIds : [row.supplierId]) expect(team.supplierIds).toContain(supplierId);
    }
  });
  it('assigns every order to the customer actual follow-up owner, rather than another member of the group', () => {
    for (const row of buildBusinessScenarios(master).orders) {
      const customer = master.catalog.customers.find(customer => customer.id === row.customerId)!;
      expect(master.cast[row.owner].id).toBe(customer.ownerId);
    }
  });
  it('follows an explicitly changed customer owner within the actual group', () => {
    const team = master.businessTeams[0], customerId = team.customerIds[0];
    const reassigned = { ...master, catalog: { ...master.catalog, customers: master.catalog.customers.map(customer =>
      customer.id === customerId ? { ...customer, ownerId: team.salespersonId } : customer) } };
    const rows = buildBusinessScenarios(reassigned).orders.filter(row => row.customerId === customerId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(master.cast[row.owner].id).toBe(team.salespersonId);
  });
  it('refuses a customer follow-up owner outside the selected business group', () => {
    const customerId = master.businessTeams[0].customerIds[0];
    const outsideOwner = { ...master, catalog: { ...master.catalog, customers: master.catalog.customers.map(customer =>
      customer.id === customerId ? { ...customer, ownerId: master.cast.owner.id } : customer) } };
    expect(() => buildBusinessScenarios(outsideOwner)).toThrow('Scenario customer actual follow-up owner is outside its business group.');
  });
  it('keeps the historical catalog reference honest and consistent with the intended counterparty pair', () => {
    for (const row of buildBusinessScenarios(master).orders) {
      const asset = [...master.catalog.fabricAssets, ...master.catalog.garmentAssets].find(asset => asset.id === row.catalogAssetId)!;
      expect(asset.customerRelationId).toBe(row.customerId); expect(asset.factoryRelationId).toBe(row.supplierId);
      expect(asset.source).toBe('other'); expect(asset.sourceDetail).toContain('未声明');
    }
  });
  it('plans a compatible same-customer pair for each family without claiming that it shipped', () => {
    const rows = buildBusinessScenarios(master).orders.filter(row => row.shipmentGroupKey);
    expect(rows).toHaveLength(4);
    for (const family of ['fabric', 'garment']) {
      const pair = rows.filter(row => row.family === family);
      expect(new Set(pair.map(row => row.customerId)).size).toBe(1);
      expect(new Set(pair.map(row => row.teamKey)).size).toBe(1);
      expect(new Set(pair.map(row => row.owner)).size).toBe(1);
      expect(new Set(pair.map(row => row.shipmentGroupKey)).size).toBe(1);
    }
  });
});
