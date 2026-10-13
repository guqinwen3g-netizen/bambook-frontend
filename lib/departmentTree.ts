/**
 * 部门下拉选项树序展开 + 层级缩进（2026-08-19 组织架构走查）。
 *
 * 背景：部门选择器此前平铺渲染（按名称字母序），「总公司（根级）」与
 * 「支线部门」在同一列表里无从分辨从属关系。
 *
 * 方案：按 parentId 构树 → 深度优先展开（同层保持接口的名称序）→
 * 子级逐层加「— 」前缀。原生 <option> 文本可靠渲染前缀，无需换控件：
 *   总公司
 *   — 业务部
 *   — 质量部
 *
 * 容错：parentId 指向不存在部门（孤儿节点）按根级处理，保证选项不丢。
 */

export type DepartmentTreeNode = {
  id: string;
  name: string;
  parentId?: string | null;
};

export type DepartmentOption = DepartmentTreeNode & {
  /** 树序渲染文案（含层级前缀） */
  label: string;
  /** 根级=0，每深一层 +1 */
  depth: number;
};

export function buildDepartmentOptions(departments: DepartmentTreeNode[]): DepartmentOption[] {
  const byId = new Map(departments.map(d => [d.id, d]));
  const childrenOf = new Map<string | null, DepartmentTreeNode[]>();
  for (const d of departments) {
    const parentKey = d.parentId && byId.has(d.parentId) ? d.parentId : null;
    const list = childrenOf.get(parentKey);
    if (list) list.push(d);
    else childrenOf.set(parentKey, [d]);
  }
  const out: DepartmentOption[] = [];
  const visit = (node: DepartmentTreeNode, depth: number) => {
    out.push(depth > 0 ? { ...node, depth, label: `${'— '.repeat(depth)}${node.name}` } : { ...node, depth: 0, label: node.name });
    for (const child of childrenOf.get(node.id) ?? []) visit(child, depth + 1);
  };
  for (const root of childrenOf.get(null) ?? []) visit(root, 0);
  return out;
}
