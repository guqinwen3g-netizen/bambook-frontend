/**
 * 演示工作区的模块示例数据。
 *
 * 只在创建“演示工作区”时运行；空白 / 正式工作区不会调用。所有记录都通过真实业务命令生成，
 * 因此同样经过校验、留下操作记录，并且彼此关联（开发 → 样品 → QC → 档案 → 报价 → 订单 → 采购 → 入库 → 出运 → 报关 → 单据）。
 * 某一步失败时跳过并记录原因（测试要求零失败），不会写入半成品记录。
 */
import { applyMistCommand, type MistCommand, type MistContext, type MistState } from './mistWorkspace';
import { emptyFabricRequirements } from './mistDevelopmentDomain';
import { demoFileRecord, type DemoFileTemplate } from './mistDemoFiles';
import { riskSignals } from './mistRisk';
import { MIST_DEMO_ACCOUNTS } from './mistAccounts';

export const DEMO_SEED_VERSION = 15;
export type DemoSeedFailure = { step: string; message: string };

const DAY = 86400000;

export function seedDemoModules(initial: MistState, context: MistContext): { state: MistState; failures: DemoSeedFailure[] } {
  let state = initial;
  const failures: DemoSeedFailure[] = [];
  const nowMs = Date.parse(context.now);
  /** 业务日期：相对“现在”的天数偏移，保证已发生的事实不晚于现在。 */
  const day = (offset: number) => new Date(nowMs + offset * DAY).toISOString().slice(0, 10);
  const at = (offset: number, hour = 9) => { const d = new Date(nowMs + offset * DAY); d.setUTCHours(hour, 0, 0, 0); return (d.getTime() > nowMs ? new Date(nowMs - 60000) : d).toISOString(); };
  const supplierApprovers = { version: 1, userIds: ['demo-reviewer'] };
  const authority: NonNullable<MistContext['authority']> = {
    supplier: Object.fromEntries(['purchase', 'processing', 'finished', 'material'].flatMap(kind => ['garment', 'fabric'].map(domain => [`supplierCommitment.approvers.${kind}.${domain}`, supplierApprovers]))),
    businessReviewerId: 'demo-reviewer', claimReviewerId: 'demo-reviewer', orderReviewerIds: { garment: ['demo-reviewer'], fabric: ['demo-reviewer'] },
    // 演示叙事中的财务、采购、业务均按已有处理权推进；风险申请由演示主管周敏审批。
    risk: { all: true, orders: true, customers: true }, riskReviewerIds: ['demo-reviewer'],
  };
  // 演示人物目录：示例数据的负责人 / 经手人按账号引用这些人物（包 A）。
  const actor = (actorName: string, actorId: string): MistContext => ({ ...context, actorName, actorId, authority, members: MIST_DEMO_ACCOUNTS });
  const sales = actor('顾言', 'demo-sales'), buyer = actor('沈禾', 'demo-buyer'), reviewer = actor('周敏', 'demo-reviewer'), inspector = actor('许言', 'demo-qc'), warehouse: MistContext = { ...actor('陈晓', 'demo-warehouse'), can: scope => scope === 'customs:clear' }; // 演示后勤/单证岗：唯一登记清关完成的身份
  const run = (step: string, command: MistCommand, ctx: MistContext = sales): Record<string, unknown> | null => {
    try { const r = applyMistCommand(state, command, ctx); state = r.state; return r.result as Record<string, unknown>; }
    catch (e) { failures.push({ step, message: e instanceof Error ? e.message : String(e) }); return null; }
  };
  /** 示例附件：只登记元数据，内容由服务端按模板生成真实 PDF 写入存储。 */
  const demoFile = (template: DemoFileTemplate, ref: string, name: string) => { const file = demoFileRecord(context.id(), template, ref, name, context.now); state.files.push(file); return file.id; };
  const id = (r: Record<string, unknown> | null, key = 'id') => (r && typeof r[key] === 'string' ? r[key] as string : '');

  const [c0, c1, c2] = state.customers;
  if (!c0 || !c1 || !c2) return { state, failures: [{ step: 'customers', message: '演示客户不足' }] };

  /* ───────── 订单主单审批：演示订单按真实流程提交并批准，之后才能进入采购与履约 ───────── */
  const approveOrder = (orderId: string, po: string, depositPercent: number) => {
    const o = state.orders.find(x => x.id === orderId); if (!o || o.governance?.status === 'approved') return;
    run('order draft ' + o.code, { type: 'order.governance.saveDraft', payload: { orderId, input: { kind: 'external', poNumber: po, confirmationFileIds: [demoFile('customer-po', orderId, `${o.code} 客户PO确认（演示）.pdf`)], internalPurpose: '', receiver: '', paymentMethod: 'TT', depositPercent, paymentNote: `${depositPercent}% 定金，余款见提单副本`, incoterm: 'FOB', deliveryPlace: '上海' } } }, sales);
    run('order submit ' + o.code, { type: 'order.governance.submit', payload: { orderId } }, sales);
    run('order approve ' + o.code, { type: 'order.governance.decide', payload: { id: orderId, decision: 'approved', note: '价格、交期与付款条件已核对' } }, reviewer);
  };
  state.orders.forEach((o, i) => approveOrder(o.id, `PO-${o.code.slice(-3)}-${2026 + (i % 2)}`, 30));

  /* ───────── 供应商与联系人 ───────── */
  const supplier = (code: string, name: string, type: string, capabilities: string, capacity: number, capacityUnit: string, leadDays: number, address: string, contact: [string, string, string, string]) => {
    const existing = state.market.suppliers.find(s => s.code === code);
    const handlerIds = type === '成衣加工' ? { garment: 'demo-sales' } : type === '辅料' ? { garment: 'demo-buyer', fabric: 'demo-buyer' } : { fabric: 'demo-buyer' };
    const sid = id(run('supplier ' + name, { type: 'market.supplier.save', payload: { id: existing?.id, input: { code, name, type, country: '中国', address, capabilities, capacity, capacityUnit, leadDays, fileIds: [], note: '', handlerIds } } }));
    if (sid) run('supplier contact ' + name, { type: 'market.contact.save', payload: { kind: 'supplier', parentId: sid, name: contact[0], role: contact[1], email: contact[2], phone: contact[3], primary: true } });
    return sid;
  };
  const jiangnan = supplier('SUP-0001', '江南成衣', '成衣加工', '大衣 · 西装 · 双面呢手工', 6000, '件/月', 35, '浙江嘉兴秀洲区新塍镇工业园 8 号', ['王建国', '厂长', 'wang@jiangnan-garment.cn', '0573-8312 6608']);
  const yuanshan = supplier('SUP-0002', '远山服装', '成衣加工', '精纺西装 · Blazer · 衬里', 4500, '件/月', 40, '江苏常熟虞山镇海虞北路 126 号', ['李慧', '业务经理', 'lihui@yuanshan-fashion.cn', '0512-5277 1180']);
  const huasheng = supplier('SUP-0003', '华盛毛纺', '织造', '粗纺 / 精纺羊毛 · 双面呢 · 染整', 80000, '米/月', 25, '江苏张家港塘桥镇毛纺工业区', ['赵琳', '跟单', 'zhaolin@huasheng-wool.cn', '0512-5868 2203']);
  const baotai = supplier('SUP-0004', '宝泰辅料', '辅料', '树脂扣 · 牛角扣 · 金属扣 · 衬布', 2000000, '粒/月', 12, '浙江义乌稠城街道辅料市场 3 区', ['钱多多', '销售', 'sales@baotai-trims.cn', '0579-8551 0921']);
  const hengcai = supplier('SUP-0005', '恒彩印花', '印花', '数码印花 · 圆网印花 · 小批量打样', 30000, '米/月', 18, '浙江绍兴柯桥区齐贤街道印染园 21 号', ['孙蕾', '业务主管', 'sunlei@hengcai-print.cn', '0575-8410 3367']);
  const cert = (sid: string, name: string, number: string, issuer: string, validDays: number) => { if (sid) run('supplier cert ' + name, { type: 'market.supplier.certificate.save', payload: { supplierId: sid, name, number, issuer, validUntil: day(validDays), fileIds: [] } }); };
  cert(huasheng, 'OEKO-TEX Standard 100', 'SH025 168432', 'TESTEX', 20);
  cert(huasheng, 'GRS 全球回收标准', 'CU-GRS-883104', 'Control Union', 300);
  cert(jiangnan, 'BSCI 社会责任审核', 'DBID 429-8811', 'amfori', -5);
  cert(jiangnan, 'ISO 9001', 'CN-QMS-22178', 'SGS', 410);
  cert(baotai, 'OEKO-TEX Standard 100', 'HK-024 77310', 'Hohenstein', 160);
  const rate = (sid: string, grade: 'A' | 'B' | 'C' | 'D', period: string, note: string) => { if (sid) run('supplier rate ' + period, { type: 'market.supplier.rate', payload: { supplierId: sid, grade, period, note } }, reviewer); };
  rate(jiangnan, 'B', '2026 Q2', '交期稳定，返修率 2.1%，略高于目标');
  rate(jiangnan, 'A', '2026 Q3', '准交 100%，返修率降到 0.8%');
  rate(huasheng, 'B', '2026 Q3', '准交良好；一批燕麦色双面呢色差 20 米退回');
  rate(baotai, 'A', '2026 Q3', '到货点数无误，响应快');
  rate(hengcai, 'C', '2026 Q3', '两批色牢度不达标，已要求整改');
  if (hengcai) run('supplier pause', { type: 'market.supplier.status', payload: { id: hengcai, status: 'paused', reason: '色牢度两批不达标，整改报告待复核' } }, reviewer);

  /* ───────── 往来单位：客户身份、货代、报关行 ───────── */
  const relation = (name: string, category: 'Customer' | 'Agent' | 'Partner' | 'Government', country: string, address: string, aliases: string[], customerId = '') => id(run('relation ' + name, { type: 'market.relation.save', payload: { input: { name, category, customerId, supplierId: '', country, address, aliases, fileIds: [], note: '' } } }));
  relation(c0.name, 'Customer', '英国', '12 Savile Row, London W1S 3PQ', ['CEDAR & CROWN LTD'], c0.id);
  relation(c1.name, 'Customer', '瑞典', 'Birger Jarlsgatan 18, Stockholm', ['NORTHWIND ATELIER AB'], c1.id);
  relation(c2.name, 'Customer', '法国', '18 Rue de Turenne, 75004 Paris', ['MAISON LUNE SARL'], c2.id);
  const forwarder = relation('中远海运物流（上海）', 'Agent', '中国', '上海市虹口区东大名路 378 号', ['COSCO Logistics']);
  if (forwarder) run('forwarder contact', { type: 'market.contact.save', payload: { kind: 'relation', parentId: forwarder, name: '周海峰', role: '订舱专员', email: 'booking.sh@cosco-logistics.cn', phone: '021-3512 6600', primary: true } });
  relation('上海东航报关有限公司', 'Partner', '中国', '上海浦东新区机场镇', ['东航报关']);

  /* ───────── 季节与趋势 ───────── */
  const aw27 = id(run('season AW27', { type: 'market.season.save', payload: { input: { code: 'AW27', name: '2027 秋冬', startDate: day(-90), endDate: day(120), status: 'Active', milestones: [{ label: '面料定版', date: day(-30) }, { label: '首样评审', date: day(-3) }, { label: '订货会', date: day(21) }, { label: '大货交期', date: day(95) }], fileIds: [], note: '主推双面呢大衣与精纺西装。' } } }));
  const ss27 = id(run('season SS27', { type: 'market.season.save', payload: { input: { code: 'SS27', name: '2027 春夏', startDate: day(60), endDate: day(240), status: 'Planning', milestones: [{ label: '趋势定调', date: day(70) }, { label: '面料开发截止', date: day(110) }], fileIds: [], note: '' } } }));

  /* ───────── 面料开发（独立面料线） ───────── */
  const fabricValues = { ...{ name: '燕麦色羊毛混纺双面呢', customer: c0.id, style: '', season: 'AW27', category: '双面呢', kind: 'new' as const, fabric: '420 g/m² 双面呢，手感软糯不起球', color: '燕麦色', target: '7.80', targetCurrency: 'EUR', targetUnit: '米', sizeBase: '', goal: '替代现款双面呢，降低起球等级', factories: [huasheng], due: day(25), collaborators: [], sampleQuantity: 3, sampleForm: '米样', sampleUnit: '米' }, domain: 'fabric' as const, fabricRequirements: { ...emptyFabricRequirements(), composition: '羊毛:70\n涤纶:30', weightValue: '420', weightUnit: 'g/m²', widthValue: '148', widthUnit: 'cm', weave: '双面斜纹', yarn: '2/26Nm 粗纺', finish: '缩绒', usage: '大衣', handle: '软糯' } };
  const fabricDev = huasheng ? run('fabric development', { type: 'development.submit', payload: { values: fabricValues, fileIds: [] } }) : null;
  const fabricDevId = id(fabricDev, 'devId'), fabricVersionId = id(fabricDev, 'versionId');
  if (fabricDevId) {
    run('fabric sample returned', { type: 'development.recordSample', payload: { devId: fabricDevId, versionId: fabricVersionId, sample: 'HS-2701-L1', quantity: 3, form: '米样', unit: '米', location: '面料架 B-2', color: '燕麦色', returnedAt: at(-6) } });
    run('fabric QC', { type: 'development.recordQc', payload: { devId: fabricDevId, versionId: fabricVersionId, domain: 'fabric', qc: { result: 'pass', reviewer: '许言', reviewedAt: at(-4, 10), report: 'QC-F-2026-0031', opinion: '克重、门幅在公差内；起球 4 级，达到目标。', fabricMeasurements: [{ property: '克重', actual: 418, unit: 'g/m²' }, { property: '门幅', actual: 148, unit: 'cm' }] } } }, inspector);
    run('fabric customer confirmation', { type: 'development.confirm', payload: { devId: fabricDevId, versionId: fabricVersionId, result: 'approved', confirmer: 'Emma Clarke', organization: c0.name, confirmedAt: at(-3), basis: '软件演示确认记录', originalText: '软件演示：已确认本版米样，可按此面料版本报价下单。' } });
  }

  /* ───────── 数字档案 ───────── */
  const coatDev = state.devs.find(d => d.id === 'DEV-G-2026-031'), coatVersion = coatDev && state.versions.find(v => v.devId === coatDev.id && v.qc?.result === 'pass');
  const coatProduct = coatDev && coatVersion ? id(run('product coat', { type: 'market.product.fromVersion', payload: { devId: coatDev.id, versionId: coatVersion.id, sku: 'GA-2711', supplierId: jiangnan, supplierCode: 'JX-C88' } })) : '';
  const fabricProduct = fabricDevId ? id(run('product fabric', { type: 'market.product.fromVersion', payload: { devId: fabricDevId, versionId: fabricVersionId, sku: 'FB-2701', supplierId: huasheng, supplierCode: 'HS-W3302' } })) : '';
  const product = (step: string, input: Parameters<typeof productInput>[0]) => id(run(step, { type: 'market.product.save', payload: { input: productInput(input) } }));
  const nylon = product('product nylon', { sku: 'FB-2702', name: '再生涤纶塔丝隆', category: 'fabric', supplierId: huasheng, supplierCode: 'HS-N210', composition: '再生涤纶 100', color: '黑色', unit: '码', cost: '1.35', currency: 'USD', refPrice: '1.90', specs: { weight: '95', width: '150', weave: '平纹', finish: '防泼水' } });
  const vest = product('product vest', { sku: 'GA-2712', name: '轻量填充马甲', category: 'garment', supplierId: yuanshan, supplierCode: 'YS-V12', composition: '面 再生涤纶 / 填充 仿羽绒棉', color: '黑色', unit: '件', cost: '21.00', currency: 'USD', refPrice: '29.50', specs: { garmentCategory: '马甲', sizeRange: 'S–XXL', mainFabric: 'FB-2702' } });
  const button = product('product button', { sku: 'TR-0301', name: '牛角纹树脂扣 24L', category: 'trimming', supplierId: baotai, supplierCode: 'BT-24L', composition: '树脂', color: '深棕', unit: '粒', cost: '0.08', currency: 'CNY', refPrice: '0.12', specs: { trimType: '纽扣', size: '24L / 15mm', moq: '5000 粒' } });
  const withDetails = (pid: string, patch: { refPrice?: string; customerCodes?: Array<{ customerId: string; code: string }>; cost?: string }) => {
    const p = state.market.products.find(x => x.id === pid); if (!p) return;
    const { id: _i, createdAt: _c, updatedAt: _u, status: _s, ...input } = p;
    run('product details ' + p.sku, { type: 'market.product.save', payload: { id: pid, input: { ...input, ...patch } } });
  };
  withDetails(coatProduct, { cost: '58.00', refPrice: '72.50', customerCodes: [{ customerId: c0.id, code: 'CC-AW27-COAT-014' }, { customerId: c1.id, code: 'NW-77031' }] });
  withDetails(fabricProduct, { cost: '6.20', refPrice: '7.80', customerCodes: [{ customerId: c0.id, code: 'CC-F-0912' }] });
  void nylon; void button;

  /* ───────── 报价：已接受并转单 / 已交付待回复 / 草稿 ───────── */
  const quote = (step: string, customerId: string, currency: string, validIn: number, lines: Array<{ productId: string; qty: string; price: string }>, note = '') => {
    const rows = lines.map(l => { const p = state.market.products.find(x => x.id === l.productId); return p ? { productId: p.id, sourceDevId: p.sourceDevId, sourceVersionId: p.sourceVersionId, name: p.name, style: p.sku, specification: p.specification || [p.specs?.weight && p.specs.weight + ' g/m²', p.specs?.width && p.specs.width + ' cm', p.specs?.sizeRange].filter(Boolean).join(' · '), qty: l.qty, unit: p.unit, price: l.price, cost: p.cost } : null; }).filter((x): x is NonNullable<typeof x> => !!x);
    if (!rows.length) return '';
    return id(run(step, { type: 'market.quotation.save', payload: { input: { customerId, currency, season: 'AW27', validUntil: day(validIn), deliveryTerms: 'FOB 上海', paymentTerms: 'T/T 30% 定金，70% 见提单副本', lines: rows, fileIds: [], note } } }));
  };
  // 已失效：40 天前发出，10 天前到期，客户未回复。
  const early = { ...sales, now: at(-40) };
  const expiredRows = (() => { const p = state.market.products.find(x => x.id === nylon); return p ? [{ productId: p.id, sourceDevId: p.sourceDevId, sourceVersionId: p.sourceVersionId, name: p.name, style: p.sku, specification: p.specification || '', qty: '8000', unit: p.unit, price: '1.85', cost: p.cost }] : []; })();
  const expiredQuote = expiredRows.length ? id(run('quote expired', { type: 'market.quotation.save', payload: { input: { customerId: c0.id, currency: 'USD', season: 'SS27', validUntil: day(-10), deliveryTerms: 'FOB 上海', paymentTerms: 'T/T 见提单副本', lines: expiredRows, fileIds: [], note: 'SS27 里布询价。' } } }, early)) : '';
  if (expiredQuote) {
    run('quote expired sent', { type: 'market.quotation.status', payload: { id: expiredQuote, status: 'Sent', evidence: '邮件发送报价给采购 Emma Clarke' } }, { ...sales, now: at(-38) });
    run('quote expired mark', { type: 'market.quotation.status', payload: { id: expiredQuote, status: 'Expired', evidence: '有效期内客户未回复，已电话确认本季暂不下单' } });
  }
  const fabricQuote = quote('quote fabric', c0.id, 'EUR', 30, [{ productId: fabricProduct, qty: '3600', price: '7.80' }], '面料单独报价，按米计价。');
  if (fabricQuote) {
    run('quote fabric sent', { type: 'market.quotation.status', payload: { id: fabricQuote, status: 'Sent', evidence: '邮件发送报价 PDF 给 Emma Clarke' } });
    run('quote fabric accepted', { type: 'market.quotation.status', payload: { id: fabricQuote, status: 'Accepted', evidence: '客户邮件确认 3,600 米，按报价执行' } });
    const converted = run('quote fabric convert', { type: 'market.quotation.convert', payload: { id: fabricQuote, type: 'fabric', due: day(55), ownerId: 'demo-sales' } });
    if (id(converted, 'orderId')) approveOrder(id(converted, 'orderId'), 'CC-F-PO-0912', 30);
  }
  const coatQuote = quote('quote coat', c1.id, 'USD', 21, [{ productId: coatProduct, qty: '800', price: '72.50' }, { productId: vest, qty: '600', price: '29.50' }], '补单报价，含两款。');
  if (coatQuote) run('quote coat sent', { type: 'market.quotation.status', payload: { id: coatQuote, status: 'Sent', evidence: '视频会议后发送报价单' } });
  quote('quote draft', c2.id, 'USD', 40, [{ productId: nylon, qty: '5000', price: '1.90' }], '待确认门幅后发送。');
  // 版本链：大衣报价 V1 客户还价未接受 → V2 马甲降到成本以下，提交业务审批（待审批）。
  if (coatQuote) {
    run('quote coat rejected', { type: 'market.quotation.status', payload: { id: coatQuote, status: 'Rejected', evidence: '客户回复：马甲目标价 USD 27.00，大衣可接受' } });
    const v2 = run('quote coat v2', { type: 'market.quotation.save', payload: { input: { previousId: coatQuote, customerId: c1.id, currency: 'USD', season: 'AW27', validUntil: day(18), deliveryTerms: 'FOB 上海', paymentTerms: 'T/T 30% 定金，70% 见提单副本', lines: (state.market.quotations.find(q => q.id === coatQuote)?.lines || []).map(l => ({ productId: l.productId, sourceDevId: l.sourceDevId, sourceVersionId: l.sourceVersionId, name: l.name, style: l.style, specification: l.specification, qty: l.qty, unit: l.unit, price: l.productId === vest ? '20.50' : l.price, cost: l.cost })), fileIds: [], note: '按客户还价调整马甲单价，低于成本，需审批。' } } });
    if (id(v2)) run('quote coat v2 submit', { type: 'market.quotation.submit', payload: { id: id(v2) } });
  }
  // 临期：已发送、4 天后到期。
  const nearQuote = quote('quote near expiry', c2.id, 'USD', 4, [{ productId: vest, qty: '1200', price: '29.80' }], '展会样衣跟进报价。');
  if (nearQuote) run('quote near sent', { type: 'market.quotation.status', payload: { id: nearQuote, status: 'Sent', evidence: '邮件发送报价 PDF 给 Claire Martin' } });

  /* ───────── 展会、营销活动与线索 ───────── */
  const show = aw27 ? id(run('show', { type: 'market.show.save', payload: { input: { name: 'Première Vision Paris', location: '巴黎北郊维勒班展馆', seasonId: aw27, startDate: day(-40), endDate: day(-38), booth: 'Hall 6 · F12', attendees: '顾言、沈禾', cost: '8600.00', currency: 'EUR', status: 'Completed', fileIds: [], note: '' } } })) : '';
  const campaign = aw27 ? id(run('campaign', { type: 'market.campaign.save', payload: { input: { name: 'AW27 双面呢大衣推广', type: '邮件 + 样衣寄送', seasonId: aw27, showId: show, startDate: day(-20), endDate: day(25), target: '老客户补单与 2 个新客户试单', budget: '3000.00', actualCost: '1260.00', currency: 'USD', owner: '顾言', productIds: [coatProduct, fabricProduct].filter(Boolean), fileIds: [], note: '' } } })) : '';
  if (campaign) {
    run('campaign active', { type: 'market.campaign.status', payload: { id: campaign, status: 'Active' } });
    const lead = (name: string, company: string, email: string, demand: string, value: string) => id(run('lead ' + company, { type: 'market.lead.save', payload: { input: { name, company, email, phone: '', demand, source: 'campaign', parentId: campaign, customerId: '', followUpDate: day(5), estimatedValue: value, actualValue: '', currency: 'USD', fileIds: [], note: '' } } }));
    const l1 = lead('Sofia Brandt', 'Hallberg Studio', 'sofia@hallberg.se', '双面呢大衣 300 件试单，要求 RWS 羊毛', '21000.00');
    lead('Kenji Mori', 'Atelier Mori', 'kenji@ateliermori.jp', '精纺西装面料打样', '8000.00');
    if (l1) run('lead contacted', { type: 'market.lead.transition', payload: { id: l1, status: 'Contacted', note: '已寄送色卡与报价区间' } });
  }
  if (show) run('show lead', { type: 'market.showLead.save', payload: { input: { name: 'Clara Weiss', company: 'Weiss & Söhne', email: 'clara@weiss-soehne.de', phone: '', demand: '羊毛混纺面料 2,000 米', source: 'show', parentId: show, customerId: '', followUpDate: day(3), estimatedValue: '15000.00', actualValue: '', currency: 'EUR', fileIds: [], note: '展位交换名片' } } });
  if (aw27 && fabricProduct) run('trend', { type: 'market.trend.save', payload: { input: { name: '软糯双面呢回归', type: 'fabric', seasonId: aw27, source: 'Première Vision 面料趋势区', productIds: [fabricProduct], fileIds: [], note: '' } } });
  if (aw27 && nylon) run('trend nylon', { type: 'market.trend.save', payload: { input: { name: '再生功能面料', type: 'composition', seasonId: aw27, source: 'Première Vision Smart 区 · 客户询盘', productIds: [nylon], fileIds: [], note: '' } } });
  if (aw27) run('trend color', { type: 'market.trend.save', payload: { input: { name: '燕麦与炭灰中性色', type: 'color', seasonId: aw27, source: 'WGSN AW27 色彩报告', productIds: [fabricProduct].filter(Boolean), fileIds: [], note: '' } } });
  if (ss27) run('trend craft', { type: 'market.trend.save', payload: { input: { name: '轻量无衬里结构', type: 'craft', seasonId: ss27, source: '客户 Cedar & Crown 春夏简报', productIds: [], fileIds: [], note: '' } } });
  const aw26 = id(run('season AW26', { type: 'market.season.save', payload: { input: { code: 'AW26', name: '2026 秋冬', startDate: day(-460), endDate: day(-120), status: 'Closed', milestones: [{ label: '订货会', date: day(-380) }, { label: '大货交期', date: day(-200) }], fileIds: [], note: '上一季：大衣为主。' } } }));
  if (aw26) run('season AW26 review', { type: 'market.season.review', payload: { id: aw26 } });
  const intertextile = ss27 ? id(run('show SS27', { type: 'market.show.save', payload: { input: { name: 'Intertextile 上海面辅料博览会', location: '上海国家会展中心', seasonId: ss27, startDate: day(32), endDate: day(34), booth: '5.1H · C18', attendees: '顾言、沈禾', cost: '42000.00', currency: 'CNY', status: 'Planned', fileIds: [], note: '面料板块主推再生功能面料' } } })) : '';
  void intertextile;
  if (show) {
    const lukas = id(run('show lead 2', { type: 'market.showLead.save', payload: { input: { name: 'Lukas Berg', company: 'Berg Outerwear GmbH', email: 'lukas@berg-outerwear.de', phone: '+49 89 2041 7781', demand: '防泼水塔丝隆 5,000 码，SS27 外套', source: 'show', parentId: show, customerId: '', followUpDate: day(-2), estimatedValue: '9500.00', actualValue: '', currency: 'USD', fileIds: [], note: '对再生涤纶感兴趣' } } }));
    if (lukas) run('show lead 2 convert', { type: 'market.lead.convertToCrm', payload: { id: lukas, opportunity: { title: 'Berg 外套塔丝隆 SS27', domain: 'fabric', amount: '9500.00', currency: 'USD', expectedDate: day(45) } } });
    run('show lead 3', { type: 'market.showLead.save', payload: { input: { name: 'Anna Rossi', company: 'Studio Rossi Milano', email: 'anna@studiorossi.it', phone: '', demand: '精纺西装面料色卡', source: 'show', parentId: show, customerId: '', followUpDate: day(-6), estimatedValue: '4000.00', actualValue: '', currency: 'EUR', fileIds: [], note: '' } } });
  }
  const demoBook = coatProduct ? id(run('lookbook', { type: 'market.lookbook.save', payload: { input: { name: 'Cedar & Crown AW27 大衣画册', customerId: c0.id, productIds: [coatProduct], fileIds: [], note: '示例资料，不代表已发送客户' } } })) : '';
  if (demoBook) run('lookbook prepared', { type: 'market.lookbook.status', payload: { id: demoBook, status: 'Prepared' } });
  if (campaign) {
    const kenji = state.market.leads.find(l => l.source === 'campaign' && l.parentId === campaign && l.name === 'Kenji Mori');
    if (kenji) run('campaign lead convert', { type: 'market.lead.convertToCrm', payload: { id: kenji.id, opportunity: { title: 'Atelier Mori 精纺面料打样', domain: 'fabric', amount: '8000.00', currency: 'USD', expectedDate: day(35) } } });
    run('campaign overdue lead', { type: 'market.lead.save', payload: { input: { name: 'Emma Lind', company: 'Nordform Studio', email: 'emma@example.test', phone: '', demand: '羊毛混纺大衣 200 件试单', source: 'campaign', parentId: campaign, customerId: '', followUpDate: day(-3), estimatedValue: '14000.00', actualValue: '0', currency: 'USD', fileIds: [], note: '明确的软件演示线索' } } });
    const paused = id(run('campaign paused demo', { type: 'market.campaign.save', payload: { input: { name: 'SS27 功能面料推广（暂停）', type: '面料资料推广', seasonId: ss27, showId: '', startDate: day(-8), endDate: day(20), target: '功能外套客户', budget: '2000.00', actualCost: '2300.00', currency: 'EUR', owner: '沈禾', productIds: [nylon].filter(Boolean), fileIds: [], note: '示例：费用超预算，暂停核对' } } }));
    if (paused) { run('campaign start demo', { type: 'market.campaign.status', payload: { id: paused, status: 'Active' } }); run('campaign pause demo', { type: 'market.campaign.status', payload: { id: paused, status: 'Paused' } }); }
  }

  /* ───────── 客户关系：商机与跟进 ───────── */
  const fabricOrder = state.market.quotations.find(q => q.id === fabricQuote)?.convertedOrderId || '';
  const opp = (step: string, input: { customerId: string; title: string; domain: 'garment' | 'fabric'; amount: string; currency: string; expectedDate: string; note: string; devIds?: string[]; quotationIds?: string[]; orderIds?: string[] }) => id(run(step, { type: 'crm.opportunity.save', payload: { input: { ownerId: 'demo-sales', devIds: [], quotationIds: [], orderIds: [], ...input } } }));
  const oppCoat = opp('opp coat', { customerId: c1.id, title: 'AW27 大衣与马甲补单', domain: 'garment', amount: '75700.00', currency: 'USD', expectedDate: day(20), note: '客户希望 2 月中旬到港', quotationIds: coatQuote ? [coatQuote] : [] });
  if (oppCoat) { run('opp coat sampling', { type: 'crm.opportunity.stage', payload: { id: oppCoat, stage: 'sampling', note: '确认用现款版型' } }); if (coatQuote) run('opp coat quoting', { type: 'crm.opportunity.stage', payload: { id: oppCoat, stage: 'quoting', note: '已发送补单报价' } }); }
  const oppFabric = opp('opp fabric', { customerId: c0.id, title: '双面呢面料 3,600 米', domain: 'fabric', amount: '28080.00', currency: 'EUR', expectedDate: day(-2), note: '', devIds: fabricDevId ? [fabricDevId] : [], quotationIds: fabricQuote ? [fabricQuote] : [], orderIds: fabricOrder ? [fabricOrder] : [] });
  if (oppFabric) for (const stage of ['sampling', 'quoting', 'won'] as const) run('opp fabric ' + stage, { type: 'crm.opportunity.stage', payload: { id: oppFabric, stage, note: stage === 'won' ? '报价已转面料订单' : stage === 'quoting' ? '报价已交付客户' : '米样寄出' } });
  const oppLost = opp('opp lost', { customerId: c2.id, title: 'SS27 亚麻衬衫', domain: 'garment', amount: '18000.00', currency: 'USD', expectedDate: day(-10), note: '' });
  if (oppLost) run('opp lost stage', { type: 'crm.opportunity.stage', payload: { id: oppLost, stage: 'lost', note: '客户转向本地供应商，交期无法满足' } });
  run('follow-up 1', { type: 'crm.followUp.save', payload: { customerId: c1.id, method: 'meeting', content: '视频会议确认大衣补单意向：约 800 件，另加马甲 600 件，希望 2 月中旬到港。', at: at(-1, 6), nextDate: day(3), link: oppCoat ? { kind: 'opportunity', id: oppCoat } : null } });
  run('follow-up 2', { type: 'crm.followUp.save', payload: { customerId: c0.id, method: 'email', content: '回复首样评审意见：袖长按 QC 报告修正，三轮样下周寄出。', at: at(-3, 3), nextDate: '', link: { kind: 'development', id: 'DEV-G-2026-021' } } });
  run('follow-up 3', { type: 'crm.followUp.save', payload: { customerId: c2.id, method: 'call', content: '电话沟通 SS27 亚麻衬衫，客户已决定转本地供应商。', at: at(-10, 8), nextDate: '', link: oppLost ? { kind: 'opportunity', id: oppLost } : null } });

  /* ───────── 定金到账与归属：导入银行流水后确认归属到订单（开产前置条件） ───────── */
  const finance = actor('林舒', 'demo-finance');
  const pricingGarment = state.orders.find(o => o.code === 'SO-G-2026-017'), pricingFabric = state.orders.find(o => o.type === 'fabric');
  if (pricingGarment) run('pricing garment reference', { type: 'platform.pricing.save', payload: { orderId: pricingGarment.id, purchaseCostCny: 280, refundRate: 13, exchangeRate: 7.2, profitMargin: 20, commissionRate: 5, basis: '软件演示试算：羊毛西装套装 CNY/套；280 为演示工厂参考，退税13%、CNY/USD 7.2 仅为演示参数，不是实际成本或生效市场汇率。' } });
  if (pricingFabric) run('pricing fabric reference', { type: 'platform.pricing.save', payload: { orderId: pricingFabric.id, purchaseCostCny: 48, refundRate: 13, exchangeRate: 7.2, profitMargin: 20, commissionRate: 0, basis: '软件演示试算：毛呢面料 CNY/米；按演示规格与计价单位核对，参数仅供软件演示，不自动改报价或合同。' } });
  run('demo payment CNY', { type: 'finance.payment.save', payload: { date: day(-6), payee: '华盛毛纺', amount: 12600, currency: 'CNY', ref: 'DEMO-PAY-CNY-01 · 软件演示付款记录，未关联应付或银行账户' } }, finance);
  run('demo payment USD', { type: 'finance.payment.save', payload: { date: day(-3), payee: '演示物流服务商', amount: 850, currency: 'USD', ref: 'DEMO-PAY-USD-01 · 软件演示付款记录，未关联应付或银行账户' } }, finance);
  const orderByCode = (code: string) => state.orders.find(o => o.code === code);
  const deposits: Array<[string, string, number, string]> = [['SO-G-2026-017', 'NORTHWIND ATELIER AB', 12555, 'DEPOSIT SO-G-2026-017 PO-017'], ['SO-G-2026-015', 'CEDAR & CROWN LTD', 35520, 'DEPOSIT SO-G-2026-015']];
  if (fabricOrderCode()) { const fo = orderByCode(fabricOrderCode()); if (fo) deposits.push([fo.code, 'CEDAR & CROWN LTD', Math.round(fo.amount * 30) / 100, 'DEPOSIT ' + fo.code]); }
  run('import receipts', { type: 'finance.importReceipts', payload: { receipts: deposits.map(([code, payer, amount, ref], i) => ({ date: day(-14 + i * 3), payer, amount, currency: orderByCode(code)?.currency || 'USD', ref })) } }, finance);
  const assignDeposit = (code: string, ref: string) => { const o = orderByCode(code), r = state.receipts.find(x => x.ref === ref); if (o && r) run('deposit ' + code, { type: 'funding.assign', payload: { receiptId: r.id, customerId: o.customerId, orderId: o.id, amount: r.amount, note: '附言注明订单号，按合同定金归属' } }, finance); };
  for (const [code, , , ref] of deposits) assignDeposit(code, ref);
  const cedarDeposit = state.receipts.find(r => r.code === 'BR-2026-1012-03'), deposit018 = orderByCode('SO-G-2026-018');
  if (cedarDeposit && deposit018) run('deposit SO-G-2026-018', { type: 'funding.assign', payload: { receiptId: cedarDeposit.id, customerId: deposit018.customerId, orderId: deposit018.id, amount: cedarDeposit.amount, note: '客户确认此笔为 SO-G-2026-018 定金' } }, finance);
  function fabricOrderCode() { const oid = state.market.quotations.find(q => q.id === fabricQuote)?.convertedOrderId; return state.orders.find(o => o.id === oid)?.code || ''; }

  /* ───────── 采购：面料 / 辅料已批准并入库，加工单草稿 ───────── */
  const order015 = state.orders.find(o => o.code === 'SO-G-2026-015'), lines015 = state.orderLines.filter(l => l.orderId === order015?.id);
  const purchase = (step: string, input: { lineIndex: number; kind: 'material' | 'processing' | 'finished'; supplierId: string; description: string; quantity: number; unit: string; price: number; currency: string; due: number; terms: string; destination: string; note?: string }) => {
    const line = lines15(input.lineIndex); if (!order015 || !line || !input.supplierId) return '';
    return id(run(step, { type: 'fulfillment.procurement.save', payload: { orderId: order015.id, lineId: line.id, kind: input.kind, supplierId: input.supplierId, supplier: '', description: input.description, quantity: input.quantity, unit: input.unit, price: input.price, currency: input.currency, due: day(input.due), terms: input.terms, destination: input.destination, note: input.note || '', fileIds: [] } }, buyer));
  };
  function lines15(index: number) { return lines015[index]; }
  const approveAndConfirm = (pid: string, label: string, confirmedOffset: number) => {
    if (!pid) return;
    run(label + ' submit', { type: 'fulfillment.procurement.submit', payload: { id: pid } }, buyer);
    run(label + ' approve', { type: 'fulfillment.procurement.decide', payload: { id: pid, decision: 'approved', note: '单价与报价核算一致，同意下单' } }, reviewer);
    run(label + ' send', { type: 'fulfillment.procurement.send', payload: { id: pid, at: at(confirmedOffset - 1, 8), evidence: '邮件发送批准版采购合同 PDF', fileIds: [demoFile('supplier-contract', pid, `${state.fulfillment.purchases.find(p => p.id === pid)?.code || label} 采购合同（演示）.pdf`)] } }, buyer);
    const due = state.fulfillment.purchases.find(p => p.id === pid)?.due || day(20);
    run(label + ' confirm', { type: 'fulfillment.procurement.confirm', payload: { id: pid, at: at(confirmedOffset, 10), evidence: '供应商盖章回签', confirmedDue: due, fileIds: [] } }, buyer);
  };
  const fabricPo = purchase('purchase fabric', { lineIndex: 0, kind: 'material', supplierId: huasheng, description: '燕麦色双面呢 420 g/m² · 148 cm（大衣大身）', quantity: 2400, unit: '米', price: 46.5, currency: 'CNY', due: -2, terms: '30% 预付，余款到货验收后 30 天', destination: '嘉兴面辅料仓' });
  approveAndConfirm(fabricPo, 'purchase fabric', -12);
  if (fabricPo) run('purchase fabric receive', { type: 'fulfillment.procurement.receive', payload: { id: fabricPo, quantity: 2380, rejected: 20, destination: 'warehouse', location: '嘉兴面辅料仓 A-03', date: day(-3), evidence: '到货 2,400 米，色差 20 米退回', fileIds: [] } }, warehouse);
  const buttonPo = purchase('purchase buttons', { lineIndex: 0, kind: 'material', supplierId: baotai, description: '牛角纹树脂扣 24L 深棕（每件 8 粒 + 2% 损耗）', quantity: 6600, unit: '粒', price: 0.08, currency: 'CNY', due: -1, terms: '月结 30 天', destination: '嘉兴面辅料仓' });
  approveAndConfirm(buttonPo, 'purchase buttons', -8);
  if (buttonPo) run('purchase buttons receive', { type: 'fulfillment.procurement.receive', payload: { id: buttonPo, quantity: 6600, rejected: 0, destination: 'warehouse', location: '嘉兴面辅料仓 C-11', date: day(-2), evidence: '到货点数无误', fileIds: [] } }, warehouse);
  purchase('purchase processing draft', { lineIndex: 1, kind: 'processing', supplierId: yuanshan, description: '炭灰细格 Blazer 成衣缝制加工（含锁眼钉扣、整烫）', quantity: 800, unit: '件', price: 85, currency: 'CNY', due: 40, terms: '月结 30 天，按实际回交数结算', destination: '远山服装', note: '待确认工价后提交审批' });
  const liningPo = purchase('purchase lining', { lineIndex: 2, kind: 'material', supplierId: huasheng, description: '雾蓝西装里布 · 铜氨丝混纺', quantity: 1100, unit: '米', price: 18.8, currency: 'CNY', due: 10, terms: '月结 30 天', destination: '嘉兴面辅料仓' });
  void liningPo;

  /* ───────── 库存：从面料批次领用给工厂 ───────── */
  const fabricLot = state.fulfillment.stock.find(s => s.purchaseId === fabricPo);
  if (fabricLot) {
    run('stock issue', { type: 'fulfillment.inventory.move', payload: { id: fabricLot.id, kind: 'issue', quantity: 1200, location: '江南成衣 裁床', person: '王建国', note: '第一批裁剪领用' } }, warehouse);
    run('stock move', { type: 'fulfillment.inventory.move', payload: { id: fabricLot.id, kind: 'move', quantity: 300, location: '嘉兴面辅料仓 A-05', person: '陈晓', note: '整理库位', sourceLocation: '嘉兴面辅料仓 A-03' } }, warehouse);
  }

  /* ───────── 样品：借出、寄客户 ───────── */
  const returnedSamples = state.fulfillment.samples.filter(s => s.available > 0);
  if (returnedSamples[0]) run('sample lend', { type: 'fulfillment.samples.move', payload: { id: returnedSamples[0].id, kind: 'lend', quantity: 1, person: '沈禾', location: '版房', note: '版师核对袖笼', expectedReturn: day(3) } }, buyer);
  if (returnedSamples[1]) run('sample send', { type: 'fulfillment.samples.move', payload: { id: returnedSamples[1].id, kind: 'send', quantity: 1, person: 'DHL 1Z84 2207 31', location: 'Cedar & Crown 伦敦', note: '客户评审样' } }, buyer);

  /* ───────── QC：产前样通过、生产中期抽检未通过、待领取任务 ───────── */
  const productionOf = (code: string) => state.productions.find(p => p.code === code);
  const sampleQc = (productionCode: string, role: 'pp' | 'shipping', result: 'pass' | 'reject', shipmentId?: string) => {
    const job = productionOf(productionCode); if (!job) return '';
    const source = { kind: 'orderLine' as const, orderId: job.orderId, lineId: job.lineId, productionId: job.id };
    const sampleId = id(run(`sample ${role} ${productionCode}`, { type: 'fulfillment.samples.create', payload: { name: `${job.name} ${role === 'pp' ? '产前样' : '船样'}`, category: '成衣', form: '实物', quantity: 1, unit: '件', size: 'M', color: '', location: '样品间 A-3', source, role, shipmentId, note: '', fileIds: [] } }, buyer));
    if (!sampleId) return '';
    const task = id(run(`qc ${role} ${productionCode}`, { type: 'fulfillment.qc.request', payload: { source, sampleId, kind: 'sample', domain: 'garment', factory: job.factory, location: job.factory + ' 样衣间', contact: '王建国', due: day(-1) } }, sales));
    if (!task) return '';
    run(`qc claim ${productionCode}`, { type: 'fulfillment.qc.claim', payload: { id: task, domain: 'garment' } }, inspector);
    run(`qc report ${productionCode}`, { type: 'fulfillment.qc.report', payload: { id: task, domain: 'garment', result, report: `QC-G-${productionCode.slice(-4)}-${role.toUpperCase()}`, opinion: result === 'pass' ? '尺寸、外观与工艺符合确认样。' : '门襟缝线跳针 6 处，袖长超差 1.2 cm，需返修后复验。', measurements: [{ point: '胸围', standard: 112, actual: result === 'pass' ? 112.3 : 113.6, tolerance: 1 }, { point: '袖长', standard: 63.5, actual: result === 'pass' ? 63.8 : 64.7, tolerance: 1 }], sizeChecks: [{ size: 'M', inspected: 2, result, evidence: result === 'pass' ? '抽检 2 件' : '抽检 2 件均超差' }], fileIds: [], reviewedAt: at(-2, 7) } }, inspector);
    if (result === 'pass') { run(`qc confirm ${productionCode}`, { type: 'fulfillment.qc.confirm', payload: { id: task, result: 'approved', note: '客户邮件认可' } }, sales); run(`qc continue ${productionCode}`, { type: 'fulfillment.qc.continue', payload: { id: task, note: '业务核对后继续' } }, sales); }
    return task;
  };
  const release = (productionCode: string) => {
    const job = productionOf(productionCode); if (!job) return;
    run('plan ' + productionCode, { type: 'fulfillment.production.plan', payload: { productionId: job.id, sizes: sizeSplit(job.qty) } }, sales);
    sampleQc(productionCode, 'pp', 'pass');
    run('release ' + productionCode, { type: 'fulfillment.production.release', payload: { productionId: job.id, note: '面辅料到齐、产前样已确认' } }, sales);
  };
  release('PO-L-0418');
  release('PO-L-0411');
  const midQc = productionOf('PO-L-0412');
  if (midQc) { run('plan PO-L-0412', { type: 'fulfillment.production.plan', payload: { productionId: midQc.id, sizes: sizeSplit(midQc.qty) } }, sales); sampleQc('PO-L-0412', 'pp', 'reject'); }
  const pendingJob = productionOf('PO-L-0419');
  if (pendingJob) run('qc pending', { type: 'fulfillment.qc.request', payload: { source: { kind: 'orderLine', orderId: pendingJob.orderId, lineId: pendingJob.lineId, productionId: pendingJob.id }, kind: 'production', domain: 'garment', factory: pendingJob.factory, location: pendingJob.factory + ' 车间', contact: '李慧', due: day(2) } }, sales);
  if (fabricDevId) run('qc fabric pending', { type: 'fulfillment.qc.request', payload: { source: { kind: 'version', devId: fabricDevId, versionId: fabricVersionId }, kind: 'sample', domain: 'fabric', factory: '华盛毛纺', location: '面料架 B-2', contact: '赵琳', due: day(1) } }, sales);

  /* ───────── 出运：SO-G-2026-017 第一批已离港（生产 QC、船样、装箱、报关、CI/PL 齐全），第二批待安排 ───────── */
  const order017 = state.orders.find(o => o.code === 'SO-G-2026-017'), job017 = productionOf('PO-L-0411');
  if (order017 && job017) {
    run('complete 0411', { type: 'fulfillment.production.complete', payload: { productionId: job017.id, quantity: job017.qty, sizeQuantities: sizeSplit(job017.qty), date: day(-7), evidence: '工厂完工点数 500 件，待成品 QC', fileIds: [] } }, sales);
    const productionQc = id(run('qc production 0411', { type: 'fulfillment.qc.request', payload: { source: { kind: 'orderLine', orderId: order017.id, lineId: job017.lineId, productionId: job017.id }, kind: 'production', domain: 'garment', factory: job017.factory, location: job017.factory + ' 成品仓', contact: '李慧', due: day(-6) } }, sales));
    if (productionQc) {
      run('qc production claim', { type: 'fulfillment.qc.claim', payload: { id: productionQc, domain: 'garment' } }, inspector);
      run('qc production report', { type: 'fulfillment.qc.report', payload: { id: productionQc, domain: 'garment', result: 'pass', report: 'QC-G-0411-FINAL', opinion: 'AQL 2.5 抽检 80 件，主要缺陷 1 件，判定通过。', measurements: [{ point: '胸围', standard: 104, actual: 104.4, tolerance: 1 }, { point: '衣长', standard: 74, actual: 73.7, tolerance: 1 }], sizeChecks: sizeSplit(80).map(s => ({ size: s.size, inspected: s.quantity, result: 'pass' as const, evidence: 'AQL 2.5 抽检' })), fileIds: [], reviewedAt: at(-7, 6) } }, inspector);
    }
    run('terms 017', { type: 'fulfillment.shipments.sourceTerms', payload: { orderId: order017.id, consignee: 'Northwind Atelier AB, Stockholm', partialAllowed: true, mode: 'sea', confirmedAt: day(-40), evidence: '合同第 5 条，允许分批' } }, sales);
    for (const item of (state.orders.find(o => o.id === order017.id)?.checklist || []).filter(i => ['拟发范围确认', '收货与贸易条款确认', '收款条件核对'].includes(i.label))) run('checklist ' + item.label, { type: 'order.checklist', payload: { orderId: order017.id, itemId: item.id, done: true } } as unknown as MistCommand, sales);
    run('handoff 017', { type: 'order.handoff', payload: { orderId: order017.id, note: '第一批 500 件交接后勤安排出运' } } as unknown as MistCommand, sales);
    const ship = id(run('shipment 017', { type: 'fulfillment.shipments.save', payload: { consignee: 'Northwind Atelier AB, Stockholm', mode: 'sea', portOfLoading: '上海洋山', portOfDischarge: '哥德堡', incoterm: 'FOB', plannedDate: day(-4), booking: 'MSKU 7741 2093', lines: [{ orderId: order017.id, lineId: job017.lineId, productionId: job017.id, quantity: job017.qty, factoryConfirmedAt: day(-7) }], note: '第一批', fileIds: [] } }, sales));
    if (ship) {
      sampleQc('PO-L-0411', 'shipping', 'pass', ship);
      run('pack 017', { type: 'fulfillment.shipments.pack', payload: { id: ship, lines: Array.from({ length: 5 }, (_, i) => ({ lineId: job017.lineId, productionId: job017.id, carton: `${i * 20 + 1}-${i * 20 + 20}`, quantity: 100, netWeight: 96, grossWeight: 108, volume: 1.15, note: '' })) } }, warehouse);
      run('customs 017', { type: 'fulfillment.customs.save', payload: { shipmentId: ship, declarationNo: '2200 2026 1004 9126 51', broker: '上海东航报关有限公司', hsCode: '6203.31', origin: '中国', tradeMode: '一般贸易', declaredAt: day(-5), clearedAt: day(-4), evidence: '海关放行通知', fileIds: [demoFile('customs-release', ship, '报关放行通知 SO-G-2026-017（演示）.pdf')], note: '', status: 'cleared' } }, warehouse);
      for (const [type, title] of [['CI', '商业发票'], ['PL', '装箱单']] as const) {
        const doc = id(run('document ' + type, { type: 'fulfillment.documents.save', payload: { shipmentId: ship, orderId: type === 'CI' ? order017.id : '', type, number: `${type}-2026-0417`, title: `${title} · SO-G-2026-017 第一批`, dueDate: type === 'CI' ? day(26) : '', content: type === 'CI' ? '500 件修身羊毛西装套装 · FOB 上海 · USD' : '100 箱 · 净重 480 kg · 毛重 540 kg · 5.75 m³', fileIds: [demoFile(type === 'CI' ? 'commercial-invoice' : 'packing-list', ship, `${type}-2026-0417 ${title}（演示）.pdf`)] } }, warehouse));
        const issued = doc ? run('document issue ' + type, { type: 'fulfillment.documents.issue', payload: { id: doc } }, warehouse) : null;
        // CI 应收先待财务确认；演示中由财务确认后才计入应收余额。
        if (type === 'CI' && typeof issued?.invoiceId === 'string') run('receivable confirm CI', { type: 'finance.receivable.confirm', payload: { invoiceId: issued.invoiceId } }, finance);
      }
      run('ready 017', { type: 'fulfillment.shipments.ready', payload: { id: ship } }, warehouse);
      run('documents sent 017', { type: 'fulfillment.shipments.sent', payload: { id: ship, at: at(-5, 9) } }, sales);
      run('depart 017', { type: 'fulfillment.shipments.depart', payload: { id: ship, at: at(-4, 6), evidence: '船公司装船通知 · 提单 MSKU77412093', fileIds: [] } }, warehouse);
    }
  }
  const order018 = state.orders.find(o => o.code === 'SO-G-2026-018');
  if (order018) run('terms 018', { type: 'fulfillment.shipments.sourceTerms', payload: { orderId: order018.id, consignee: 'Cedar & Crown Ltd, London', partialAllowed: false, mode: 'sea', confirmedAt: day(-25), evidence: '合同第 7 条' } }, sales);

  /* ───────── 关系智库：一家同时是客户和供应商的组织；一个因逾期冻结的往来 ───────── */
  const boyuanSupplier = supplier('SUP-0006', '博远纺织贸易', '面料贸易', '现货里布 · 衬布 · 小批量面料调货', 50000, '米/月', 7, '浙江绍兴柯桥区中国轻纺城东区 2 号楼', ['何静', '采购与销售', 'hejing@boyuan-textile.cn', '0575-8566 1027']);
  const boyuan = run('customer boyuan', { type: 'market.customer.create', payload: { input: { name: '博远纺织贸易', country: '中国', city: '绍兴', industry: '面料贸易', ownerId: 'demo-sales', grade: 'B', currency: 'CNY', terms: '月结 30 天', incoterm: 'EXW', categories: '面料', creditLimit: 200000, since: day(-200) } } });
  const boyuanRelation = boyuan ? String((boyuan as { relationId?: string }).relationId || '') : '';
  if (boyuanRelation && boyuanSupplier) run('relation link boyuan', { type: 'market.relation.linkSupplier', payload: { id: boyuanRelation, supplierId: boyuanSupplier } });
  const luneRelation = state.market.relations.find(r => r.customerId === c2.id);
  if (luneRelation) run('relation hold lune', { type: 'market.relation.hold', payload: { id: luneRelation.id, frozen: true, reason: '尾款逾期 45 天未付，暂停新报价与新订单，待财务确认回款后解冻' } }, reviewer);

  /* ───────── 风险管理：从真实预警登记；一条待审批升级、一条新发现、一条已关闭可回读 ───────── */
  const signals = riskSignals(state, day(0));
  const register = (step: string, key: string, owner: string, ctx: MistContext) => { const sig = signals.find(x => x.key.startsWith(key)); return sig ? id(run(step, { type: 'platform.risk.save', payload: { title: sig.title, level: sig.level, basis: sig.basis, owner, type: sig.type, source: { kind: sig.source.kind, id: sig.source.id }, signalKey: sig.key } } as MistCommand, ctx)) : ''; };
  const holdRisk = register('risk hold', 'relation-hold:', '林舒', finance);
  if (holdRisk) {
    run('risk hold ack', { type: 'platform.risk.transition', payload: { id: holdRisk, state: 'Acknowledged', resolution: '财务牵头催收，业务配合' } } as MistCommand, finance);
    run('risk hold plan', { type: 'platform.risk.plan', payload: { id: holdRisk, plan: '①本周内与客户确认付款计划；②已在途订单暂停出运放行，待收到 50% 尾款后恢复；③新报价保持冻结。', planDue: day(7) } } as MistCommand, finance);
    run('risk hold escalate', { type: 'platform.risk.escalate', payload: { id: holdRisk, action: 'release', reason: '客户申请分两期付清，需负责人授权在收到首期后放行一票已备货出运。' } } as MistCommand, finance);
  }
  register('risk cert', 'cert-expired:', '沈禾', buyer);
  if (order018) {
    const late = id(run('risk 018', { type: 'platform.risk.save', payload: { title: 'SO-G-2026-018 面料到货晚影响交期', level: 'warning', basis: '华盛毛纺回复主面料晚到 5 天，裁剪顺延；客户交期无缓冲。', owner: '顾言', type: 'delivery', source: { kind: 'order', id: order018.id } } } as MistCommand, sales));
    if (late) {
      run('risk 018 ack', { type: 'platform.risk.transition', payload: { id: late, state: 'Acknowledged', resolution: '' } } as MistCommand, sales);
      run('risk 018 plan', { type: 'platform.risk.plan', payload: { id: late, plan: '工厂加开夜班追回 3 天；剩余 2 天与客户协商，首批 60% 按期海运。', planDue: day(-2) } } as MistCommand, sales);
      run('risk 018 escalate', { type: 'platform.risk.escalate', payload: { id: late, action: 'authorize', reason: '夜班加工费 CNY 4,800 超出订单预算。' } } as MistCommand, sales);
      const esc = state.platform?.risks.find(r => r.id === late)?.escalations?.[0];
      if (esc) run('risk 018 decide', { type: 'platform.risk.decide', payload: { id: late, escalationId: esc.id, decision: 'approved', note: '同意加班，费用记入本单成本，交期不再顺延。' } } as MistCommand, reviewer);
      run('risk 018 close', { type: 'platform.risk.transition', payload: { id: late, state: 'Resolved', resolution: '客户书面同意首批 60% 按期、余量顺延 2 天；工厂排期已确认。' } } as MistCommand, sales);
    }
  }

  return { state, failures };
}

type ProductSeed = { sku: string; name: string; category: 'garment' | 'fabric' | 'trimming'; supplierId: string; supplierCode: string; composition: string; color: string; unit: string; cost: string; currency: string; refPrice: string; specs: Record<string, string> };
function productInput(p: ProductSeed) { return { ...p, season: 'AW27', specification: '', sourceDevId: '', sourceVersionId: '', fileIds: [], note: '' }; }
/** 按常规尺码比例拆分数量（S 15% / M 35% / L 35% / XL 余数），总数严格等于原数量。 */
function sizeSplit(total: number) { const s = Math.floor(total * 0.15), m = Math.floor(total * 0.35), l = Math.floor(total * 0.35); return [{ size: 'S', quantity: s }, { size: 'M', quantity: m }, { size: 'L', quantity: l }, { size: 'XL', quantity: total - s - m - l }]; }
