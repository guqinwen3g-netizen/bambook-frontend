/** Same orchestration for a private rehearsal and the verified current dev.
 * Only master data is seeded separately; every business fact uses real HTTP. */
import { createHash } from 'node:crypto';
import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import { buildBusinessScenarios } from './scenarios';
import { runDevelopmentScenarios } from './developmentDriver';
import { runDevelopmentFinanceScenarios } from './developmentFinanceDriver';
import { runOrderScenarios, type OrderDriverOptions } from './orderDriver';
import { prepareScenarioFinancialInstrument } from './letterOfCreditDriver';
import { scenarioCommand, type ScenarioDriverDependencies } from './driverContract';
import { configureSimulationBusinessPolicy } from './scenarioConfiguration';
import { runSupplierFinanceScenario } from './supplierFinanceDriver';
import { prepareFabricCommissionTerms, runFabricCommissionScenario } from './fabricCommissionDriver';
import { prepareInternalSupplyTerms, runInternalSupplyScenario } from './internalSupplyDriver';

function cashUnits(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,4})?$/.test(value)) return null;
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  return negative ? -units : units;
}

export function createScenarioCashResolver(master: ScenarioMasterData, deps: ScenarioDriverDependencies) {
  const cache = new Map<string, { id: string; revision: number }>();
  const commandKey = (key: string) => {
    const hash = createHash('sha256').update(`${deps.runtimeId}:${key}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  return async (currency: string): Promise<{ id: string }> => {
    if (!['USD', 'EUR', 'CNY'].includes(currency) || deps.actorIds.owner !== master.cast.owner.id) throw Error('SCENARIO_CASH_CONFIGURATION_SOURCE_MISMATCH');
    let account = cache.get(currency);
    if (!account) {
      const key = `cash-account:${currency}`, requestKey = commandKey(key);
      const made = await scenarioCommand(deps, { key, actor: 'owner', method: 'post', url: '/api/v1/finance/cash-accounts', idempotent: true,
        body: { requestKey, name: `${currency} 结算账户`, companyName: master.catalog.company.name,
          companyRelationId: master.catalog.company.id, currency, bankName: '招商银行', accountName: master.catalog.company.englishName,
          accountNumberMasked: `SIM-****-${currency}`, allowedUserIds: ['owner', 'financeOperator', 'financeAccountant', 'financeApprover'].map(key => master.cast[key as ScenarioActorKey].id) } });
      if (typeof made.account?.id !== 'string' || !Number.isSafeInteger(made.account.revision) || made.account.revision < 1)
        throw Error('SCENARIO_CASH_CONFIGURATION_ACK_MISSING');
      account = { id: made.account.id, revision: made.account.revision }; cache.set(currency, account);
    }
    const id = account.id;
    // Simulated bank statements establish an opening independently from
    // customer AR or supplier AP. EUR deliberately retains an unknown opening.
    const openingAmount = currency === 'USD' ? '250000.0000' : currency === 'CNY' ? '800000.0000' : null;
    if (openingAmount !== null) {
      const key = `cash-opening:${currency}`;
      const opened = await scenarioCommand(deps, { key, actor: 'financeAccountant', method: 'post',
        url: `/api/v1/finance/cash-accounts/${encodeURIComponent(id)}/commands`, idempotent: true,
        body: { requestKey: commandKey(key), expectedRevision: account.revision, action: 'opening', currency,
          amount: openingAmount, occurredDate: '2026-09-01', bankReference: `SIM-BANK-OPENING-20260901-${currency}`,
          evidenceNote: `2026-09-01日初对账单：${currency} ${openingAmount}，不包含9月1日及以后的收支；由独立财务会计核实。` } });
      if (opened.account?.id !== id || opened.entry?.kind !== 'Opening' || opened.entry.currency !== currency
        || cashUnits(opened.entry.amount) !== cashUnits(openingAmount) || cashUnits(opened.entry.signedAmount) !== cashUnits(openingAmount)
        || opened.entry.occurredDate !== '2026-09-01' || opened.financeCommand?.kind !== 'cash_account.opening'
        || opened.financeCommand.actorId !== master.cast.financeAccountant.id || opened.financeCommand.targetId !== id
        || !opened.financeCommand.auditId) throw Error('SCENARIO_CASH_OPENING_ACK_MISSING');
    }
    await deps.verifyActor('financeAccountant');
    const actual = await deps.invoke('financeAccountant', 'get', `/api/v1/finance/cash-accounts/${encodeURIComponent(id!)}`);
    if (actual.status !== 200 || actual.body?.account?.id !== id || actual.body.account.currency !== currency
      || actual.body.account.companyRelationId !== master.catalog.company.id) throw Error('SCENARIO_CASH_CONFIGURATION_READBACK_MISMATCH');
    if (openingAmount === null) {
      if (actual.body.opening != null || actual.body.balance !== null || actual.body.balanceStatus !== 'unknown')
        throw Error('SCENARIO_CASH_UNKNOWN_OPENING_INVENTED');
    } else if (actual.body.balanceStatus !== 'verified' || actual.body.balance === null
      || actual.body.opening?.kind !== 'Opening' || cashUnits(actual.body.opening.amount) !== cashUnits(openingAmount)
      || actual.body.opening.occurredDate !== '2026-09-01' || !actual.body.sourcesAvailable)
      throw Error('SCENARIO_CASH_VERIFIED_OPENING_READBACK_MISMATCH');
    if (openingAmount !== null) {
      if (!Array.isArray(actual.body.entries) || actual.body.entries.some((entry: any) => cashUnits(entry.signedAmount) === null)
        || cashUnits(actual.body.balance) !== actual.body.entries.reduce((sum: bigint, entry: any) => sum + cashUnits(entry.signedAmount)!, BigInt(0)))
        throw Error('SCENARIO_CASH_BALANCE_CONSERVATION_MISMATCH');
    }
    return { id: id! };
  };
}

export async function runFullBusinessSimulation(master: ScenarioMasterData, deps: ScenarioDriverDependencies, options: {
  archiveExternalFiling: NonNullable<OrderDriverOptions['archiveExternalFiling']>;
  developmentPaymentMode?: 'partial-first' | 'unpaid';
}) {
  const configuration = await configureSimulationBusinessPolicy(master, deps);
  const plan = buildBusinessScenarios(master), cash = createScenarioCashResolver(master, deps);
  for (const currency of ['USD', 'CNY', 'EUR']) await cash(currency);
  const upstream = await runDevelopmentScenarios(master, plan.developments, deps);
  const partial = plan.developments.find(row => row.family === 'fabric' && row.stopAfter === 'development_ci_finance')!;
  const paymentPlans = options.developmentPaymentMode === 'unpaid' ? {} : {
    [partial.key]: { amount: '40', cashAccountId: (await cash('USD')).id, bankReference: `SIM-BANK-${partial.key}-40USD` },
  };
  const development = await runDevelopmentFinanceScenarios(master, plan.developments, upstream, deps, { paymentPlans });
  const orders = plan.orders.map(scenario => {
    const team = master.businessTeams.find(row => row.key === scenario.teamKey)!;
    const archive = development.archives.find(row => row.family === scenario.family && row.customerId === scenario.customerId && team.supplierIds.includes(row.factoryId));
    return archive ? { ...scenario, supplierId: archive.factoryId } : scenario;
  });
  const orderResults = await runOrderScenarios(master, orders, deps, { businessDate: '2026-10-08',
    prepareCommercialTerms: async context => {
      if (context.scenario.stopAfter === 'commission_pending') await prepareFabricCommissionTerms(context, { rate: '5' });
      if (context.scenario.family === 'garment' && context.scenario.stopAfter === 'production_preparation')
        await prepareInternalSupplyTerms(context);
    },
    prepareFinancialInstrument: prepareScenarioFinancialInstrument,
    prepareMaterialSupply: async context => {
      if (context.scenario.family !== 'garment' || context.scenario.stopAfter !== 'production_preparation') return null;
      const fabricTeam = master.businessTeams.find(team => team.key === 'fabric1' && team.businessFamily === 'fabric');
      if (!fabricTeam || !fabricTeam.memberIds.includes(master.cast.fabric1Sales.id)) throw Error('SCENARIO_INTERNAL_FABRIC_TEAM_REQUIRED');
      return runInternalSupplyScenario(context, { businessDate: '2026-10-08', fabricOwner: 'fabric1Sales',
        fabricSupplierId: fabricTeam.supplierIds[0], sourceQuantity: '1000', metres: '720', unitPrice: '3.20', currency: 'CNY' });
    },
    resolveConfirmedSource: async scenario => {
      const source = development.archives.find(row => row.family === scenario.family && row.customerId === scenario.customerId && row.factoryId === scenario.supplierId);
      return source && source.customerId ? { caseId: source.caseId, assetId: source.assetId, factoryId: source.factoryId, customerId: source.customerId, family: source.family } : null;
    },
    resolveCashAccount: async scenario => cash(scenario.currency), archiveExternalFiling: options.archiveExternalFiling,
    continueFabricCommission: context => runFabricCommissionScenario(context, { businessDate: '2026-10-08', rate: '5' }),
    continueSupplierFinance: context => runSupplierFinanceScenario(context, {
      businessDate: '2026-10-08', purchaseUnitPrice: context.scenario.family === 'fabric' ? '3.20' : '12.00',
      currency: 'CNY', taxRate: '13', supplierPaymentTerms: '供应商明确报价：人民币结算，2026-10-08原票开票后30天到期（2026-11-07）；按原票及实际付款核销，不抵销客户货款。',
      supplierPaymentDueDate: '2026-11-07',
      requestedDeliveryDate: context.scenario.dueDate,
      supplierApprovalUserIds: master.approvalAuthorities[context.scenario.family], resolveCashAccount: cash,
    }),
  });
  return { configuration, plan: { ...plan, orders }, development, orders: orderResults };
}
