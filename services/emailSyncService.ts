import { apiService } from './apiService';

export interface EmailSyncInput {
  email: string;
  password: string;
  host?: string;
  port?: number;
  box?: string;
  limit?: number;
}

export interface EmailSyncError extends Error {
  code: string;
}

export interface EmailSyncResult {
  synced: number;
  skipped: number;
  errors: number;
  accountMasked: string;
  auditIds: string[];
}

export const emailSyncService = {
  async syncToErp(input: EmailSyncInput, endpoint?: string): Promise<EmailSyncResult> {
    const url = apiService.buildApiUrl('/v1/email/sync', endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        host: input.host,
        port: input.port,
        box: input.box,
        limit: input.limit,
      }),
    });
    let json: any;
    try { json = await res.json(); } catch { throw new Error(`email sync failed: HTTP ${res.status} (non-JSON response)`) as EmailSyncError; }
    if (!res.ok || !json?.ok) {
      const err = new Error(json?.error?.message || json?.message || `email sync failed: HTTP ${res.status}`) as EmailSyncError;
      err.code = json?.error?.code || `HTTP_${res.status}`;
      throw err;
    }
    return {
      synced: json.synced,
      skipped: json.skipped,
      errors: json.errors,
      accountMasked: json.accountMasked,
      auditIds: json.auditIds || [],
    };
  },
};
