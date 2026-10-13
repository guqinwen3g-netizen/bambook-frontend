/**
 * ERP-P1: 短期 server-side secret context（in-memory）。
 * SMTP 密码不持久化到 ApprovalRequest.payload（避免 admin /approvals 暴露明文）。
 * draft 阶段存 pass 到此 store（credentialRef 索引），payload 只存 credentialRef。
 * commit 阶段用 credentialRef 恢复 pass；取一次后销毁（one-shot）。
 * 进程重启 secret 丢失 → commit MISSING_CREDENTIALS fail closed（重新发起审批）。
 */

const store = new Map<string, { pass: string; expiresAt: number }>();
const TTL_MS = 30 * 60 * 1000; // 30 分钟

export interface EmailSendCredentialBinding {
  actorId: string;
  emailId: string;
  smtpUser: string;
  contentHash: string;
}
const sendStore = new Map<string, { pass: string; expiresAt: number; binding: EmailSendCredentialBinding }>();
/** Send-only credentials bind a trusted account and the exact approved native content. */
export function putEmailSendCredential(pass: string, binding: EmailSendCredentialBinding): string {
  const ref = `esend_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  sendStore.set(ref, { pass, expiresAt: Date.now() + TTL_MS, binding: { ...binding } });
  return ref;
}
export function takeEmailSendCredential(ref: string, binding: EmailSendCredentialBinding): string | null {
  const entry = sendStore.get(ref);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { sendStore.delete(ref); return null; }
  if (entry.binding.actorId !== binding.actorId || entry.binding.emailId !== binding.emailId
    || entry.binding.smtpUser !== binding.smtpUser || entry.binding.contentHash !== binding.contentHash) return null;
  sendStore.delete(ref);
  return entry.pass;
}

export function putEmailCredential(pass: string): string {
  const ref = `ecred_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  store.set(ref, { pass, expiresAt: Date.now() + TTL_MS });
  return ref;
}

export function takeEmailCredential(ref: string): string | null {
  const entry = store.get(ref);
  if (!entry) return null;
  store.delete(ref); // one-shot：取一次后销毁
  if (Date.now() > entry.expiresAt) return null; // 过期
  return entry.pass;
}

export function clearEmailCredentials(): void {
  store.clear();
  sendStore.clear();
}
