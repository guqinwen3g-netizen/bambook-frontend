import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAllowedKnowledgeDocumentFile,
  knowledgeDocumentFileFilter,
  KNOWLEDGE_DOC_EXT_ALLOWLIST,
} from '../knowledgeDocumentsRoute';

/**
 * 知识库文档上传类型白名单（2026-09-15 补）。
 *
 * 此前本路由的 multer **没有 fileFilter**——任意类型、最大 50MB 都能落盘，
 * 而代码库里其它上传路径（印章图/产品图/技术包/QC 报告/报价图/壁纸）都有类型白名单。
 * 本文件测的就是**接到 multer 上的那个函数本身**（不是另写一个等价实现）。
 */

const run = (filename: string) => {
  let accepted: boolean | undefined;
  let error: Error | null = null;
  knowledgeDocumentFileFilter({}, { originalname: filename }, (err, ok) => {
    error = err ?? null;
    accepted = ok;
  });
  return { accepted, error };
};

describe('知识库上传类型白名单', () => {
  it('文档/表格/图片/归档类放行', () => {
    for (const name of [
      '工艺单.pdf', 'SOP.docx', '报价模板.xlsx', '客户资料.csv',
      '说明.md', '流程图.png', '样衣照片.JPG', '资料包.zip', '导出.json',
    ]) {
      expect(run(name).accepted, name).toBe(true);
      expect(isAllowedKnowledgeDocumentFile(name), name).toBe(true);
    }
  });

  it('脚本/可执行/网页类一律拒绝（html / svg / js / exe / php / sh …）', () => {
    for (const name of [
      'x.html', 'x.htm', 'x.xhtml', 'x.svg', 'x.js', 'x.mjs',
      'x.exe', 'x.sh', 'x.bat', 'x.dll', 'x.php', 'x.jsp', 'x.wasm',
    ]) {
      const { accepted, error } = run(name);
      expect(accepted, name).toBeUndefined();
      expect(error, name).toBeInstanceOf(Error);
    }
  });

  it('双扩展名以最后一个为准：合同.pdf.html 必须拒绝（否则绕过白名单）', () => {
    expect(run('合同.pdf.html').accepted).toBeUndefined();
    expect(run('合同.html.pdf').accepted).toBe(true);
  });

  it('无扩展名 / 空名 / 仅点号 → 拒绝', () => {
    for (const name of ['', 'README', '.', '..', 'noext']) {
      expect(run(name).accepted, JSON.stringify(name)).toBeUndefined();
    }
  });

  it('大小写不敏感', () => {
    expect(run('REPORT.PDF').accepted).toBe(true);
    expect(run('X.HTML').accepted).toBeUndefined();
  });

  it('拒绝时错误信息带出扩展名（便于前端提示，非静默失败）', () => {
    const { error } = run('evil.html');
    expect(error?.message).toContain('.html');
  });

  it('白名单本身不含任何脚本/网页类扩展名（防后人误加）', () => {
    const forbidden = ['html', 'htm', 'xhtml', 'svg', 'js', 'mjs', 'exe', 'sh', 'php', 'jsp', 'dll'];
    for (const ext of forbidden) {
      expect(KNOWLEDGE_DOC_EXT_ALLOWLIST.has(ext), ext).toBe(false);
    }
  });

  it('接线守卫：multer 配置确实挂了 fileFilter（防止后人删掉这行而测试仍绿）', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'knowledgeDocumentsRoute.ts'),
      'utf8',
    );
    expect(src).toMatch(/fileFilter:\s*knowledgeDocumentFileFilter/);
  });
});
