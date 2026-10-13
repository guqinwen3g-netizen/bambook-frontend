import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** Independent archive binding for a reviewed B131 snapshot. This checks the
 * retained source records, not only two numbers copied from the same baseline. */
export function verifyTierMessageBaselineEvidence(baseline, compressedInventory) {
  const fail = detail => { throw new Error(`B131 source evidence mismatch: ${detail}`); };
  const evidence = baseline?._sourceEvidence;
  if (!evidence?.sourceHead || !/^[a-f0-9]{40}$/.test(evidence.sourceHead)
    || !evidence.sourceInventory || !evidence.sourceInventorySha256) fail('missing reviewed source archive identity');
  const checksum = createHash('sha256').update(compressedInventory).digest('hex');
  if (checksum !== evidence.sourceInventorySha256) fail('archive checksum');
  const inventory = JSON.parse(gunzipSync(compressedInventory));
  if (inventory.sourceHead !== evidence.sourceHead || inventory.measurement !== baseline.measurement) fail('fixed source or meter identity');
  const rows = inventory.report?.inventory;
  if (!Array.isArray(rows) || !rows.length) fail('empty source inventory');
  const accounting = rows.reduce((out, row) => {
    if (!['public-message', 'typed-contract', 'internal', 'unresolved'].includes(row.kind)) fail('unclassified record');
    if (!row.file || !Number.isSafeInteger(row.line) || row.line < 1 || row.kind === 'unresolved' && !row.reason) fail('source locator or unresolved reason');
    out.total++; out[row.kind]++; return out;
  }, { total: 0, 'public-message': 0, 'typed-contract': 0, internal: 0, unresolved: 0 });
  for (const [key, count] of Object.entries(accounting)) if (baseline.sourceInventory?.[key] !== count || inventory.accounting?.[key] !== count) fail(`source accounting ${key}`);
  const publicKeys = new Set(inventory.report.publicLiterals.map(row => `${row.file}|${row.message.trim()}`));
  if (!Array.isArray(inventory.literals) || inventory.literals.length !== publicKeys.size
    || inventory.literals.some(row => !publicKeys.has(`${row.file}|${row.message.trim()}`))) fail('literal source corpus');
  const seen = new Set(), buckets = {};
  for (const row of inventory.literals) {
    const key = `${row.file}|${row.message.trim()}`;
    if (seen.has(key) || ![400, 404, 409, 500].includes(row.tier)) fail('duplicate literal or unknown keyword tier');
    seen.add(key); buckets[row.tier] = (buckets[row.tier] ?? 0) + 1;
  }
  if (baseline.count !== seen.size || inventory.keywordCount !== seen.size) fail('literal count');
  const tiers = new Set([...Object.keys(buckets), ...Object.keys(baseline.byTier ?? {})]);
  for (const tier of tiers) if ((baseline.byTier?.[tier] ?? 0) !== (buckets[tier] ?? 0)) fail(`keyword bucket ${tier}`);
  return { sourceHead: inventory.sourceHead, count: seen.size, accounting };
}
