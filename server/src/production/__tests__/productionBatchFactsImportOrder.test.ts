import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Actual CommonJS graphs: neither the registry nor any domain module is mocked.
describe('neutral ProductionBatch leaf actual CommonJS load orders', () => {
  it.each([
    ['production/releaseService', 'production/productionBatchService', 'shipping/shipmentPhysicalAllocationService', 'qc/qcPhysicalCoverage'],
    ['production/productionBatchService', 'production/releaseService', 'qc/qcPhysicalCoverage', 'shipping/shipmentPhysicalConsumerService'],
    ['shipping/shipmentPhysicalAllocationService', 'production/productionBatchService', 'production/releaseService', 'qc/qcPhysicalCoverage'],
    ['qc/qcPhysicalCoverage', 'production/productionBatchFacts', 'production/releaseService', 'production/productionBatchService'],
  ])('clear-cache real graph %# loads without changing neutral facts', (...order: string[]) => {
    const script = `const path=require('node:path'); const root=path.resolve('src');
      for(const key of Object.keys(require.cache)) if(key.startsWith(root+path.sep)) delete require.cache[key];
      for(const module of ${JSON.stringify(order)}) require(path.join(root,module));
      const leaf=require(path.join(root,'production/productionBatchFacts'));
      const old=require(path.join(root,'production/productionBatchService'));
      for(const name of ['productionBatchLineFingerprint','productionBatchSourceFingerprint','resolveCurrentProductionBatchFacts']) if(leaf[name]!==old[name]) throw Error('Public API lost original function identity: '+name);
      const o={id:'O',customerRelationId:null,millRelationId:'F',sourceCaseId:null},l={id:'L',orderId:'O',confirmedSourceType:'Sample',confirmedSourceId:'S',specSnapshot:{z:2,a:1},quantity:'1.2345',unit:'m'};
      if(leaf.productionBatchLineFingerprint(o,l)!==old.productionBatchLineFingerprint(o,l)) throw Error('Fingerprint changed');
      process.stdout.write('native modules loaded');`;
    const r = spawnSync(process.execPath, ['-r','ts-node/register/transpile-only','-e',script], {
      cwd: path.resolve(process.cwd()), env: { ...process.env, TS_NODE_COMPILER_OPTIONS: '{"module":"CommonJS"}', BAMBOOK_NO_SCHEDULER: '1' }, encoding: 'utf8', timeout: 15000,
    });
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain('native modules loaded');
  });
});
