/**
 * 模板变量提取 — 邮件模板（F5）与单据模板（PRD 11.3 DocumentTemplate）共享
 *
 * 从模板文本解析 {{variable}} 占位符（去重、保序）。
 * 变量名规则：字母开头，后续字母/数字/下划线；{{ var }} 允许两侧空白。
 */

export function extractTemplateVariables(...texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    const re = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
  }
  return out;
}
