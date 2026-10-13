import { appendFileSync } from 'node:fs';
/** Optional private verification output. Observes the original storage spies;
 * never supplies identity, grants, scope, rows, results or fallback behavior. */
export async function recordAuthorityFixtureProof(file: string, task: any, fixture: any) {
  const destination = process.env.BAMBOOK_AUTHORITY_FIXTURE_PROOF_PATH;
  if (!destination || !fixture) return;
  const names: string[] = [];
  for (let node = task; node; node = node.suite) if (node.name) names.unshift(node.name);
  const storage = fixture.prisma ?? fixture.db;
  const delegates: Record<string, unknown> = {};
  for (const model of ['userAccount', 'userPermissionOverrides', 'department', 'teamMember', 'teamDataGrant', 'relation']) {
    const methods: Record<string, unknown> = {};
    for (const [name, method] of Object.entries(storage[model] ?? {})) {
      const mock = (method as any)?.mock;
      if (!mock) continue;
      const results = await Promise.all(mock.results.map(async (result: any) => {
        try { const value = await result.value; return { status: 'fulfilled',
          ...((model === 'userAccount' && name === 'findUnique') || model === 'department' ? { value } : {}) }; }
        catch (error: any) { return { status: 'rejected', name: error?.name, message: error?.message }; }
      }));
      methods[name] = { calls: mock.calls, results };
    }
    delegates[model] = { present: !!storage[model], methods };
  }
  appendFileSync(destination, JSON.stringify({ file, fullName: names.join(' '), taskName: task?.name,
    delegates, authorityReads: fixture.authorityReads ?? null,
    beforeTransactionInvocations: fixture.beforeTransactionInvocations?.() ?? null }) + '\n');
}
