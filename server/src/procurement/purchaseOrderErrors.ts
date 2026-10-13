import { httpStatusOfCode } from '../shared/errorCodes';

/** Only native, finite purchase-order validation failures cross the public
 * boundary. SQL errors and caller-supplied status/code objects do not. */
export class PurchaseOrderDomainError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(message: string, readonly code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' = 'VALIDATION_FAILED') {
    super(message);
    this.status = httpStatusOfCode(code);
    this.statusCode = this.status;
  }
}
