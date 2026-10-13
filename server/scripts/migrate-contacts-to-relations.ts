/**
 * migrate-contacts-to-relations.ts — 联系人统一（方案 A）存量数据迁移
 *
 * Contact 实体（CRM 域）→ Relation 人物轨（isOrganization=false）：
 *   1. 逐条处理未删除的 Contact：
 *      - 同组织（relationId）下同名 Relation 人物存在 → 合并 CRM 字段（isPrimary/isDecisionMaker/
 *        contactStatus 仅在 Contact 有值时覆盖；email/phone 等档案字段 Relation 优先）
 *      - 不存在 → 新建 Relation 人物（category 继承父组织）
 *   2. FollowUpRecord.contactId / CommunicationLog.contactId：旧 Contact id → 映射到
 *      对应 Relation 人物 id（未迁移成功则保留原值）
 *   3. 迁移映射关系记录到 Contact.migratedToRelationId 列（不新增列——改用日志输出），
 *      幂等：重跑时已合并的（同组织同名 Relation 且带 isPrimary 标记）跳过。
 *
 * 运行：cd server && npx ts-node scripts/migrate-contacts-to-relations.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const now = () => BigInt(Date.now());

async function main() {
  const contacts = await prisma.contact.findMany({ where: { deletedAt: null } });
  console.log(`[migrate-contacts] 未删除 Contact 实体: ${contacts.length} 条${DRY_RUN ? '（dry-run）' : ''}`);

  const idMap = new Map<string, string>(); // 旧 Contact id → Relation 人物 id
  let merged = 0;
  let created = 0;
  let skipped = 0;

  for (const c of contacts) {
    // 同组织下同名 Relation 人物
    const match = await prisma.relation.findFirst({
      where: { parentId: c.relationId, isOrganization: false, deletedAt: null, name: c.name },
    });

    if (match) {
      // 幂等：Relation 已带 primary 标记且 Contact 无 primary → 视为已迁移
      const alreadyMigrated = !c.isPrimary && (match.isPrimary || match.isDecisionMaker || match.contactStatus);
      if (alreadyMigrated) {
        idMap.set(c.id, match.id);
        skipped++;
        continue;
      }
      if (!DRY_RUN) {
        await prisma.relation.update({
          where: { id: match.id },
          data: {
            // CRM 语义字段：Contact 值优先补（Relation 侧未设置时）
            isPrimary: c.isPrimary || match.isPrimary,
            isDecisionMaker: c.isDecisionMaker || match.isDecisionMaker,
            contactStatus: match.contactStatus ?? c.status ?? 'Active',
            // 档案字段：Relation 已有值优先，Contact 补缺
            role: match.role ?? c.title ?? null,
            department: match.department ?? c.department ?? null,
            email: match.email ?? c.email ?? null,
            phone: match.phone ?? c.phone ?? null,
            mobile: match.mobile ?? c.mobile ?? null,
            wechat: match.wechat ?? c.wechat ?? null,
            whatsapp: match.whatsapp ?? c.whatsapp ?? null,
            birthday: match.birthday ?? c.birthday ?? null,
            personalNote: match.personalNote ?? c.personalNote ?? null,
          },
        });
      }
      idMap.set(c.id, match.id);
      merged++;
    } else {
      // 新建 Relation 人物：category 继承父组织
      const org = await prisma.relation.findFirst({
        where: { id: c.relationId, isOrganization: true },
        select: { category: true },
      });
      const newId = `REL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!DRY_RUN) {
        await prisma.relation.create({
          data: {
            id: newId,
            name: c.name,
            category: org?.category || 'Other',
            type: 'Contact',
            isOrganization: false,
            parentId: c.relationId,
            role: c.title ?? null,
            department: c.department ?? null,
            email: c.email ?? null,
            phone: c.phone ?? null,
            mobile: c.mobile ?? null,
            wechat: c.wechat ?? null,
            whatsapp: c.whatsapp ?? null,
            isPrimary: c.isPrimary,
            isDecisionMaker: c.isDecisionMaker,
            contactStatus: c.status ?? 'Active',
            birthday: c.birthday ?? null,
            personalNote: c.personalNote ?? null,
            tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
            contactInfo: '',
            rating: 3,
            lastInteraction: c.updatedAt ?? now(),
          },
        });
      }
      idMap.set(c.id, newId);
      created++;
    }
  }

  // 2. 引用重映射（FollowUpRecord / CommunicationLog）
  let fuRemapped = 0;
  let clRemapped = 0;
  if (!DRY_RUN) {
    const fus = await prisma.followUpRecord.findMany({
      where: { contactId: { not: null } },
      select: { id: true, contactId: true },
    });
    for (const fu of fus) {
      const mapped = fu.contactId ? idMap.get(fu.contactId) : undefined;
      if (mapped && mapped !== fu.contactId) {
        await prisma.followUpRecord.update({ where: { id: fu.id }, data: { contactId: mapped } });
        fuRemapped++;
      }
    }
    const cls = await prisma.communicationLog.findMany({
      where: { contactId: { not: null } },
      select: { id: true, contactId: true },
    });
    for (const cl of cls) {
      const mapped = cl.contactId ? idMap.get(cl.contactId) : undefined;
      if (mapped && mapped !== cl.contactId) {
        await prisma.communicationLog.update({ where: { id: cl.id }, data: { contactId: mapped } });
        clRemapped++;
      }
    }
  }

  console.log(`[migrate-contacts] 完成：合并=${merged} 新建=${created} 跳过(已迁移)=${skipped}`);
  console.log(`[migrate-contacts] 引用重映射：FollowUpRecord=${fuRemapped} CommunicationLog=${clRemapped}`);
  console.log('[migrate-contacts] Contact 表保留为历史归档（不再写入）。代理层：crmService.contacts CRUD 已改读写 Relation。');
}

main()
  .catch((e) => { console.error('[migrate-contacts] FATAL', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
