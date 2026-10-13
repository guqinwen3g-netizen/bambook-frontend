import { businessError } from '../shared/errorCodes';

/** Explicit domain validation, never inferred from a database error's wording.
 * The HTTP adapter preserves its historical per-operation code for this class.
 * Auth and other domains' typed errors retain their own public code and details. */
export class PricingDomainError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_MULTIPLIER', message: string) {
    const classified = businessError(code, message);
    super(classified.message);
    this.name = 'PricingDomainError';
    this.code = classified.code;
    this.statusCode = classified.statusCode;
  }
}

export const pricingInputError = (message: string) => new PricingDomainError('VALIDATION_FAILED', message);
export const pricingNotFoundError = (message: string) => new PricingDomainError('NOT_FOUND', message);
