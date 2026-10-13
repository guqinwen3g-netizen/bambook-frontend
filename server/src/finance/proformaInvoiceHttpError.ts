import { lookupErrorCode } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';

/** The PI service has a finite rejection contract. An unrecognized producer
 * failure is a server failure and cannot be turned into a caller's 400. */
export function proformaInvoiceHttpError(error: { code?: unknown; message?: unknown } | undefined) {
  const code = error?.code;
  if (typeof code === 'string' && typeof error?.message === 'string') {
    if (code === 'NOT_FOUND' || code === 'QUOTATION_NOT_FOUND') return { status: 404, code, message: error.message };
    if (code === 'QUOTATION_NOT_ACCEPTED' || code === 'NOT_PROFORMA' || code === 'ALREADY_CONVERTED' || code === 'INVALID_STATUS') {
      return { status: 400, code, message: error.message };
    }
    if (code === 'SEQUENCE_FAILED') return { status: 500, code, message: error.message };
    if (code === 'LC_GATE_BLOCKED' || code === 'LC_EXCEPTION_CHECK_FAILED') {
      const registered = lookupErrorCode(code);
      if (registered) return { status: registered.status, code, message: registered.message };
    }
  }
  return safeRouteError(undefined, {
    fallbackCode: 'INTERNAL_ERROR',
    fallbackMessage: '开票结果暂不可确认，请刷新核对原单据记录后重试；持续失败请联系管理员。',
  });
}
