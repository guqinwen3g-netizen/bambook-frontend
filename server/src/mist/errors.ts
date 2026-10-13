export class MistApiError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); this.name = 'MistApiError'; }
}
export function fail(code: string, message: string, status = 422): never { throw new MistApiError(code, message, status); }
