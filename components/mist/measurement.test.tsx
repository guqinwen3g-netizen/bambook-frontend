// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { MeasurementTable } from './patterns';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement;
function render(rows: React.ComponentProps<typeof MeasurementTable>['rows']) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<MeasurementTable rows={rows} />));
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; });

it('keeps the original five columns and renders an empty state without an invented tolerance', () => {
  render([]);
  expect(host.querySelector('[data-head]')?.children).toHaveLength(5);
  expect(host.textContent).toContain('暂无测量记录');
  expect(host.textContent).not.toContain('±1.0');
});

it('keeps zero-tolerance markers finite for equal, larger and smaller measurements', () => {
  render([{ point: '等于标准', standard: 1, actual: 1, tolerance: 0 }, { point: '大于标准', standard: 1, actual: 2, tolerance: 0 }, { point: '小于标准', standard: 1, actual: 0, tolerance: 0 }]);
  const markers = [...host.querySelectorAll<HTMLElement>('.mist-tol i')];
  expect(markers.map(item => item.style.left)).toEqual(['50%', '98%', '2%']);
  expect(markers.map(item => item.dataset.tone)).toEqual([undefined, 'bad', 'bad']);
  expect(host.innerHTML).not.toMatch(/NaN|Infinity/);
});

it('labels mixed row tolerances accurately and avoids a false first-row tolerance header', () => {
  render([{ point: '胸围', standard: 112, actual: 112.4, tolerance: 1 }, { point: '袖长', standard: 63.5, actual: 63.7, tolerance: 0.2 }]);
  expect(host.querySelector('[data-head]')?.textContent).toContain('公差（cm）');
  expect(host.querySelector('[data-head]')?.textContent).not.toContain('±1.0');
  expect([...host.querySelectorAll('.mist-tol')].map(item => item.getAttribute('aria-label'))).toEqual(['胸围 公差 ±1cm', '袖长 公差 ±0.2cm']);
  expect(host.querySelectorAll('.mist-tol i')[1].getAttribute('data-tone')).not.toBe('bad');
});

it('retains the original uniform-tolerance header and does not misclassify decimal boundaries', () => {
  render([{ point: '胸围', standard: 112, actual: 112.1, tolerance: 0.1 }]);
  expect(host.querySelector('[data-head]')?.textContent).toContain('公差 ±0.1cm');
  expect(host.querySelector('.mist-tol i')?.getAttribute('data-tone')).toBe('warn');
});

it('does not round an entered tolerance to a different value', () => {
  render([{ point: '肩宽', standard: 46, actual: 46.05, tolerance: 0.05 }]);
  expect(host.querySelector('[data-head]')?.textContent).toContain('公差 ±0.05cm');
  expect(host.querySelector('.mist-tol i')?.getAttribute('data-tone')).not.toBe('bad');
});
