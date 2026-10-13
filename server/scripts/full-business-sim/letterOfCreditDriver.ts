import { scenarioCommand, type ScenarioDriverDependencies } from './driverContract';
import type { ScenarioMasterData } from './masterData';
import type { OrderScenario } from './scenarios';

export async function prepareScenarioFinancialInstrument(context: { master: ScenarioMasterData; scenario: OrderScenario;
  orderId: string; lineId: string; deps: ScenarioDriverDependencies }): Promise<void> {
  const { master, scenario: s, orderId, lineId, deps } = context;
  const read = async (url: string) => {
    await deps.verifyActor(s.logistics);
    const response = await deps.invoke(s.logistics, 'get', url);
    if (response.status !== 200 || response.body?.ok === false) throw Error(`SCENARIO_LC_READ_REJECTED: ${url}`);
    return response.body;
  };
  const order = (await read(`/api/v2/orders/${encodeURIComponent(orderId)}`)).order;
  if (order?.id !== orderId || order.customerRelationId !== s.customerId || order.currency !== s.currency
    || !order.lines?.some((line: any) => line.id === lineId)) throw Error('SCENARIO_LC_ORDER_SOURCE_MISMATCH');
  // Read the structured actual contract field, never infer settlement from
  // free-text payment terms or silently overwrite the selected instrument.
  if (order.paymentInstrument !== 'L/C') return;
  const customer = master.catalog.customers.find(row => row.id === s.customerId);
  const amount = Number(s.quantity) * Number(s.unitPrice);
  if (!customer || !Number.isSafeInteger(amount) || amount <= 0 || deps.actorIds[s.logistics] !== master.cast[s.logistics].id) {
    throw Error('SCENARIO_LC_EXPLICIT_AMOUNT_ACTOR_REQUIRED');
  }
  const key = `${s.key}:lc.register`, url = '/api/v1/customs/letters-of-credit';
  const body = { lcNumber: `SIM-LC-${s.key}`, type: 'Irrevocable', orderId, relationId: customer.id, amount,
    currency: s.currency, issueDate: '2026-10-08', issueBank: 'Simulation Issuing Bank', applicant: customer.englishName,
    beneficiary: master.catalog.company.englishName, expiryDate: '2026-11-30', shipmentDeadline: '2026-10-31',
    documentsRequired: ['CommercialInvoice', 'PackingList'], notes: '按本单虚构银行信用证原件登记，非真实银行承诺。' };
  const previous = await deps.journal.read(key);
  let item: any;
  try { item = (await scenarioCommand(deps, { key, actor: s.logistics, method: 'post', url, body, expectedStatus: 201 })).item; }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('SCENARIO_ACK_UNKNOWN_RECONCILE_REQUIRED:') || previous?.state !== 'intent') throw error;
    const list = await read(`${url}?orderId=${encodeURIComponent(orderId)}&search=${encodeURIComponent(body.lcNumber)}`);
    const matches = list.items?.filter((row: any) => row.lcNumber === body.lcNumber) ?? [];
    if (matches.length !== 1) throw Error('SCENARIO_LC_UNKNOWN_CREATE_NOT_RECONCILED');
    item = matches[0];
  }
  if (!item?.id) throw Error('SCENARIO_LC_ACK_MISSING');
  const current = (await read(`${url}/${encodeURIComponent(item.id)}`)).item;
  for (const field of ['lcNumber', 'type', 'orderId', 'relationId', 'currency', 'issueDate', 'issueBank', 'applicant', 'beneficiary', 'expiryDate', 'shipmentDeadline', 'notes'] as const) {
    if (current?.[field] !== body[field]) throw Error(`SCENARIO_LC_CURRENT_SOURCE_MISMATCH: ${field}`);
  }
  if (Number(current.amount) !== amount || current.status !== 'Issued'
    || JSON.stringify(current.documentsRequired) !== JSON.stringify(body.documentsRequired)) throw Error('SCENARIO_LC_CURRENT_TERMS_MISMATCH');
  const timeline = await read(`${url}/${encodeURIComponent(item.id)}/events`);
  const events = timeline.items ?? timeline.events;
  if (!Array.isArray(events) || !events.some((event: any) => event.toNode === 'Issued' && event.actorId === master.cast[s.logistics].id
    && event.eventDate === body.issueDate)) throw Error('SCENARIO_LC_ACTUAL_ISSUE_EVENT_MISSING');
  if (previous?.state === 'intent') await deps.journal.write({ ...previous, state: 'acknowledged', response: { status: 201, body: { item: current } } });
}
