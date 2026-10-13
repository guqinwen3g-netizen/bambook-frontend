/**
 * Retired live-database credit-note drill.
 *
 * The previous entry loaded checkout env, mixed direct DB writes with fixed-port
 * HTTP, used existing company accounts, and deleted allocation/audit history.
 * It cannot safely prove a candidate checkout or a single database identity.
 *
 * Its meaningful ledger controls move to the isolated acceptance runner:
 * server/acceptance-tests/creditNoteSettlementRealDb.test.ts.
 * Old source and point-in-time results remain recoverable in Git/evidence.
 * A3/A4 independent refund lifecycle and A5 synchronized revocation remain
 * business acceptance obligations; legacy Invoice Paid compatibility does not
 * establish either obligation. This retirement must never be reported as a pass.
 *
 * Fail BEFORE loading env, constructing Prisma, contacting HTTP or mutating data.
 * There is deliberately no bypass flag for this old production-like execution.
 */
throw new Error('RETIRED_UNSAFE_LIVE_DRILL: use the isolated creditNoteSettlementRealDb acceptance manifest; this entry performs no env/DB/HTTP work');
export {};
