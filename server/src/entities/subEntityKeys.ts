import { createHash } from 'crypto';

export type RelationAddressLike = {
  id?: string;
  address?: string;
  text?: string;
  city?: string;
  contactName?: string;
  phone?: string;
  note?: string;
};

export type RelationContactLike = {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  text?: string;
  note?: string;
};

export function ensureStableAddressIds(addresses: RelationAddressLike[] | null | undefined): RelationAddressLike[] {
  return (addresses || []).map((address, index) => ({
    ...address,
    id: address.id || stableSubEntityId('addr', [address.address, address.text, address.city, address.contactName, address.phone, index]),
  }));
}

export function ensureStableContactIds(contacts: RelationContactLike[] | null | undefined): RelationContactLike[] {
  return (contacts || []).map((contact, index) => ({
    ...contact,
    id: contact.id || stableSubEntityId('contact', [contact.name, contact.email, contact.phone, contact.text, index]),
  }));
}

export function stableSubEntityId(prefix: string, parts: unknown[]): string {
  const normalized = parts
    .map((part) => String(part ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join('|');
  const hash = createHash('sha1').update(normalized || prefix).digest('hex').slice(0, 12);
  return `${prefix}_${hash}`;
}

export function relationTargetPath(kind: 'shipToAddresses' | 'backupContacts', id: string): string {
  return `${kind}.${id}`;
}
