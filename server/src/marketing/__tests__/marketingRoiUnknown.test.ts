import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

// Storage/scope seams only. Real Decimal values and the actual ROI service are
// exercised; this file does not prove DB authorization or marketing conversion.
vi.mock('../../auth/permissionService', () => ({ createPermissionService: () => ({
  getDataScopeResolver: async () => ({ rule: { kind: 'self' }, allowedUserIds: ['roi-unit-actor'] }),
}) }));
vi.mock('../../sequence/sequenceService', () => ({ createSequenceService: () => ({}) }));
vi.mock('../../dictionaries/dataDictionaryService', () => ({ getDataDictionaryService: () => ({}) }));
import { createMarketingService } from '../marketingService';

const lead = (status: string, actualValue: string | null) => ({ status,
  actualValue: actualValue === null ? null : new Prisma.Decimal(actualValue), estimatedValue: null });
const cases = [
  { name: 'Converted null revenue stays unknown with a known cost', leads: [lead('Converted', null)], cost: '100', total: null, roi: null, converted: 1 },
  { name: 'known Converted revenue cannot make a mixed unknown sum certain', leads: [lead('Converted', '150'), lead('Converted', null)], cost: '100', total: null, roi: null, converted: 2 },
  { name: 'explicit Converted zero is real zero revenue and a full cost loss', leads: [lead('Converted', '0')], cost: '100', total: 0, roi: -1, converted: 1 },
  { name: 'empty leads sum to zero rather than unknown revenue', leads: [], cost: '100', total: 0, roi: -1, converted: 0 },
  { name: 'non-Converted nullable and known values do not enter actual revenue', leads: [lead('New', null), lead('Qualified', '999'), lead('Converted', '150')], cost: '100', total: 150, roi: 0.5, converted: 1 },
  { name: 'all known Converted Decimal values retain their sum and ROI formula', leads: [lead('Converted', '100.25'), lead('Converted', '49.75')], cost: '100', total: 150, roi: 0.5, converted: 2 },
  { name: 'explicit zero actual cost keeps ROI unknown with known revenue', leads: [lead('Converted', '150')], cost: '0', total: 150, roi: null, converted: 1 },
  { name: 'nullable actual cost keeps ROI unknown with known revenue', leads: [lead('Converted', '150')], cost: null, total: 150, roi: null, converted: 1 },
];

describe('Marketing ROI nullable Converted revenue contract', () => {
  it.each(cases)('$name', async scenario => {
    const row = { id: 'ROI-UNIT', name: 'Synthetic ROI', ownerId: 'roi-unit-actor', deletedAt: null,
      budget: null, actualCost: scenario.cost === null ? null : new Prisma.Decimal(scenario.cost), leads: scenario.leads };
    const findFirst = vi.fn(async () => row);
    const service = createMarketingService({ marketingCampaign: { findFirst } } as any);
    const result = await service.getCampaignROI({ userId: row.ownerId, roles: [], permissions: ['marketing:read'] }, row.id);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: row.id, deletedAt: null, ownerId: row.ownerId }, include: { leads: { where: { deletedAt: null } } } });
    expect(result.totalLeads).toBe(scenario.leads.length);
    expect(result.convertedCount).toBe(scenario.converted);
    expect(result.conversionRate).toBe(scenario.leads.length ? scenario.converted / scenario.leads.length : 0);
    expect(result.totalActualValue).toBe(scenario.total);
    expect(result.roi).toBe(scenario.roi);
    expect(result.totalEstimatedValue).toBe(0);
  });
});
