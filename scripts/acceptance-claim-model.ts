/**
 * Retired shared-database claim-model drill.
 *
 * Its checkout env / fixed-port HTTP / fixed DRILL actor and broad DRILL cleanup
 * cannot establish candidate identity or run-local ownership. No bypass flag is
 * accepted. This entry fails before loading env, Prisma, HTTP or writing data.
 *
 * Actual approved-fact execution and all four disposition kinds are verified in
 * server/acceptance-tests/claimApprovalFactRealDb.test.ts. That bounded evidence
 * does not replace cancellation, credit-note allocation, or complete UI/UAT.
 * Original source assertions and prior results remain in Git/evidence; retirement
 * is not a passing product result and does not waive the still required cases.
 */
throw new Error('RETIRED_UNSAFE_SHARED_CLAIM_DRILL: use isolated claimApprovalFactRealDb acceptance; cancellation and credit-note allocation still require independent verification');
export {};
