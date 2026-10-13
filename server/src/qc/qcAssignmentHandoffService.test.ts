import { describe, expect, it } from 'vitest';
import { normalizeQcHandoffInput } from './qcAssignmentHandoffService';
const input = () => ({ requestKey: 'claim-1', expectedQcUserId: null, expectedUpdatedAt: '100', expectedScopeFingerprint: 'a'.repeat(64), reason: '工厂现场检验由我实际处理' });
describe('QC claim and handoff command boundaries', () => {
  it('claim identity comes from the actual account, ignoring a supplied recipient', () => {
    expect(normalizeQcHandoffInput({ ...input(), toQcUserId: 'forged-inspector' }, 'claim', 'actual-qc')).toMatchObject({ toQcUserId: 'actual-qc', expectedQcUserId: null });
  });
  it('does not turn already assigned work into a claim or transfer to the same inspector', () => {
    expect(() => normalizeQcHandoffInput({ ...input(), expectedQcUserId: 'other-qc' }, 'claim', 'actual-qc')).toThrow('正式转交');
    expect(() => normalizeQcHandoffInput({ ...input(), expectedQcUserId: 'actual-qc', toQcUserId: 'actual-qc' }, 'transfer', 'actual-qc')).toThrow('实际接手');
  });
  it('requires a reason and exact optimistic state instead of accepting an identity-only update', () => {
    expect(() => normalizeQcHandoffInput({ ...input(), reason: ' ' }, 'claim', 'qc')).toThrow();
    expect(() => normalizeQcHandoffInput({ ...input(), expectedUpdatedAt: '' }, 'claim', 'qc')).toThrow();
    expect(() => normalizeQcHandoffInput({ ...input(), expectedScopeFingerprint: '' }, 'claim', 'qc')).toThrow();
  });
});
