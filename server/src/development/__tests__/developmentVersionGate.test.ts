import { describe, expect, it, vi } from 'vitest';
import { assertDevelopmentQualityCompletionAudit, assertDevelopmentVersionQualityPass } from '../developmentVersionGate';

function auditFixture(overrides: any = {}) {
  const review: any = { id: 'review-1', reviewedBy: 'qc-1', result: 'pass', reviewedAt: 20n };
  const rows = [
    { id: 'request-audit', action: 'request_development_sample_qc', targetType: 'DevelopmentSampleQualityReview', targetId: review.id,
      actorId: 'sales-1', detail: { source: 'route:development:sample-qc', after: { status: 'queued' } }, createdAt: new Date(10) },
    { id: 'completion-audit', action: 'complete_development_sample_qc', targetType: 'DevelopmentSampleQualityReview', targetId: review.id,
      actorId: 'qc-1', detail: { source: 'route:qc:development-sample', after: { reportId: review.id, result: 'pass', reviewedAt: '20' } }, createdAt: new Date(20), ...overrides },
  ];
  // Model the storage seam: an unqualified findFirst returns the earlier request,
  // exactly as PostgreSQL may do. No default client or database is used.
  const findFirst = vi.fn(async ({ where }: any) => rows.find(row =>
    (!where.action || row.action === where.action)
    && (!where.actorId || row.actorId === where.actorId)
    && (!where.detail || row.detail.source === where.detail.equals)
    && row.targetType === where.targetType && row.targetId === where.targetId) ?? null);
  return { review, tx: { auditLog: { findFirst } } };
}

describe('accurate development QC report completion evidence', () => {
  it('accepts the completed report even when its request audit is returned first by an unordered lookup', async () => {
    const f = auditFixture();
    await expect(assertDevelopmentQualityCompletionAudit(f.tx, f.review)).resolves.toMatchObject({ id: 'completion-audit' });
  });

  it.each([
    { actorId: 'another-qc' },
    { action: 'start_development_sample_qc' },
    { detail: { source: 'route:development:sample-qc', after: { reportId: 'review-1', result: 'pass', reviewedAt: '20' } } },
    { detail: { source: 'route:qc:development-sample', after: { reportId: 'review-other', result: 'pass', reviewedAt: '20' } } },
    { detail: { source: 'route:qc:development-sample', after: { reportId: 'review-1', result: 'reject', reviewedAt: '20' } } },
  ])('rejects a completion fact that does not belong to this report and reviewer: %j', async overrides => {
    const f = auditFixture(overrides);
    await expect(assertDevelopmentQualityCompletionAudit(f.tx, f.review)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
});

describe('latest formal report gate for the exact development version', () => {
  function fixture(reports: any[]) {
    const completion = auditFixture();
    const tx: any = { ...completion.tx, developmentSampleQualityReview: { findFirst: vi.fn(async ({ where }: any) => reports
      .filter(row => row.developmentCaseId === where.developmentCaseId && row.sampleVersionId === where.sampleVersionId && where.status.in.includes(row.status))
      .sort((a, b) => b.reviewSequence - a.reviewSequence)[0] ?? null) } };
    tx.auditLog.findFirst = vi.fn(async ({ where }: any) => {
      const report = reports.find(row => row.id === where.targetId);
      return report ? { actorId: report.reviewedBy, detail: { source: 'route:qc:development-sample', after: {
        reportId: report.id, result: report.result, opinion: report.opinion, reviewedAt: String(report.reviewedAt), sampleVersionId: report.sampleVersionId, sourceFingerprint: report.sourceFingerprint,
      } } } : null;
    });
    return tx;
  }
  const pass = { id: 'parent-pass', developmentCaseId: 'case-1', sampleVersionId: 'major-a', status: 'reviewed', result: 'pass', reviewSequence: 1, reviewedAt: 20n, reviewedBy: 'qc-1' };

  it('does not borrow a parent pass for a dotted version', async () => {
    await expect(assertDevelopmentVersionQualityPass(fixture([pass]), 'case-1', 'minor-a1')).rejects.toMatchObject({ code: 'QC_PASS_REQUIRED' });
  });

  it('uses the newest completed result, so a later NOK blocks an earlier pass', async () => {
    await expect(assertDevelopmentVersionQualityPass(fixture([pass, { ...pass, id: 'reject-2', result: 'reject', reviewSequence: 2 }]), 'case-1', 'major-a')).rejects.toMatchObject({ code: 'QC_PASS_REQUIRED' });
  });

  it('accepts a later completed pass without requiring customer selection', async () => {
    const reports = [{ ...pass, result: 'reject' }, { ...pass, id: 'pass-2', reviewSequence: 2 }];
    await expect(assertDevelopmentVersionQualityPass(fixture(reports), 'case-1', 'major-a')).resolves.toMatchObject({ id: 'pass-2' });
  });

  it('allows conditional pass with its exact preserved issues, never old adjustment history', async () => {
    const conditional = { ...pass, result: 'conditional_pass', opinion: '袖口线迹需要客户知悉', evidence: [{ id: 'issue-photo' }] };
    await expect(assertDevelopmentVersionQualityPass(fixture([conditional]), 'case-1', 'major-a')).resolves.toMatchObject(conditional);
    for (const result of ['needs_adjustment', 'reject']) {
      await expect(assertDevelopmentVersionQualityPass(fixture([{ ...conditional, result }]), 'case-1', 'major-a')).rejects.toMatchObject({ code: 'QC_PASS_REQUIRED' });
    }
    await expect(assertDevelopmentVersionQualityPass(fixture([{ ...conditional, opinion: ' ' }]), 'case-1', 'major-a')).rejects.toMatchObject({ code: 'QC_PASS_REQUIRED' });
    const tx = fixture([conditional]);
    tx.auditLog.findFirst.mockResolvedValue({ actorId: conditional.reviewedBy, detail: { after: { reportId: conditional.id, result: conditional.result, opinion: '篡改问题', reviewedAt: '20', sampleVersionId: conditional.sampleVersionId } } });
    await expect(assertDevelopmentVersionQualityPass(tx, 'case-1', 'major-a')).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });

  it('keeps historical reports with missing exact version readable but never promotes them to an accurate pass', async () => {
    await expect(assertDevelopmentVersionQualityPass(fixture([{ ...pass, sampleVersionId: null }]), 'case-1', 'major-a')).rejects.toMatchObject({ code: 'QC_PASS_REQUIRED' });
  });
});
