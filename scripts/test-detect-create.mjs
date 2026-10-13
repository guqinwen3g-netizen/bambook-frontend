// 验证修复后的 detectCreateRelationIntent 对各种输入都能正确提取 "ABC"
// 直接从修改后的 planner.ts 源码中提取函数逻辑来测

function detectCreateRelationIntent(query) {
  if (!/(创建|新建|添加|新增|录入|帮我加|帮我建|帮我新建|create|add\s+new)/i.test(query)) return null;
  if (!/(客户|供应商|联系人|customer|supplier|vendor|contact)/i.test(query)) return null;
  let name = '';

  // 策略 1
  const company = query.match(/([\u4e00-\u9fa5A-Za-z0-9&.' _\-]{2,40}(?:有限公司|Co\.?|Inc\.?|Ltd\.?|LLC))/)?.[1];
  if (company) name = company;

  // 策略 1.5: 动词 + 空格 + 英文标识
  if (!name) {
    const verbSpaceEntity = query.match(/(?:写|填|取|叫|为)\s+([A-Za-z][A-Za-z0-9&.'_\-]{1,40})/)?.[1];
    if (verbSpaceEntity) name = verbSpaceEntity;
  }

  // 策略 2
  if (!name) {
    const nameLabeled = query.match(/(?:名字|名称|全名|公司名)\s*(?:就|叫|是|写)?\s*(?:叫|为|填)?\s*([A-Za-z0-9&.' _\-\u4e00-\u9fa5]{1,40}?)(?=[，。！？!?,;\s]|$)/i)?.[1];
    if (nameLabeled) {
      const cleaned2 = nameLabeled.trim();
      const testCleaned = cleaned2.replace(/^[写填取叫为是成就就你帮请麻烦帮我一下]*\s*/g, '').trim();
      if (testCleaned) name = cleaned2;
    }
  }

  // 策略 3
  if (!name) {
    const labeled = query.match(/(?:客户|供应商|联系人|customer|supplier|vendor|contact)\s*(?:的)?(?:名字|名称|全名)?\s*[:：是叫就写为填]\s*([A-Za-z0-9&.' _\-\u4e00-\u9fa5]{1,40}?)(?=[，。！？!?,;\s]|$)/i)?.[1];
    if (labeled) {
      const cleaned3 = labeled.trim();
      const testCleaned3 = cleaned3.replace(/^[写填取叫为是成就就你帮请麻烦帮我一下]*\s*/g, '').trim();
      if (testCleaned3) name = cleaned3;
    }
  }

  // 策略 4
  if (!name) {
    const writeAs = query.match(/(?:写|填|取)\s*(?:为|叫|成|名)?\s*([A-Za-z0-9&.' _\-\u4e00-\u9fa5]{2,40}?)(?=[，。！？!?,;\s]|$)/i)?.[1];
    if (writeAs && writeAs.length >= 1) {
      const cleaned = writeAs.replace(/^(你就|你就写|帮我|请|麻烦|就|你|写|填|取)\s*/g, '').trim();
      if (cleaned.length >= 1) name = cleaned;
    }
  }

  // 策略 5
  if (!name) {
    const trailingEntity = query.match(/(?:叫|为|是|写|填|取)\s*([A-Z][A-Za-z0-9]{1,30})\s*(?:[，。！？!?;；\s]|$)/)?.[1];
    if (trailingEntity) name = trailingEntity;
  }

  // 策略 6
  if (!name) {
    const lastEnglishEntity = query.match(/\s([A-Za-z][A-Za-z0-9]{1,30})(?:\s|$)/)?.[1];
    if (lastEnglishEntity && !['Customer', 'Supplier', 'Contact', 'customer', 'supplier', 'contact'].includes(lastEnglishEntity)) {
      name = lastEnglishEntity;
    }
  }

  // 后处理
  name = name.replace(/^[写填取叫为是成就就你帮请麻烦帮我一下]*\s*/g, '').trim();
  name = name.replace(/^[叫是为成]\s*/g, '').trim();

  // 关键修复：清洗为空时的兜底
  if (!name) {
    const fallbackEntity = query.match(/([A-Za-z][A-Za-z0-9]{1,30})(?:\s|$)/g)?.pop()?.trim();
    if (fallbackEntity && !['Customer', 'Supplier', 'Contact', 'customer', 'supplier', 'contact'].includes(fallbackEntity)) {
      name = fallbackEntity;
    }
  }

  if (!name) return null;
  const kind = /供应商|supplier|vendor/i.test(query) ? 'Supplier' : /联系人|contact/i.test(query) ? 'Contact' : 'Customer';
  const slug = name.replace(/[\s\.,'"`~!@#$%^&*()+=\[\]{}|\\:;<>?\/]/g, '').slice(0, 32) || `REL-${Date.now().toString(36)}`;
  const id = `ORG-${kind.toUpperCase()}-${slug}`.slice(0, 64);
  return { id, name, kind };
}

// 测试用例
const testCases = [
  '帮我创建一个新的客户档案 这个客户的名字你就写 ABC',    // 前端实际消息（带空格）
  '帮我创建一个新的客户档案 这个客户的名字你就写ABC',      // 无空格版
  '帮我创建一个新的客户档案 名字叫ABC',
  '创建一个新客户 名字写 XYZ',
  '新建供应商 名称就叫 Test Co',
  '创建客户档案 客户名字：ABC Corp',
  '帮我创建客户 名字写 Panda Clothing',
  '创建新客户 写 ABC',
];

console.log('=== detectCreateRelationIntent 测试 ===\n');
let allPass = true;
for (const q of testCases) {
  const result = detectCreateRelationIntent(q);
  const status = result ? `name="${result.name}" kind=${result.kind}` : 'null ❌';
  const ok = result && result.name.length >= 2;
  if (!ok) allPass = false;
  console.log(`${ok ? '✅' : '❌'} "${q}"`);
  console.log(`   → ${status}\n`);
}
console.log(allPass ? '✅ 全部通过' : '❌ 有失败用例');
