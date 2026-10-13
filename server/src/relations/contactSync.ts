import type { Prisma } from '@prisma/client';

/**
 * 联系人真源回写（Contact → Relation 冗余字段）——2026-08-31 联系人真源统一收尾（P2 路线 A：写时回流）。
 *
 * 背景：Contact 表是组织联系人的唯一写真源，但旧轨冗余字段仍有大量只读消费点
 * （邮箱发件人匹配 emailLinkService、订单确认/采购合同/销售合同/财务发票四类单据模板、
 * 出运单据集 documentSetService、报关组合单据、订单表单预填 orderSchema.autoFillFrom、
 * 全局实体搜索回填 entities/search、命令面板、合同生成器等），它们实时读
 * Relation.primaryContactName/Email/Phone 与 contactInfo。
 *
 * 本函数在 Contact 任何写操作（create/update/delete/status 变更）的同一事务内重算
 * 该组织的「在岗主联系人」并回写冗余字段，保证所有消费点读到的一直是新鲜数据：
 *   1. 优先取 isPrimary 且在岗（status='Active'）的联系人；
 *   2. 无在岗 primary 时回退第一个在岗联系人（isPrimary 优先、创建先后为序）；
 *   3. 全员离岗/无联系人时清空冗余字段（contactInfo 归 ''）。
 * contactInfo 回写格式与 company-sim 种子一致：'姓名 / 邮箱 / 电话'（缺项跳过）。
 *
 * 注意：关系智库「联系方式」Tab 对这些冗余字段的手工编辑，会在下一次 Contact 写操作时
 * 被本函数覆盖——真源为 Contact 表，冗余字段从此是派生值（UI 入口退役另行登记）。
 */
export async function syncOrganizationPrimaryContact(
  tx: Prisma.TransactionClient,
  relationId: string,
): Promise<void> {
  const activeWhere = { relationId, deletedAt: null, status: 'Active' };
  const primary =
    (await tx.contact.findFirst({ where: { ...activeWhere, isPrimary: true }, orderBy: { createdAt: 'asc' } })) ??
    (await tx.contact.findFirst({ where: activeWhere, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }));

  await tx.relation.update({
    where: { id: relationId },
    data: {
      primaryContactName: primary?.name ?? null,
      primaryContactEmail: primary?.email ?? null,
      primaryContactPhone: primary?.phone ?? primary?.mobile ?? null,
      contactInfo: primary
        ? [primary.name, primary.email, primary.phone ?? primary.mobile].filter(Boolean).join(' / ')
        : '',
    },
  });
}
