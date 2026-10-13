export interface PdmlSourceOptions {
  endpoint?: string;
  token?: string;
  bridgeKey?: string;
  ztCode?: string;
  gsid?: string;
  pageSize?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface PdmlFetchResult {
  gsid: string;
  totalAvailable: number;
  rows: Record<string, any>[];
}

const DEFAULT_ENDPOINT = 'https://pdml.jiangsupanda.com/api/myapi/apidoing';
const DEFAULT_TOKEN = '111111';
const DEFAULT_ZT_CODE = 'PDML';
const DEFAULT_GSID = '6';

const sqlLiteral = (value: unknown) => String(value ?? '').replace(/'/g, "''");

export async function fetchPdmlRawRows(opts: PdmlSourceOptions = {}): Promise<PdmlFetchResult> {
  const endpoint = opts.endpoint || process.env.PDML_ENDPOINT || DEFAULT_ENDPOINT;
  const token = opts.token || process.env.PDML_TOKEN || DEFAULT_TOKEN;
  const bridgeKey = String(opts.bridgeKey || process.env.PDML_BRIDGE_KEY || '').trim();
  const ztCode = opts.ztCode || process.env.PDML_ZT_CODE || DEFAULT_ZT_CODE;
  const gsid = opts.gsid || process.env.PDML_GSID || DEFAULT_GSID;
  const fetchImpl = opts.fetchImpl || fetch;
  const pageSize = Number(opts.pageSize || process.env.PDML_SYNC_PAGE_SIZE || 500);
  const limit = opts.limit == null ? Infinity : Number(opts.limit);

  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error('pageSize must be a positive number');
  }
  if (!Number.isFinite(limit) && limit !== Infinity) {
    throw new Error('limit must be a positive number');
  }

  const select = async (sql: string) => {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        ...(bridgeKey ? { 'X-PDML-Bridge-Key': bridgeKey } : {}),
      },
      body: JSON.stringify({
        Doing: 'select',
        SQL: sql,
        ZTCode: ztCode,
        ModuleParams: {},
        Token: token,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.ResultCode !== 'SUCCESS') {
      throw new Error(`PDML query failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data.ResultData?.SQL?.data || [];
  };

  const where = `AND GSID = '${sqlLiteral(gsid)}'`;
  const countRows = await select(`select count(*) as CNT from V_MLXX D where 1=1 ${where}`);
  const totalAvailable = Number(countRows[0]?.CNT || 0);
  const target = Math.min(totalAvailable, limit);
  const rows: Record<string, any>[] = [];

  for (let skip = 0; skip < target; skip += pageSize) {
    const first = Math.min(pageSize, target - skip);
    const sql = `select first ${first} skip ${skip} D.* from V_MLXX D where 1=1 ${where} ORDER BY DJRQ DESC`;
    const page = await select(sql);
    rows.push(...page);
    if (page.length < first) break;
  }

  return { gsid, totalAvailable, rows };
}
