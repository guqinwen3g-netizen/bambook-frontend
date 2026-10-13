#!/usr/bin/env python3
"""B255 · 金额格式化一族的**四轴取值集合对照表**（v3.219 落盘；只测量，不改代码）

为什么要这一件：`lib/moneyFormat.ts` 的注释当初写着"其余 21 份本批不动 —— 收口要先比
每份的取值集合与默认档，半套合并比不动更糟"。**这句话是对的，但那份账的份数与档位都没量过**
⇒ 本件就是"先比"这一步：按**函数定义落点**穷举，每份在四条轴上归类，输出一张可排期的表。

三条尺的前置（每一条都是本批实测踩出来的，写在这里免得下一批重踩）：
① 归类窗口 = 函数的**词汇范围**：首行以 `{` 结尾走大括号配对；箭头/单行式收到语句结束符。
   （第一版用固定 16 行窗口 ⇒ 把真源读成"没表态"——它的档位住在这个函数之外，见 ②；
     第二版把无花括号的一律只取一行 ⇒ 把两行箭头函数读成"没有函数体"，5 处落进隐形桶）
② 同文件私有 helper 要跟进：真源的小数档/前缀住在 `render()` 里，不跟就整轴看不见。
③ **已知样本验尺**（下表七个站点，档位是逐处读全文人工定的）：量错一格就 fail-closed 不出表。
   ⇒ 样本按**函数名**定位，不钉行号（钉行号会让本件在自己下次复跑前就烂）。
   ⚠️ 「码在后」那一档唯一的样本（`ProcurementManager.formatAmount`）随 v3.220 把六处并进第三出口而**离开分母**
   ⇒ 该分支从今天起没有证人、读数里恒为 0；要恢复它得先在树上放一份这样的实现（不为好看造假样本）。

复量：`python3 scripts/money-format-census.py`（只读；`--json <path>` 另存机读表）
判据口径：扫描根 `components lib services`，`--include=*.ts,*.tsx`，七个名字
（`formatAmount` `formatMoney` `fmtMoney` `formatMoneyText` `fmtAmount` `fmtPrice` `formatPrice`），
排除 `*.test.*`（测试里的对照实现不是产品落点）。
"""
import io, json, os, re, subprocess, sys
from collections import Counter

NAMES = ['formatAmount', 'formatMoney', 'fmtMoney', 'formatMoneyText', 'fmtAmount', 'fmtPrice', 'formatPrice']
SCAN = ['components', 'lib', 'services']
DEFRE = re.compile(r'(?:function|const)\s+(' + '|'.join(NAMES) + r')\s*[=(]')
SKIP_CALLS = {'if', 'for', 'while', 'switch', 'return', 'Number', 'String', 'Math', 'Array', 'Object',
              'JSON', 'Date', 'toFixed', 'split', 'join', 'map', 'filter', 'replace', 'trim',
              'padStart', 'push', 'find', 'forEach', 'some', 'includes', 'toLocaleString', 'abs'}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

hits = []
for d in SCAN:
    ere = '(function|const)[[:space:]]+(' + '|'.join(NAMES) + r')[[:space:]]*[=(]'
    r = subprocess.run(['grep', '-rnE', '--include=*.ts', '--include=*.tsx', ere, d],
                       cwd=ROOT, capture_output=True, text=True)
    for l in r.stdout.split('\n'):
        if not l.strip():
            continue
        p, ln, rest = l.split(':', 2)
        if '.test.' in p:
            continue
        m = DEFRE.search(rest)
        assert m, 'grep 命中但 python 正则不认：' + rest[:60]
        hits.append((p, int(ln), m.group(1)))

CACHE = {}

def lines_of(path):
    key = os.path.join(ROOT, path)
    if key not in CACHE:
        CACHE[key] = io.open(key, encoding='utf-8').read().split('\n')
    return CACHE[key]

def block(lines, start):
    first = lines[start - 1]
    if first.rstrip().endswith('{'):
        out, depth = [], 0
        for l in lines[start - 1:]:
            out.append(l)
            depth += l.count('{') - l.count('}')
            if depth <= 0:
                break
        return '\n'.join(out)
    out = []
    for l in lines[start - 1:]:
        out.append(l)
        s = l.rstrip()
        if len(out) > 1 and (s.endswith((';', ',', '}')) or l.strip() == ''):
            break
    return '\n'.join(out)

def extent(path, line):
    src = lines_of(path)
    body = block(src, line)
    for _ in range(2):
        for hm in re.finditer(r'\b([a-z][A-Za-z0-9_]*)\s*\(', body):
            nm = hm.group(1)
            if nm in SKIP_CALLS:
                continue
            for idx, l in enumerate(src):
                if re.match(r'^(?:export\s+)?(?:function|const)\s+%s\b' % re.escape(nm), l):
                    sub = block(src, idx + 1)
                    if sub not in body:
                        body += '\n' + sub
                    break
    return body

def classify(path, line):
    body = extent(path, line)
    whole = '\n'.join(lines_of(path))
    # 委托的判据放宽成"这一份里**调用**了出口"（原来是 `return 出口(` / `=> 出口(` 两种字面）。
    #   产品建档那处把出口包在模板串里（后面还要拼单位），按旧写法认不出 ⇒ 会被读成"仍自己实现"。
    #   两条必须排除的自匹配：① 出口自己的声明行（`function formatMoneyText(` 也是"名字+("）；
    #   ② import 别名（那是"某处在用真源"的声明，不是这一份函数在转调）。
    def _calls_outlet(text):
        for m in re.finditer(r'\b(formatMoneyText|formatMoneySymbol|formatMoneyCodeAfter)\s*\(', text):
            head = text[:m.start()].rsplit('\n', 1)[-1]
            if re.search(r'(?:function|const)\s+$', head):
                continue
            if re.search(r'\bimport\b', head):
                continue
            # ★ 复核举出的另一种假委托：整段自带实现、只在**注释**里提了一句出口名 ⇒ 不能算转调
            if re.match(r'^\s*(?://|\*|/\*)', head):
                continue
            return True
        return False
    delegated = ('lib/moneyFormat' in whole) and _calls_outlet(body)
    dash = ('—' in body) or ('MONEY_EMPTY' in body)
    bail_null = bool(re.search(r'return null\b', body))
    zero = ('?? 0' in body) or (': 0' in body) or ('|| 0' in body) or ('num : 0' in body)
    blank = bool(re.search(r"\? '' :", body)) or bool(re.search(r"=== ''", body))
    business_word = '未填' in body
    # 守卫谓词要认"输入可空"，不能裸认 `undefined` 这个词：`toLocaleString(undefined, {…})`
    # 里那个 undefined 是 locale 参数，把它当守卫会把"根本没有空值守卫"误判成"有守卫"（实测 1 处）
    guard = ('== null' in body) or ('=== null' in body) or ('| undefined' in body) \
        or ('!price' in body) or ('!n' in body) or ('!value' in body) \
        or ('!amount' in body) or ('!num' in body)
    cond4 = bool(re.search(r'subCent \? 4 : 2', body))
    uncond4 = ('FractionDigits: 4' in body) and not cond4
    min2 = 'minimumFractionDigits: 2' in body
    max2 = ('maximumFractionDigits: 2' in body) or ('toFixed(2)' in body)
    symbol = ('¥' in body) or ("'$'" in body) or ('€' in body)
    # ★ v3.223 更正：`new Intl.NumberFormat('zh-CN', {…}).format(n)` **默认就带千分位**
    #   （useGrouping 默认 true，本机实测 1234.5 → `1,234.50`）。这一轴原先只认 toLocaleString，
    #   把唯一一份 Intl 写法（收款认领）误判成"无千分位"，H 档因此多算了一处。
    thousand = ('toLocaleString' in body) or ('Intl.NumberFormat' in body)

    if delegated:
        digits = '委托真源'
    elif cond4:
        digits = '2+4条件'
    elif uncond4:
        digits = '2..4无条件'
    elif min2 and max2:
        digits = '固定2位'
    elif max2:
        digits = '上限2不补零'
    elif re.search(r'\$\{[a-zA-Z0-9_.\[\]]*(amount|price|value)', body):
        digits = '原样串'
    else:
        digits = '未表态'

    if delegated:
        nll = '委托真源'
    elif dash:
        nll = '—'
    elif business_word:
        nll = '未填'
    elif bail_null:
        nll = 'null'
    elif zero:
        nll = '0'
    elif blank:
        nll = '空串'
    elif guard:
        nll = '有守卫未定档'
    elif '.format(' in body:
        # ★ v3.223 更正：`Intl.NumberFormat(...).format(x)` 没有"抛"这一步 ——
        #   本机实测 null → `0.00`、undefined/NaN → `NaN`。这一档从前落在 B（"会抛或上屏 undefined"），
        #   实际形状是 A（没值显示成 0.00），所以"A 档已清零"那句当时就说早了。
        nll = '无空值守卫(Intl:null→0.00)'
    else:
        nll = '无空值守卫'

    if delegated:
        ccy = sep = '委托真源'
    else:
        if symbol:
            ccy = '符号在前'
        elif re.search(r'\$\{[^}]*(currency|cur|ccy)\b', body) or re.search(r'\bc \?\? ', body):
            after = bool(re.search(r'toLocaleString\([^)]*\)\s*\}\s*\$\{[^}]*\}', body)) or \
                bool(re.search(r'text\}\s*\$\{', body)) or \
                bool(re.search(r'\}\s*\$\{(currency|cur|ccy)\}[`;]', body))
            ccy = '码在后' if after else '码在前'
        else:
            ccy = '无币种'
        sep = '千分位' if thousand else '无千分位'
    # ★ v3.223 新轴：转调了真源，但**空值那一档还是自己定的**（订单上下文摘要靠空串把整段摘掉、
    #   产品建档那格要显示业务文字"未填"）。这一类不许被算进"纯委托"，否则"还剩几份"会把
    #   两处仍然不同的屏面口径说成已经一致。
    partial = None
    if delegated:
        m = re.search(r"\?\s*''\s*:", body)
        if m:
            partial = '空串'
        else:
            m = re.search(r"return\s+'([^']{1,8})'", body)
            if m and m.group(1) != '—':
                partial = m.group(1)
    return {'null': nll, 'digits': digits, 'ccy': ccy, 'sep': sep, 'partial': partial}

def find_line(rel_path, name):
    for i, l in enumerate(lines_of(rel_path), 1):
        if DEFRE.search(l) and re.search(r'\b%s\b' % re.escape(name), l):
            return i
    raise SystemExit('样本落点查无：%s 里的 %s ⇒ 本件的定位方式已过期，先修件再谈读数' % (rel_path, name))

SRC = ('—', '2+4条件', '码在前', '千分位')
DELEG = ('委托真源',) * 4
SAMPLES = [
    # (文件, 函数名, 四轴档位, 自带空值档)
    ('lib/moneyFormat.ts', 'formatMoneyText', SRC, None),
    ('components/PricingManager.tsx', 'formatMoney', DELEG, None),
    ('components/ui/crm/crmRelationSections.tsx', 'fmtMoney', DELEG, None),
    ('components/orders/OrderShipmentBatchPanel.tsx', 'fmtMoney',
     ('—', '上限2不补零', '无币种', '千分位'), None),
    # ★ 这两格是"尺自己被抓到误判"之后补的反向样本：`toLocaleString(undefined, …)` 里的
    #   undefined 不是空值守卫
    ('components/mes/OrderProcessChainPanel.tsx', 'fmtAmount', DELEG, None),   # v3.222：写死的 ¥ 改成显式 CNY 实参后只剩一行转调
    # ★ v3.223 新轴的两个样本：转调了真源、但空值那一档仍然自己定（一处空串、一处业务文字）
    ('components/order/OrderContextSection.tsx', 'fmtAmount', DELEG, '空串'),
    ('components/ProductsManager.tsx', 'formatPrice', DELEG, '未填'),
]
# v3.223 收口走掉的**两格**样本落点（MarketingManager.formatMoney / ReceiptClaimsPanel.fmtMoney ——
# 本批并掉的五处里只有这两处当年是样本）；SeasonsManager / OrderContextSection / ProductsManager 三处
# 本来就不在样本表里，其中后两处今天以"自带空值档"的新形状重新入表。
# ⇒ 与 v3.220 那批同一件事 —— 档位分支还留在尺上，但**已无活样本**。
#    "Intl:null→0.00" 那一格尤其要说清：它的判据是本轮 node 实测量出来的（见收口件 §八 8.8），不是样本喂出来的。
for f, nm, want, want_partial in SAMPLES:
    c = classify(f, find_line(f, nm))
    got = tuple(c[k] for k in ('null', 'digits', 'ccy', 'sep'))
    if got != want or c['partial'] != want_partial:
        raise SystemExit('尺不成立：%s 的 %s 量成 %s + 空值档 %r，读全文定的是 %s + %r ⇒ 不出表'
                         % (f, nm, got, c['partial'], want, want_partial))
    print('验尺通过 %-46s %-16s → %s%s'
          % (f, nm, ' | '.join(got), '' if not c['partial'] else ' +自带空值档(%s)' % c['partial']))

rows = [{'file': p, 'line': ln, 'name': nm, **classify(p, ln)} for p, ln, nm in hits]
sig = lambda r: (r['null'], r['digits'], r['ccy'], r['sep'])
priv = [r for r in rows if r['file'] != 'lib/moneyFormat.ts' and '委托真源' not in sig(r)]
deleg = [r for r in rows if '委托真源' in sig(r)]
same = [r for r in priv if sig(r) == SRC]
cnt = Counter(sig(r) for r in rows)

print('\n落点合计 %d · 按名字 %s' % (len(rows), dict(Counter(r['name'] for r in rows))))
part = [r for r in rows if r['partial']]
print('  真源 1 · 纯委托真源 %d · 仍自己实现 %d · 转调但自带空值档 %d 处（%s）'
      % (len(deleg) - len(part), len(priv), len(part), ', '.join('%s:%s' % (r['file'], r['name']) for r in part) or '无'))
print('\n══ 每轴档位计数（仅"仍自己实现"的 %d 份）══' % len(priv))
for ax in ('null', 'digits', 'ccy', 'sep'):
    print('  %-7s %s' % (ax, dict(Counter(r[ax] for r in priv))))
print('\n完整签名分布：')
for s, n in cnt.most_common():
    print('  %-40s %2d 份' % (' | '.join(s), n))

groups = [
    ('A. "算不出/没值"显示成 0（G3 同族活缺陷，非风格问题）', lambda r: r['null'] == '0'),
    ('B. 空值守卫缺失（调用方传空会抛或上屏 undefined）', lambda r: r['null'] == '无空值守卫'),
    ('C. 空值→空串（屏面上"没有"=一片白）', lambda r: r['null'] == '空串'),
    ('D. 空值→null（判断推给调用方）', lambda r: r['null'] == 'null'),
    ('E. 小数档≠真源', lambda r: r['digits'] in ('2..4无条件', '上限2不补零', '原样串', '未表态')),
    ('F. 币种位置=码在后（并过去会把 USD 挪到数字前）', lambda r: r['ccy'] == '码在后'),
    ('G. 币种=无（句子末尾自己带币种）', lambda r: r['ccy'] == '无币种'),
    ('H. 无千分位（六位数以上形状不同）', lambda r: r['sep'] == '无千分位'),
    ('I. 空值→业务文字"未填"（不是 —，但也没兜 0：这一档要不要统一，属屏面口径题）',
     lambda r: r['null'] == '未填'),
    ('J. 有守卫但空值档位读不出（尺的盲区点名处，逐处人工读）', lambda r: r['null'] == '有守卫未定档'),
    ('Z. 其余（空值走 —、小数/币种/千分位仍与真源不同档）',
     lambda r: r['null'] == '—' and sig(r) != SRC),
]
print('\n══ 分档清单（收口按档改口径，一档一批改）══')
accounted = set()
for title, pred in groups:
    g = [r for r in priv if pred(r)]
    for r in g:
        accounted.add((r['file'], r['line']))
    print('\n%s：%d 份' % (title, len(g)))
    for r in g:
        print('   %-56s:%-5d %-16s %s' % (r['file'], r['line'], r['name'], ' | '.join(sig(r))))

# 自证：分档清单必须覆盖全部私有落点，不许有落点哪一档都不在（那就是量错了却没喊）
missed = [r for r in priv if (r['file'], r['line']) not in accounted]
print('\n★ 覆盖自证：私有 %d 份 / 被某一档点名 %d 份 / 没点名 %d 份'
      % (len(priv), len(priv) - len(missed), len(missed)))
for r in missed:
    print('   !! 未点名：', r['file'], r['line'], r['name'], sig(r))
if missed:
    raise SystemExit('有落点没进任何一档 ⇒ 尺有盲区，本表不发')

print('\n══ 与真源取值集合完全相同（并过去行为不变）：%d 份 ══' % len(same))
for r in same:
    print('   %s:%d %s' % (r['file'], r['line'], r['name']))
if not same:
    print('   （无 ⇒ "行为不变的机械合并"在本族不成立；收口只能"先改口径、再并"）')

if '--json' in sys.argv:
    out = sys.argv[sys.argv.index('--json') + 1]
    io.open(out, 'w', encoding='utf-8').write(json.dumps(
        {'total': len(rows), 'by_name': dict(Counter(r['name'] for r in rows)),
         'delegated': deleg, 'private': priv, 'dist': {'|'.join(k): v for k, v in cnt.items()},
         'axis_tiers': {ax: dict(Counter(r[ax] for r in priv)) for ax in ('null', 'digits', 'ccy', 'sep')},
         'groups': {t: [r['file'] + ':' + str(r['line']) + ' ' + r['name'] for r in priv if p(r)]
                    for t, p in groups},
         'same_as_source': same}, ensure_ascii=False, indent=1))
    print('机读表已写 %s' % out)
