import { describe, it, expect } from 'vitest';
import { formatDocumentDecimal, renderCertificateOfOriginBody, renderBillOfLadingBody, renderAirWaybillBody, renderInsurancePolicyBody } from '../docTemplates/customsDocs';
import { renderPackingListBody } from '../docTemplates/packingList';
import { storage, actor } from '../../customs/__tests__/documentSourceStorage';
import { assembleDocumentSetData } from '../../shipping/documentSetService';
const exporter = { nameEn: 'Exporter', addressEn: 'Original address' };
describe('strict decimal string formatter — original numeric template branches retained', () => {
  it.each([
    ['99999999999999.9999', 2, 2, '100,000,000,000,000.00'], ['99999999999999.9949', 2, 2, '99,999,999,999,999.99'],
    ['1.005', 2, 2, '1.01'], ['-1.005', 2, 2, '-1.01'], ['0', 2, 2, '0.00'], ['0.0001', 2, 4, '0.0001'],
    ['-0.0001', 0, 2, '0'], ['1234.5000', 0, 2, '1,234.5'], ['12.3456', 3, 3, '12.346'],
  ])('formats source %s with decimal precision and original display scale', (value, min, max, expected) => {
    expect(formatDocumentDecimal(value, min, max)).toBe(expected);
  });
  it.each([null, undefined, '', 'NaN', 'Infinity', '1e3', '1,000', '0x10', {}, true])('unknown %s never becomes fake zero', value => {
    expect(formatDocumentDecimal(value)).toBe('—');
  });
  it('renders actual source DTO through PL/CO/BL/AWB/INS with string quantities and no original whole-order amount', async () => {
    const s = storage(), data = (await assembleDocumentSetData(s.db, 'S', { trustedActor: actor })).data as any;
    const pl = renderPackingListBody(data, exporter);
    expect(pl).toContain('20 m'); expect(pl).toContain('2.35'); expect(pl).not.toContain('100 m');
    for (const render of [renderCertificateOfOriginBody, renderBillOfLadingBody, renderAirWaybillBody, renderInsurancePolicyBody]) {
      const html = render(data, exporter); expect(html).toContain('SH-001'); expect(html).not.toContain('NaN'); expect(html).not.toContain('undefined');
    }
  });
});
