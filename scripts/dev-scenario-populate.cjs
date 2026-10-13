/** Actual HTTP business population, separately from the atomic master reset.
 * Resume consumes the original cast/receipt/journal; it never clears or seeds. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const guard = require('./dev-scenario-database.cjs');
const preflight = require('./dev-scenario-rebuild.cjs');
const maintenance = require('./dev-scenario-apply.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readPopulationContext(supplied) {
  const context = maintenance.readContext(supplied), command = context.command;
  const manifest = preflight.readJsonEvidence(context.qualifiedRunDirectory, 'source-files.json').value;
  if (sha(JSON.stringify(manifest)) !== command.sourceSha256
    || JSON.stringify(preflight.currentSourceManifest(guard.root, manifest)) !== JSON.stringify(manifest)) throw Error('POPULATION_QUALIFIED_SOURCE_CHANGED');
  return context;
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--private-directory') throw Error('Usage: dev-scenario-populate.cjs --private-directory ORIGINAL_DIRECTORY');
  const context = readPopulationContext(args[1]), target = preflight.assertDevConnection(guard.loadTarget());
  if (target.port !== context.expectedPort) throw Error('POPULATION_ORIGINAL_PORT_CHANGED');
  const response = await guard.freshMaintenanceGet('/api/dev/status');
  preflight.assertDevApiIdentity(response.status, await response.json());
  const url = new URL('postgresql://localhost/panda_hub_dev');
  url.hostname = target.pgEnv.PGHOST; url.port = target.pgEnv.PGPORT;
  url.username = target.pgEnv.PGUSER; url.password = target.pgEnv.PGPASSWORD;
  url.searchParams.set('schema', 'public'); url.searchParams.set('connection_limit', '1');
  Object.assign(process.env, target.env, { DATABASE_URL: url.toString(), NODE_ENV: 'development' });
  const runtimeGuard = maintenance.createPopulationRuntimeGuard(guard.root, context);
  require(require.resolve('tsx/cjs', { paths: [path.join(guard.root, 'server')] }));
  const { PrismaClient } = require(path.join(guard.root, 'server/node_modules/@prisma/client'));
  const { runCurrentDevPopulation } = require(path.join(guard.root, 'server/scripts/full-business-sim/runningDevPopulation.ts'));
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const report = await runCurrentDevPopulation(client, { ...context.command, privateDirectory: context.privateDirectory,
      expectedPort: context.expectedPort, assertRuntimeCurrent: () => { runtimeGuard.assertCurrent(); } });
    fs.mkdirSync(guard.evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(guard.evidenceDir, 'population-result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ database: report.database, businessTime: report.businessTime, counts: report.counts,
      allStopsReached: report.claims.allStopsReached, currentDevRebuilt: report.claims.currentDevRebuilt,
      wholeProductPassed: false, uiPassed: false }));
    return report;
  } finally { await client.$disconnect(); }
}
module.exports = { readPopulationContext, main };
if (require.main === module) main().catch(() => {
  console.error('Current dev population stopped. No reset or reseed was attempted; retain the original private directory and reconcile its journal/report before resuming.');
  process.exitCode = 1;
});
