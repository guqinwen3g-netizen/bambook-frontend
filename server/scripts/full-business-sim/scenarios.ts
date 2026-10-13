import type { ScenarioActorKey, ScenarioBusinessFamily, ScenarioBusinessTeamKey, ScenarioMasterData } from './masterData';

export const SCENARIO_BUSINESS_TIME = '2026-10-08T00:18:00.000Z';
export type OrderScenarioStop = 'draft' | 'approval_pending' | 'approval_rejected' | 'approval_withdrawn'
  | 'sample_qc_pending' | 'sample_rework' | 'production_preparation' | 'production_running'
  | 'production_qc_rework' | 'quantity_shortfall' | 'factory_loading' | 'warehouse_handoff'
  | 'document_return' | 'partially_shipped' | 'shipped_unpaid' | 'partially_settled' | 'settled' | 'commission_pending' | 'supplier_payment_pending';
export type DevelopmentScenarioStop = 'draft' | 'planning' | 'multi_factory_sampling' | 'qc_queued'
  | 'qc_in_progress' | 'qc_rework' | 'business_ack_pending' | 'requester_confirmation_pending'
  | 'archived_and_borrowed' | 'minor_version_review' | 'internal_request' | 'development_ci_finance';
export interface ScenarioResponsibility {
  teamKey: ScenarioBusinessTeamKey; owner: ScenarioActorKey; reviewer: ScenarioActorKey;
  qc: ScenarioActorKey; finance: ScenarioActorKey; logistics: ScenarioActorKey;
}
export interface OrderScenario extends ScenarioResponsibility {
  key: string; family: ScenarioBusinessFamily; stopAfter: OrderScenarioStop;
  customerId: string; supplierId: string; catalogAssetId: string;
  quantity: string; unit: 'M' | 'PC'; unitPrice: string; currency: 'USD' | 'EUR' | 'CNY';
  contractDate: string; dueDate: string; paymentInstrument: 'T/T' | 'L/C'; paymentTerms: string; description: string;
  shipmentGroupKey?: string;
}
export interface DevelopmentScenario extends ScenarioResponsibility {
  key: string; family: ScenarioBusinessFamily; stopAfter: DevelopmentScenarioStop;
  customerId: string | null; supplierIds: string[]; plannedReturnDate: string; description: string;
}

const ORDER_STOPS: OrderScenarioStop[] = ['draft', 'approval_pending', 'approval_rejected', 'approval_withdrawn',
  'sample_qc_pending', 'sample_rework', 'production_preparation', 'production_running', 'production_qc_rework',
  'quantity_shortfall', 'factory_loading', 'warehouse_handoff', 'document_return', 'partially_shipped',
  'shipped_unpaid', 'partially_settled', 'settled', 'commission_pending'];
const DEVELOPMENT_STOPS: DevelopmentScenarioStop[] = ['draft', 'planning', 'multi_factory_sampling', 'qc_queued',
  'qc_in_progress', 'qc_rework', 'business_ack_pending', 'requester_confirmation_pending', 'archived_and_borrowed',
  'minor_version_review', 'internal_request', 'development_ci_finance'];
const orderDescriptions = ['客户秋冬补单草稿', '交期及付款条件待主管审批', '主管退回价格与规格补充', '业务主动撤回修改合同',
  '实物已返待专业QC', '样品NOK待工厂重做', '封样通过待生产分支准备', 'PP通过后正常生产', '生产质量问题待整改复验',
  '完工短少等待补产或客户接受', '工厂直装待实际装箱记录', '大货已入库待业务出运交接', 'CI及PL制作后待业务对客发送',
  '首批已开船余量待出运', '全部已出运应收未到账', '客户与供应商分别部分收付款', '履约及财务分别核对完成', '全单已出运待佣金统一结算'];
const developmentDescriptions = ['客户需求草稿', '计划阶段待落实工厂', '多工厂独立版本制作', '实物返样后排队QC',
  '实际QC已认领执行', '准确版本NOK待新样复验', 'QC通过待业务已阅报告', '业务已阅待需求方真实确认',
  '准确版本转档且实物正在借出', '点号小版本复用原件但独立评审', '内部团队独立开发需求', '开发费用CI已开待财务登记及收款'];

/** A reproducible script specification. It does not write statuses or claim
 * any scenario executed; the HTTP driver must earn each stop through gates. */
export function buildBusinessScenarios(master: ScenarioMasterData) {
  const orders: OrderScenario[] = [], developments: DevelopmentScenario[] = [];
  const actorKey = (id: string): ScenarioActorKey => {
    const actor = Object.values(master.cast).find(row => row.id === id);
    if (!actor) throw Error('Scenario references an unknown actual account.');
    return actor.key;
  };
  for (const family of ['fabric', 'garment'] as const) {
    const teams = master.businessTeams.filter(row => row.businessFamily === family);
    const assets = family === 'fabric' ? master.catalog.fabricAssets : master.catalog.garmentAssets;
    const factories = master.catalog.suppliers.filter(row => row.kind === (family === 'fabric' ? 'fabric_mill' : 'garment_factory'));
    if (!teams.length || assets.length < 35 || factories.length < 2) throw Error('Scenario master data is incomplete.');
    const responsibility = (index: number): ScenarioResponsibility => {
      const team = teams[index % teams.length];
      return { teamKey: team.key, owner: actorKey(index % 2 ? team.leaderId : team.salespersonId),
        reviewer: family === 'fabric' ? 'fabricManager' : 'garmentManager',
        qc: family === 'fabric' ? 'fabricQc' : index % 2 ? 'garmentQc1' : 'garmentQc2',
        finance: index % 2 ? 'financeOperator' : 'financeAccountant', logistics: index % 2 ? 'logistics1' : 'logistics2' };
    };
    ORDER_STOPS.forEach((plannedStop, index) => {
      // Ledger §5.4 confirms commission mode for fabric only. The garment
      // financial case instead stops at a genuine independent AP approval.
      const stopAfter: OrderScenarioStop = family === 'garment' && plannedStop === 'commission_pending'
        ? 'supplier_payment_pending' : plannedStop;
      // A genuine same-customer pair can later share one shipment. The driver
      // still has to prove compatible consignee/destination and exact scopes.
      const consolidationPair = index === 13 || index === 14;
      const duties = responsibility(consolidationPair ? 0 : index), team = master.businessTeams.find(row => row.key === duties.teamKey)!;
      const customerId = team.customerIds[consolidationPair ? 0 : Math.floor(index / teams.length) % team.customerIds.length];
      const customer = master.catalog.customers.find(row => row.id === customerId)!;
      if (!team.memberIds.includes(customer.ownerId)) throw Error('Scenario customer actual follow-up owner is outside its business group.');
      const owner = actorKey(customer.ownerId);
      const candidates = assets.filter(asset => asset.customerRelationId === customerId && team.supplierIds.includes(asset.factoryRelationId));
      const catalogAsset = candidates[index % candidates.length];
      if (!catalogAsset || !factories.some(factory => factory.id === catalogAsset.factoryRelationId)) throw Error('Scenario has no scoped historical catalog reference.');
      orders.push({ ...duties, owner, key: `${master.namespace}-order-${family}-${String(index + 1).padStart(2, '0')}`,
        family, stopAfter, customerId, supplierId: catalogAsset.factoryRelationId, catalogAssetId: catalogAsset.id,
        ...(consolidationPair ? { shipmentGroupKey: `${master.namespace}-${family}-combined-customer-shipment` } : {}),
        quantity: family === 'fabric' ? String(1200 + index * 100) : String(240 + index * 20), unit: family === 'fabric' ? 'M' : 'PC',
        unitPrice: family === 'fabric' ? String(8 + index % 5) : String(28 + index % 7), currency: customer.currency,
        contractDate: '2026-09-10', dueDate: index < 10 ? '2026-10-16' : '2026-10-03',
        paymentInstrument: index === 12 ? 'L/C' : 'T/T',
        paymentTerms: index === 12 ? 'L/C at sight; original documents according to the actual credit' : 'T/T 30% deposit, balance within 30 days of shipment',
        description: stopAfter === 'supplier_payment_pending' ? '客户货款已核销，供应商付款申请待财务独立审批' : orderDescriptions[index] });
    });
    DEVELOPMENT_STOPS.forEach((stopAfter, index) => {
      const duties = responsibility(index), team = master.businessTeams.find(row => row.key === duties.teamKey)!;
      const scopedFactories = factories.filter(factory => team.supplierIds.includes(factory.id));
      if (scopedFactories.length < 2) throw Error('Development script needs two factories within its actual group sharing.');
      const customerId = stopAfter === 'internal_request' ? null : team.customerIds[Math.floor(index / teams.length) % team.customerIds.length];
      developments.push({ ...duties, key: `${master.namespace}-dev-${family}-${String(index + 1).padStart(2, '0')}`,
        family, stopAfter, customerId, supplierIds: [scopedFactories[index % scopedFactories.length].id,
          ...(stopAfter === 'multi_factory_sampling' ? [scopedFactories[(index + 1) % scopedFactories.length].id] : [])],
        plannedReturnDate: index === 2 ? '2026-10-06' : '2026-10-12', description: developmentDescriptions[index] });
    });
  }
  return { businessTime: SCENARIO_BUSINESS_TIME, orders, developments,
    boundary: 'Planned commands, not generated data or acceptance. No business status is directly written.' };
}
