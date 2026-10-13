import { describe, expect, it } from 'vitest';
import {
  groupToolsByDomain,
  normalizeAgentManifestResponse,
  type AgentToolManifestEntry,
} from './agentManifest';

const baseTool = (overrides: Partial<AgentToolManifestEntry>): AgentToolManifestEntry => ({
  id: 'tool',
  name: 'Tool',
  domain: 'orders',
  risk: 'low',
  description: 'd',
  safety: { approval: 'never', sideEffects: false },
  ...overrides,
});

describe('groupToolsByDomain', () => {
  it('orders by predefined domain order, unknown domains alphabetically last', () => {
    const tools: AgentToolManifestEntry[] = [
      baseTool({ id: 'a', domain: 'knowledge' }),
      baseTool({ id: 'b', domain: 'zeta' }),
      baseTool({ id: 'c', domain: 'orders' }),
      baseTool({ id: 'd', domain: 'apex' }),
    ];
    const grouped = groupToolsByDomain(tools);
    expect(grouped.map(g => g.domain)).toEqual(['orders', 'knowledge', 'apex', 'zeta']);
  });

  it('within a domain, sorts by risk severity then by name', () => {
    const tools: AgentToolManifestEntry[] = [
      baseTool({ id: '1', name: 'BB', risk: 'low' }),
      baseTool({ id: '2', name: 'AA', risk: 'low' }),
      baseTool({ id: '3', name: 'CC', risk: 'high' }),
      baseTool({ id: '4', name: 'DD', risk: 'critical' }),
    ];
    const grouped = groupToolsByDomain(tools);
    expect(grouped[0].tools.map(t => t.id)).toEqual(['4', '3', '2', '1']);
  });
});

describe('normalizeAgentManifestResponse', () => {
  it('returns null when payload missing tools array', () => {
    expect(normalizeAgentManifestResponse({ ok: true })).toBeNull();
    expect(normalizeAgentManifestResponse(null)).toBeNull();
  });

  it('drops malformed tools and falls back safety defaults', () => {
    const catalog = normalizeAgentManifestResponse({
      schemaVersion: '2026-06-runtime-2.0',
      tools: [
        { id: 'good', domain: 'products', risk: 'medium', safety: { approval: 'risk_based', sideEffects: false } },
        { id: 42, domain: 'orders' }, // bad: id not string
        { /* no id */ name: 'x' },
        { id: 'no-safety', domain: 'orders', risk: 'low' },
      ],
      summary: { total: 4, byDomain: { products: 1 }, byRisk: { medium: 1 }, approvalRequired: [] },
    });
    expect(catalog).not.toBeNull();
    expect(catalog!.tools.map(t => t.id).sort()).toEqual(['good', 'no-safety']);
    const noSafety = catalog!.tools.find(t => t.id === 'no-safety')!;
    expect(noSafety.safety.approval).toBe('never');
    expect(noSafety.safety.sideEffects).toBe(false);
    expect(noSafety.name).toBe('no-safety'); // name fallback to id
  });

  it('produces groupedByDomain summary derived from tools', () => {
    const catalog = normalizeAgentManifestResponse({
      schemaVersion: 'v',
      tools: [
        { id: 'a', domain: 'orders', risk: 'low', name: 'A', safety: { approval: 'never', sideEffects: false } },
        { id: 'b', domain: 'products', risk: 'high', name: 'B', safety: { approval: 'risk_based', sideEffects: false } },
      ],
    });
    expect(catalog!.groupedByDomain.map(g => g.domain)).toEqual(['orders', 'products']);
  });
});
