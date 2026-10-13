import {describe,it,expect,vi} from 'vitest';
import {supplierDirectoryItem,listSupplierDirectory} from '../supplierDirectory';
const relation={id:'r1',name:'供应商',createdAt:'2026-10-10T00:00:00Z',lastInteraction:1};
describe('supplier identity directory',()=>{
 it('includes identity-only suppliers without manufacturing an extension',()=>{
  const row=supplierDirectoryItem(relation,null);
  expect(row).toMatchObject({id:'r1',relationId:'r1',productionProfileId:null,productionArchived:false,specialties:[]});
  expect(row.createdAt).toBe(Date.parse(relation.createdAt));
 });
 it('preserves original extension IDs, ratings and capacities',()=>{
  expect(supplierDirectoryItem(relation,{id:'f1',relationId:'r1',deletedAt:null,qualityScore:91,monthlyCapacity:5000})).toMatchObject({id:'f1',productionProfileId:'f1',qualityScore:91,monthlyCapacity:5000});
 });
 it('does not silently restore a retired extension',()=>{
  expect(supplierDirectoryItem(relation,{id:'f1',deletedAt:123})).toMatchObject({id:'r1',productionProfileId:null,productionArchived:true});
 });
 it('uses the same supplier filter for count and rows and clamps invalid pagination',async()=>{
  const query=vi.fn().mockResolvedValueOnce([{relation,profile:null}]).mockResolvedValueOnce([{total:32}]);
  const result=await listSupplierDirectory({$queryRaw:query} as any,{sort:'invalid; DROP TABLE',search:'%_needle',limit:Infinity,offset:-100});
  expect(result.total).toBe(32);expect(result.items[0].productionProfileId).toBeNull();
  const [rows,count]=query.mock.calls.map(c=>c[0]);
  expect(rows.text).toContain('LEFT JOIN');expect(count.text).toContain('LEFT JOIN');
  expect(rows.text).toContain('strpos');expect(rows.text).not.toContain('DROP');
  expect(rows.values).toContain('%_needle');expect(rows.values.slice(-2)).toEqual([20,0]);
 });
});

// These inspect Prisma's actual bound SQL so pagination/count cannot regress to
// slicing or filtering profile rows in memory.
describe('supplier directory pinyin search SQL', () => {
 const baseFilter = `r.category = 'Supplier' AND r."isOrganization" = true AND r."deletedAt" IS NULL`;
 const blacklistFilter = `(f."blacklistedAt" IS NOT NULL AND f."deletedAt" IS NULL)`;

 it.each(['L', 'lu', 'LU', 'bc', 'BC', 'beichen', 'BEICHEN', 'ACME'])('binds matching IDs for %s in both rows and count', async search => {
  const candidates = [{id:'lu-id',name:'路港服装'}, {id:'bc-id',name:'北辰服装'}, {id:'english-id',name:'Acme'}];
  const expectedId = /^l/i.test(search) ? 'lu-id' : /^a/i.test(search) ? 'english-id' : 'bc-id';
  const query = vi.fn().mockResolvedValueOnce(candidates).mockResolvedValueOnce([{relation:{...relation,id:expectedId},profile:null}]).mockResolvedValueOnce([{total:1}]);
  const result = await listSupplierDirectory({$queryRaw:query} as any, {search, limit:1, offset:0});
  expect(result).toMatchObject({total:1,items:[{relationId:expectedId}]});
  const [candidateSql, rows, count] = query.mock.calls.map(c => c[0]);
  expect(candidateSql.text).toContain('SELECT r.id, r.name');
  expect(candidateSql.text).not.toMatch(/to_jsonb|LIMIT|OFFSET|ORDER BY|strpos/);
  for (const sql of [candidateSql,rows,count]) expect(sql.text).toContain(baseFilter);
  for (const sql of [rows,count]) {
   expect(sql.text).toContain('r.id IN (');
   expect(sql.text).not.toContain(expectedId);
   expect(sql.values).toContain(expectedId);
   for (const candidate of candidates.filter(c => c.id !== expectedId)) expect(sql.values).not.toContain(candidate.id);
  }
  expect(rows.text.slice(rows.text.indexOf('WHERE'), rows.text.indexOf('ORDER BY')).trim()).toBe(count.text.slice(count.text.indexOf('WHERE')).trim());
 });

 it('finds names beyond the unfiltered first page and leaves pagination, count and sorting to SQL', async () => {
  const candidates = Array.from({length:25}, (_,i) => ({id:`other-${i}`,name:'普通供应商'}));
  candidates.push({id:'late-1',name:'北辰一厂'}, {id:'late-2',name:'北辰二厂'});
  const query = vi.fn().mockResolvedValueOnce(candidates).mockResolvedValueOnce([{relation:{...relation,id:'late-2',name:'北辰二厂'},profile:{id:'factory-late-2',deletedAt:null}}]).mockResolvedValueOnce([{total:2}]);
  const result = await listSupplierDirectory({$queryRaw:query} as any, {search:'bc',limit:1,offset:1,sort:'delivery',order:'asc'});
  expect(result).toMatchObject({total:2,items:[{relationId:'late-2',productionProfileId:'factory-late-2'}]});
  const [candidateSql,rows,count] = query.mock.calls.map(c => c[0]);
  expect(candidateSql.text).not.toContain('LIMIT');
  expect(rows.values).toEqual(['late-1','late-2',1,1]);
  expect(count.values).toEqual(['late-1','late-2']);
  expect(rows.text).toContain('ORDER BY CASE WHEN f."deletedAt" IS NULL THEN f."deliveryScore" END ASC NULLS LAST, r.name ASC, r.id ASC');
  expect(rows.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
  expect(count.text).not.toMatch(/LIMIT|OFFSET/);
 });

 it.each([true, 'true', false, 'false'])('applies the active blacklist filter %s before matching and again in rows/count', async blacklisted => {
  // The name-only result represents DB candidates after the base filters.
  const query = vi.fn().mockResolvedValueOnce([{id:'allowed-id',name:'北辰'}]).mockResolvedValueOnce([{relation:{...relation,id:'allowed-id'},profile:null}]).mockResolvedValueOnce([{total:1}]);
  await listSupplierDirectory({$queryRaw:query} as any, {search:'BC',blacklisted});
  const wanted = blacklisted === true || blacklisted === 'true';
  for (const [sql] of query.mock.calls) {
   expect(sql.text).toContain(baseFilter);
   expect(sql.text).toContain(blacklistFilter);
   expect(sql.values[0]).toBe(wanted);
  }
 });

 it('returns an empty directory without issuing page/count queries when no filtered name matches', async () => {
  const query = vi.fn().mockResolvedValueOnce([{id:'ordinary',name:'普通供应商'}]);
  expect(await listSupplierDirectory({$queryRaw:query} as any, {search:'bc',blacklisted:false})).toEqual({items:[],total:0});
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0].text).toContain(blacklistFilter);
  expect(query.mock.calls[0][0].values).toEqual([false]);
 });

 it.each(['北辰', '%', '_', '%_needle', 'Acme Textiles'])('retains bound literal strpos search for %s', async search => {
  const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{total:0}]);
  await listSupplierDirectory({$queryRaw:query} as any, {search});
  expect(query).toHaveBeenCalledTimes(2);
  for (const [sql] of query.mock.calls) {
   expect(sql.text).toContain('strpos(lower(r.name), lower(');
   expect(sql.text).not.toContain('LIKE');
   expect(sql.values).toContain(search);
  }
 });
});
