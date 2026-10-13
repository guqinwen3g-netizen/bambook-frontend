import {
  assertOrderSampleSource, canonicalOrderSampleJson, orderSampleDate, orderSampleDigest,
  OrderSampleContractError, OrderSampleMeasure, OrderSampleSource,
} from './orderSampleSourceContract';

import { parseOrderSampleRegistrationDetails, type OrderSampleRegistrationDetails } from './orderSampleCommandContract';

export type OrderSampleShipment = { sentDate: string; courier: string; trackingNumber: string };
export type OrderSampleFeedback = {
  shippedEventId: string; result: 'approved' | 'needs_revision' | 'adjust_and_resend';
  channel: 'email' | 'portal' | 'written'; confirmationDate: string; evidenceRefs: string[];
};
export type OrderSampleQcReport = {
  id: string; revision: number; requestedEventId: string; sourceId: string; sampleId: string; round: number;
  contentFingerprint: string; coverageFingerprint: string;
  result: 'passed' | 'failed' | 'direct_reject'; opinion: string;
};
export type OrderSampleQcAudit = {
  auditId: string; protocol: 'order_sample_native_v1'; source: 'route:qc:order-sample-review';
  operation: 'order_sample_qc_review'; actorId: string; targetType: 'InspectionReport'; targetId: string;
  after: OrderSampleQcReport;
};
type Payloads = {
  registered: OrderSampleMeasure & {registrationDetails?: OrderSampleRegistrationDetails};
  shipped: OrderSampleShipment;
  customer_feedback: OrderSampleFeedback;
  qc_requested: { reason: string };
  qc_reviewed: { requestedEventId: string; report: OrderSampleQcReport; reportAudit: OrderSampleQcAudit };
  /** Business retention after the current customer result passes; no inventory,
   * physical custody or Card/seal tag is represented by this event. */
  retained: { location: string };
  invalidated: { reason: string };
  legacy_linked: { subjectType: 'FSS' | 'EPS' | 'Sample'; subjectId: string; evidenceAuditIds: string[] };
};
export type OrderSampleEventType = keyof Payloads;
export type OrderSampleEventFact = {
  [K in OrderSampleEventType]: {
    id: string; sourceId: string; sampleId: string; sequence: number; previousEventId: string | null;
    actorId: string; recordedAt: string; occurredAt: string; eventType: K;
    contentFingerprint: string; coverageFingerprint: string; payload: Payloads[K];
  }
}[OrderSampleEventType];
export type OrderSampleEventAudit = {
  auditId: string; protocol: 'order_sample_native_v1'; source: 'route:samples:order-source:event';
  operation: `order_sample_${OrderSampleEventType}`; actorId: string;
  targetType: 'OrderSampleEvent'; targetId: string; after: OrderSampleEventFact;
};
export type OrderSampleEvent = OrderSampleEventFact & { audit: OrderSampleEventAudit };
export type OrderSampleEventHead = { eventId: string; sequence: number };
export type OrderSampleEventView = {
  identity: Pick<OrderSampleSource, 'sourceId' | 'sampleId' | 'family' | 'round' | 'provenance' | 'contentFingerprint' | 'coverageFingerprint'>;
  head: OrderSampleEventHead; proofTier: 'native_audit_chain' | 'historical_observation';
  shipments: (OrderSampleShipment & { eventId: string })[];
  latestFeedback: (OrderSampleFeedback & { eventId: string }) | null;
  pendingQcRequest: { eventId: string; reason: string } | null;
  qc: (OrderSampleQcReport & { eventId: string; requestedEventId: string }) | null;
  /** Recorded business retention and its exact feedback, not current custody. */
  retained: { eventId: string; location: string; customerFeedbackEventId: string; shippedEventId: string } | null;
  invalidated: { eventId: string; reason: string } | null;
  legacyObservations: (Payloads['legacy_linked'] & { eventId: string })[];
  rcScopeEnabled: boolean;
};
function reject(message: string): never { throw new OrderSampleContractError(message); }
function object(value: unknown, keys: string[], label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(`${label}须为完整对象。`);
  if (Object.keys(value).some(key => !keys.includes(key))) reject(`${label}含未定义字段。`);
  return value as Record<string, any>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 2048 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) reject(`${label}须明确。`);
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) reject('事件顺序或修订须为正整数。');
  return value;
}
function references(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) reject('须提供明确证据引用。');
  const refs = value.map(ref => text(ref, '证据引用'));
  if (new Set(refs).size !== refs.length) reject('证据引用重复。');
  return refs;
}
function sameFact(actual: unknown, expected: unknown, label: string): void {
  if (orderSampleDigest(actual) !== orderSampleDigest(expected)) reject(`${label}与完整冻结事实不符。`);
}
const eventKeys = ['id', 'sourceId', 'sampleId', 'sequence', 'previousEventId', 'actorId', 'recordedAt', 'occurredAt', 'eventType', 'contentFingerprint', 'coverageFingerprint', 'payload', 'audit'];
const auditKeys = ['auditId', 'protocol', 'source', 'operation', 'actorId', 'targetType', 'targetId', 'after'];

/** Reduces supplied native facts, not trust. A future service must load real
 * records/audits, enforce current DB grants/L2/signed ceiling and lock/CAS the
 * graph. Neither self-consistent audits nor this view grant Release/Shipment
 * eligibility, historical approval, inventory changes or Case PP projection. */
export function reduceOrderSampleEvents(source: unknown, values: unknown, expectedHead: unknown): OrderSampleEventView {
  assertOrderSampleSource(source);
  canonicalOrderSampleJson(values);
  canonicalOrderSampleJson(expectedHead);
  if (!Array.isArray(values) || !values.length) reject('须传入完整非空事件链。');
  const head = object(expectedHead, ['eventId', 'sequence'], '读取head');
  text(head.eventId, 'head身份'); integer(head.sequence);
  const view: OrderSampleEventView = {
    identity: { sourceId: source.sourceId, sampleId: source.sampleId, family: source.family, round: source.round, provenance: source.provenance,
      contentFingerprint: source.contentFingerprint, coverageFingerprint: source.coverageFingerprint },
    head: { eventId: head.eventId, sequence: head.sequence }, proofTier: source.provenance === 'native_new' ? 'native_audit_chain' : 'historical_observation',
    shipments: [], latestFeedback: null, pendingQcRequest: null, qc: null, retained: null, invalidated: null, legacyObservations: [], rcScopeEnabled: false,
  };
  const eventIds = new Set<string>(), auditIds = new Set<string>();
  const reportRevisions = new Map<string, number>();
  let previousId: string | null = null, recordedAt = BigInt(0);
  for (let index = 0; index < values.length; index++) {
    const event = object(values[index], eventKeys, '事件') as OrderSampleEvent;
    text(event.id, '事件身份'); text(event.actorId, '执行人'); integer(event.sequence);
    if (eventIds.has(event.id) || event.sequence !== index + 1 || event.previousEventId !== previousId) reject('事件链重复、乱序、缺项或前项不符。');
    if (event.sourceId !== source.sourceId || event.sampleId !== source.sampleId || event.contentFingerprint !== source.contentFingerprint || event.coverageFingerprint !== source.coverageFingerprint) reject('事件跨来源、样品、内容或代表范围。');
    if (typeof event.recordedAt !== 'string' || !/^[1-9]\d{0,19}$/.test(event.recordedAt) || BigInt(event.recordedAt) < recordedAt) reject('记录时序不完整或倒退。');
    orderSampleDate(event.occurredAt);
    const audit = object(event.audit, auditKeys, '原生事件审计');
    text(audit.auditId, '审计身份');
    if (auditIds.has(audit.auditId) || audit.protocol !== 'order_sample_native_v1' || audit.source !== 'route:samples:order-source:event' || audit.operation !== `order_sample_${event.eventType}` || audit.actorId !== event.actorId || audit.targetType !== 'OrderSampleEvent' || audit.targetId !== event.id) reject('原生事件审计身份不符或重复。');
    const { audit: omitted, ...fact } = event;
    sameFact(audit.after, fact, '原生事件审计');
    if (source.provenance === 'native_new') {
      if (event.eventType === 'legacy_linked') reject('原生链不能混入历史关联恢复资格。');
      if (index === 0 ? event.eventType !== 'registered' : event.eventType === 'registered') reject('原生事件链须且仅以登记开始。');
    } else if (event.eventType !== 'legacy_linked') reject('历史关联只能记录观察，不能恢复原生资格。');
    if (view.invalidated) reject('此来源轮次已失效，不能追加业务动作。');
    switch (event.eventType) {
      case 'registered':
        object(event.payload, ['quantity', 'unit', 'cuttingDate', 'registrationDetails'], '登记事实');
        sameFact({quantity:event.payload.quantity,unit:event.payload.unit,cuttingDate:event.payload.cuttingDate}, source.sampleFacts, '登记事实');
        if (event.payload.registrationDetails !== undefined) sameFact(event.payload.registrationDetails, parseOrderSampleRegistrationDetails(event.payload.registrationDetails), '本轮登记内容');
        if (event.occurredAt !== source.sampleFacts.cuttingDate) reject('登记事实日期不符。');
        break;
      case 'shipped': {
        const p = object(event.payload, ['sentDate', 'courier', 'trackingNumber', 'physicalShipment', 'directShipment'], '寄送事实');
        if (p.directShipment !== undefined && (p.directShipment !== true || p.physicalShipment !== undefined)) reject('直接寄送不能同时声明仓库实物。');
        if (p.physicalShipment !== undefined) {
          const physical = object(p.physicalShipment, ['itemId','quantity','recipientName','relationId'], '实物寄送');
          text(physical.itemId, '实物编号'); integer(physical.quantity); text(physical.recipientName, '收件人');
          if (physical.relationId !== undefined) text(physical.relationId, '收件客户');
        }
        if (orderSampleDate(p.sentDate) !== event.occurredAt || p.sentDate < source.sampleFacts.cuttingDate) reject('寄送日期与取样事实不符。');
        if (['garment_pp', 'garment_top'].includes(source.family) && (view.qc?.result !== 'passed' || view.pendingQcRequest)) reject('PP/TOP须准确原生QC通过才可寄客户。');
        view.shipments.push({ eventId: event.id, sentDate: p.sentDate, courier: text(p.courier, '承运人'), trackingNumber: text(p.trackingNumber, '寄送单号') });
        view.latestFeedback = null;
        if (source.family === 'fabric_rc') view.rcScopeEnabled = true;
        break;
      }
      case 'qc_requested': {
        const p = object(event.payload, ['reason'], 'QC请求');
        view.pendingQcRequest = { eventId: event.id, reason: text(p.reason, '检验原因') };
        view.qc = null;
        break;
      }
      case 'qc_reviewed': {
        const p = object(event.payload, ['requestedEventId', 'report', 'reportAudit'], 'QC结果');
        if (!view.pendingQcRequest || p.requestedEventId !== view.pendingQcRequest.eventId) reject('QC报告须对应当前同源检验请求。');
        const report = object(p.report, ['id', 'revision', 'requestedEventId', 'sourceId', 'sampleId', 'round', 'contentFingerprint', 'coverageFingerprint', 'result', 'opinion'], '原生QC报告');
        text(report.id, '报告身份'); integer(report.revision); text(report.opinion, '检验意见');
        if (report.requestedEventId !== p.requestedEventId) reject('QC报告与准确检验请求不符。');
        const previousRevision = reportRevisions.get(report.id);
        if (previousRevision !== undefined && report.revision <= previousRevision) reject('同一QC报告修订须真实递增。');
        if (report.sourceId !== source.sourceId || report.sampleId !== source.sampleId || report.round !== source.round || report.contentFingerprint !== source.contentFingerprint || report.coverageFingerprint !== source.coverageFingerprint || !['passed', 'failed', 'direct_reject'].includes(report.result)) reject('QC报告跨来源、轮次、内容或代表范围。');
        const reportAudit = object(p.reportAudit, auditKeys, '原生QC报告审计');
        text(reportAudit.auditId, 'QC审计身份');
        if (reportAudit.auditId === audit.auditId || auditIds.has(reportAudit.auditId) || reportAudit.protocol !== 'order_sample_native_v1' || reportAudit.source !== 'route:qc:order-sample-review' || reportAudit.operation !== 'order_sample_qc_review' || reportAudit.actorId !== event.actorId || reportAudit.targetType !== 'InspectionReport' || reportAudit.targetId !== report.id) reject('原生QC报告审计身份不符或重复。');
        sameFact(reportAudit.after, report, '原生QC报告审计');
        auditIds.add(reportAudit.auditId);
        reportRevisions.set(report.id, report.revision);
        view.qc = { ...p.report, eventId: event.id, requestedEventId: p.requestedEventId };
        view.pendingQcRequest = null;
        break;
      }
      case 'legacy_linked': {
        const p = object(event.payload, ['subjectType', 'subjectId', 'evidenceAuditIds'], '历史关联');
        if (!['FSS', 'EPS', 'Sample'].includes(p.subjectType) || (p.subjectType === 'FSS' && !['fabric_ss', 'fabric_rc'].includes(source.family)) || (p.subjectType === 'EPS' && source.family !== 'fabric_eps')) reject('历史关联主体不属于该业务族。');
        view.legacyObservations.push({ eventId: event.id, subjectType: p.subjectType, subjectId: text(p.subjectId, '历史主体'), evidenceAuditIds: references(p.evidenceAuditIds) });
        break;
      }
      case 'retained': {
        const p = object(event.payload, ['location'], '业务留存');
        const latestShipment = view.shipments[view.shipments.length - 1];
        if (!latestShipment || !view.latestFeedback || view.latestFeedback.result !== 'approved' || view.latestFeedback.shippedEventId !== latestShipment.eventId) reject('业务留存须有当前客户通过事实。');
        view.retained = { eventId: event.id, location: text(p.location, '业务留存位置'), customerFeedbackEventId: view.latestFeedback.eventId, shippedEventId: latestShipment.eventId };
        break;
      }
      case 'invalidated': {
        const p = object(event.payload, ['reason'], '来源失效');
        view.invalidated = { eventId: event.id, reason: text(p.reason, '失效原因') };
        break;
      }
      case 'customer_feedback': {
        const p = object(event.payload, ['shippedEventId', 'result', 'channel', 'confirmationDate', 'evidenceRefs'], '客户反馈');
        const shipped = view.shipments.find(shipment => shipment.eventId === p.shippedEventId);
        if (!shipped) reject('客户反馈须引用此前同源实际寄送事件。');
        if (!['approved', source.family === 'fabric_eps' ? 'adjust_and_resend' : 'needs_revision'].includes(p.result) || !['email', 'portal', 'written'].includes(p.channel)) reject('客户反馈结果或渠道不属于该业务族。');
        if (orderSampleDate(p.confirmationDate) !== event.occurredAt || p.confirmationDate < shipped.sentDate) reject('客户反馈日期早于寄送或事实不符。');
        view.latestFeedback = { eventId: event.id, shippedEventId: p.shippedEventId, result: p.result, channel: p.channel,
          confirmationDate: p.confirmationDate, evidenceRefs: references(p.evidenceRefs) };
        break;
      }
      default: reject('事件类型尚未支持。');
    }
    eventIds.add(event.id); auditIds.add(audit.auditId); previousId = event.id; recordedAt = BigInt(event.recordedAt);
  }
  if (head.eventId !== previousId || head.sequence !== values.length) reject('读取head与完整事件链不符。');
  return view;
}
