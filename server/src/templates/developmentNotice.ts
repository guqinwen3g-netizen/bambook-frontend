/** BB-DEV-4 试样通知单模板（纯函数、带版本）：按冻结快照输出本轮共同要求与本厂差异、样品与要求日期、参考附件。不读数据库、不引外部资源。 */
import { buildServerDocument, esc } from './docPrintBase';
import type { DevNoticeSnapshot } from '../shared/mistDevelopmentNotice';

const row = (label: string, value: string) => value ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>` : '';

export function renderDevelopmentNoticeHtml(s: DevNoticeSnapshot, options: { screen?: boolean } = {}): string {
  const c = s.issuer;
  const facts = [row('开发案', `${s.devCode} · ${s.devName}`), row('版本', s.versionLabel), row('款号', s.style), row('品类', s.category), row('季节', s.season), row('颜色', s.color), row('面料', s.fabric), row('尺码基准', s.sizeBase)].join('');
  const fabric = s.fabricRequirements.length ? `<section class="block"><div class="block-title">面料要求</div><table class="facts">${s.fabricRequirements.map(item => row(item.label, item.value)).join('')}</table></section>` : '';
  const body = `<header class="doc-header"><div class="doc-title-block"><div class="issuer-name">${esc(c.legalName)}</div>${c.englishName ? `<div class="issuer-en">${esc(c.englishName)}</div>` : ''}<div class="issuer-detail">${[c.address, [c.phone, c.email].filter(Boolean).join(' / ')].filter(Boolean).map(esc).join('<br>')}</div></div>
<div class="doc-meta"><h1>${esc(s.title)}</h1><div class="doc-no">${esc(s.noticeNo)}</div><div>致：${esc(s.factory)}</div><div>第 ${s.roundNumber} 轮 · ${esc(s.versionLabel)}</div><div>生成日期：${esc(s.generatedAt.slice(0, 10))}</div></div></header>
<table class="facts">${facts}</table>
<section class="block"><div class="block-title">本轮共同要求</div><div class="text" data-common>${esc(s.commonRequirements)}</div></section>
<section class="block"><div class="block-title">本厂差异要求</div><div class="text" data-extra>${s.extraRequirements ? esc(s.extraRequirements) : '无（按共同要求）'}</div></section>
${fabric}
<section class="block"><div class="block-title">样品与完成日期</div><table class="facts">${row('样品形态', s.sampleForm)}${row('数量和单位', `${s.sampleQuantity} ${s.sampleUnit}`)}${row('要求完成日期', s.dueDate)}</table></section>
<section class="block"><div class="block-title">参考附件</div>${s.attachments.length ? `<ol class="files">${s.attachments.map(file => `<li>${esc(file.name)}</li>`).join('')}</ol>` : '<div class="text">无</div>'}</section>
<footer class="doc-footer"><div class="doc-signature"><div class="sig-label">制单</div><div class="sig-name">${esc(s.generatedBy)}</div><div>${esc(s.generatedAt.replace('T', ' ').slice(0, 16))} UTC</div></div><div class="doc-signature"><div class="sig-label">工厂确认（签字 / 日期）</div><div class="sig-box"></div></div></footer>
<div class="version-note">${esc(s.noticeNo)} · 第 ${s.seq} 份 · Template v${s.templateVersion}</div>`;
  return buildServerDocument(body, { screen: options.screen, extraStyles: `@page{size:A4}body{padding:0;font-size:11px}.issuer-name{font-size:15px;font-weight:600}.issuer-en{font-size:11px;color:#4a5568}.issuer-detail{font-size:10px;color:#4a5568;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}.doc-meta h1{font-size:20px;font-weight:600;letter-spacing:2px}.facts{width:100%;border-collapse:collapse;margin:8px 0}.facts th{width:22%;text-align:left;color:#4a5568;font-weight:500;padding:4px 8px;border-bottom:1px solid #edf2f7;vertical-align:top}.facts td{padding:4px 8px;border-bottom:1px solid #edf2f7;white-space:pre-wrap;overflow-wrap:anywhere}.block{margin-top:14px;break-inside:avoid}.block-title{font-weight:600;font-size:12px;margin-bottom:4px;border-left:3px solid #2c5282;padding-left:6px}.text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.files{margin:0;padding-left:18px}.sig-box{height:48px;border-bottom:1px solid #a0aec0}.version-note{margin-top:12px;text-align:right;font-size:9px;color:#a0aec0}.doc-footer{break-inside:avoid;margin-top:24px}` }).replace('<head>', '<head><title>' + esc(s.title + ' ' + s.noticeNo) + '</title>');
}
