import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Exercise the actual shell guard's PCRE patterns with rg, not a JS reimplementation.
const source = readFileSync(new URL('./check-design-tokens.sh', import.meta.url), 'utf8');
const patterns = ['l2_a', 'l2_b'].map(name => {
  const line = source.split('\n').find(value => value.startsWith(`${name}=`));
  const pattern = line?.match(/-e '([^']+)'/)?.[1];
  if (!pattern) throw new Error(`Missing ${name} spacing guard`);
  return pattern;
});

function scan(input: string) {
  return patterns.flatMap(pattern => {
    const result = spawnSync('rg', ['-o', '-P', '-e', pattern], { input, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean);
  }).sort();
}

describe('design token guard: spacing detection', () => {
  it('detects ordinary, negative and responsive out-of-scale integer spacing', () => {
    expect(scan('p-9 gap-9 px-11 -mt-28 md:p-9 hover:gap-y-11 !p-9')).toEqual(
      ['p-9', 'gap-9', 'px-11', '-mt-28', 'p-9', 'gap-y-11', 'p-9'].sort(),
    );
  });

  it('detects ordinary and negative arbitrary pixel spacing', () => {
    expect(scan('px-[15px] gap-[7px] -mb-[1px] md:space-x-[7px]')).toEqual(
      ['px-[15px]', 'gap-[7px]', '-mb-[1px]', 'space-x-[7px]'].sort(),
    );
  });

  it('allows the documented scale, resets and unrelated class names', () => {
    const scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16];
    expect(scan(scale.flatMap(n => [`p-${n}`, `gap-${n}`, `-mt-${n}`, `md:px-${n}`]).join(' '))).toEqual([]);
    expect(scan('custom-p-9 mygap-9 custom-px-[15px] w-9 h-[15px] p-auto gap-px')).toEqual([]);
  });
});

const positionGuard = source.split("<<'BDS_L2_POSITION_GUARD'\n")[1]?.split('\nBDS_L2_POSITION_GUARD')[0];
function positionScan(files: Record<string,string>, rows: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'bds-l2-'));
  try {
    mkdirSync(join(root, 'components'));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, 'components', file), text);
    writeFileSync(join(root, 'ledger.csv'), 'source_path,source_line,source_anchor,matched_class,guard_policy\n' + rows.join('\n'));
    return spawnSync('python3', ['-', root, 'ledger.csv'], {input:positionGuard,encoding:'utf8'});
  } finally { rmSync(root,{recursive:true,force:true}); }
}

describe('L2 position debt guard', () => {
  const row = 'components/Page.tsx,1,const x = `p-9`;,p-9,tracked-debt';
  it('accepts exact recorded debt and debt removal', () => {
    expect(positionScan({'Page.tsx':'const x = `p-9`;'},[row]).status).toBe(0);
    expect(positionScan({'Page.tsx':'const x = `p-4`;'},[row]).status).toBe(0);
  });
  it('rejects same-total replacement, movement and duplicate occurrence', () => {
    for (const text of ['const x = `p-11`;','\nconst x = `p-9`;','const x = `p-9 p-9`;']) {
      expect(positionScan({'Page.tsx':text},[row]).status).toBe(1);
    }
    expect(positionScan({'Elsewhere.tsx':'const x = `p-9`;'},[row]).status).toBe(1);
  });
  it('comment and Dashboard policies allow only their precise recorded positions', () => {
    const rows = ['components/Page.tsx,1,// p-9,p-9,comment-only','components/Dashboard.tsx,1,const x = `p-9`;,p-9,protected-dashboard'];
    expect(positionScan({'Page.tsx':'// p-9','Dashboard.tsx':'const x = `p-9`;'},rows).status).toBe(0);
    expect(positionScan({'Page.tsx':'// p-9\nconst y = `p-9`;','Dashboard.tsx':'const x = `p-9`;'},rows).status).toBe(1);
    expect(positionScan({'Page.tsx':'// p-9','Dashboard.tsx':'const x = `p-9`;\nconst y = `p-11`;'},rows).status).toBe(1);
  });
});

const embeddedGuard = source.split("<<'BDS_M1_EMBEDDED_GUARD'\n")[1]?.split('\nBDS_M1_EMBEDDED_GUARD')[0];
function embeddedScan(parent: string, child: string, extra?: string) {
  const root = mkdtempSync(join(tmpdir(), 'bds-m1-'));
  try {
    mkdirSync(join(root,'components','tools'),{recursive:true});
    writeFileSync(join(root,'components','CustomsManager.tsx'),parent);
    writeFileSync(join(root,'components','tools','DocumentTemplateManager.tsx'),child);
    if(extra) writeFileSync(join(root,'components','OtherManager.tsx'),extra);
    return spawnSync('node',['-',root],{input:embeddedGuard,encoding:'utf8'});
  } finally {rmSync(root,{recursive:true,force:true});}
}
describe('M1 exact embedded page exception', () => {
  const parent = "import Templates from './tools/DocumentTemplateManager'; export default () => <><PageHeader/><Templates/></>";
  const child = 'export default () => <h2>单据模板</h2>';
  it('accepts only actual parent header, actual child heading and one owned render', () => {
    expect(embeddedScan(parent,child).status).toBe(0);
  });
  it('rejects a new consumer, including aliased import', () => {
    expect(embeddedScan(parent,child,"import Other from './tools/DocumentTemplateManager'; export default () => <Other/>").status).toBe(1);
  });
  it('rejects missing structure, comments pretending to be structure and unused import', () => {
    expect(embeddedScan(parent.replace('<PageHeader/>','{/* PageHeader */}'),child).status).toBe(1);
    expect(embeddedScan(parent,'// <h2>\nexport default () => <div/>').status).toBe(1);
    expect(embeddedScan(parent.replace('<Templates/>',''),child).status).toBe(1);
    expect(embeddedScan(parent.replace('<Templates/>','<Templates/><Templates/>'),child).status).toBe(1);
  });
});
